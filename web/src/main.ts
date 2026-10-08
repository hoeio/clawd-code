import { createClawd, type ClawdState } from './character/clawd.ts';
import { UI } from './i18n.ts';
import { MOODS, isMood, type Mood } from '../../src/mood.ts';

const $ = (id: string) => document.getElementById(id)!;
const token = new URLSearchParams(location.search).get('t') ?? '';
const input = $('msg') as HTMLInputElement;
const send = $('send') as HTMLButtonElement;
const stage = $('stage');
const clawd = createClawd(stage);
(window as any).clawd = clawd;

let current: ClawdState = 'idle';
let emoteTimer = 0;
const ui = (k: keyof (typeof UI)['en']) => UI.en[k];

// Voice. The daemon makes a WAV with the OS speech engine; we play it with Web Audio, which every
// browser has. Browsers keep sound locked until the first tap/key on the page, so we say so on the button.
// No engine on the daemon's machine -> the browser's own speech synthesis.
const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as any).webkitAudioContext;
const synth = window.speechSynthesis as SpeechSynthesis | undefined;
let voiceOn = !!(AC || synth);
try { voiceOn &&= localStorage.getItem('clawd-voice') !== 'off'; } catch {}
let ctx: AudioContext | null = null;
let unlocked = false;
let pending: { text: string; id: number; at: number; mood: Mood } | null = null; // last line said while sound was locked
let playing: AudioBufferSourceNode | null = null;
let speakId = 0;
try { (navigator as any).audioSession.type = 'playback'; } catch {} // iOS 17+: play even with the silent switch on

const voiceBtn = $('voice');
voiceBtn.hidden = !(AC || synth);
function showVoice() {
  voiceBtn.setAttribute('aria-pressed', String(voiceOn));
  voiceBtn.classList.toggle('locked', voiceOn && !unlocked);
  voiceBtn.textContent = ui(!voiceOn ? 'voiceOff' : unlocked ? 'voiceOn' : 'voiceLocked');
}

function unlock() {
  if (!voiceOn || unlocked) return;
  if (AC) {
    ctx ??= new AC();
    ctx.resume();
    // iOS Safari only unlocks after something actually plays inside the gesture.
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start();
  }
  synth?.speak(new SpeechSynthesisUtterance(' ')); // same rule for browser speech
  unlocked = true;
  showVoice();
  // A line said just before the tap: say it again, out loud this time.
  const p = pending;
  pending = null;
  if (p && Date.now() - p.at < 15_000) onPhrase(--replayId, p.text, p.text, p.mood);
}
for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, unlock, { capture: true });

voiceBtn.onclick = () => {
  voiceOn = !voiceOn;
  if (!voiceOn) stopVoice();
  else unlock();
  try { localStorage.setItem('clawd-voice', voiceOn ? 'on' : 'off'); } catch {}
  showVoice();
};

function stopVoice() {
  lineNo++; // drops whatever is still queued
  try { playing?.stop(); } catch {}
  playing = null;
  synth?.cancel();
}

// Lines arrive a phrase at a time while the LLM is still writing. Each phrase's audio is requested at
// once (the daemon is already making it), and phrases play back to back. The bubble waits for the voice:
// each phrase starts typing when its audio starts, at the audio's pace.
// The bubble is sized once for the whole line (no growing as phrases arrive), so the first phrase waits
// for the line's full text. It usually lands before the first phrase's audio is ready anyway.
const FULL_WAIT_MS = 1500;
const newLine = (id: number) => {
  let gotFull: (full: string) => void = () => {};
  const full = new Promise<string>(r => { gotFull = r; });
  return { id, chain: Promise.resolve(), started: false, full, gotFull };
};
let line = newLine(NaN);
let lineNo = 0;
let replayId = 0;
function onPhrase(id: number, text: string, full?: string, mood: Mood = 'calm') {
  if (id !== line.id) { stopVoice(); line = newLine(id); }
  const cur = line, my = lineNo;
  if (full) cur.gotFull(full);
  const sized = cur.started ? null : Promise.race([cur.full, new Promise<undefined>(r => setTimeout(r, FULL_WAIT_MS))]);
  const voiced = voiceOn && unlocked;
  if (voiceOn && !unlocked) pending = { text: (pending?.id === id ? pending.text + ' ' : '') + text, id, at: Date.now(), mood };
  const audio = voiced && ctx ? fetchAudio(text, mood).catch(() => null) : null; // starts now, while earlier phrases play
  let fullText: string | undefined;
  const show = (seconds?: number) => {
    if (cur.started) clawd.append(text, seconds);
    else { cur.started = true; clawd.say(text, seconds, fullText); }
  };
  cur.chain = cur.chain.then(async () => {
    if (my !== lineNo) return;
    fullText = (await sized) ?? undefined; // waits alongside the audio, not after it
    if (my !== lineNo) return;
    if (!voiced) return show();
    const buf = await audio;
    if (my !== lineNo) return;
    const { rate } = MOODS[mood];
    return buf ? play(buf, mood, () => show(buf.duration / rate)) : speakBrowser(text, mood, show, my);
  });
}

