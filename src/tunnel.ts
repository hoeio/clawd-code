// Remote access without any Cloudflare account: a TryCloudflare quick tunnel to the daemon.
// The URL is random per run; the per-run token still guards every data endpoint.
import { spawn, type ChildProcess } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';

const CANDIDATES = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
const READY_TIMEOUT_MS = 90_000;

export function findCloudflared(): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir && fs.existsSync(`${dir}/cloudflared`)) return `${dir}/cloudflared`;
  return CANDIDATES.find(p => fs.existsSync(p)) ?? null;
}

// Public resolvers: asking the user's own DNS before the record exists can get "not found" cached for minutes.
const resolver = new dns.Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8']);

/** Status code our daemon returns through the tunnel for an unauthenticated /state (401), or 0. */
export function probe(host: string): Promise<number> {
  return new Promise(resolve => {
    const req = https.get({
      host, path: '/state', timeout: 8000,
      lookup: (h: string, opts: any, cb: any) => resolver.resolve4(h, (err, addrs) => {
        if (err || !addrs.length) return cb(err ?? new Error('no address'));
        return opts?.all ? cb(null, addrs.map(address => ({ address, family: 4 }))) : cb(null, addrs[0], 4);
      }),
    }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

export class QuickTunnel {
  private child: ChildProcess | null = null;
  private pending: Promise<string> | null = null; // concurrent start() calls share one tunnel
  private configFile: string;
  private probeFn: (host: string) => Promise<number>;
  host: string | null = null; // e.g. "abc-def.trycloudflare.com", set once it actually works

  /**
   * configFile: our own cloudflared config, so a user's ~/.cloudflared/config.yml
   * (named-tunnel ingress, e.g. a 404 catch-all) can't hijack the quick tunnel.
   */
  constructor(configFile: string, probeFn = probe) {
    this.configFile = configFile;
    this.probeFn = probeFn;
  }

  /**
   * Resolves with the public host once a request through it reaches the daemon.
   * onAccept(host) runs first so the daemon accepts that Host header; onHost(null) when the tunnel dies.
   * Rejects with 'no_cloudflared' / 'timeout' / 'exited'.
   */
  start(port: number, onHost: (host: string | null) => void): Promise<string> {
    if (this.host) return Promise.resolve(this.host);
    if (this.pending) return this.pending;
    const bin = findCloudflared();
    if (!bin) return Promise.reject(new Error('no_cloudflared'));
    this.stop();
    try { fs.writeFileSync(this.configFile, '# clawd-companion quick tunnel\nno-autoupdate: true\n'); } catch {}
    const child = spawn(bin, ['tunnel', '--config', this.configFile, '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    this.pending = new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let found = false, buf = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', async (chunk: string) => {
        buf = (buf + chunk).slice(-4000);
        const m = buf.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
        if (!m || found) return;
        found = true;
        const host = m[1];
        onHost(host); // accept the Host header before probing
        while (Date.now() < deadline && this.child === child) {
          if (await this.probeFn(host) === 401) { this.host = host; return resolve(host); }
          await new Promise(r => setTimeout(r, 2000));
        }
        reject(new Error('timeout'));
      });
      child.on('exit', () => {
        if (this.child === child) { this.child = null; this.host = null; onHost(null); }
        reject(new Error('exited'));
      });
      setTimeout(() => { if (!found) reject(new Error('timeout')); }, READY_TIMEOUT_MS);
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.host = null;
  }
}
