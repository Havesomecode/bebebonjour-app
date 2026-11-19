import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performNarration } from '../../src/delivery-loop/provider-transport.mjs';
const environment = { BEBEBONJOUR_VOICE_WORKER_URL: 'https://voice.example.invalid', BEBEBONJOUR_VOICE_WORKER_TOKEN: 'offline-token' };
const sha = text => createHash('sha256').update(text).digest('hex');
test('voice server structurally gates GPU readiness and serializes lazy lifecycle', async () => {
  const source = await readFile(new URL('../../voice-worker/server.py', import.meta.url), 'utf8');
  assert.match(source, /device=DEVICE/);
  assert.match(source, /inference\.submit\(queued_speak, request\)/);
  assert.match(source, /inference\.submit\(unload_if_idle\)/);
  assert.doesNotMatch(source, /inference\.submit\(load\)/);
  assert.match(source, /if self\.path == "\/ready":[\s\S]*?if not self\.authorized\(\)/);
  assert.match(source, /nvidia-smi.*utilization\.gpu,memory\.free,memory\.total/);
  assert.match(source, /torch\.cuda\.reset_peak_memory_stats\(\)/);
  assert.match(source, /torch\.cuda\.empty_cache\(\)/);
});

test('worker receives phrases sequentially with selected voice and language', async () => {
  const text = 'Bienvenue.\nMila.'; const calls = []; let active = 0;
  const frame = Buffer.alloc(384); frame.set([0xff, 0xf3, 0xc4, 0xc4]);
  const receipt = await performNarration({ text, textDigest: sha(text), language: 'fr', voice: 'mere' }, environment, async (url, request) => {
    assert.equal(++active, 1); assert.equal(url, 'https://voice.example.invalid/speak');
    assert.equal(request.method, 'POST'); assert.equal(request.headers.authorization, 'Bearer offline-token');
    assert.ok(request.signal instanceof AbortSignal); calls.push(JSON.parse(request.body));
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return new Response(frame);
  });
  assert.deepEqual(calls, [{voice:'mere',language:'fr',text:'Bienvenue.'},{voice:'mere',language:'fr',text:'Mila.'}]);
  assert.equal(receipt.provider, 'voxcpm'); assert.equal(receipt.model, 'openbmb/VoxCPM2@7936080b'); assert.equal(receipt.voice, 'mere');
  assert.equal(receipt.textDigest, sha(text)); assert.equal(receipt.phraseStarts.length, 2); assert.equal(receipt.phraseStarts[0], 0); assert.ok(receipt.phraseStarts[1] > 0);
  await assert.rejects(() => performNarration({text,textDigest:sha(text),language:'fr',voice:'x'},environment), /narration_input_invalid/);
});
test('worker configuration is required before fetch', async () => {
  const args = {text:'Bonjour.',textDigest:sha('Bonjour.'),language:'fr',voice:'pere'};
  for (const key of ['BEBEBONJOUR_VOICE_WORKER_URL','BEBEBONJOUR_VOICE_WORKER_TOKEN']) {
    const env = {...environment}; delete env[key];
    await assert.rejects(() => performNarration(args,env,() => { throw Error('unexpected_fetch'); }), new RegExp(`${key}_not_configured`));
  }
});

test('a waking worker (502/503 or refused connection) is retried', async () => {
  const frame = Buffer.alloc(384); frame.set([0xff, 0xf3, 0xc4, 0xc4]);
  const replies = [() => { throw new TypeError('fetch failed'); }, () => new Response('', {status:502}), () => new Response('', {status:503}), () => new Response(frame)];
  const receipt = await performNarration({text:'Bonjour.',textDigest:sha('Bonjour.'),language:'fr',voice:'pere'}, {...environment, BEBEBONJOUR_VOICE_WORKER_WAKE_DELAY_MS:'1'}, async () => replies.shift()());
  assert.equal(replies.length, 0); assert.equal(receipt.phraseStarts.length, 1);
});

test('worker errors and invalid audio fail closed', async () => {
  const args = {text:'Bonjour.',textDigest:sha('Bonjour.'),language:'ar',voice:'pere'};
  await assert.rejects(() => performNarration(args,environment,async () => new Response('{}',{status:500})), /narration_provider_http_500/);
  for (const size of [127, 12 * 1024 * 1024 + 1]) {
    await assert.rejects(() => performNarration(args,environment,async () => new Response(Buffer.alloc(size))), /narration_audio_invalid/);
  }
});