async function fetchAudio(text: string, mood: Mood): Promise<AudioBuffer | null> {
  const r = await fetch(`/tts?mood=${mood}&text=${encodeURIComponent(text)}&t=${encodeURIComponent(token)}`, { cache: 'no-store' });
  return r.ok ? ctx!.decodeAudioData(await r.arrayBuffer()) : null;
}

/** Plays one phrase in its mood (pitch and loudness); resolves when it ends (or is stopped). The real volume moves Clawd. */
async function play(buf: AudioBuffer, mood: Mood, onStart: () => void): Promise<void> {
  if (ctx!.state !== 'running') await ctx!.resume();
  const src = ctx!.createBufferSource();
  const an = ctx!.createAnalyser();
  const gain = ctx!.createGain();
  an.fftSize = 512;
  src.buffer = buf;
  src.playbackRate.value = MOODS[mood].rate; // a small pitch shift (it also changes the length a little)
  gain.gain.value = MOODS[mood].gain;
  src.connect(gain).connect(an).connect(ctx!.destination);
  playing = src;
  const ended = new Promise<void>(resolve => { src.onended = () => { if (playing === src) playing = null; resolve(); }; });
  onStart();
  src.start();
  const data = new Float32Array(an.fftSize);
  const beat = () => {
    if (playing !== src) return;
    an.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    clawd.setAmplitude(Math.min(1, Math.sqrt(sum / data.length) * 5));
    requestAnimationFrame(beat);
  };
  beat();
  return ended;
}

/** No audio from the daemon: the browser's own speech. It doesn't say how long it takes: ~15 chars/s. */
function speakBrowser(text: string, mood: Mood, show: (seconds?: number) => void, my: number): Promise<void> {
  if (!synth) { show(); return Promise.resolve(); }
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.voice = englishVoice();
    u.rate = MOODS[mood].speed;
    u.pitch = MOODS[mood].rate;
    u.volume = MOODS[mood].gain;
    u.onboundary = () => clawd.setAmplitude(0.6 + Math.random() * 0.4);
    let shown = false;
    const start = (voiced: boolean) => { if (!shown && my === lineNo) { shown = true; show(voiced ? text.length / (15 * MOODS[mood].speed) : undefined); } };
    u.onstart = () => start(true);
    u.onend = u.onerror = () => { start(false); resolve(); };
    setTimeout(() => start(false), 3000); // never started (blocked or no voices): text anyway
    setTimeout(resolve, 4000 + (text.length / 15) * 1000); // and never hold up the rest of the line
    synth.speak(u);
  });
}

// Browser fallback: pick an English voice explicitly; the default follows the OS language.
const NICE = /Samantha|Alex|Ava|Allison|Google US English|Aria|Jenny|Zira|Daniel|Karen/;
function englishVoice(): SpeechSynthesisVoice | null {
  const en = synth?.getVoices().filter(v => /^en[-_]/i.test(v.lang)) ?? [];
  return en.find(v => NICE.test(v.name)) ?? en.find(v => /^en[-_]US/i.test(v.lang) && v.default) ?? en[0] ?? null;
}

stage.setAttribute('aria-label', ui('stage'));
input.placeholder = ui('placeholder');
$('send').textContent = ui('send');
showVoice();
$('conn').textContent = ui('connecting');

interface Cost { enabled: boolean; talks: boolean; monthUsd: number; softUsd: number; hardUsd: number; overSoft: boolean; broken: string | null; model: string }

const es = new EventSource('/events?t=' + encodeURIComponent(token));
let live = false; // got anything over the event stream yet?
es.onopen = () => { $('conn').textContent = ''; };
// Tell a restarted daemon (new token: this link is dead) apart from one that is just off.
es.onerror = () => {
  fetch('/state?t=' + encodeURIComponent(token)).then(
    r => { $('conn').textContent = r.status === 401 ? ui('expired') : ui('disconnected'); if (r.status === 401) es.close(); },
    () => { $('conn').textContent = ui('disconnected'); },
  );
};
es.addEventListener('state', e => { live = true; onState(JSON.parse((e as MessageEvent).data)); });
es.addEventListener('say', e => onSay(JSON.parse((e as MessageEvent).data)));
es.addEventListener('cost', e => onCost(JSON.parse((e as MessageEvent).data)));

