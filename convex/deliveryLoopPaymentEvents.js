import { internalQueryGeneric, internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { paymentEvidenceFields, preparePaymentEvidence, commitPaymentEvidence } from './deliveryLoop.js';
import { expectedLivemode } from './deliveryLoopPaidPolicy.js';
import { PAYMENT_EVENT_REJECTION_REASONS, paymentEventRejection } from '../src/delivery-loop/paid-event.mjs';

export const paymentEventFields = {
  providerAccountId: v.string(), providerEventId: v.string(), type: v.literal('payment_intent.succeeded'),
  livemode: v.boolean(), rawBodySha256: v.string(), providerPaymentId: v.optional(v.string()),
  jobId: v.optional(v.string()), revision: v.optional(v.number()), previewDigest: v.optional(v.string()),
  rejectionReason: v.optional(v.string()),
};
function validate(event) {
  if (event.providerAccountId !== process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID
      || !/^acct_[A-Za-z0-9]+$/.test(event.providerAccountId) || !/^evt_[A-Za-z0-9]{1,196}$/.test(event.providerEventId)
      || !/^[a-f0-9]{64}$/.test(event.rawBodySha256) || (event.rejectionReason && !PAYMENT_EVENT_REJECTION_REASONS.includes(event.rejectionReason))) throw new Error('payment_event_configuration');
}
function identity(ctx, event, index = 'by_identity') {
  return ctx.db.query('deliveryLoopPaymentEvents').withIndex(index, q => {
    const scope = q.eq('providerAccountId', event.providerAccountId).eq('providerEventId', event.providerEventId);
    return index === 'by_fingerprint' ? scope.eq('rawBodySha256', event.rawBodySha256) : scope;
  });
}
const response = receipt => ({ disposition: receipt.disposition, reason: receipt.reason });
async function lookup(ctx, event) {
  validate(event);
  const exact = await identity(ctx, event, 'by_fingerprint').unique();
  if (exact) return response(exact);
  if (await identity(ctx, event).first()) return { disposition: 'rejected', reason: 'payment_event_conflict' };
  return null;
}
export const lookupEvent = internalQueryGeneric({ args: { event: v.object(paymentEventFields) }, handler: (ctx, { event }) => lookup(ctx, event) });

// One transaction commits the immutable redacted receipt and the existing order
// settlement. Conflicting fingerprints get separate rejection receipts; the
// first receipt is never overwritten. Exact replays don't even touch the order.
export const recordEvent = internalMutationGeneric({
  args: { event: v.object(paymentEventFields), evidence: v.optional(v.object(paymentEvidenceFields)), rejectionReason: v.optional(v.string()) },
  handler: async (ctx, { event, evidence, rejectionReason }) => {
    const prior = await lookup(ctx, event);
    const exact = await identity(ctx, event, 'by_fingerprint').unique();
    if (exact) return response(exact);
    let reason = prior?.reason || event.rejectionReason || rejectionReason;
    if (reason && !PAYMENT_EVENT_REJECTION_REASONS.includes(reason)) throw new Error('payment_event_configuration');
    let prepared;
    if (!reason) {
      if (!evidence) throw new Error('payment_inspection_required');
      try {
        if (evidence.providerAccountId !== event.providerAccountId || evidence.providerPaymentId !== event.providerPaymentId
            || evidence.jobId !== event.jobId || evidence.revision !== event.revision || evidence.previewDigest !== event.previewDigest
            || evidence.livemode !== event.livemode) throw new Error('payment_evidence_mismatch');
        // Binds the payment to the order's revision-1 brief, consent and live state.
        prepared = await preparePaymentEvidence(ctx, evidence);
      } catch (error) {
        reason = paymentEventRejection(error);
        if (!reason) throw error; // datastore/configuration failures are retryable
      }
    }
    if (!reason) await commitPaymentEvidence(ctx, evidence, prepared);
    const { rejectionReason: _discard, ...correlation } = event;
    const receipt = { ...correlation, disposition: reason ? 'rejected' : event.livemode === expectedLivemode() ? 'settled' : 'test_only',
      reason: reason || 'payment_verified', processedAtMs: Date.now() };
    await ctx.db.insert('deliveryLoopPaymentEvents', receipt);
    return response(receipt);
  },
});
