import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHooks, hookCommand, removeHooks, HOOK_EVENTS } from '../src/settings.ts';

const user = {
  model: 'sonnet',
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
};

test('add is idempotent and keeps user hooks; remove restores exactly', () => {
  const cmd = hookCommand("/opt/my pkg/it's/hook.sh");
  const once = addHooks(user, cmd);
  const twice = addHooks(once, cmd);
  assert.deepEqual(once, twice);
  for (const ev of HOOK_EVENTS) assert.ok(JSON.stringify(once.hooks[ev]).includes('clawd-companion'));
  assert.equal(once.hooks.Stop.length, 2);
  assert.deepEqual(removeHooks(once), user);
  assert.deepEqual(removeHooks(addHooks({}, cmd)), {});
});
