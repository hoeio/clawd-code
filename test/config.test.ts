import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, merge } from '../src/config.ts';

test('user config merges over defaults; arrays replace, not merge', () => {
  const c = merge(DEFAULTS, { allowedHosts: ['clawd.example.com'], llm: { enabled: true } });
  assert.deepEqual(c.allowedHosts, ['clawd.example.com']);
  assert.equal(c.llm.enabled, true);
  assert.equal(c.llm.model, DEFAULTS.llm.model);
  assert.deepEqual(merge(DEFAULTS, { allowedHosts: 'oops' }).allowedHosts, []);
});
