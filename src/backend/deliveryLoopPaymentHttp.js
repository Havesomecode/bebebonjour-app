import { httpAction } from "./functions.mjs";
import { readPaidEventBytes, verifyPaidEvent, redactPaidEvent } from '../delivery-loop/paid-event.mjs';

const reply = (code, status) => new Response(JSON.stringify({ status: code }), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
} });
export const paidPaymentWebhook = httpAction(async (ctx, request) => {
  try {
    const bytes = await readPaidEventBytes(request);
    const verified = await verifyPaidEvent(bytes, request.headers.get('stripe-signature'), process.env.BEBEBONJOUR_PAID_STRIPE_WEBHOOK_SECRET);
    const event = redactPaidEvent(verified, process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID);
    // Internal action only. No worker/editorial/browser assertion can submit a
    // verified event or settlement; only this raw-byte authenticated HTTP seam.
    const result = await ctx.runAction('deliveryLoopProviders:reconcilePaidEvent', { event });
    return reply(result.disposition, 200); // rejection is acknowledged only after durable receipt
  } catch (error) {
    // Never expose Stripe error bodies, request IDs, credentials or job details.
    const message = error?.message || '';
    if (/\bpayment_event_too_large\b/.test(message)) return reply('payment_event_too_large', 413);
    if (/\bpayment_event_signature\b/.test(message)) return reply('payment_event_signature', 400);
    if (/\bpayment_event_format\b/.test(message)) return reply('payment_event_format', 400);
    return reply('payment_event_retry', 503); // no success receipt on uncertain inspection/commit
  }
});
