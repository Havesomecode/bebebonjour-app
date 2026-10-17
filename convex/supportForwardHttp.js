import { httpActionGeneric, makeFunctionReference } from 'convex/server';
import { Resend } from 'resend';

export const MAX_SUPPORT_EVENT_BYTES = 64 * 1024;
const receive = makeFunctionReference('supportForwardProvider:receive');
const source = 'contact@bebebonjour.com';
const loopSenders = new Set([source, 'z@havesomecode.io', 'bonjour@updates.bebebonjour.com']);
const reply = (status, httpStatus) => new Response(JSON.stringify({ status }), {
  status: httpStatus,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  },
});
const invalid = () => new Error('support_event_invalid');

// Stream the original bytes; never parse/re-serialize a signed payload.
export async function readSupportRequest(request) {
  const headers = request.headers;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.get('content-type') || '')
    || !['', 'identity'].includes(headers.get('content-encoding') || '')) throw invalid();
  const id = headers.get('svix-id') || '';
  const timestamp = headers.get('svix-timestamp') || '';
  const signature = headers.get('svix-signature') || '';
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id) || !/^\d{10,12}$/.test(timestamp)
    || !signature || signature.length > 2048) throw invalid();
  const length = headers.get('content-length');
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw invalid();
    if (Number(length) > MAX_SUPPORT_EVENT_BYTES) throw new Error('support_event_too_large');
  }
  if (!request.body) throw invalid();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SUPPORT_EVENT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('support_event_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload;
  try { payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalid(); }
  return { payload, id, timestamp, signature };
}

function classify(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw invalid();
  if (event.type !== 'email.received') return null;
  const data = event.data;
  if (!data || typeof data.email_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.email_id)
    || !Array.isArray(data.received_for) || !data.received_for.every(value => typeof value === 'string' && value.length <= 320)
    || typeof data.from !== 'string' || data.from.length > 512 || /[\r\n]/.test(data.from)) throw invalid();
  const mailbox = /^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(data.from);
  const from = (mailbox?.[1] || mailbox?.[2] || '').toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) throw invalid();
  return {
    emailId: data.email_id,
    disposition: data.received_for.length === 1 && data.received_for[0].toLowerCase() === source
      && !loopSenders.has(from) ? 'forward' : 'ignored',
  };
}

export const supportForwardWebhook = httpActionGeneric(async (ctx, request) => {
  if (process.env.BEBEBONJOUR_SUPPORT_FORWARD_ENABLED !== 'true'
    || !process.env.BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET || !process.env.RESEND_API_KEY) return reply('unavailable', 503);
  let input;
  try { input = await readSupportRequest(request); }
  catch (error) {
    return error?.message === 'support_event_too_large'
      ? reply('too_large', 413) : reply('invalid', 400);
  }
  let event;
  try {
    // Pinned SDK verification is pure JS and isolate-compatible. This client is
    // verification-only: no provider credential or request is needed here.
    const verifier = new Resend('verification-only-no-provider-requests', { baseUrl: 'https://api.resend.com' });
    event = verifier.webhooks.verify({ payload: input.payload,
      headers: { id: input.id, timestamp: input.timestamp, signature: input.signature },
      webhookSecret: process.env.BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET });
  } catch (error) {
    return error?.name === 'WebhookVerificationError' || error instanceof SyntaxError
      ? reply('invalid', 400) : reply('unavailable', 503);
  }
  let incoming;
  try { incoming = classify(event); }
  catch { return reply('invalid', 400); }
  if (incoming === null) return reply('ignored', 200);
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.payload));
    const rawBodySha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    // Raw payload, signature, addresses and subject never become arguments to
    // a persisted/internal function invocation; only these identifiers cross.
    const result = await ctx.runAction(receive, { eventId: input.id, ...incoming, rawBodySha256 });
    return ['sent', 'ignored'].includes(result.status)
      ? reply(result.status, 200) : reply('reconciliation_required', 503);
  } catch {
    // Do not expose exceptions or assume an uncertain commit failed. A retry
    // still has to pass the durable one-shot fence.
    return reply('unavailable', 503);
  }
});
