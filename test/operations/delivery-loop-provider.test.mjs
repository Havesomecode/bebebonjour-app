import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performNarration, performEmail, authorizeProviderToken } from '../../src/delivery-loop/provider-transport.mjs';

const token = 'loop-test-token-'.repeat(4);
const environment = { BEBEBONJOUR_DELIVERY_LOOP_TOKEN: token, OPENAI_API_KEY: 'sk-test-only', RESEND_API_KEY: 're_test_only' };

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

test('email sends one fixed idempotency identity and requires a provider receipt', async () => {
  const payload = { to: 'family@example.com', subject: 'Mila — votre annonce', text: 'Une version prête.',
    html: '<p>Une version prête.</p>', idempotencyKey: 'bebe-loop:job_test_1:1:draft_email' };
  let calls = 0;
  const receipt = await performEmail(payload, environment, async (url, request) => {
    calls += 1;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(request.headers['idempotency-key'], payload.idempotencyKey);
    assert.deepEqual(JSON.parse(request.body).to, [payload.to]);
    return Response.json({ id: 'message_test_123' });
  });
  assert.equal(calls, 1);
  assert.equal(receipt.providerMessageId, 'message_test_123');
  await assert.rejects(() => performEmail({ ...payload, idempotencyKey: 'arbitrary' }, environment), /email_input_invalid/);
});

test('provider transport reports failures without fake success or printing private provider bodies', async () => {
  const payload = { to: 'family@example.com', subject: 'Annonce', text: 'Texte', html: '<p>Texte</p>',
    idempotencyKey: 'bebe-loop:job_test_1:2:final_email' };
  await assert.rejects(() => performEmail(payload, environment, async () => new Response('private body', { status: 401 })),
    /^Error: email_provider_http_401$/);
});
