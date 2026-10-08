import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.ts';
import { initialSm, onEvent, onTick } from '../src/state.ts';

const t = DEFAULTS.timing;

test('turn lifecycle', () => {
  let sm = onEvent(initialSm(0), { type: 'prompt_submitted' }, 0, t);
  assert.equal(sm.state, 'thinking');
  sm = onEvent(sm, { type: 'tool_finished', success: true }, 1000, t);
  assert.equal(sm.state, 'working');
  sm = onTick(sm, 1000 + t.thinkingAfterSec * 1000 + 1, t);
  assert.equal(sm.state, 'thinking');
  sm = onEvent(sm, { type: 'approval_needed' }, 9000, t);
  assert.equal(sm.state, 'waiting_approval');
  sm = onEvent(sm, { type: 'turn_finished', mood: 'proud' }, 10_000, t);
  assert.equal(sm.state, 'proud');
  sm = onTick(sm, 10_000 + t.proudSec * 1000, t);
  assert.equal(sm.state, 'idle');
  sm = onTick(sm, 10_000 + t.sleepyAfterMin * 60_000 + 1, t);
  assert.equal(sm.state, 'sleepy');
});

test('worried holds through failures, clears on success', () => {
  let sm = onEvent(initialSm(0), { type: 'error_streak' }, 0, t);
  sm = onEvent(sm, { type: 'tool_finished', success: false }, 1, t);
  assert.equal(sm.state, 'worried');
  sm = onEvent(sm, { type: 'tool_finished', success: true }, 2, t);
  assert.equal(sm.state, 'working');
});

test('idle does not drift to thinking', () => {
  const sm = onTick(initialSm(0), 60_000, t);
  assert.equal(sm.state, 'idle');
});
