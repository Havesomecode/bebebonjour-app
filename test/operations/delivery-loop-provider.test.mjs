import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performNarration, authorizeProviderToken } from '../../src/delivery-loop/provider-transport.mjs';

const token = 'loop-test-token-'.repeat(4);
const environment = { BEBEBONJOUR_DELIVERY_LOOP_TOKEN: token, OPENAI_API_KEY: 'sk-test-only' };

test('provider authorization rejects wrong tokens without exposing a credential', () => {
  assert.doesNotThrow(() => authorizeProviderToken(token, environment));
  assert.throws(() => authorizeProviderToken('bad', environment), /provider_unauthorized/);
});

test('narration uses Cedar and preserves exact text with durable audio digest', async () => {
  const text = 'Bienvenue, Mila.';
  const textDigest = createHash('sha256').update(text).digest('hex');
  const audio = Buffer.alloc(1024, 4);
  const result = await performNarration({ text, textDigest, language: 'fr' }, environment, async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/speech');
    const payload = JSON.parse(request.body);
    assert.equal(payload.input, text);
    assert.equal(payload.voice, 'cedar');
    assert.equal(payload.model, 'gpt-4o-mini-tts');
    return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
  });
  assert.equal(result.audioDigest, createHash('sha256').update(audio).digest('hex'));
  assert.equal(result.textDigest, textDigest);
  await assert.rejects(() => performNarration({ text, textDigest: 'bad', language: 'fr' }, environment), /narration_input_invalid/);
});
