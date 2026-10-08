import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HeartEvent, Snapshot } from '../src/heart.ts';
import { PhraseSplitter, SpeechPlanner, firstSentence, type Moment } from '../src/speech.ts';
import type { CharState } from '../src/state.ts';

// The brain is faked: `speaks` decides whether it says something (true) or stays quiet (false).
function setup(speaks = true) {
  let now = 1_000_000;
  const asked: Moment[] = [];
  const emotes: CharState[] = [];
  const sp = new SpeechPlanner({ cooldownSec: 20, react: async m => { asked.push(m); return speaks; }, emote: s => emotes.push(s), now: () => now });
  const snap: Snapshot = { state: 'idle', sessionId: 's', cwd: '/p/shop', task: '', files: [], errorStreak: 0, failing: false, lastPlan: '', lastMessage: '', lastError: '', sessionStartedAt: 0, notesPath: null };
  const base = { sessionId: 's', cwd: '/p', transcriptPath: '' };
  const ev = async (e: object, s: Partial<Snapshot> = {}) => { sp.onEvent({ ...base, ...e } as HeartEvent, { ...snap, ...s }); await new Promise(r => setImmediate(r)); };
  return { asked, emotes, ev, advance: (ms: number) => (now += ms) };
}
const bash = (command: string, success: boolean) => ({ type: 'tool_finished', tool: 'Bash', command, success });
const edit = { type: 'tool_finished', tool: 'Edit', file: '/p/a.ts', success: true };

test('cooldown blocks normal moments, urgent ones skip it', async () => {
  const { asked, ev, advance } = setup();
  await ev({ type: 'session_started', source: 'startup' });
  await ev({ type: 'turn_finished', message: '' });
  assert.equal(asked.length, 1);
  assert.match(asked[0].what, /started in the project "shop"/);
  await ev({ type: 'approval_needed', message: '' });
  assert.equal(asked.length, 2);
  assert.equal(asked[1].mustSpeak, true);
  advance(21_000);
  await ev({ type: 'turn_finished', message: '' });
  assert.equal(asked.length, 3);
});

test('when the brain stays quiet, the cooldown slot is given back', async () => {
  const { asked, ev } = setup(false);
  await ev({ type: 'session_started', source: 'startup' });
  await ev({ type: 'turn_finished', message: '' });
  assert.equal(asked.length, 2);
});

test('quiet during plain tool activity', async () => {
  const { asked, ev } = setup();
  for (let i = 0; i < 20; i++) await ev(bash('ls', true));
  await ev(edit);
  assert.equal(asked.length, 0);
});

test('moments carry observed facts: Claude\'s own words and the real error', async () => {
  const { asked, ev, advance } = setup();
  await ev({ type: 'turn_finished', message: '' }, { state: 'proud', lastMessage: 'Fixed the **auth** check. Also cleaned up.' });
  assert.match(asked[0].what, /went well.*"Fixed the auth check\."/);
  advance(21_000);
  await ev({ type: 'error_streak', count: 6, error: 'x' }, { lastError: 'TypeError: x is undefined' });
  assert.match(asked[1].what, /6 times in a row: TypeError: x is undefined.*no jokes/);
  assert.equal(asked[1].mustSpeak, true);
});

test('prediction hit -> pride (body reacts too)', async () => {
  const { asked, emotes, ev } = setup();
  await ev(bash('npm test', false));
  await ev(edit);
  assert.match(asked[0].what, /Predict/);
  await ev(bash('npm test', true));
  assert.match(asked[1].what, /just passed/);
  assert.deepEqual(emotes, ['proud']);
});

test('prediction miss -> apology; less sure after repeated failures', async () => {
  const { asked, emotes, ev } = setup();
  await ev(bash('npx tsc', false));
  await ev(bash('npx tsc', false));
  await ev(edit);
  assert.match(asked[0].what, /failed 2 times.*less sure/);
  await ev(bash('npx tsc', false));
  assert.match(asked[1].what, /apologize/);
  assert.deepEqual(emotes, ['worried']);
});

