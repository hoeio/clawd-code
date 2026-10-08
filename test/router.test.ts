import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffRequest } from '../src/router.ts';

test('code-change requests become a terminal instruction', () => {
  for (const t of ['fix the login button', 'can you rename foo to bar', 'Please add a logo to the header', '로그인 버튼 고쳐줘', '헤더에 로고 추가해줘']) {
    assert.equal(handoffRequest(t), t, t);
  }
});

test('questions and chat are not requests', () => {
  for (const t of ['what did you change?', 'what changed', '뭐 바꿨어?', 'how is it going', 'thanks!', 'do you like music?', 'is the fix done?']) {
    assert.equal(handoffRequest(t), null, t);
  }
});
