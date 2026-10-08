// Budget guard. Every LLM call goes through check() before and record() after. No exceptions.
// Prices come from the config pricing table only. Ledger persists in usage.json.
import fs from 'node:fs';
import path from 'node:path';

export interface Price { inputPerMTok: number; outputPerMTok: number }
export interface BudgetOpts {
  pricing: Record<string, Price>;
  softMonthlyUsd: number;
  hardMonthlyUsd: number;
  file: string; // usage.json
  now?: () => number;
}
export type Verdict = { ok: true; overSoft: boolean } | { ok: false; reason: 'no_price' | 'daily' | 'month' };
export interface BudgetStatus { monthUsd: number; todayUsd: number; softUsd: number; hardUsd: number; overSoft: boolean; allowanceLeftUsd: number }

interface Ledger { days: Record<string, number>; calls: number }

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class BudgetGuard {
  private o: BudgetOpts;
  private now: () => number;
  private ledger: Ledger = { days: {}, calls: 0 };

  constructor(o: BudgetOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
    try { this.ledger = { ...this.ledger, ...JSON.parse(fs.readFileSync(o.file, 'utf8')) }; } catch {}
  }

  /** null = unknown model: refuse rather than guess. Local Ollama is free. */
  price(model: string, provider: string): Price | null {
    if (provider === 'ollama') return { inputPerMTok: 0, outputPerMTok: 0 };
    return this.o.pricing[model] ?? null;
  }

  /** Worst case: the whole output cap gets used (thinking counts as output too). */
  estimate(p: Price, inputTokens: number, maxOutputTokens: number): number {
    return (inputTokens * p.inputPerMTok + maxOutputTokens * p.outputPerMTok) / 1e6;
  }

  check(price: Price | null, estUsd: number): Verdict {
    if (!price) return { ok: false, reason: 'no_price' };
    const { monthUsd, allowance } = this.month();
    if (monthUsd + estUsd > this.o.hardMonthlyUsd) return { ok: false, reason: 'month' };
    if (monthUsd + estUsd > allowance) return { ok: false, reason: 'daily' };
    return { ok: true, overSoft: monthUsd >= this.o.softMonthlyUsd };
  }

  /** Record actual usage reported by the provider. Returns the cost. */
  record(price: Price, inputTokens: number, outputTokens: number): number {
    const usd = (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1e6;
    const k = dayKey(this.now());
    this.ledger.days[k] = (this.ledger.days[k] ?? 0) + usd;
    this.ledger.calls++;
    // Keep ~3 months of history.
    const cutoff = dayKey(this.now() - 92 * 86_400_000);
    for (const d of Object.keys(this.ledger.days)) if (d < cutoff) delete this.ledger.days[d];
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      fs.writeFileSync(this.o.file, JSON.stringify(this.ledger, null, 2));
    } catch {}
    return usd;
  }

  status(): BudgetStatus {
    const { monthUsd, allowance } = this.month();
    return {
      monthUsd, todayUsd: this.ledger.days[dayKey(this.now())] ?? 0,
      softUsd: this.o.softMonthlyUsd, hardUsd: this.o.hardMonthlyUsd,
      overSoft: monthUsd >= this.o.softMonthlyUsd,
      allowanceLeftUsd: Math.max(0, Math.min(allowance, this.o.hardMonthlyUsd) - monthUsd),
    };
  }

  /**
   * Daily allowance = hard cap / 30, and unused allowance rolls over:
   * by day d of the month you may have spent at most hard * d / 30 in total.
   */
  private month() {
    const today = dayKey(this.now());
    const prefix = today.slice(0, 8); // YYYY-MM-
    let monthUsd = 0;
    for (const [d, usd] of Object.entries(this.ledger.days)) if (d.startsWith(prefix)) monthUsd += usd;
    const day = Number(today.slice(8));
    return { monthUsd, allowance: this.o.hardMonthlyUsd * Math.min(day, 30) / 30 };
  }
}

/** Conservative token estimate without a tokenizer: ~1 token per 3 UTF-8 bytes (Korean ≈ 1 per char). */
export const estimateTokens = (s: string) => Math.ceil(Buffer.byteLength(s, 'utf8') / 3);
