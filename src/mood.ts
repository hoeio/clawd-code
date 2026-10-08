// Voice emotion. The LLM tags each line with a mood; the mood sets how it sounds.
// Kokoro can't act, so a mood is built from what it can do: speaking speed (Kokoro), plus a small
// pitch shift and loudness on playback (the page). Shared by the daemon and the page; no imports.

export const MOODS = {
  //        Kokoro speed   playback pitch/rate   loudness
  excited: { speed: 1.12, rate: 1.05, gain: 1 },
  cheerful: { speed: 1.05, rate: 1.02, gain: 1 },
  calm: { speed: 1, rate: 1, gain: 0.95 },
  soft: { speed: 0.92, rate: 0.98, gain: 0.8 },
  worried: { speed: 0.95, rate: 0.97, gain: 0.85 },
  sleepy: { speed: 0.86, rate: 0.94, gain: 0.75 },
} as const;

export type Mood = keyof typeof MOODS;
export const isMood = (m: unknown): m is Mood => typeof m === 'string' && Object.hasOwn(MOODS, m);

/** A leading "[mood]" tag: the mood (if it's one we know) and the text without the tag. Any other leading [tag] is dropped too, so it's never read aloud. */
export function parseMood(s: string): { mood?: Mood; text: string } {
  const m = s.match(/^\s*\[([a-z]+)\]\s*/i);
  if (!m) return { text: s };
  const mood = m[1].toLowerCase();
  return { mood: isMood(mood) ? mood : undefined, text: s.slice(m[0].length) };
}