// Some proxies (TryCloudflare quick tunnels) never deliver event streams: fall back to polling.
setTimeout(() => { if (!live) startPolling(); }, 4000);

function startPolling() {
  es.close();
  let since = -1;
  const tick = async () => {
    try {
      const r = await fetch('/poll?since=' + since + '&t=' + encodeURIComponent(token), { cache: 'no-store' });
      if (r.status === 401) { $('conn').textContent = ui('expired'); return; } // dead link: stop polling
      const p = (await r.json()) as { id: number; state: { state: ClawdState }; cost: Cost; messages: { data: { id?: number; text: string; full?: string; emote?: ClawdState; mood?: string } }[] };
      $('conn').textContent = '';
      onState(p.state);
      onCost(p.cost);
      for (const m of p.messages) onSay(m.data);
      since = p.id;
    } catch {
      $('conn').textContent = ui('disconnected');
    }
    setTimeout(tick, 1500);
  };
  tick();
}

function onState(s: { state: ClawdState }) {
  current = s.state;
  if (!emoteTimer) clawd.setState(current);
}

// A short reaction (pride, apology) on top of whatever the session state is.
function showEmote(s: ClawdState) {
  clearTimeout(emoteTimer);
  clawd.setState(s);
  emoteTimer = window.setTimeout(() => { emoteTimer = 0; clawd.setState(current); }, 3500);
}

function onSay({ id, text, full, emote, mood }: { id?: number; text: string; full?: string; emote?: ClawdState; mood?: string }) {
  if (emote) showEmote(emote);
  if (full && id === line.id) line.gotFull(full);
  const m = isMood(mood) ? mood : undefined;
  if (text.trim()) id === undefined ? onPhrase(--replayId, text, text, m) : onPhrase(id, text, undefined, m);
}

// "This month's cost": only shown when LLM chat is enabled.
function onCost(c: Cost) {
  input.placeholder = ui(c.talks ? 'placeholder' : 'mute'); // no LLM, no words: say so here, not in Clawd's mouth
  const el = $('cost');
  el.hidden = !c.enabled;
  if (!c.enabled) return;
  el.classList.toggle('warn', c.overSoft || !!c.broken);
  el.textContent = c.broken ? ui('costOff') : `${ui('costMonth')} $${c.monthUsd.toFixed(c.monthUsd < 0.01 ? 4 : 2)} / $${c.hardUsd}`;
  el.title = c.broken ?? `${c.model} · soft $${c.softUsd} · hard $${c.hardUsd}`;
}

// Copy / handoff buttons for the latest reply only. The bubble is the conversation.
function setActions(opts: { copy?: string; handoffId?: string } = {}) {
  const box = $('actions');
  box.replaceChildren();
  if (opts.copy) {
    const copy = opts.copy;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ui('copy');
    b.onclick = () => navigator.clipboard.writeText(copy).then(() => { b.textContent = ui('copied'); });
    box.append(b);
  }
  if (opts.handoffId) {
    // Handoff gate: nothing goes to Claude Code until this is pressed.
    const id = opts.handoffId;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ui('handoff');
    b.onclick = async () => {
      b.disabled = true;
      try {
        const res = await fetch('/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clawd-Token': token }, body: JSON.stringify({ id }) });
        const { result } = (await res.json()) as { result: string };
        const done = result === 'queued' || result === 'duplicate';
        b.textContent = ui(done ? 'handoffQueued' : result === 'full' ? 'handoffBusy' : 'handoffStale');
        if (done) showEmote('proud');
        else b.disabled = result === 'unknown';
      } catch {
        $('conn').textContent = ui('chatError');
        b.disabled = false;
      }
    };
    box.append(b);
  }
}

$('chat').addEventListener('submit', async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  setActions();
  send.disabled = true;
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clawd-Token': token },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const r = (await res.json()) as { text: string; copy?: string; emote?: ClawdState; handoffId?: string };
    // The words already streamed in over the event stream; this is just the leftovers.
    if (r.emote || !r.text) showEmote(r.emote ?? 'thinking'); // no words: at least a "hmm"
    setActions({ copy: r.copy, handoffId: r.handoffId });
    $('conn').textContent = '';
  } catch {
    $('conn').textContent = ui('chatError');
  } finally {
    send.disabled = false;
    input.focus();
  }
});
