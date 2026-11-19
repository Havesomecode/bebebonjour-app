import { createHash, timingSafeEqual } from "node:crypto";
import { narratePhrases } from './narration-timing.mjs';

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export async function performNarration({ text, textDigest, language, voice }, environment = process.env, fetchImpl = fetch) {
  if (!['fr', 'ar'].includes(language) || !['pere', 'mere'].includes(voice) || typeof text !== 'string' || !text.trim()
      || Buffer.byteLength(text, 'utf8') > 16_000
      || createHash('sha256').update(text).digest('hex') !== textDigest) throw new Error('narration_input_invalid');
  const url = required(environment, 'BEBEBONJOUR_VOICE_WORKER_URL').replace(/\/+$/, '');
  const token = required(environment, 'BEBEBONJOUR_VOICE_WORKER_TOKEN');
  const { audio: bytes, phraseStarts } = await narratePhrases({ text, language, concurrency: 1, synthesize: async (phrase) => {
    const response = await fetchImpl(`${url}/speak`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ voice, language: phrase.language, text: phrase.text }), signal: AbortSignal.timeout(180_000),
    });
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
