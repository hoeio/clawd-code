// Character state machine. Pure: (state, event, now) -> state. No LLM.
import type { Timing } from './config.ts';

export type CharState = 'idle' | 'working' | 'thinking' | 'waiting_approval' | 'proud' | 'worried' | 'sleepy';

export type SmEvent =
  | { type: 'session_started' | 'prompt_submitted' | 'approval_needed' | 'session_ended' | 'error_streak' }
  | { type: 'tool_finished'; success: boolean }
  | { type: 'turn_finished'; mood: 'proud' | 'worried' | 'neutral' };

export interface Sm {
  state: CharState;
  since: number;
  until?: number; // transient states fall back to idle after this
  turnActive: boolean;
  lastActivity: number;
}

export const initialSm = (now: number): Sm => ({ state: 'idle', since: now, turnActive: false, lastActivity: now });

const go = (sm: Sm, state: CharState, now: number, until?: number): Sm =>
  ({ ...sm, state, since: sm.state === state ? sm.since : now, until });

export function onEvent(sm: Sm, ev: SmEvent, now: number, t: Timing): Sm {
  sm = { ...sm, lastActivity: now };
  switch (ev.type) {
    case 'session_started': return go({ ...sm, turnActive: false }, 'idle', now);
    case 'prompt_submitted': return go({ ...sm, turnActive: true }, 'thinking', now);
    case 'approval_needed': return go(sm, 'waiting_approval', now);
    case 'error_streak': return go(sm, 'worried', now);
    // Stay worried through more failures; the first success clears it.
    case 'tool_finished': return sm.state === 'worried' && !ev.success ? sm : go({ ...sm, turnActive: true }, 'working', now);
    case 'turn_finished': {
      sm = { ...sm, turnActive: false };
      if (ev.mood === 'proud') return go(sm, 'proud', now, now + t.proudSec * 1000);
      if (ev.mood === 'worried') return go(sm, 'worried', now, now + t.worriedSec * 1000);
      return go(sm, 'idle', now);
    }
    case 'session_ended': return go({ ...sm, turnActive: false }, 'sleepy', now);
  }
}

export function onTick(sm: Sm, now: number, t: Timing): Sm {
  if (sm.state !== 'sleepy' && now - sm.lastActivity > t.sleepyAfterMin * 60_000) {
    // Also covers turns that never got a Stop (e.g. user interrupted).
    return go({ ...sm, turnActive: false }, 'sleepy', now);
  }
  if (sm.until !== undefined && now >= sm.until) return go(sm, 'idle', now);
  if (sm.turnActive && sm.state === 'working' && now - sm.lastActivity > t.thinkingAfterSec * 1000) return go(sm, 'thinking', now);
  return sm;
}
