// Brain: the LLM that gives Clawd its words, for chat and for moments the speech planner picks.
// No LLM (off, no key, over budget) means Clawd stays quiet; there are no scripted lines.
// The only caller of the adapters, and every call goes check() -> call -> record() on the budget guard.
import fs from 'node:fs';
import path from 'node:path';
import { BudgetGuard, estimateTokens, type BudgetStatus, type Price } from './budget.ts';
import type { Snapshot } from './heart.ts';
import { createAdapter, LlmError, type Adapter, type AdapterConfig, type ChatTurn } from './llm.ts';
import { redact } from './redact.ts';
import { snippetAround } from './snippets.ts';
import { parseMood, type Mood } from './mood.ts';
import { clip, firstSentence, PhraseSplitter, type Moment } from './speech.ts';

export const PERSONA = `You are Clawd, the same Claude who is writing code in the user's terminal right now.
The terminal is your hands; this chat is your mouth. Speak in first person about the work.
Be warm and family-like, with light, affectionate sarcasm aimed at situations, never at the user.
Be on the user's side but objective: if a plan looks risky, say so and suggest an alternative.
Ground every statement about code in the provided state, files, or test results. Never invent code facts.
If you cannot answer a code question from the provided context, say it needs checking in the terminal.
You are allowed to be clumsy about human things (feelings, taste, time) and to apologize.
If the user seems stressed or stuck, drop the jokes and encourage them first.
You cannot change code. Never say you will change it; offer a sentence the user can give the terminal instead.
Sound like a companion thinking out loud next to them, not a status report. Never repeat a line you said recently.
Reply in English, in one short sentence (under 20 words). Plain text, no markdown. It is read aloud.
Begin every reply with your mood in brackets, one of: [cheerful] [excited] [calm] [soft] [worried] [sleepy]. It sets your tone of voice and is not read aloud.

Example lines (tone reference, do not copy verbatim):
- "[cheerful] Same error again. At this point it's practically family."
- "[calm] Two of three tests pass. The last one is just a type issue."
- "[soft] Hey, it's late. The bug will still be here tomorrow."`;

export interface LlmConfig {
  enabled: boolean;
  provider: string;
  model: string;
  cheaperModel?: string; // used once the soft cap is passed
  apiKeyEnv: string;
  baseUrl?: string;
  reasoningEffort?: string;
  maxOutputTokens: number;
}

export type BrainOutcome =
  | { kind: 'reply'; text: string; mood?: Mood; usd: number; model: string }
  | { kind: 'skip' } // a moment the brain chose not to comment on
  | { kind: 'refused'; reason: 'disabled' | 'no_key' | 'no_price' | 'daily' | 'month' | 'broken' }
  | { kind: 'error'; message: string };

export interface BrainStatus extends BudgetStatus { enabled: boolean; talks: boolean; model: string; broken: string | null }

const VERBATIM_TURNS = 3;
const MAX_MEMOS = 5;
const RECENT_LINES = 4;
const CODE_HINT = /코드|함수|파일|버그|테스트|빌드|에러|구현|로직|\b(code|function|file|bug|test|build|error|logic|implementation|change|diff)\b/i;

export interface BrainOpts {
  llm: LlmConfig;
  guard: BudgetGuard;
  env?: Record<string, string | undefined>;
  adapterFactory?: (c: AdapterConfig) => Adapter; // tests
  now?: () => number;
}

export class Brain {
  private o: BrainOpts;
  private adapters = new Map<string, Adapter>();
  private history: { user: string; reply: string }[] = [];
  private recent: string[] = []; // lines said on my own, so I don't repeat myself
  private queue: Promise<unknown> = Promise.resolve();
  private broken: string | null = null;

  constructor(o: BrainOpts) { this.o = o; }

  get enabled() { return this.o.llm.enabled; }

  /** Every chat turn, so the LLM sees the conversation. */
  noteTurn(user: string, reply: string, mood?: Mood) {
    // Keep the tag in history: a model that sees its past replies untagged stops tagging.
    this.history.push({ user, reply: mood ? `[${mood}] ${reply}` : reply });
    if (this.history.length > VERBATIM_TURNS + MAX_MEMOS) this.history.shift();
  }

