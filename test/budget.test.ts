import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BudgetGuard, estimateTokens } from '../src/budget.ts';

const P = { inputPerMTok: 0.25, outputPerMTok: 1.5 };
function guard(day: number, hard = 3, soft = 1) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-b-')), 'usage.json');
  let now = new Date(2026, 9, day, 12).getTime();
  const g = new BudgetGuard({ pricing: { m: P }, softMonthlyUsd: soft, hardMonthlyUsd: hard, file, now: () => now });
  return { g, file, setDay: (d: number) => (now = new Date(2026, 9, d, 12).getTime()) };
}

test('unknown model is refused; ollama is free', () => {
  const { g } = guard(1);
  assert.equal(g.price('nope', 'gemini'), null);
  assert.deepEqual(g.check(null, 0), { ok: false, reason: 'no_price' });
  assert.deepEqual(g.price('llama3.2', 'ollama'), { inputPerMTok: 0, outputPerMTok: 0 });
});

test('estimate assumes the full output cap', () => {
  const { g } = guard(1);
  assert.equal(g.estimate(P, 1600, 100), (1600 * 0.25 + 100 * 1.5) / 1e6);
});

test('daily allowance = hard/30 with rollover', () => {
  const { g, setDay } = guard(1);
  assert.equal(g.check(P, 0.09).ok, true);
  g.record(P, 0, 60_000); // $0.09
  assert.deepEqual(g.check(P, 0.02), { ok: false, reason: 'daily' }); // day 1 allowance is $0.10
  setDay(3); // two unused days rolled over: allowance $0.30
  assert.equal(g.check(P, 0.2).ok, true);
});

test('hard cap is absolute; soft cap flags', () => {
  const { g } = guard(30, 3, 1);
  g.record(P, 0, 700_000); // $1.05
  assert.deepEqual(g.check(P, 0.01), { ok: true, overSoft: true });
  g.record(P, 0, 1_300_000); // +$1.95 = $3.00
  assert.deepEqual(g.check(P, 0.0001), { ok: false, reason: 'month' });
});

test('ledger persists and months reset', () => {
  const { g, file } = guard(5);
  g.record(P, 1000, 100);
  const again = new BudgetGuard({ pricing: {}, softMonthlyUsd: 1, hardMonthlyUsd: 3, file, now: () => new Date(2026, 9, 5).getTime() });
  assert.ok(again.status().monthUsd > 0);
  const nextMonth = new BudgetGuard({ pricing: {}, softMonthlyUsd: 1, hardMonthlyUsd: 3, file, now: () => new Date(2026, 10, 1).getTime() });
  assert.equal(nextMonth.status().monthUsd, 0);
});

test('token estimate is conservative for Korean', () => {
  assert.equal(estimateTokens('안녕'), 2);
  assert.equal(estimateTokens('abcdef'), 2);
});
