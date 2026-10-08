// Read-only file access for the brain: small snippets around regions Claude Code changed.
// Scoped to the project root; never .env or key files. Never writes.
import fs from 'node:fs';
import path from 'node:path';

const BLOCKED = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)[^/]*|\.npmrc|\.netrc|credentials[^/]*|secrets?[^/]*)$/i;
const CONTEXT_LINES = 6;
const MAX_CHARS = 1200;

export interface Snippet { file: string; startLine: number; text: string }

/** Returns null if the file is outside the root, blocked, unreadable, or the edit isn't there anymore. */
export function snippetAround(root: string, file: string, editText: string): Snippet | null {
  if (!root || BLOCKED.test(file)) return null;
  let real: string, realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.resolve(root, file));
  } catch { return null; }
  const rel = path.relative(realRoot, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || BLOCKED.test(real)) return null;

  let content: string;
  try {
    if (fs.statSync(real).size > 1_000_000) return null;
    content = fs.readFileSync(real, 'utf8');
  } catch { return null; }

  // Find the edit by its first non-empty line (whole-text match breaks on small later edits).
  const needle = editText.split('\n').map(l => l.trim()).find(l => l.length >= 4);
  if (!needle) return null;
  const lines = content.split('\n');
  const hit = lines.findIndex(l => l.includes(needle));
  if (hit < 0) return null;
  const editLines = editText.split('\n').length;
  const start = Math.max(0, hit - CONTEXT_LINES);
  const end = Math.min(lines.length, hit + editLines + CONTEXT_LINES);
  let text = lines.slice(start, end).join('\n');
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n…';
  return { file: rel, startLine: start + 1, text };
}
