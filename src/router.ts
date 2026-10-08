// Spots code-change requests in chat. Clawd can't change code; these get a copyable instruction
// for the terminal (or the handoff gate). Everything Clawd *says* comes from the brain.
import { clip } from './speech.ts';
import type { CharState } from './state.ts';

export interface Reply { text: string; copy?: string; emote?: CharState; handoffId?: string }

// "what did you change" is a question, not a request: checked first.
const QUESTION = /(뭐|뭘|무엇을?|어떤|어디).{0,6}(바꿨|고쳤|수정했|건드렸|만졌|손댔)|\bwhat (did|have) you (change|changed|edit|edited|touch|touched|modify|modified)\b|\bwhat changed\b/;
const REQUEST = /(고쳐|바꿔|추가해|지워|삭제해|수정해|만들어|구현해|넣어|빼)\s*(줘|줄래|주라|주세요|봐|보자)|^(please |pls |can you |could you )?(fix|change|add|remove|rename|refactor|update|implement|write|make|delete|create)\b|\b(can|could) you (please )?(fix|change|add|remove|rename|refactor|update|implement|write|make|delete|create)\b/;

/** The instruction to hand to the terminal, or null if this isn't a code-change request. */
export function handoffRequest(text: string): string | null {
  const t = text.trim().toLowerCase();
  return !QUESTION.test(t) && REQUEST.test(t) ? clip(text.trim(), 200) : null;
}
