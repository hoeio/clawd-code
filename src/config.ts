import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.CLAWD_HOME ?? path.join(os.homedir(), '.clawd-companion');
export const homePath = (...p: string[]) => path.join(HOME, ...p);

export const DEFAULTS = {
  port: 47821,
  // Extra hostnames that reach the daemon through a reverse proxy/tunnel (e.g. Cloudflare Tunnel),
  // served over https. The per-run token still guards everything; put real auth (Cloudflare Access) in front.
  allowedHosts: [] as string[],
  debug: false, // true: append raw hook payloads to raw.jsonl
  autoOpen: true, // open the window when the daemon starts with a Claude Code session
  remote: false, // keep a TryCloudflare quick tunnel open for remote access (needs cloudflared)
  speech: {
    cooldownSec: 120, // min gap between spontaneous lines (urgent ones skip it)
  },
  // Kokoro: local neural voice, installed into ~/.clawd-companion/voice on first start (~400 MB).
  // Voices: af_heart, af_bella, af_nicole, am_michael, am_puck, bf_emma, bm_george, ...
  voice: { kokoro: true, name: 'af_heart' },
  llm: {
    enabled: false,
    provider: 'gemini', // gemini | anthropic | openai | ollama
    model: 'gemini-3.1-flash-lite',
    cheaperModel: '', // switched to after the soft cap, if set
    apiKeyEnv: 'CLAWD_LLM_API_KEY',
    baseUrl: '', // openai-compatible / ollama / proxies
    reasoningEffort: '', // openai-compatible only, sent if set
    maxOutputTokens: 60,
  },
  // $ per 1M tokens. Verified 2026-10-06 (docs/llm-providers.md). Calls to models not listed here are refused.
  pricing: {
    'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 },
    'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  } as Record<string, { inputPerMTok: number; outputPerMTok: number }>,
  budget: { softMonthlyUsd: 1, hardMonthlyUsd: 3 },
  // Approved chat instructions go to Claude Code via sync hooks. Run `init` again after changing this.
  handoff: { enabled: false },
  timing: {
    thinkingAfterSec: 4, // no tool activity mid-turn -> thinking
    sleepyAfterMin: 10, // no activity at all -> sleepy
    returnAfterMin: 15, // prompt after this gap -> user_returned
    longSessionMin: 120, // long_session every N minutes
    proudSec: 6,
    worriedSec: 10,
  },
};
export type Config = typeof DEFAULTS;
export type Timing = Config['timing'];

export function loadConfig(): Config {
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(homePath('config.json'), 'utf8')));
  } catch {
    return DEFAULTS;
  }
}

export function merge<T>(base: T, over: any): T {
  if (Array.isArray(base) || Array.isArray(over)) return Array.isArray(over) ? over as T : base;
  if (typeof base !== 'object' || base === null || typeof over !== 'object' || over === null) return over ?? base;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = k in out ? merge(out[k], over[k]) : over[k];
  return out;
}
