import { createHash, timingSafeEqual } from "node:crypto";
import { createSocket } from 'node:dgram';
import { setTimeout as sleep } from 'node:timers/promises';
import { narratePhrases } from './narration-timing.mjs';

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export async function performNarration({ text, textDigest, language, voice }, environment = process.env, fetchImpl = fetch, wake = sendWakePacket) {
  if (!['fr', 'ar'].includes(language) || !['pere', 'mere'].includes(voice) || typeof text !== 'string' || !text.trim()
      || Buffer.byteLength(text, 'utf8') > 16_000
      || createHash('sha256').update(text).digest('hex') !== textDigest) throw new Error('narration_input_invalid');
  const url = required(environment, 'BEBEBONJOUR_VOICE_WORKER_URL').replace(/\/+$/, '');
  const token = required(environment, 'BEBEBONJOUR_VOICE_WORKER_TOKEN');
  // Retry a sleeping tower without treating local synthesis as a committed effect.
  const wakeDelayMs = Number(environment.BEBEBONJOUR_VOICE_WORKER_WAKE_DELAY_MS ?? 10_000);
  const attempts = Number(environment.BEBEBONJOUR_VOICE_WORKER_WAKE_ATTEMPTS ?? 12);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(wakeDelayMs) || wakeDelayMs < 0) throw new Error('voice_wake_configuration_invalid');
  let lastWake = -Infinity;
  const speak = async (phrase) => {
    for (let attempt = 1; ; attempt++) {
      let response, failure;
      try {
        response = await fetchImpl(`${url}/speak`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ voice, language: phrase.language, text: phrase.text }), signal: AbortSignal.timeout(180_000),
        });
      } catch (error) {
        if (!['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name)) throw error;
        failure = error;
      }
      if (response && ![502, 503].includes(response.status)) return response;
      if (environment.BEBEBONJOUR_VOICE_WORKER_WAKE_MAC && Date.now() - lastWake >= 120_000) {
        lastWake = Date.now();
        try { await wake(environment.BEBEBONJOUR_VOICE_WORKER_WAKE_MAC, environment.BEBEBONJOUR_VOICE_WORKER_WAKE_BROADCAST ?? '192.168.1.255'); } catch { /* retry even if broadcast fails */ }
      }
      if (attempt >= attempts) { if (failure) throw failure; return response; }
      await sleep(wakeDelayMs);
    }
  };
  const { audio: bytes, phraseStarts } = await narratePhrases({ text, language, concurrency: 1, synthesize: async (phrase) => {
    const response = await speak(phrase);
    if (!response.ok) throw new Error(`narration_provider_http_${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length < 128 || audio.length > MAX_AUDIO_BYTES) throw new Error('narration_audio_invalid');
    return audio;
  } });
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error('narration_audio_invalid');
  return { audioBase64: bytes.toString('base64'), bytes: bytes.length,
    audioDigest: createHash('sha256').update(bytes).digest('hex'), textDigest, phraseStarts,
    provider: 'voxcpm', model: 'openbmb/VoxCPM2@7936080b', voice };
}

async function sendWakePacket(mac, broadcast) {
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) throw new Error('voice_wake_mac_invalid');
  const packet = Buffer.concat([Buffer.alloc(6, 255), ...Array(16).fill(Buffer.from(mac.replaceAll(':', ''), 'hex'))]);
  const socket = createSocket('udp4');
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, resolve); });
    socket.setBroadcast(true);
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve, reject) => socket.send(packet, 9, broadcast, error => error ? reject(error) : resolve()));
      if (i < 2) await sleep(300);
    }
  } finally { socket.close(); }
}

export function authorizeProviderToken(actual, environment = process.env) {
  const expected = required(environment, 'BEBEBONJOUR_DELIVERY_LOOP_TOKEN');
  if (Buffer.byteLength(expected) < 32 || typeof actual !== 'string') throw new Error('provider_unauthorized');
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(left, right)) throw new Error('provider_unauthorized');
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}_not_configured`);
  return value;
}
