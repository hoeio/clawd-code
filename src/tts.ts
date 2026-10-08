// Voice made on this machine, so every browser can just play a WAV.
// Kokoro (local neural voice, free, offline) once installed; until then, or if it fails, the OS engine:
// macOS say, Linux espeak-ng / espeak, Windows SAPI. None at all -> null (browser speech fallback).
// Always an English voice: the OS default follows the system language (a Korean Mac reads English in a Korean voice).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { MOODS, type Mood } from './mood.ts';

type Engine = { cmd: string; args: (out: string) => string[] };

// Natural voices first; macOS also ships novelty en_US voices (Bahh, Bells, Boing...) that must never win.
const MAC_VOICES = ['Samantha', 'Alex', 'Ava', 'Allison', 'Tom', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Fred'];
let macVoice: string | undefined;
function pickMacVoice(): string {
  if (macVoice !== undefined) return macVoice;
  const installed = new Set(spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout.split('\n').map(l => l.split(/\s{2,}/)[0].trim()));
  return (macVoice = MAC_VOICES.find(v => installed.has(v)) ?? 'Samantha');
}

const ENGINES: Engine[] =
  process.platform === 'darwin' ? [{ cmd: 'say', args: out => ['-v', pickMacVoice(), '-f', '-', '-o', out, '--data-format=LEI16@22050'] }]
  : process.platform === 'win32' ? [{
      cmd: 'powershell',
      args: out => ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoiceByHints('NotSet', 'NotSet', 0, [Globalization.CultureInfo]'en-US') } catch {}; $s.SetOutputToWaveFile('${out}'); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`],
    }]
  : ['espeak-ng', 'espeak'].map(cmd => ({ cmd, args: (out: string) => ['--stdin', '-w', out, '-v', 'en-us'] }));

let engine: Engine | null | undefined;
function findEngine(): Engine | null {
  if (engine !== undefined) return engine;
  const which = process.platform === 'win32' ? 'where' : 'which';
  return (engine = ENGINES.find(e => spawnSync(which, [e.cmd], { stdio: 'ignore' }).status === 0) ?? null);
}

export const ttsAvailable = () => !!findEngine();

/** OS engine: WAV bytes for text, or null. Text goes in on stdin, never as an argument. */
export function systemSynthesize(text: string): Promise<Buffer | null> {
  const e = findEngine();
  if (!e) return Promise.resolve(null);
  const out = path.join(os.tmpdir(), `clawd-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  return new Promise(resolve => {
    const p = spawn(e.cmd, e.args(out), { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => p.kill(), 15_000);
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', code => {
      clearTimeout(timer);
      fs.readFile(out, (err, buf) => {
        fs.rm(out, { force: true }, () => {});
        resolve(code === 0 && !err && buf.length > 44 ? buf : null);
      });
    });
    p.stdin.end(text);
  });
}

// --- Kokoro ---
const KOKORO_PKG = 'kokoro-js@1.2.1';
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Runs in a worker thread: model load (~7 s) and generation (~1 s/line) must never block hook requests.
// A real ES module file, not eval'd code: kokoro-js finds its voice files via __dirname when that exists,
// and in an eval worker it does (as "."), which sends it looking in the wrong folder.
const WORKER = `
import { parentPort, workerData } from 'node:worker_threads';
(async () => {
  const { KokoroTTS } = await import(workerData.entry);
  const tts = await KokoroTTS.from_pretrained(workerData.model, { dtype: 'q8', device: 'cpu' });
  parentPort.postMessage({ ready: true });
  parentPort.on('message', async ({ id, text, voice, speed }) => {
    try {
      const audio = await tts.generate(text, { voice, speed });
      parentPort.postMessage({ id, wav: new Uint8Array(audio.toWav()) });
    } catch (e) { parentPort.postMessage({ id, error: String(e) }); }
  });
})().catch(e => parentPort.postMessage({ fatal: String(e) }));
`;

