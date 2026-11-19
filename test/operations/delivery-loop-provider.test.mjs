import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authorizeProviderToken, performNarration } from '../../src/delivery-loop/provider-transport.mjs';

const token = 'loop-test-token-'.repeat(4);
const environment = { BEBEBONJOUR_DELIVERY_LOOP_TOKEN: token };

test('connection refusal wakes tower once and retries synthesis', async () => {
  const text = 'Bienvenue.';
  const frame = Buffer.alloc(384); frame.set([0xff, 0xf3, 0xc4, 0xc4]);
  let calls = 0; const wakes = [];
  const result = await performNarration({text, textDigest:createHash('sha256').update(text).digest('hex'), language:'fr', voice:'pere'}, {BEBEBONJOUR_VOICE_WORKER_URL:'http://example.invalid', BEBEBONJOUR_VOICE_WORKER_TOKEN:'offline', BEBEBONJOUR_VOICE_WORKER_WAKE_MAC:'30:56:0f:19:9c:25', BEBEBONJOUR_VOICE_WORKER_WAKE_DELAY_MS:'0'}, async () => { if (++calls === 1) throw new TypeError('fetch failed'); return new Response(frame); }, async (...args) => wakes.push(args));
  assert.equal(calls, 2); assert.deepEqual(wakes, [['30:56:0f:19:9c:25','192.168.1.255']]); assert.equal(result.provider, 'voxcpm');
});

test('provider authorization rejects wrong tokens without exposing a credential', () => {
  assert.doesNotThrow(() => authorizeProviderToken(token, environment));
  assert.throws(() => authorizeProviderToken('bad', environment), /provider_unauthorized/);
});