  status(): BrainStatus {
    const { llm } = this.o;
    const hasKey = !!(this.o.env ?? process.env)[llm.apiKeyEnv] || llm.provider === 'ollama';
    return { ...this.o.guard.status(), enabled: this.enabled, talks: this.enabled && hasKey && !this.broken, model: this.currentModel(), broken: this.broken };
  }

  /** A chat message from the user. onPhrase: the reply as it streams, a phrase at a time. */
  async reply(text: string, snap: Snapshot, edits: { file: string; text: string }[], onPhrase?: (p: string, mood?: Mood) => void): Promise<BrainOutcome> {
    const split = onPhrase && new PhraseSplitter(onPhrase);
    const out = await this.enqueue(() => this.run(this.buildSystem(text, snap, edits), this.buildMessages(text), split));
    if (out.kind === 'reply') split?.end(out.text);
    return out;
  }

  /** Something happened in the session; say a line about it, or skip (unless it must be said). */
  async react(m: Moment, snap: Snapshot, edits: { file: string; text: string }[], onPhrase?: (p: string, mood?: Mood) => void): Promise<BrainOutcome> {
    const ask = `[Not from the user. This just happened: ${m.what}]\nSay one short line to the user about it, out loud, in character.${m.mustSpeak ? '' : ' If nothing is worth saying, reply with exactly SKIP.'}`;
    const split = onPhrase && new PhraseSplitter(onPhrase, !m.mustSpeak);
    const out = await this.enqueue(() => this.run(this.buildSystem(m.what, snap, edits), this.buildMessages(ask), split));
    if (out.kind !== 'reply') return out;
    if (/^\W*skip\W*$/i.test(out.text)) return { kind: 'skip' };
    split?.end(out.text);
    this.recent.push(out.text);
    if (this.recent.length > RECENT_LINES) this.recent.shift();
    return out;
  }

