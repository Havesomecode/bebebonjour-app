import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVoiceReady } from '../../src/delivery-loop/provider-transport.mjs';

const env = { BEBEBONJOUR_VOICE_WORKER_URL: 'http://tower.invalid', BEBEBONJOUR_VOICE_WORKER_TOKEN: 'token', BEBEBONJOUR_VOICE_WORKER_WAKE_MAC: '00:11:22:33:44:55' };
test('readiness is authenticated and requires a true response', async () => {
  for (const ready of [true, false]) assert.equal(await checkVoiceReady(env, async (url, opts) => {
    assert.equal(url, 'http://tower.invalid/ready'); assert.equal(opts.headers.authorization, 'Bearer token');
    return Response.json({ ready });
  }), ready);
});
test('connection failure wakes and returns false', async () => {
  let calls = 0;
  assert.equal(await checkVoiceReady(env, async () => { throw new TypeError('offline'); }, async () => { calls++; }), false);
  assert.equal(calls, 1);
});
