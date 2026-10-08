import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snippetAround } from '../src/snippets.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-s-'));
const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
lines[19] = 'export const total = items.reduce((a, b) => a + b.price, 0);';
fs.writeFileSync(path.join(root, 'cart.ts'), lines.join('\n'));
fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\nexport const total');
fs.writeFileSync(path.join(os.tmpdir(), 'outside.ts'), 'export const total = 1');

test('returns a small window around the edit', () => {
  const s = snippetAround(root, path.join(root, 'cart.ts'), 'export const total = items.reduce((a, b) => a + b.price, 0);')!;
  assert.equal(s.file, 'cart.ts');
  assert.equal(s.startLine, 14);
  assert.ok(s.text.includes('reduce') && s.text.includes('line 14') && !s.text.includes('line 13\n'));
});

test('never reads .env, key files, or outside the root', () => {
  assert.equal(snippetAround(root, path.join(root, '.env'), 'export const total'), null);
  assert.equal(snippetAround(root, path.join(root, 'id_rsa'), 'x'), null);
  assert.equal(snippetAround(root, path.join(os.tmpdir(), 'outside.ts'), 'export const total'), null);
  assert.equal(snippetAround(root, '../outside.ts', 'export const total'), null);
});
