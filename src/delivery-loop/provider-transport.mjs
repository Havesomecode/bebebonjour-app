import { createHash, timingSafeEqual } from "node:crypto";

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const speechModel = "gpt-4o-mini-tts";
export const speechVoice = "cedar";

export async function performNarration({ text, textDigest, language }, environment = process.env, fetchImpl = fetch) {
  if (!['fr', 'ar'].includes(language) || typeof text !== 'string' || !text.trim()
      || Buffer.byteLength(text, 'utf8') > 16_000
      || createHash('sha256').update(text).digest('hex') !== textDigest) {
    throw new Error('narration_input_invalid');
  }
  const response = await fetchImpl('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${required(environment, 'OPENAI_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: speechModel, voice: speechVoice, input: text, response_format: 'mp3',
      instructions: 'Speak as a father sharing intimate, joyful news. Warm, restrained, natural pauses. Not theatrical or robotic. Read the text exactly in its own language.' }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`narration_provider_http_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 128 || bytes.length > MAX_AUDIO_BYTES) throw new Error('narration_audio_invalid');
  return { audioBase64: bytes.toString('base64'), bytes: bytes.length,
    audioDigest: createHash('sha256').update(bytes).digest('hex'), textDigest,
    provider: 'openai', model: speechModel, voice: speechVoice };
}

export async function performEmail({ from, to, subject, html, text, idempotencyKey }, environment = process.env, fetchImpl = fetch) {
  if (typeof to !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)
      || !/^bebe-loop:job_[A-Za-z0-9_-]+:\d+:(draft_email|final_email)$/.test(idempotencyKey || '')
      || [subject, html, text].some(value => typeof value !== 'string' || !value || value.length > 32_000)) {
    throw new Error('email_input_invalid');
  }
  const sender = environment.BEBEBONJOUR_DELIVERY_LOOP_FROM || environment.RESEND_FROM
    || 'Bébé Bonjour <bonjour@updates.bebebonjour.com>';
  if (from && from !== sender) throw new Error('email_sender_invalid');
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${required(environment, 'RESEND_API_KEY')}`, 'content-type': 'application/json',
      'idempotency-key': idempotencyKey },
    body: JSON.stringify({ from: sender, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`email_provider_http_${response.status}`);
  const result = await response.json();
  if (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(result.id)) throw new Error('email_provider_receipt_invalid');
  return { providerMessageId: result.id, provider: 'resend', idempotencyKey };
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
