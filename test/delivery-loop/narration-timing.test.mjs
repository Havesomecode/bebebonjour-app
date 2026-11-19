import test from 'node:test';
import assert from 'node:assert/strict';
import { narratePhrases, parseMp3, splitNarrationPhrases } from '../../src/delivery-loop/narration-timing.mjs';

const frame = () => { const b = Buffer.alloc(384); Buffer.from([0xff, 0xf3, 0xc4, 0xc4]).copy(b); return b; };
test('phrase starts and total audio reflect real frame and pause counts', async () => {
  const text = 'one\ntwo\n\nthree';
  assert.deepEqual(splitNarrationPhrases(text).map(p => p.pauseAfterSeconds), [0.5, 1, 0]);
  const calls = [];
  const result = await narratePhrases({ text, language: 'fr', synthesize: async ({text: phrase}) => {
    calls.push(phrase); return Buffer.concat(Array.from({length: {one: 2, two: 3, three: 4}[phrase]}, frame));
  }});
  assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.deepEqual(result.phraseStarts, [0, 0.552, 1.632]);
  assert.equal(parseMp3(result.audio).frames, 72);
  assert.equal(parseMp3(result.audio).duration, 72 * 576 / 24000);
});
test('rejects malformed or incompatible audio', async () => {
  assert.throws(() => parseMp3(Buffer.alloc(0)), /narration_audio_invalid/);
  assert.throws(() => parseMp3(frame().subarray(0, 383)), /narration_audio_invalid/);
  const different = frame(); different[3] = 0;
  await assert.rejects(narratePhrases({text:'a\nb', language:'fr', synthesize: async ({text}) => text === 'a' ? frame() : different}), /narration_audio_invalid/);
});
