import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOODS, parseMood } from '../src/mood.ts';

test('parseMood', () => {
  assert.deepEqual(parseMood('[Soft] Hey, it is late.'), { mood: 'soft', text: 'Hey, it is late.' });
  assert.deepEqual(parseMood('[sighs] Fine.'), { mood: undefined, text: 'Fine.' });
  assert.deepEqual(parseMood('Fine [calm].'), { text: 'Fine [calm].' }); // only a leading tag
});

test('moods stay subtle enough to sound natural', () => {
  for (const [name, m] of Object.entries(MOODS)) {
    assert.ok(m.speed >= 0.8 && m.speed <= 1.2, name);
    assert.ok(m.rate >= 0.92 && m.rate <= 1.08, name); // pitch shift beyond ~8% starts to sound like a chipmunk
    assert.ok(m.gain > 0.5 && m.gain <= 1, name);
  }
});
