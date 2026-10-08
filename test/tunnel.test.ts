import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuickTunnel } from '../src/tunnel.ts';

// Fake cloudflared: logs its args and launches, prints a URL like the real one, stays alive.
function fakeCloudflared() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-t-'));
  const log = path.join(dir, 'log');
  fs.writeFileSync(path.join(dir, 'cloudflared'), `#!/bin/sh\necho "$*" >> "${log}"\necho "INF |  https://fake-$$.trycloudflare.com  |" >&2\nsleep 30\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return { dir, launches: () => fs.readFileSync(log, 'utf8').trim().split('\n'), restore: () => { process.env.PATH = oldPath; } };
}

test('concurrent starts share one tunnel; uses its own config; ready only once it reaches us', async () => {
  const f = fakeCloudflared();
  let probes = 0;
  const accepted: (string | null)[] = [];
  const t = new QuickTunnel(path.join(f.dir, 'quick.yml'), async () => (++probes < 3 ? 0 : 401));
  try {
    const [a, b] = await Promise.all([t.start(1, h => accepted.push(h)), t.start(1, () => {})]);
    assert.equal(a, b);
    assert.equal(t.host, a);
    assert.equal(probes, 3); // waited until a request actually got through
    assert.deepEqual(accepted, [a]); // Host accepted before probing
    const launches = f.launches();
    assert.equal(launches.length, 1);
    assert.match(launches[0], /--config .*quick\.yml/); // never the user's ~/.cloudflared/config.yml
  } finally { t.stop(); f.restore(); }
});