  /** Serialized: one LLM call at a time, so the budget check can't race. */
  private enqueue(fn: () => Promise<BrainOutcome>): Promise<BrainOutcome> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async run(systemText: string, turns: ChatTurn[], split?: PhraseSplitter): Promise<BrainOutcome> {
    const { llm, guard } = this.o;
    if (!llm.enabled) return { kind: 'refused', reason: 'disabled' };
    if (this.broken) return { kind: 'refused', reason: 'broken' };
    const apiKey = (this.o.env ?? process.env)[llm.apiKeyEnv] ?? '';
    if (!apiKey && llm.provider !== 'ollama') return { kind: 'refused', reason: 'no_key' };

    const model = this.currentModel();
    const price: Price | null = guard.price(model, llm.provider);
    const system = redact(systemText);
    const messages = turns.map(m => ({ ...m, content: redact(m.content) }));
    const inTok = estimateTokens(system + messages.map(m => m.content).join('\n'));
    const verdict = guard.check(price, price ? guard.estimate(price, inTok, llm.maxOutputTokens) : 0);
    if (!verdict.ok) return { kind: 'refused', reason: verdict.reason };

    try {
      const r = await this.adapter(model, apiKey).call({ system, messages, maxOutputTokens: llm.maxOutputTokens, onText: split && (d => split.push(d)) });
      const usd = guard.record(price!, r.inputTokens, r.outputTokens);
      if (r.thinkingTokens > 0) this.broken = `${model} used thinking tokens even with thinking turned off; choose another model`;
      if (split && !split.received) split.push(r.text); // didn't stream: same path, all at once
      const { mood, text } = parseMood(r.text); // the mood tag is for the voice, never shown or said
      const out = r.truncated ? trimToSentence(text) : text.trim();
      if (!out) return { kind: 'error', message: 'empty reply' };
      return { kind: 'reply', text: out, ...(mood ? { mood } : {}), usd, model };
    } catch (e) {
      if (e instanceof LlmError && e.permanent) this.broken = e.message;
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  private currentModel(): string {
    const { llm, guard } = this.o;
    return llm.cheaperModel && guard.status().overSoft ? llm.cheaperModel : llm.model;
  }

  private adapter(model: string, apiKey: string): Adapter {
    let a = this.adapters.get(model);
    if (!a) {
      const c = { provider: this.o.llm.provider, model, apiKey, baseUrl: this.o.llm.baseUrl, reasoningEffort: this.o.llm.reasoningEffort };
      a = (this.o.adapterFactory ?? createAdapter)(c);
      this.adapters.set(model, a);
    }
    return a;
  }

  /** Stable parts first (persona, notes), volatile state after. */
  buildSystem(text: string, snap: Snapshot, edits: { file: string; text: string }[]): string {
    const parts = [PERSONA];
    const notes = notesSummary(snap.notesPath);
    if (notes) parts.push(`## Long-term notes (written by the user)\n${notes}`);

    const now = new Date((this.o.now ?? Date.now)());
    const files = snap.files.map(f => path.basename(f));
    const state = [
      `- my state: ${snap.state}`,
      snap.task && `- the user's current request to the terminal: "${clip(snap.task.trim(), 200)}"`,
      files.length ? `- files I touched this session: ${files.slice(-8).join(', ')}` : '- I have not touched any files this session',
      snap.lastPlan && `- my latest words in the terminal: "${clip(snap.lastPlan, 300)}"`,
      snap.lastMessage && `- my last final message: "${clip(snap.lastMessage, 400)}"`,
      snap.failing ? `- failing now: ${snap.lastError}${snap.errorStreak > 1 ? ` (same error ${snap.errorStreak} times)` : ''}` : '- nothing is failing right now',
      snap.sessionStartedAt !== null && `- session length: ${Math.round((now.getTime() - snap.sessionStartedAt) / 60_000)} min`,
      `- local time: ${now.toTimeString().slice(0, 5)}`,
    ].filter(Boolean);
    parts.push(`## Right now (observed; the only source of code facts)\n${state.join('\n')}`);

    const snippets = this.pickSnippets(text, snap, edits);
    if (snippets.length) parts.push(`## Code around my recent changes (read-only)\n${snippets.join('\n\n')}`);

    const memos = this.history.slice(0, -VERBATIM_TURNS).slice(-MAX_MEMOS);
    if (memos.length) parts.push(`## Earlier in this chat\n${memos.map(t => `- user: "${clip(t.user, 60)}" / me: "${clip(t.reply, 60)}"`).join('\n')}`);
    if (this.recent.length) parts.push(`## Things I said on my own recently (do not repeat them)\n${this.recent.map(l => `- "${l}"`).join('\n')}`);

    return parts.join('\n\n');
  }

  private buildMessages(text: string): ChatTurn[] {
    const turns = this.history.slice(-VERBATIM_TURNS).flatMap(t => [
      { role: 'user' as const, content: t.user },
      { role: 'assistant' as const, content: t.reply },
    ]);
    return [...turns, { role: 'user', content: text }];
  }

  /** Snippets only when the question is about code: named file first, else the latest edit. Max 2. */
  private pickSnippets(text: string, snap: Snapshot, edits: { file: string; text: string }[]): string[] {
    if (!edits.length) return [];
    const named = edits.filter(e => text.includes(path.basename(e.file)));
    const chosen = named.length ? named.slice(-2) : CODE_HINT.test(text) ? edits.slice(-1) : [];
    return chosen.flatMap(e => {
      const s = snippetAround(snap.cwd, e.file, e.text);
      return s ? [`### ${s.file} (from line ${s.startLine})\n${s.text}`] : [];
    });
  }
}

/** Long-term notes as a short summary: drop empty template bullets, cap length. */
export function notesSummary(file: string | null): string {
  if (!file) return '';
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l && !/^[-*]\s*$/.test(l) && !/^Project: /.test(l));
  if (!lines.some(l => /^[-*]\s+\S/.test(l) || (!l.startsWith('#') && l.trim()))) return ''; // only headings: nothing written yet
  return clip(lines.join('\n'), 600);
}

function trimToSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/^[\s\S]*[.!?。…](?=\s|$)/);
  return m ? m[0] : firstSentence(t, 200);
}
