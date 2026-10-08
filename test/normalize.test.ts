import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';

const base = { session_id: 's1', cwd: '/p', transcript_path: '/t.jsonl' };

test('maps real payload shapes (docs/hook-events.md)', () => {
  assert.equal(normalize({ ...base, hook_event_name: 'SessionStart', source: 'startup' })?.type, 'session_started');
  assert.deepEqual(normalize({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/p/a.ts', content: 'x' }, tool_response: {} }),
    { sessionId: 's1', cwd: '/p', transcriptPath: '/t.jsonl', type: 'tool_finished', tool: 'Write', file: '/p/a.ts', command: undefined, edit: 'x', success: true });
  const fail = normalize({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'cat nope' }, error: 'Exit code 1\ncat: nope: No such file', is_interrupt: false });
  assert.equal(fail?.type === 'tool_finished' && fail.success, false);
  assert.equal(fail?.type === 'tool_finished' && fail.error, 'Exit code 1\ncat: nope: No such file');
  assert.equal(normalize({ ...base, hook_event_name: 'Stop', last_assistant_message: 'done' })?.type, 'turn_finished');
});

test('drops noise', () => {
  assert.equal(normalize({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null);
  assert.equal(normalize({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt' })?.type, 'approval_needed');
  assert.equal(normalize({ ...base, hook_event_name: 'PostToolUseFailure', is_interrupt: true }), null);
  assert.equal(normalize({ hook_event_name: 'Stop' }), null);
  assert.equal(normalize('garbage'), null);
});
