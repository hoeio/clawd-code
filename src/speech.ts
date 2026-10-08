// Speech planner: decides WHEN Clawd speaks and describes what just happened. The brain picks the words.
// If it can't (LLM off, over budget, or nothing worth saying), Clawd stays quiet and reacts with its body.
import path from 'node:path';
import type { HeartEvent, Snapshot } from './heart.ts';
import { parseMood, type Mood } from './mood.ts';
import type { CharState } from './state.ts';

/** Something that happened, told to the brain in first person. mustSpeak: SKIP isn't an option. */
export interface Moment { what: string; mustSpeak: boolean }

export interface SpeechOpts {
  cooldownSec: number; // min gap between normal-priority lines
  /** Ask the brain for a line about the moment and say it. Resolves to whether anything was said. */
  react: (m: Moment) => Promise<boolean>;
  /** A short body-language reaction. Works without any LLM. */
  emote: (s: CharState) => void;
  now?: () => number;
}

// Commands worth a prediction: tests, builds, type checks, linters.
const CHECK_CMD = /\b(test|tests|spec|pytest|jest|vitest|mocha|tsc|build|lint|check|cargo|go (test|build|vet)|make|gradle|mvn)\b/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export class SpeechPlanner {
  private lastSpokeAt = -Infinity;
  private failed = new Map<string, number>(); // session\0command -> consecutive failures (insertion order = recency)
  private prediction: { key: string } | null = null;
  private o: SpeechOpts;
  private now: () => number;

  constructor(o: SpeechOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** A chat reply counts as speaking: spontaneous lines wait out the cooldown after it. */
  noteSpoke() { this.lastSpokeAt = this.now(); }

  onEvent(ev: HeartEvent, snap: Snapshot): void {
    switch (ev.type) {
      case 'session_started':
        if (ev.source === 'startup' || ev.source === 'resume') this.speak(`A Claude Code session just ${ev.source === 'resume' ? 'resumed' : 'started'} in the project "${path.basename(snap.cwd)}".`, false);
        break;
      case 'approval_needed': this.speak('I am paused: the terminal needs the user to approve something before I can continue.', true, true); break;
      case 'error_streak': {
        const serious = ev.count >= 6;
        this.speak(`The same error has now happened ${ev.count} times in a row: ${clip(snap.lastError, 160)}${serious ? '. This is getting serious: no jokes, help them step back.' : ''}`, true, serious);
        break;
      }
      case 'late_night': this.speak(`It is ${ev.hour === 0 ? 12 : ev.hour} a.m. and the user is still working.`, true); break;
      case 'long_session': this.speak(`We have been working for ${Math.floor(ev.minutes / 60)} hours straight.`, true); break;
      case 'user_returned': this.speak(`The user just came back after ${ev.awayMin} minutes away.`, false); break;
      case 'prompt_submitted': this.prediction = null; break;
      case 'session_ended':
        for (const k of this.failed.keys()) if (k.startsWith(ev.sessionId + '\0')) this.failed.delete(k);
        break;
      case 'turn_finished': this.speak(turnMoment(snap), false); break;
      case 'tool_finished': this.trackPrediction(ev); break;
    }
  }

  /**
   * Predictions: after a check command fails and Claude then edits code, Clawd bets on the next run.
   * When that same command runs again, it gloats or apologizes. The body reacts even without words.
   */
  private trackPrediction(ev: Extract<HeartEvent, { type: 'tool_finished' }>) {
    if (ev.tool === 'Bash' && ev.command && CHECK_CMD.test(ev.command)) {
      const key = `${ev.sessionId}\0${ev.command}`;
      if (this.prediction?.key === key) {
        this.prediction = null;
        this.o.emote(ev.success ? 'proud' : 'worried');
        this.speak(ev.success
          ? `I predicted \`${clip(ev.command, 60)}\` would pass, and it just passed. Be a little smug.`
          : `I predicted \`${clip(ev.command, 60)}\` would pass, but it failed again. Own it and apologize briefly.`, true);
      }
      const n = this.failed.get(key) ?? 0;
      this.failed.delete(key);
      if (!ev.success) this.failed.set(key, n + 1);
      return;
    }
    if (EDIT_TOOLS.has(ev.tool) && ev.success && !this.prediction) {
      const mine = [...this.failed].filter(([k]) => k.startsWith(ev.sessionId + '\0'));
      if (!mine.length) return;
      const [key, failures] = mine[mine.length - 1];
      const cmd = key.slice(key.indexOf('\0') + 1);
      const said = this.speak(`I just edited code after \`${clip(cmd, 60)}\` failed ${failures === 1 ? 'once' : `${failures} times`}. Predict, lightly, that the next run passes${failures >= 2 ? ' (you are less sure now)' : ''}.`, false);
      if (!said) return;
      // Only counts as a prediction if Clawd actually said it.
      const p = { key };
      this.prediction = p;
      said.then(ok => { if (!ok && this.prediction === p) this.prediction = null; });
    }
  }

  /** urgent lines skip the cooldown. null: not attempted (cooldown). */
  private speak(what: string, urgent: boolean, mustSpeak = false): Promise<boolean> | null {
    const now = this.now();
    if (!urgent && now - this.lastSpokeAt < this.o.cooldownSec * 1000) return null;
    const before = this.lastSpokeAt;
    this.lastSpokeAt = now; // reserve now: the brain answers later
    return this.o.react({ what, mustSpeak }).then(ok => {
      if (!ok && this.lastSpokeAt === now) this.lastSpokeAt = before; // stayed quiet: give the slot back
      return ok;
    }, () => false);
  }
}

function turnMoment(snap: Snapshot): string {
  const how = snap.state === 'proud' ? ' It went well: I changed files and nothing is failing.'
    : snap.state === 'worried' ? ` Something is still failing: ${clip(snap.lastError, 120)}.` : '';
  const last = firstSentence(snap.lastMessage, 160);
  return `I just finished a turn in the terminal.${how}${last ? ` My final message there began: "${last}"` : ''}`;
}

export function firstSentence(s: string, max = 90): string {
  const first = s.replace(/[*`#>_]/g, '').split(/(?<=[.!?。])\s+|\n+/).map(x => x.trim()).find(Boolean) ?? '';
  return clip(first, max);
}

export const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);

/**
 * Cuts a streamed reply into phrases at natural pauses, so the voice can start on the first phrase
 * while the rest is still being written. A short first phrase starts the voice sooner.
 */
export class PhraseSplitter {
  private full = '';
  private sent = 0; // chars of `full` already emitted
  private tagDone = false; // the leading "[mood]" tag has been read (or there is none)
  /** The line's mood, from its leading tag. */
  mood?: Mood;
  /** Whether any text came in at all (adapters that don't stream deliver it all at the end). */
  received = false;
  private emit: (phrase: string, mood?: Mood) => void;
  private holdSkip: boolean;
  /** holdSkip: the reply may be just "SKIP"; never emit that. */
  constructor(emit: (phrase: string, mood?: Mood) => void, holdSkip = false) { this.emit = emit; this.holdSkip = holdSkip; }

  push(delta: string) {
    this.received = true;
    this.full += delta;
    if (!this.tagDone) {
      // Hold everything until the mood tag is complete: it sets how the first phrase sounds.
      const lead = this.full.trimStart();
      if (!lead) return;
      if (lead.startsWith('[') && !lead.includes(']') && lead.length < 20) return;
      const { mood, text } = parseMood(this.full);
      this.mood = mood;
      this.full = text;
      this.tagDone = true;
    }
    for (;;) {
      const pending = this.full.slice(this.sent);
      if (this.holdSkip && this.sent === 0 && /^[^a-z]*(s(k(i(p)?)?)?)?[^a-z]*$/i.test(pending)) return;
      const first = this.sent === 0;
      const min = first ? 12 : 24;
      // Pauses: punctuation; for the first phrase also just before a joining word, so the voice can start
      // on a short phrase even when the sentence has no early comma ("I'm feeling sharp | and content...").
      const cuts = [...pending.matchAll(/[,.;:!?—…](?=\s)/g)].map(m => m.index! + 1);
      if (first) cuts.push(...[...pending.matchAll(/\s(?=(and|but|so|because|though|while|which|when|since)\s)/gi)].map(m => m.index!));
      const cut = cuts.sort((a, b) => a - b).find(i => pending.slice(0, i).trim().length >= min);
      if (cut === undefined) return;
      this.emit(pending.slice(0, cut).trim(), this.mood);
      this.sent += cut;
    }
  }

  /** The reply as finally settled (maybe trimmed): say whatever of it hasn't been said. */
  end(final: string) {
    const said = this.full.slice(0, this.sent);
    const rest = final.startsWith(said) ? final.slice(this.sent).trim() : '';
    if (rest) this.emit(rest, this.mood);
    this.sent = this.full.length;
  }
}
