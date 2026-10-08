import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.ts';

test('secrets are removed', () => {
  const cases = [
    'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'const apiKey = "hunter2hunter2"',
    'password: s3cretpass',
    'DATABASE_URL=postgres://u:p@h/db',
    'token a8f3k29dk3m1x9q0z8w7v6u5t4s3r2p1o0n',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  ];
  for (const c of cases) assert.match(redact(c), /\[REDACTED/, c);
  assert.ok(!redact('const apiKey = "hunter2hunter2"').includes('hunter2'));
});

test('ordinary code and paths survive', () => {
  const keep = [
    '/Users/me/Documents/project/clawd_code/src/components/CheckoutButton2.tsx',
    'function calculateTotalPriceWithDiscount(items) { return 1; }',
    'maxOutputTokens: 100',
    'expected 30, got 25',
  ];
  for (const k of keep) assert.equal(redact(k), k);
});
