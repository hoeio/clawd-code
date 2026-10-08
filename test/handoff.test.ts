import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Handoff } from '../src/handoff.ts';
import { addHooks, hookCommand, removeHooks } from '../src/settings.ts';

const DELIVER = path.resolve('hooks/deliver.sh');
fs.chmodSync(DELIVER, 0o755);
const SID = '3e2a6161-ed78-4d37-8aa1-c2b884194c2f';

function setup(opts: { ttlMs?: number; maxQueued?: number } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-h-'));
  let now = 1_000_000;
  const delivered: string[] = [];
  const h = new Handoff({ dir: path.join(home, 'handoff'), now: () => now, onDelivered: i => delivered.push(i), ...opts });
  const run = (event: string, payload: object = {}) =>
    execFileSync(DELIVER, [event], { input: JSON.stringify({ session_id: SID, hook_event_name: event, ...payload }), env: { ...process.env, CLAWD_HOME: home } }).toString();
  const queue = (text: string, sid = SID) => h.approve(h.draft(text, sid));
  return { home, h, run, queue, delivered, advance: (ms: number) => (now += ms) };
}

test('delivered exactly once via UserPromptSubmit, as additional context', () => {
  const { h, run, queue, delivered } = setup();
  assert.equal(queue('add a loading spinner'), 'queued');
  const out = JSON.parse(run('UserPromptSubmit'));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /add a loading spinner/);
  assert.equal(run('UserPromptSubmit'), '');
  assert.equal(run('Stop'), '');
  h.tick();
  assert.deepEqual(delivered, ['add a loading spinner']);
});

test('Stop delivery makes Claude continue; never when stop_hook_active (loop guard)', () => {
  const { run, queue } = setup();
  queue('rename foo to bar');
  assert.equal(run('Stop', { stop_hook_active: true }), '');
  const out = JSON.parse(run('Stop', { stop_hook_active: false }));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /rename foo to bar/);
});

test('at most one item per event; FIFO', () => {
  const { run, queue, advance } = setup();
  queue('first');
  advance(1);
  queue('second');
  assert.match(run('Stop'), /first/);
  assert.match(run('Stop'), /second/);
  assert.equal(run('Stop'), '');
});

test('only the session it was approved in', () => {
  const { run, queue } = setup();
  queue('for another session', 'aaaaaaaa-0000-0000-0000-000000000000');
  assert.equal(run('UserPromptSubmit'), '');
});

test('racing hooks: exactly one delivery', async () => {
  const { home, queue } = setup();
  queue('only once');
  const exec = promisify(execFile);
  const outs = await Promise.all(Array.from({ length: 12 }, () => {
    const p = exec(DELIVER, ['Stop'], { env: { ...process.env, CLAWD_HOME: home } });
    p.child.stdin!.end(JSON.stringify({ session_id: SID }));
    return p.then(r => r.stdout);
  }));
  assert.equal(outs.filter(Boolean).length, 1);
});

test('expired items are dropped, never delivered late', () => {
  const { h, run, queue, delivered, advance } = setup({ ttlMs: 1000 });
  queue('stale');
  advance(1001);
  h.tick();
  assert.equal(run('UserPromptSubmit'), '');
  assert.deepEqual(delivered, []);
});

test('drafts need approval; duplicates and overflow are refused', () => {
  const { h, run, queue } = setup({ maxQueued: 2 });
  h.draft('not approved', SID);
  assert.equal(run('UserPromptSubmit'), '');
  assert.equal(h.approve('nope'), 'unknown');
  assert.equal(queue('a'), 'queued');
  assert.equal(queue('a'), 'duplicate');
  assert.equal(queue('b'), 'queued');
  assert.equal(queue('c'), 'full');
});

test('empty queue: no output, exits 0, fast', () => {
  const { run } = setup();
  const t = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) assert.equal(run('Stop'), '');
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / 20;
  assert.ok(ms < 30, `${ms}ms per call`);
});

test('a fresh daemon starts with an empty queue', () => {
  const { home, run, queue } = setup();
  queue('left over');
  new Handoff({ dir: path.join(home, 'handoff') });
  assert.equal(run('Stop'), '');
});

test('settings: delivery hooks are sync, only when asked, and removed cleanly', () => {
  const plain = addHooks({}, hookCommand('/h/hook.sh'));
  assert.ok(!JSON.stringify(plain).includes('deliver.sh'));
  const withHandoff = addHooks({}, hookCommand('/h/hook.sh'), ev => hookCommand('/h/deliver.sh', ev));
  const deliver = withHandoff.hooks.Stop.flatMap((g: any) => g.hooks).find((h: any) => h.command.includes('deliver.sh'));
  assert.equal(deliver.async, undefined);
  assert.equal(deliver.command, "'/h/deliver.sh' 'Stop' clawd-companion");
  assert.deepEqual(removeHooks(withHandoff), {});
});
