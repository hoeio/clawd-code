import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.ts';
import { Heart, errorLine, type HeartEvent } from '../src/heart.ts';

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-'));
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, '');
  let now = new Date(2026, 0, 1, 14).getTime();
  const events: HeartEvent[] = [];
  const heart = new Heart({ timing: DEFAULTS.timing, home, now: () => now, onEvent: e => events.push(e) });
  const send = (hook_event_name: string, extra: object = {}) =>
    heart.ingest({ session_id: 's1', cwd: '/proj/x', transcript_path: transcript, hook_event_name, ...extra });
  return { home, transcript, heart, events, send, advance: (ms: number) => (now += ms) };
}
const fail = (command: string, error: string) => ({ tool_name: 'Bash', tool_input: { command }, error });

test('same error 3x -> error_streak + worried; success of same command clears', () => {
  const { heart, events, send } = setup();
  send('UserPromptSubmit', { prompt: 'fix tests' });
  for (let i = 0; i < 3; i++) send('PostToolUseFailure', fail('npm test', `Exit code 1\nFAIL test ${i}.ts line ${i * 7}`));
  assert.equal(events.filter(e => e.type === 'error_streak').length, 1);
  assert.equal(heart.snapshot().state, 'worried');
  assert.equal(heart.snapshot().errorStreak, 3);
  send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }); // different command: streak stays
  assert.equal(heart.snapshot().errorStreak, 3);
  send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(heart.snapshot().errorStreak, 0);
});

test('different errors do not form a streak', () => {
  const { events, send } = setup();
  send('PostToolUseFailure', fail('a', 'Exit code 1\nmissing module'));
  send('PostToolUseFailure', fail('b', 'Exit code 2\ntype error'));
  send('PostToolUseFailure', fail('c', 'Exit code 1\nsyntax error'));
  assert.equal(events.some(e => e.type === 'error_streak'), false);
});

test('turn with edits and no failure -> proud; final message saved as-is', () => {
  const { home, heart, send } = setup();
  send('UserPromptSubmit', { prompt: 'add button' });
  send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/proj/x/a.ts' } });
  send('Stop', { last_assistant_message: 'Added the button.' });
  const s = heart.snapshot();
  assert.equal(s.state, 'proud');
  assert.deepEqual(s.files, ['/proj/x/a.ts']);
  const note = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 's1.jsonl'), 'utf8'));
  assert.equal(note.message, 'Added the button.');
  assert.equal(note.prompt, 'add button');
  assert.ok(fs.readFileSync(s.notesPath!, 'utf8').includes('## Goals'));
});

test('reads Claude\'s own words from the transcript', () => {
  const { transcript, heart, send } = setup();
  send('UserPromptSubmit', { prompt: 'x' });
  fs.appendFileSync(transcript, [
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: "I'll fix the auth check first." }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n{"type":"assist'); // trailing partial line
  send('PostToolUse', { tool_name: 'Read', tool_input: {} });
  assert.equal(heart.snapshot().lastPlan, "I'll fix the auth check first.");
});

test('derived: user_returned, long_session', () => {
  const { heart, events, send, advance } = setup();
  send('SessionStart', { source: 'startup' });
  advance(20 * 60_000);
  send('UserPromptSubmit', { prompt: 'back' });
  assert.ok(events.some(e => e.type === 'user_returned'));
  advance(DEFAULTS.timing.longSessionMin * 60_000);
  send('PostToolUse', { tool_name: 'Read', tool_input: {} }); // still active
  heart.tick();
  assert.equal(events.filter(e => e.type === 'long_session').length, 1);
  heart.tick();
  assert.equal(events.filter(e => e.type === 'long_session').length, 1);
});

test('errorLine skips the generic exit-code line', () => {
  assert.equal(errorLine('Exit code 1\ncat: nope.txt: No such file'), 'cat: nope.txt: No such file');
  assert.equal(errorLine('boom'), 'boom');
});

test('streak then moving on to a passing finish -> proud, streak cleared', () => {
  const { heart, send } = setup();
  send('UserPromptSubmit', { prompt: 'x' });
  for (let i = 0; i < 3; i++) send('PostToolUseFailure', fail('node missing.js', 'Exit code 1\nCannot find module'));
  send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/proj/x/app.js' } });
  send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'node app.js' } });
  send('Stop', { last_assistant_message: 'ok' });
  assert.equal(heart.snapshot().state, 'proud');
  assert.equal(heart.snapshot().errorStreak, 0);
});

test('turn ending on the streaking error -> worried', () => {
  const { heart, send } = setup();
  send('UserPromptSubmit', { prompt: 'x' });
  for (let i = 0; i < 3; i++) send('PostToolUseFailure', fail('npm test', 'Exit code 1\nFAIL'));
  send('Stop', { last_assistant_message: 'still failing' });
  assert.equal(heart.snapshot().state, 'worried');
});

test('listeners see the post-event state', () => {
  const { heart, send } = setup();
  let seen = '';
  (heart as any).o.onEvent = (e: HeartEvent) => { if (e.type === 'turn_finished') seen = heart.snapshot().state; };
  send('UserPromptSubmit', { prompt: 'x' });
  send('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/a' } });
  send('Stop', { last_assistant_message: 'ok' });
  assert.equal(seen, 'proud');
});
