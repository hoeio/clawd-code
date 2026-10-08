// Heart: memory (3 layers) + derived events + state machine, per Claude Code session.
import fs from 'node:fs';
import path from 'node:path';
import type { Timing } from './config.ts';
import { normalize, type NormEvent } from './normalize.ts';
import { initialSm, onEvent, onTick, type CharState, type Sm, type SmEvent } from './state.ts';
import { TranscriptTail } from './transcript.ts';

export type DerivedEvent =
  | { type: 'error_streak'; sessionId: string; count: number; error: string }
  | { type: 'user_returned'; sessionId: string; awayMin: number }
  | { type: 'long_session'; sessionId: string; minutes: number }
  | { type: 'late_night'; sessionId: string; hour: number };
export type HeartEvent = NormEvent | DerivedEvent;

interface Session {
  id: string;
  cwd: string;
  startedAt: number;
  lastEventAt: number;
  task: string; // last user prompt
  files: string[]; // touched this session, most recent last
  lastPlan: string; // Claude's latest own words mid-turn (from transcript)
  lastMessage: string; // Claude's final message of the last turn
  lastError: string;
  edits: Map<string, string>; // file -> last text an edit put there (for snippets)
  errors: Map<string, { count: number; keys: Set<string> }>;
  turnEdits: number;
  lastToolFailed: boolean;
  longSessionsAnnounced: number;
  lateNightDay: string;
  tail?: TranscriptTail;
  sm: Sm;
}

export interface Snapshot {
  state: CharState;
  sessionId: string | null;
  cwd: string;
  task: string;
  files: string[];
  errorStreak: number;
  failing: boolean; // last tool failed, or a streak is still open
  lastPlan: string;
  lastMessage: string;
  lastError: string;
  sessionStartedAt: number | null;
  notesPath: string | null;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_FILES = 50;

export interface HeartOpts {
  timing: Timing;
  home: string; // ~/.clawd-companion
  now?: () => number;
  onChange?: (s: Snapshot) => void;
  onEvent?: (e: HeartEvent) => void;
}

export class Heart {
  private sessions = new Map<string, Session>();
  private focus: string | null = null; // most recently active session is the one on screen
  private now: () => number;

