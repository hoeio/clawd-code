#!/usr/bin/env node
// `npx clawd-companion` with no arguments runs a guided setup. Everything else is a small subcommand.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BudgetGuard } from './budget.ts';
import { CLI_TEXT } from './cli-text.ts';
import { DEFAULTS, HOME, homePath, loadConfig } from './config.ts';
import { openBrowser, readApiKey, readRuntime, runDaemon, type Runtime } from './daemon.ts';
import { addHooks, hookCommand, MARKER, removeHooks } from './settings.ts';
import { findCloudflared } from './tunnel.ts';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url)); // package root (this file lives in dist/)
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const COMMAND_FILE = path.join(CLAUDE_DIR, 'commands', 'clawd.md');
const BACKUP = homePath('settings.backup.json');
const ABSENT = '__absent__'; // backup content when there was no settings.json
const APP = homePath('app');
const ENTRY = path.join(APP, 'dist', 'clawd.js');
// What the installed copy needs: the bundled app, the page, the hook scripts.
const APP_FILES = ['dist/clawd.js', 'web/index.html', 'web/clawd.css', 'web/dist/main.js', 'hooks/hook.sh', 'hooks/deliver.sh'];

const t = CLI_TEXT.en;
const args = process.argv.slice(2);
const yes = args.includes('--yes') || !process.stdin.isTTY;
const isSsh = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY);

const commands: Record<string, () => void | Promise<void>> = {
  async setup() {
    console.log(t.hello + '\n');
    if (!fs.existsSync(CLAUDE_DIR)) console.log(t.noClaude);
    installApp();
    const cfg = readUserConfig();
    const rl = yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
    rl?.on('SIGINT', () => { console.log(''); process.exit(130); }); // Ctrl+C: quit cleanly
    try {
      await askAiKey(rl, cfg);
      // Defaults: the previous answer if there is one (re-running setup changes nothing by accident).
      cfg.autoOpen = await askYesNo(rl, isSsh ? t.askAutoOpenRemote : t.askAutoOpen, cfg.autoOpen ?? !isSsh);
      if (isSsh || findCloudflared()) {
        const remote = await askYesNo(rl, t.askRemote, cfg.remote ?? isSsh);
        if (remote && !findCloudflared()) console.log(t.remoteNeedsCloudflared);
        cfg.remote = remote && !!findCloudflared();
      }
    } finally { rl?.close(); }
    writeUserConfig(cfg);
    installHooks();
    console.log('\n' + t.installed + '\n' + t.starting);
    await restart();
    if (cfg.autoOpen) await commands.open(); else await commands.url();
    console.log('\n' + t.tips);
  },

  init() { return commands.setup(); }, // older name

  async url() {
    const rt = await ensureRunning();
    let links = await api(rt, 'GET', '/links');
    if (loadConfig().remote && !links.remote.some((l: string) => l.includes('trycloudflare'))) {
      console.log(t.remoteWait);
      const r = await api(rt, 'POST', '/remote', { on: true });
      if (r.ok) links = r; else console.log(t.remoteFailed(r.error));
    }
    printLinks(links);
  },

  async open() {
    const rt = await ensureRunning();
    openBrowser(`http://127.0.0.1:${rt.port}/?t=${rt.token}`);
    printLinks(await api(rt, 'GET', '/links'));
  },

  async remote() {
    const on = args[1] !== 'off';
    if (on && !findCloudflared()) { console.log(t.remoteNeedsCloudflared); process.exitCode = 1; return; }
    writeUserConfig({ ...readUserConfig(), remote: on });
    const rt = await ensureRunning();
    if (on) console.log(t.remoteWait);
    const r = await api(rt, 'POST', '/remote', { on });
    if (!r.ok) { console.log(t.remoteFailed(r.error)); process.exitCode = 1; return; }
    console.log(on ? t.remoteOn : t.remoteOff);
    if (on) printLinks(r);
  },

  async status() {
    const cfg = loadConfig();
    const ok = (good: boolean, msg: string) => console.log(`  ${good ? '✓' : '✗'} ${msg}`);
    console.log(t.statusTitle);
    ok(Number(process.versions.node.split('.')[0]) >= 22, t.stNode(process.versions.node));
    ok(fs.existsSync(ENTRY), t.stApp);
    let hooked = false;
    try { hooked = fs.readFileSync(SETTINGS, 'utf8').includes(MARKER); } catch {}
    ok(hooked, t.stHooks);
    ok(isOurCommand(), t.stCommand);
    const rt = readRuntime();
    if (rt) ok(true, t.stRunning(rt.port));
    else if (await portBusy(cfg.port)) ok(false, t.stPortBusy(cfg.port));
    else console.log(`  – ${t.stNotRunning}`);
    if (cfg.llm.enabled) {
      const src = process.env[cfg.llm.apiKeyEnv] ? cfg.llm.apiKeyEnv : readApiKey(cfg.llm.apiKeyEnv) ? 'saved' : '';
      ok(!!src || cfg.llm.provider === 'ollama', src || cfg.llm.provider === 'ollama' ? t.stAiOn(src || 'ollama') : t.stAiNoKey);
      const b = new BudgetGuard({ pricing: cfg.pricing, ...cfg.budget, file: homePath('usage.json') }).status();
      console.log(`    ${t.stCost(b.monthUsd.toFixed(4), b.hardUsd)}`);
    } else console.log(`  – ${t.stAiOff}`);
    console.log(`  ${cfg.remote ? '✓' : '–'} ${cfg.remote ? t.stRemoteOn : t.stRemoteOff}`);
    if (!fs.existsSync(ENTRY) || !hooked) console.log('\n' + t.stFix);
  },

  async start() { await ensureRunning(true); }, // called by the SessionStart hook: may open the window

  stop() {
    const rt = readRuntime();
    if (rt) process.kill(rt.pid, 'SIGTERM');
  },

  uninstall() {
    commands.stop();
    if (fs.existsSync(SETTINGS)) {
      let settings: any;
      try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { fail(t.badSettings(SETTINGS)); }
      const cleaned = removeHooks(settings);
      const backup = fs.existsSync(BACKUP) ? fs.readFileSync(BACKUP, 'utf8') : null;
      if (backup === ABSENT && Object.keys(cleaned).length === 0) fs.rmSync(SETTINGS);
      else if (backup && backup !== ABSENT && isDeepStrictEqual(JSON.parse(backup), cleaned)) fs.writeFileSync(SETTINGS, backup); // byte-exact restore
      else fs.writeFileSync(SETTINGS, JSON.stringify(cleaned, null, 2) + '\n'); // settings changed since setup: keep their edits
    }
    if (isOurCommand()) fs.rmSync(COMMAND_FILE);
    // bin/ stays: Claude Code sessions already running may still call those hook scripts.
    for (const p of [BACKUP, APP, homePath('secrets.json'), homePath('handoff-hooks'), homePath('handoff')]) fs.rmSync(p, { recursive: true, force: true });
    console.log(t.uninstalled(HOME));
  },

  daemon() { runDaemon(); }, // foreground; `start` runs it detached
};

