// Convex isolate compatible: authenticate bytes before decoding or parsing.
export const MAX_PAID_EVENT_BYTES = 64 * 1024;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const same = (a, b) => { let diff = a.length ^ b.length; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0); return diff === 0; };

export async function readPaidEventBytes(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw new Error('payment_event_format');
  if (request.headers.get('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw new Error('payment_event_format');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_PAID_EVENT_BYTES)) throw new Error('payment_event_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('payment_event_format');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_PAID_EVENT_BYTES) { await reader.cancel(); throw new Error('payment_event_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function verifyPaidEvent(bytes, header, secret, nowMs = Date.now()) {
  if (!/^whsec_[A-Za-z0-9]{16,}$/.test(secret || '')) throw new Error('payment_event_configuration');
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PAID_EVENT_BYTES) throw new Error('payment_event_too_large');
  if (typeof header !== 'string' || header.length > 2048) throw new Error('payment_event_signature');
  const parts = header.split(',').map(p => p.trim());
  const timestamps = parts.filter(p => p.startsWith('t='));
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (timestamps.length !== 1 || !/^t=\d{1,12}$/.test(timestamps[0]) || signatures.length < 1 || signatures.length > 8
      || signatures.some(s => !/^[a-f0-9]{64}$/.test(s))) throw new Error('payment_event_signature');
  const timestamp = timestamps[0].slice(2);
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) throw new Error('payment_event_signature');
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bytes.length); signed.set(prefix); signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, signed));
  let valid = false; for (const signature of signatures) valid = same(expected, signature) || valid;
  if (!valid) throw new Error('payment_event_signature');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('payment_event_format'); }
  if (!value || value.object !== 'event' || typeof value.id !== 'string' || !/^evt_[A-Za-z0-9]{1,196}$/.test(value.id)
      || value.type !== 'payment_intent.succeeded' || typeof value.livemode !== 'boolean') throw new Error('payment_event_format');
  return { value, rawBodySha256: hex(await crypto.subtle.digest('SHA-256', bytes)) };
}

// Allowlist only correlation fields. Never pass the provider body, metadata bag,
// billing/customer details, instrument data or client_secret to a mutation.
export function redactPaidEvent({ value, rawBodySha256 }, accountId) {
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId || '')) throw new Error('payment_event_configuration');
  const event = { providerAccountId: accountId, providerEventId: value.id, type: value.type, livemode: value.livemode, rawBodySha256 };
  const intent = value.data?.object;
  const metadata = intent?.metadata || {};
  if (typeof intent?.id === 'string' && /^pi_[A-Za-z0-9]{1,196}$/.test(intent.id)) event.providerPaymentId = intent.id;
  if (typeof metadata.job_id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(metadata.job_id)) event.jobId = metadata.job_id;
  if (typeof metadata.revision === 'string' && /^[1-9]\d{0,5}$/.test(metadata.revision)) event.revision = Number(metadata.revision);
  if (typeof metadata.preview_digest === 'string' && /^[a-f0-9]{64}$/.test(metadata.preview_digest)) event.previewDigest = metadata.preview_digest;
  if (value.account !== undefined && value.account !== accountId) event.rejectionReason = 'payment_account_mismatch';
  else if (intent?.object !== 'payment_intent' || !event.providerPaymentId || !event.jobId || !event.revision || !event.previewDigest
      || metadata.project !== 'bebebonjour' || metadata.order_mode !== 'paid_route_a') event.rejectionReason = 'payment_event_scope_mismatch';
  else if (intent.status !== 'succeeded' || intent.amount !== 3900 || intent.amount_received !== 3900 || intent.currency !== 'eur'
      || intent.livemode !== event.livemode) event.rejectionReason = 'payment_evidence_mismatch';
  return event;
}

export const PAYMENT_EVENT_REJECTION_REASONS = [
  'payment_account_mismatch', 'payment_event_scope_mismatch', 'payment_evidence_mismatch', 'payment_event_conflict',
  'payment_evidence_conflict', 'payment_already_settled', 'paid_order_required', 'paid_permissions_required',
  'stale_revision', 'preview_expired', 'order_cancelled', 'hosting_ended', 'data_deleted', 'not_found',
];
export function paymentEventRejection(error) {
  return PAYMENT_EVENT_REJECTION_REASONS.find(code => error?.message === code);
}