  private o: HeartOpts;
  constructor(o: HeartOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  ingest(raw: unknown): void {
    const ev = normalize(raw);
    if (!ev) return;
    const now = this.now();
    const s = this.session(ev, now);
    const derived: DerivedEvent[] = [];

    if (ev.type === 'prompt_submitted') {
      const away = now - s.lastEventAt;
      if (away >= this.o.timing.returnAfterMin * 60_000) derived.push({ type: 'user_returned', sessionId: s.id, awayMin: Math.round(away / 60_000) });
      const d = new Date(now);
      const day = d.toDateString();
      if (d.getHours() < 5 && s.lateNightDay !== day) {
        s.lateNightDay = day;
        derived.push({ type: 'late_night', sessionId: s.id, hour: d.getHours() });
      }
      s.task = ev.prompt;
      s.turnEdits = 0;
      s.lastToolFailed = false;
    }
    if (ev.type === 'tool_finished') {
      this.readTranscript(s);
      if (ev.file) s.files = [...s.files.filter(f => f !== ev.file), ev.file].slice(-MAX_FILES);
      if (ev.success && EDIT_TOOLS.has(ev.tool)) {
        s.turnEdits++;
        if (ev.file && ev.edit) {
          s.edits.delete(ev.file);
          s.edits.set(ev.file, ev.edit.slice(0, 2000));
          if (s.edits.size > 20) s.edits.delete(s.edits.keys().next().value!);
        }
      }
      s.lastToolFailed = !ev.success;
      if (!ev.success) s.lastError = errorLine(ev.error ?? '');
      const streak = trackError(s, ev);
      if (streak) derived.push({ type: 'error_streak', sessionId: s.id, ...streak });
    }
    if (ev.type === 'turn_finished') {
      this.readTranscript(s);
      s.lastMessage = ev.message;
      this.appendNote(s, ev.message);
    }
    s.lastEventAt = now;
    this.focus = s.id;

    // State first, then events: listeners (speech) see the post-event state.
    s.sm = onEvent(s.sm, smEvent(ev, s), now, this.o.timing);
    for (const d of derived) if (d.type === 'error_streak') s.sm = onEvent(s.sm, d, now, this.o.timing);
    // Claude moved on and ended the turn on a success: old error streaks are history.
    if (ev.type === 'turn_finished' && !s.lastToolFailed) s.errors.clear();
    this.o.onChange?.(this.snapshot());
    this.emit(ev);
    for (const d of derived) this.emit(d);
  }

  tick(): void {
    const now = this.now();
    let changed = false;
    for (const s of this.sessions.values()) {
      if (now - s.lastEventAt > 24 * 3600_000 && s.id !== this.focus) { this.sessions.delete(s.id); continue; }
      const before = s.sm.state;
      s.sm = onTick(s.sm, now, this.o.timing);
      if (s.sm.state !== before && s.id === this.focus) changed = true;
      const n = Math.floor((now - s.startedAt) / (this.o.timing.longSessionMin * 60_000));
      if (n > s.longSessionsAnnounced && s.sm.state !== 'sleepy') {
        s.longSessionsAnnounced = n;
        this.emit({ type: 'long_session', sessionId: s.id, minutes: Math.round((now - s.startedAt) / 60_000) });
      }
    }
    if (changed) this.o.onChange?.(this.snapshot());
  }

  snapshot(): Snapshot {
    const s = this.focus ? this.sessions.get(this.focus) : undefined;
    const errorStreak = s ? Math.max(0, ...[...s.errors.values()].map(e => e.count)) : 0;
    return {
      state: s?.sm.state ?? 'idle',
      sessionId: s?.id ?? null,
      cwd: s?.cwd ?? '',
      task: s?.task ?? '',
      files: s?.files ?? [],
      errorStreak,
      failing: !!s && (s.lastToolFailed || errorStreak > 0),
      lastPlan: s?.lastPlan ?? '',
      lastMessage: s?.lastMessage ?? '',
      lastError: s?.lastError ?? '',
      sessionStartedAt: s?.startedAt ?? null,
      notesPath: s ? this.notesPath(s.cwd) : null,
    };
  }

  /** Recent edits in the focused session, newest last: what changed where. */
  recentEdits(): { file: string; text: string }[] {
    const s = this.focus ? this.sessions.get(this.focus) : undefined;
    return s ? [...s.edits].map(([file, text]) => ({ file, text })) : [];
  }

  /** Layer 3: long-term notes, a Markdown file per project the user can edit. */
  notesPath(cwd: string): string {
    return path.join(this.o.home, 'notes', cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.md');
  }

  private session(ev: NormEvent, now: number): Session {
    let s = this.sessions.get(ev.sessionId);
    if (!s) {
      s = {
        id: ev.sessionId, cwd: ev.cwd, startedAt: now, lastEventAt: now, task: '', files: [], lastPlan: '', lastMessage: '', lastError: '',
        errors: new Map(), edits: new Map(), turnEdits: 0, lastToolFailed: false, longSessionsAnnounced: 0, lateNightDay: '', sm: initialSm(now),
      };
      this.sessions.set(s.id, s);
      this.ensureNotes(ev.cwd);
    }
    if (ev.transcriptPath && s.tail?.path !== ev.transcriptPath) s.tail = new TranscriptTail(ev.transcriptPath);
    return s;
  }

  private readTranscript(s: Session) {
    const texts = s.tail?.readNewTexts() ?? [];
    if (texts.length) s.lastPlan = texts[texts.length - 1];
  }

  private emit(e: HeartEvent) { this.o.onEvent?.(e); }

  /** Layer 2: Claude Code's own final message per turn, stored as-is. No summarizing. */
  private appendNote(s: Session, message: string) {
    if (!message) return;
    write(path.join(this.o.home, 'sessions', `${s.id}.jsonl`), JSON.stringify({ at: this.now(), cwd: s.cwd, prompt: s.task, message }) + '\n', true);
  }

  private ensureNotes(cwd: string) {
    if (!cwd) return;
    const p = this.notesPath(cwd);
    if (fs.existsSync(p)) return;
    write(p, `# ${path.basename(cwd)}\n\nProject: ${cwd}\n\n## Goals\n\n- \n\n## About me (preferences)\n\n- \n`, false);
  }
}

function write(file: string, data: string, append: boolean) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    (append ? fs.appendFileSync : fs.writeFileSync)(file, data);
  } catch {} // memory is best-effort; never crash the daemon over it
}

function smEvent(ev: NormEvent, s: Session): SmEvent {
  if (ev.type === 'tool_finished') return { type: 'tool_finished', success: ev.success };
  if (ev.type === 'turn_finished') {
    const streak = [...s.errors.values()].some(e => e.count >= 3);
    const mood = streak && s.lastToolFailed ? 'worried' : s.turnEdits > 0 && !s.lastToolFailed ? 'proud' : 'neutral';
    return { type: 'turn_finished', mood };
  }
  return { type: ev.type };
}

/**
 * Same error repeating = streak. Signature = tool + first meaningful error line, digits masked.
 * A success of the same tool on the same command/file clears the errors it had.
 * Fires at 3, 6, 9... of the same signature.
 */
function trackError(s: Session, ev: Extract<NormEvent, { type: 'tool_finished' }>): { count: number; error: string } | null {
  const key = ev.command ?? ev.file ?? '';
  if (ev.success) {
    for (const [sig, e] of s.errors) if (sig.startsWith(ev.tool + ':') && e.keys.has(key)) s.errors.delete(sig);
    return null;
  }
  const line = errorLine(ev.error ?? '');
  const sig = `${ev.tool}:${line.replace(/\d+/g, '#')}`;
  const e = s.errors.get(sig) ?? { count: 0, keys: new Set<string>() };
  e.count++;
  e.keys.add(key);
  s.errors.set(sig, e);
  return e.count % 3 === 0 ? { count: e.count, error: line } : null;
}

export function errorLine(error: string): string {
  const lines = error.split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.find(l => !/^exit code \d+$/i.test(l)) ?? lines[0] ?? '').slice(0, 200);
}