/** Copy the app out of the package (npx caches get cleaned) into ~/.clawd-companion/app. */
function installApp() {
  fs.mkdirSync(homePath('bin'), { recursive: true });
  if (path.resolve(PKG_ROOT) !== path.resolve(APP)) {
    if (!fs.existsSync(path.join(PKG_ROOT, 'dist/clawd.js'))) fail(t.noBuild);
    const next = `${APP}.new`;
    fs.rmSync(next, { recursive: true, force: true });
    for (const f of APP_FILES) {
      fs.mkdirSync(path.dirname(path.join(next, f)), { recursive: true });
      fs.copyFileSync(path.join(PKG_ROOT, f), path.join(next, f));
    }
    commands.stop(); // the old copy may be running
    fs.rmSync(APP, { recursive: true, force: true });
    fs.renameSync(next, APP);
  }
  for (const name of ['hook.sh', 'deliver.sh']) {
    fs.copyFileSync(path.join(APP, 'hooks', name), homePath('bin', name));
    fs.chmodSync(homePath('bin', name), 0o755);
  }
  // Hooks run without the user's PATH: remember exactly which node and which file to start.
  fs.writeFileSync(homePath('env'), `CLAWD_NODE='${process.execPath}'\nCLAWD_ENTRY='${ENTRY}'\n`);
  fs.writeFileSync(homePath('bin', 'clawd'), `#!/bin/sh\n. "${homePath('env')}"\nexec "$CLAWD_NODE" "$CLAWD_ENTRY" "$@"\n`, { mode: 0o755 });
}

function installHooks() {
  const original = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null;
  let settings: any;
  try { settings = original ? JSON.parse(original) : {}; } catch { fail(t.badSettings(SETTINGS)); }
  if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, original ?? ABSENT);
  // Handoff needs sync hooks (they print output), so they exist only while handoff is enabled.
  const handoff = loadConfig().handoff.enabled;
  const deliver = handoff ? (ev: string) => hookCommand(homePath('bin', 'deliver.sh'), ev) : undefined;
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(addHooks(settings, hookCommand(homePath('bin', 'hook.sh')), deliver), null, 2) + '\n');
  if (handoff) fs.writeFileSync(homePath('handoff-hooks'), '');
  else fs.rmSync(homePath('handoff-hooks'), { force: true });

  // `/clawd` inside Claude Code prints the window link. Never overwrite a user's own clawd.md.
  if (!fs.existsSync(COMMAND_FILE) || isOurCommand()) {
    const bin = homePath('bin', 'clawd');
    fs.mkdirSync(path.dirname(COMMAND_FILE), { recursive: true });
    fs.writeFileSync(COMMAND_FILE, `---
description: Show the link to the Clawd companion window
disable-model-invocation: true
allowed-tools: Bash(${bin} url)
---
<!-- ${MARKER}: installed by setup, removed by uninstall -->
!\`${bin} url\`

Show the user the text above exactly as it is, and nothing else.
`);
  }
}

