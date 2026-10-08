// The local daemon: hooks POST in, browser reads SSE out. 127.0.0.1 only, per-run token.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, homePath, loadConfig } from './config.ts';
import { Heart } from './heart.ts';
import { Brain } from './brain.ts';
import { BudgetGuard } from './budget.ts';
import { Handoff } from './handoff.ts';
import { handoffRequest, type Reply } from './router.ts';
import { SpeechPlanner } from './speech.ts';
import { QuickTunnel } from './tunnel.ts';
import { Voice } from './tts.ts';
import { isMood, type Mood } from './mood.ts';
import type { CharState } from './state.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const MAX_BODY = 5 * 1024 * 1024;

export interface Runtime { port: number; token: string; pid: number }

export function openBrowser(url: string) {
  const [cmd, ...args] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
  try { spawn(cmd, [...args, url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

/** API key: environment variable first, else the key saved by setup (secrets.json, mode 600). */
export function readApiKey(envName: string): string {
  if (process.env[envName]) return process.env[envName]!;
  try { return String(JSON.parse(fs.readFileSync(homePath('secrets.json'), 'utf8')).llmApiKey ?? ''); } catch { return ''; }
}

export function readRuntime(): Runtime | null {
  try {
    const rt = JSON.parse(fs.readFileSync(homePath('runtime.json'), 'utf8')) as Runtime;
    process.kill(rt.pid, 0); // throws if not alive
    return rt;
  } catch { return null; }
}

export function runDaemon(): void {
  const cfg = loadConfig();
  const token = crypto.randomBytes(24).toString('hex');
  const port = cfg.port;
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...cfg.allowedHosts.map(h => `https://${h}`)]);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...cfg.allowedHosts]);
  const clients = new Set<http.ServerResponse>();
  const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

  // Recent lines for /poll: some proxies (TryCloudflare quick tunnels) never deliver event streams.
  let seq = 0;
  const recent: { id: number; data: unknown }[] = [];
  const sse = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
    if (event !== 'say') return;
    recent.push({ id: ++seq, data });
    if (recent.length > 50) recent.shift();
  };
  const guard = new BudgetGuard({ pricing: cfg.pricing, ...cfg.budget, file: homePath('usage.json') });
  const brain = new Brain({ llm: cfg.llm, guard, env: { [cfg.llm.apiKeyEnv]: readApiKey(cfg.llm.apiKeyEnv) } });
  const tunnel = new QuickTunnel(homePath('cloudflared-quick.yml'));
  const remoteHosts = () => [...cfg.allowedHosts, ...(tunnel.host ? [tunnel.host] : [])];
  const links = () => ({ local: `http://127.0.0.1:${port}/?t=${token}`, remote: remoteHosts().map(h => `https://${h}/?t=${token}`) });
  const startTunnel = () => tunnel.start(port, h => {
    // Accept the tunnel's hostname only while the tunnel is up.
    for (const x of [...hosts]) if (x.endsWith('.trycloudflare.com')) { hosts.delete(x); origins.delete(`https://${x}`); }
    if (h) { hosts.add(h); origins.add(`https://${h}`); log('remote link ready'); }
  });
  const costEvent = () => `event: cost\ndata: ${JSON.stringify(brain.status())}\n\n`;
  const voice = new Voice({ dir: homePath('voice'), ...cfg.voice, log });
  voice.start();
  // A line streams out a phrase at a time; its voice starts being made the moment each phrase exists.
  // When the line is complete, its full text follows, so the page can size the bubble once for all of it.
  let lineId = 0;
  // Each phrase carries the line's mood (from the LLM's tag, else from Clawd's state) for the voice,
  // and the first phrase of an excited or worried line moves the body too.
  const MOOD_OF: Partial<Record<CharState, Mood>> = { proud: 'cheerful', worried: 'worried', sleepy: 'sleepy', waiting_approval: 'calm' };
  const EMOTE_OF: Partial<Record<Mood, CharState>> = { excited: 'proud', worried: 'worried' };
  const sayLine = () => {
    const id = ++lineId;
    const said: string[] = [];
    const fallback = MOOD_OF[heart.snapshot().state] ?? 'calm';
    return {
      phrase: (text: string, tagged?: Mood) => {
        const mood = tagged ?? fallback;
        const emote = said.length === 0 ? EMOTE_OF[mood] : undefined;
        said.push(text);
        voice.prepare(text, mood);
        sse('say', { id, text, mood, ...(emote ? { emote } : {}) });
      },
      done: () => { if (said.length) sse('say', { id, text: '', full: said.join(' ') }); },
    };
  };
  // Clawd's words all come from the brain. No LLM, no words: the body still reacts.
  const speech = new SpeechPlanner({
    ...cfg.speech,
    react: async m => {
      const line = sayLine();
      const out = await brain.react(m, heart.snapshot(), heart.recentEdits(), line.phrase)
        .catch((e): { kind: 'error'; message: string } => ({ kind: 'error', message: String(e) }));
      line.done();
      for (const c of clients) c.write(costEvent());
      if (out.kind === 'error') log('brain:', out.message);
      return out.kind === 'reply';
    },
    emote: s => sse('say', { text: '', emote: s }),
  });
  const heart: Heart = new Heart({
    timing: cfg.timing,
    home: HOME,
    onChange: s => sse('state', s),
    onEvent: e => {
      sse('event', e);
      speech.onEvent(e, heart.snapshot());
    },
  });
  // Handoff works only when enabled AND init installed the sync delivery hooks.
  const handoffOn = cfg.handoff.enabled && fs.existsSync(homePath('handoff-hooks'));
  const handoff = new Handoff({
    dir: homePath('handoff'),
    onDelivered: () => sse('say', { text: '', emote: 'proud' }),
  });
  setInterval(() => { heart.tick(); handoff.tick(); }, 1000).unref();

  const authed = (req: http.IncomingMessage, url: URL) => {
    const given = String(req.headers['x-clawd-token'] ?? url.searchParams.get('t') ?? '');
    return given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };

  const server = http.createServer((req, res) => {
    // DNS-rebinding and cross-site protection, before anything else.
    const origin = req.headers.origin;
    if (!hosts.has(req.headers.host ?? '') || (origin && !origins.has(origin))) return end(res, 403);
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/hook') {
      if (!authed(req, url)) return end(res, 401);
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
      req.on('end', () => {
        end(res, 204); // answer first: the hook is waiting on nothing but this
        if (size > MAX_BODY) return log('hook payload too large, dropped', size);
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (cfg.debug) fs.appendFile(homePath('raw.jsonl'), JSON.stringify(raw) + '\n', () => {});
          heart.ingest(raw);
        } catch (e) { log('bad hook payload', e); }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      if (!authed(req, url)) return end(res, 401);
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', async () => {
        let text = '';
        try { text = String(JSON.parse(body).text ?? '').slice(0, 2000); } catch {}
        if (!text.trim()) return end(res, 400);
        const snap = heart.snapshot();
        const line = sayLine();
        const out = await brain.reply(text, snap, heart.recentEdits(), line.phrase) // the words go out over SSE as they stream
          .catch((e): { kind: 'error'; message: string } => ({ kind: 'error', message: String(e) }));
        line.done();
        for (const c of clients) c.write(costEvent());
        const reply: Reply = { text: out.kind === 'reply' ? out.text : '' };
        if (out.kind === 'refused' && (out.reason === 'daily' || out.reason === 'month')) reply.emote = 'sleepy'; // talked too much today
        else if (out.kind === 'refused' || out.kind === 'error') log('brain:', out.kind === 'error' ? out.message : out.reason);
        // Code-change requests: Clawd can't change code. A copyable instruction, or a draft for the handoff gate.
        const instruction = handoffRequest(text);
        if (instruction) {
          reply.copy = instruction;
          if (handoffOn && snap.sessionId) reply.handoffId = handoff.draft(instruction, snap.sessionId); // nothing sent until confirmed
        }
        if (out.kind === 'reply') brain.noteTurn(text, out.text, out.mood);
        speech.noteSpoke();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/handoff') {
      if (!authed(req, url) || !handoffOn) return end(res, handoffOn ? 401 : 404);
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on('end', () => {
        let id = '';
        try { id = String(JSON.parse(body).id ?? ''); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: handoff.approve(id) }));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/poll') {
      if (!authed(req, url)) return end(res, 401);
      const since = Number(url.searchParams.get('since') ?? -1);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ id: seq, state: heart.snapshot(), cost: brain.status(), messages: since < 0 ? [] : recent.filter(m => m.id > since) }));
    }
    if (req.method === 'GET' && url.pathname === '/tts') {
      if (!authed(req, url)) return end(res, 401);
      const text = (url.searchParams.get('text') ?? '').slice(0, 500).trim();
      if (!text) return end(res, 400);
      const mood = url.searchParams.get('mood');
      voice.synthesize(text, isMood(mood) ? mood : 'calm').then(wav => {
        if (!wav) return end(res, 404); // no speech engine here: the page falls back to browser speech
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
        res.end(wav);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/links') {
      if (!authed(req, url)) return end(res, 401);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(links()));
    }
    if (req.method === 'POST' && url.pathname === '/remote') {
      if (!authed(req, url) || origin) return end(res, 403); // CLI only, never from a page
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { body += c; if (body.length > 256) req.destroy(); });
      req.on('end', async () => {
        let on = true;
        try { on = JSON.parse(body).on !== false; } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!on) { tunnel.stop(); return res.end(JSON.stringify({ ok: true, ...links() })); }
        try { await startTunnel(); res.end(JSON.stringify({ ok: true, ...links() })); }
        catch (e) { res.end(JSON.stringify({ ok: false, error: (e as Error).message })); }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (!authed(req, url)) return end(res, 401);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: state\ndata: ${JSON.stringify(heart.snapshot())}\n\n`);
      res.write(costEvent());
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      if (!authed(req, url)) return end(res, 401);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(heart.snapshot()));
    }
    if (req.method === 'GET') {
      // Static UI files hold no secrets; data endpoints above need the token.
      const file = path.join(WEB_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (!file.startsWith(WEB_DIR)) return end(res, 404);
      return fs.readFile(file, (err, buf) => {
        if (err) return end(res, 404);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    }
    end(res, 405);
  });

  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000).unref();

  server.on('error', (e: NodeJS.ErrnoException) => {
    // Port taken: usually another clawd daemon won the race. Leave its files alone.
    log(e.code === 'EADDRINUSE' ? `port ${port} in use, exiting` : e);
    process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
  });

  server.listen(port, '127.0.0.1', () => {
    fs.mkdirSync(HOME, { recursive: true });
    // Only written after we own the port, so a losing racer never clobbers the token.
    fs.writeFileSync(homePath('curlrc'), `url = "http://127.0.0.1:${port}/hook"\nheader = "X-Clawd-Token: ${token}"\nheader = "Content-Type: application/json"\n`, { mode: 0o600 });
    fs.writeFileSync(homePath('runtime.json'), JSON.stringify({ port, token, pid: process.pid } satisfies Runtime), { mode: 0o600 });
    log(`listening on 127.0.0.1:${port}`);
    if (cfg.remote) startTunnel().catch(e => log('remote link failed:', e.message));
    // Started by a Claude Code session (not by `open`, which opens it itself): show the window.
    if (cfg.autoOpen && !process.env.CLAWD_NO_AUTOOPEN) openBrowser(links().local);
  });

  const shutdown = () => {
    tunnel.stop();
    if (readRuntime()?.pid === process.pid) for (const f of ['curlrc', 'runtime.json']) fs.rmSync(homePath(f), { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function end(res: http.ServerResponse, code: number) {
  res.writeHead(code);
  res.end();
}