test('no prediction for non-check commands, or when it was never said', async () => {
  const { asked, emotes, ev } = setup(false);
  await ev(bash('cat nope', false));
  await ev(edit);
  assert.equal(asked.length, 0);
  await ev(bash('npm test', false));
  await ev(edit); // asked, but the brain stayed quiet...
  await ev(bash('npm test', true)); // ...so there is nothing to gloat about
  assert.equal(asked.length, 1);
  assert.deepEqual(emotes, []);
});

test('helpers', () => {
  assert.equal(firstSentence('Line one\nline two'), 'Line one');
  assert.equal(firstSentence('x'.repeat(200)).length, 90);
});

test('phrases: cut at natural pauses as text streams in; the rest comes at the end', () => {
  const out: string[] = [];
  const s = new PhraseSplitter(p => out.push(p));
  for (const d of ['Two of', ' three tests', ' pass, and', ' the last one', ' is just a type', ' issue. Almost', ' there']) s.push(d);
  assert.deepEqual(out, ['Two of three tests pass,', 'and the last one is just a type issue.']);
  s.end('Two of three tests pass, and the last one is just a type issue. Almost there');
  assert.deepEqual(out.at(-1), 'Almost there');
  const short: string[] = [];
  const t = new PhraseSplitter(p => short.push(p));
  t.push('Hm, okay. Version 3.5 works, I think. ');
  assert.deepEqual(short, ['Hm, okay. Version 3.5 works,']); // no cut inside "3.5"; first phrase at least 12 chars
  const plain: string[] = [];
  const u = new PhraseSplitter(p => plain.push(p));
  u.push('I am feeling sharp and quite content to be sitting here with you, and that is that.');
  assert.deepEqual(plain, ['I am feeling sharp', 'and quite content to be sitting here with you,']); // joining words only split the first phrase
});

test('phrases: a reply that might be SKIP is held back, and never said', () => {
  const out: string[] = [];
  const s = new PhraseSplitter(p => out.push(p), true);
  s.push('SK'); s.push('IP.');
  assert.deepEqual(out, []);
  const real = new PhraseSplitter(p => out.push(p), true);
  real.push('Ski'); real.push('pping lunch again, huh? I noticed. ');
  assert.deepEqual(out, ['Skipping lunch again,']); // "huh? I noticed." is too short to say alone yet
  real.end('Skipping lunch again, huh? I noticed.');
  assert.deepEqual(out, ['Skipping lunch again,', 'huh? I noticed.']);
});

test('mood: the leading tag is held until complete, stripped, and carried by every phrase', () => {
  const out: [string, string | undefined][] = [];
  const s = new PhraseSplitter((p, m) => out.push([p, m]));
  s.push('[che'); s.push('erf');
  assert.deepEqual(out, []); // half a tag: wait
  s.push('ul] Two of three tests pass, and the last one is a type issue.');
  s.end('Two of three tests pass, and the last one is a type issue.');
  assert.deepEqual(out, [['Two of three tests pass,', 'cheerful'], ['and the last one is a type issue.', 'cheerful']]);
  assert.equal(s.mood, 'cheerful');
});

test('mood: unknown tags are dropped unread; untagged text passes through; tagged SKIP stays silent', () => {
  const out: string[] = [];
  const a = new PhraseSplitter(p => out.push(p));
  a.push('[laughs] Okay, that one was funny. ');
  assert.deepEqual(out, ['Okay, that one was funny.']);
  assert.equal(a.mood, undefined);
  const b = new PhraseSplitter(p => out.push(p));
  b.push('No tag here, just words. ');
  assert.equal(out.at(-1), 'No tag here,'); // untouched, and cut at the first comma as usual
  const c = new PhraseSplitter(p => out.push(p), true);
  c.push('[calm] SK'); c.push('IP');
  assert.equal(out.length, 2); // nothing new from the SKIP
});