const isOurCommand = () => { try { return fs.readFileSync(COMMAND_FILE, 'utf8').includes(`<!-- ${MARKER}`); } catch { return false; } };

async function askAiKey(rl: readline.Interface | null, cfg: any) {
  const envName = cfg.llm?.apiKeyEnv ?? DEFAULTS.llm.apiKeyEnv;
  if (readApiKey(envName)) {
    if (await askYesNo(rl, t.askKeyKeep, true)) { cfg.llm = { ...cfg.llm, enabled: true }; return; }
  }
  if (!rl) return;
  let prompt = t.askKey;
  for (let i = 0; i < 3; i++) {
    const key = (await ask(rl, prompt)).trim();
    if (!key) { console.log(t.keySkipped); cfg.llm = { ...cfg.llm, enabled: false }; return; }
    console.log(t.keyChecking);
    const verdict = await checkGeminiKey(key, cfg.llm?.model ?? DEFAULTS.llm.model);
    if (verdict === 'bad') { prompt = t.keyBad; continue; }
    fs.writeFileSync(homePath('secrets.json'), JSON.stringify({ llmApiKey: key }), { mode: 0o600 });
    fs.chmodSync(homePath('secrets.json'), 0o600);
    console.log(verdict === 'ok' ? t.keyOk : t.keyOffline);
    cfg.llm = { ...cfg.llm, enabled: true, provider: cfg.llm?.provider ?? 'gemini' };
    return;
  }
  console.log(t.keySkipped);
}

/** Model metadata lookup: free, and not an LLM call. */
async function checkGeminiKey(key: string, model: string): Promise<'ok' | 'bad' | 'offline'> {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000) });
    return r.ok ? 'ok' : r.status >= 500 ? 'offline' : 'bad';
  } catch { return 'offline'; }
}

/** Ctrl+D or closed input means "take the default", never a crash. */
const ask = (rl: readline.Interface, q: string) => rl.question(q).catch(() => { console.log(''); return ''; });

async function askYesNo(rl: readline.Interface | null, q: string, dflt: boolean): Promise<boolean> {
  if (!rl) return dflt;
  const a = (await ask(rl, q)).trim().toLowerCase();
  return a ? /^(y|yes|ㅇ|ㅇㅇ|네|예|응)/.test(a) : dflt;
}

function readUserConfig(): any {
  try { return JSON.parse(fs.readFileSync(homePath('config.json'), 'utf8')); } catch { return {}; }
}
function writeUserConfig(c: any) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(homePath('config.json'), JSON.stringify(c, null, 2) + '\n');
}

function printLinks(l: { local: string; remote: string[] }) {
  console.log(`\n${t.linksTitle}\n  ${t.thisComputer}: ${l.local}`);
  for (const r of l.remote) console.log(`  ${t.otherDevices}: ${r}`);
}

async function api(rt: Runtime, method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${rt.port}${p}`, {
    method, headers: { 'X-Clawd-Token': rt.token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json();
}

async function restart() {
  commands.stop();
  for (let i = 0; i < 20 && readRuntime(); i++) await new Promise(r => setTimeout(r, 100));
  await ensureRunning();
}

/** Start the daemon from the installed copy if needed. Only a Claude Code session start may pop the window. */
async function ensureRunning(autoOpen = false): Promise<Runtime> {
  let rt = readRuntime();
  if (rt) return rt;
  fs.mkdirSync(HOME, { recursive: true });
  const log = fs.openSync(homePath('daemon.log'), 'a');
  const entry = fs.existsSync(ENTRY) ? ENTRY : process.argv[1];
  spawn(process.execPath, [entry, 'daemon'], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...(autoOpen ? {} : { CLAWD_NO_AUTOOPEN: '1' }) } }).unref();
  for (let i = 0; i < 50 && !(rt = readRuntime()); i++) await new Promise(r => setTimeout(r, 100));
  if (!rt) fail(t.startFailed(homePath('daemon.log')));
  return rt!;
}

function portBusy(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const cmd = commands[args.find(a => !a.startsWith('-')) ?? 'setup'];
if (!cmd) fail(t.usage);
await cmd();
