import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemSynthesize as synthesize, ttsAvailable, Voice } from '../src/tts.ts';

test('speech engine turns text into a WAV (text with quotes/dashes stays text)', { skip: !ttsAvailable() && 'no speech engine on this machine' }, async () => {
  const wav = await synthesize(`-v "it's" $(echo hi) done`);
  assert.ok(wav);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
});

// Kokoro failing falls back to the OS voice silently, so check the audio really is Kokoro's (24 kHz).
const kokoroDir = path.join(os.homedir(), '.clawd-companion', 'voice');
const hasKokoro = fs.existsSync(path.join(kokoroDir, 'node_modules', 'kokoro-js'));
test('Kokoro speaks (not the fallback), from any working directory', { skip: !hasKokoro && 'Kokoro not installed', timeout: 60_000 }, async () => {
  const cwd = process.cwd();
  process.chdir(os.tmpdir()); // it once looked for its voice files relative to the cwd
  const logs: unknown[][] = [];
  const voice = new Voice({ dir: kokoroDir, kokoro: true, name: 'af_heart', log: (...a) => logs.push(a) });
  try {
    voice.start();
    while (!logs.some(l => String(l[0]).includes('ready'))) {
      assert.ok(!logs.some(l => /failed|crashed/.test(String(l[0]))), JSON.stringify(logs));
      await new Promise(r => setTimeout(r, 200));
    }
    const wav = await voice.synthesize('Two of three tests pass.');
    assert.ok(wav);
    let i = 12;
    while (wav.subarray(i, i + 4).toString() !== 'fmt ') i += 8 + wav.readUInt32LE(i + 4);
    assert.equal(wav.readUInt32LE(i + 12), 24000);
    assert.ok(!logs.some(l => String(l[0]).includes('error')), JSON.stringify(logs));
    // Mood sets Kokoro's speed: the same line is shorter excited than sleepy.
    const len = (w: Buffer) => w.length;
    const fast = await voice.synthesize('This run should pass, probably.', 'excited');
    const slow = await voice.synthesize('This run should pass, probably.', 'sleepy');
    assert.ok(fast && slow && len(slow) > len(fast) * 1.15, `${fast?.length} vs ${slow?.length}`);
  } finally { voice.stop(); process.chdir(cwd); }
});