export interface VoiceOpts {
  dir: string; // where kokoro-js gets installed (~/.clawd-companion/voice)
  kokoro: boolean;
  name: string; // Kokoro voice id, e.g. af_heart
  log: (...a: unknown[]) => void;
}

export class Voice {
  private worker: Worker | null = null;
  private ready = false;
  private seq = 0;
  private waiting = new Map<number, (wav: Buffer | null) => void>();
  private made = new Map<string, Promise<Buffer | null>>(); // started ahead of the page asking for them
  private o: VoiceOpts;
  constructor(o: VoiceOpts) { this.o = o; }

  /** Install Kokoro if needed and load it, in the background. Speech works (OS voice) meanwhile. */
  start() {
    if (!this.o.kokoro) return;
    const entry = path.join(this.o.dir, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js');
    if (fs.existsSync(entry)) return this.load(entry);
    this.o.log('voice: installing Kokoro (one time, ~400 MB)');
    fs.mkdirSync(this.o.dir, { recursive: true });
    const npm = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const p = spawn(fs.existsSync(npm) ? npm : 'npm', ['install', '--prefix', this.o.dir, '--no-audit', '--no-fund', KOKORO_PKG], {
      stdio: 'ignore', shell: process.platform === 'win32', // .cmd needs a shell; the arguments are fixed strings
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    p.on('error', e => this.o.log('voice: Kokoro install failed:', e.message));
    p.on('close', code => {
      if (code === 0 && fs.existsSync(entry)) this.load(entry);
      else this.o.log('voice: Kokoro install failed, exit', code);
    });
  }

  private load(entry: string) {
    const file = path.join(this.o.dir, 'worker.mjs');
    fs.writeFileSync(file, WORKER); // rewritten each start, so it always matches this daemon
    const w = new Worker(file, { workerData: { entry: pathToFileURL(entry).href, model: KOKORO_MODEL } });
    w.unref();
    w.on('message', (m: { ready?: true; fatal?: string; id?: number; wav?: Uint8Array; error?: string }) => {
      if (m.ready) { this.ready = true; this.o.log('voice: Kokoro ready'); }
      if (m.fatal) { this.o.log('voice: Kokoro failed to load:', m.fatal); this.stop(); }
      if (m.id !== undefined) {
        this.waiting.get(m.id)?.(m.wav ? Buffer.from(m.wav) : null);
        this.waiting.delete(m.id);
        if (m.error) this.o.log('voice: Kokoro error:', m.error);
      }
    });
    w.on('error', e => { this.o.log('voice: Kokoro worker crashed:', e.message); this.stop(); });
    this.worker = w;
  }

  /** Shuts Kokoro down (the native runtime keeps the thread alive otherwise). */
  stop() {
    this.ready = false;
    this.worker?.terminate();
    this.worker = null;
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }

  /** Start making the audio now, so the page's request for the same text finds it ready (or nearly). */
  prepare(text: string, mood: Mood = 'calm') {
    const key = `${mood}\0${text}`;
    if (this.made.has(key)) return;
    this.made.set(key, this.make(text, mood));
    if (this.made.size > 30) this.made.delete(this.made.keys().next().value!);
  }

  /** WAV for text in a mood: prepared audio if there is some, else made now. */
  synthesize(text: string, mood: Mood = 'calm'): Promise<Buffer | null> {
    return this.made.get(`${mood}\0${text}`) ?? this.make(text, mood);
  }

  /** Kokoro when ready (at the mood's speed), else the OS voice (the page still shifts pitch and loudness). */
  private async make(text: string, mood: Mood): Promise<Buffer | null> {
    if (this.ready && this.worker) {
      const id = ++this.seq;
      const wav = await new Promise<Buffer | null>(resolve => {
        this.waiting.set(id, resolve);
        this.worker!.postMessage({ id, text, voice: this.o.name, speed: MOODS[mood].speed });
        setTimeout(() => { if (this.waiting.delete(id)) resolve(null); }, 20_000).unref();
      });
      if (wav) return wav;
    }
    return systemSynthesize(text);
  }
}
