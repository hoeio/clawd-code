// Strip secrets from anything before it leaves the machine for an LLM.

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED KEY]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'], // OpenAI / Anthropic style
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'], // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'], // Google API key
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED]'], // GitHub tokens
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'], // Slack
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED JWT]'],
  // key: value / key=value where the key name says it's secret
  [/\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"']{4,}\3/gi, '$1$2$3[REDACTED]$3'],
  // .env-style lines: FOO_BAR=value
  [/^([A-Z][A-Z0-9_]{2,})=(.+)$/gm, '$1=[REDACTED]'],
];

// Long random-looking strings (32+ chars, letters plus 3+ digits) are probably keys. No '/' so paths survive.
const LONG_RANDOM = /[A-Za-z0-9+_=-]{32,}/g;

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out.replace(LONG_RANDOM, m => ((m.match(/[0-9]/g)?.length ?? 0) >= 3 && /[A-Za-z]/.test(m) ? '[REDACTED]' : m));
}
