import { internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';

const identity = { eventId: v.string(), emailId: v.string(), rawBodySha256: v.string() };

// No expiry or takeover: a crashed/uncertain sender must be reconciled, not
// reclaimed after a lease or after Resend's idempotency window has elapsed.
export const begin = internalMutationGeneric({
  args: { ...identity, disposition: v.union(v.literal('forward'), v.literal('ignored')) },
  handler: async (ctx, args) => {
    const byEvent = await ctx.db.query('supportForwardReceipts').withIndex('by_event_id', q => q.eq('eventId', args.eventId)).unique();
    const byEmail = await ctx.db.query('supportForwardReceipts').withIndex('by_email_id', q => q.eq('emailId', args.emailId)).unique();
    if (byEvent && byEmail && byEvent._id !== byEmail._id) return { status: 'reconciliation_required' };
    const existing = byEvent || byEmail;
    if (existing) {
      if (existing.emailId !== args.emailId || existing.rawBodySha256 !== args.rawBodySha256) return { status: 'reconciliation_required' };
      return { status: ['sent', 'ignored'].includes(existing.status) ? existing.status : 'reconciliation_required' };
    }
    const now = Date.now();
    const ignored = args.disposition === 'ignored';
    await ctx.db.insert('supportForwardReceipts', {
      eventId: args.eventId, emailId: args.emailId, rawBodySha256: args.rawBodySha256,
      status: ignored ? 'ignored' : 'inflight', reason: ignored ? 'policy_ignored' : 'forwarding',
      startedAtMs: now, updatedAtMs: now,
    });
    return { status: ignored ? 'ignored' : 'claimed' };
  },
});

export const finish = internalMutationGeneric({
  args: { ...identity, providerMessageId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query('supportForwardReceipts').withIndex('by_event_id', q => q.eq('eventId', args.eventId)).unique();
    if (!row || row.emailId !== args.emailId || row.rawBodySha256 !== args.rawBodySha256) throw new Error('support_fence_mismatch');
    if (row.status !== 'inflight') return; // terminal; never reopen or overwrite
    await ctx.db.patch(row._id, {
      status: args.providerMessageId ? 'sent' : 'reconciliation_required',
      reason: args.providerMessageId ? 'provider_accepted' : 'provider_uncertain',
      ...(args.providerMessageId ? { providerMessageId: args.providerMessageId } : {}),
      updatedAtMs: Date.now(),
    });
  },
});
