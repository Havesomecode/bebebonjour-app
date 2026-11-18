import { internalQueryGeneric, internalMutationGeneric, queryGeneric } from "convex/server";
import { assertOwnerTrialCompletionToken, ownerTrialCompletionPolicy } from "./ownerTrialCompletion.js";
export const completionPolicy = queryGeneric({
  args: { completionToken: v.string(), jobId: v.string() },
  handler: async (ctx, args) => {
    assertOwnerTrialCompletionToken(args.completionToken);
    return ownerTrialCompletionPolicy(ctx, args.jobId);
  },
});
import { v } from "convex/values";
import { assertOwnerTrialOperator, matchesOwnerTrialAuthority } from "../src/fulfillment/owner-trial-authority.mjs";
import { stablePrivateValue } from "../src/fulfillment/private-generation-authority.mjs";
import { assertEditorialApproval } from "./generation.js";
export const hashTrial = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
export const insertTicket = internalMutationGeneric({
  args: { operatorToken: v.string(), ticketDigest: v.string(), binding: v.any() },
  handler: async (ctx, args) => {
    assertOwnerTrialOperator(args.operatorToken);
    const prior = await ctx.db.query("ownerTrialTickets").withIndex("by_ticket_id", q => q.eq("ticketId", args.binding.ticketId)).unique();
    if (prior) {
      if (stablePrivateValue(prior.binding) !== stablePrivateValue(args.binding)) throw new Error("Owner trial ticket idempotency conflict.");
      return { issued: false };
    }
    await ctx.db.insert("ownerTrialTickets", { ticketId: args.binding.ticketId, ticketDigest: args.ticketDigest,
      binding: args.binding, redeemed: false, intakeDigest: null });
    return { issued: true };
  },
});
export const redeem = internalMutationGeneric({
  args: { operatorToken: v.string(), jobId: v.string(), recipient: v.string(), ticketDigest: v.string(),
    intake: v.any(), intakeDigest: v.string(), aggregate: v.any(), editorialApproval: v.any() },
  handler: async (ctx, args) => {
    assertOwnerTrialOperator(args.operatorToken);
    const ticket = await ctx.db.query("ownerTrialTickets").withIndex("by_ticket_digest", q => q.eq("ticketDigest", args.ticketDigest)).unique();
    if (!ticket || ticket.binding.jobId !== args.jobId || ticket.binding.recipient !== args.recipient
      || Date.parse(ticket.binding.expiresAt) <= Date.now()) throw new Error("Owner trial redemption rejected.");
    const digest = await hashTrial(stablePrivateValue(args.intake));
    const customer = { schemaVersion: "1.0", jobId: args.jobId, version: 1, createdAt: args.aggregate.createdAt,
      updatedAt: args.aggregate.updatedAt, intake: args.intake, intakeDigest: args.intakeDigest,
      payment: { status: "waived", paidAt: null, checkout: null }, events: [] };
    const authority = { version: "delegated-owner-trial-v1", jobId: args.jobId, intakeDigest: digest,
      ticketId: ticket.ticketId, ownerSourceReference: ticket.binding.ownerSourceReference, recipient: args.recipient,
      origin: ticket.binding.origin, paymentDisposition: "complimentary_waiver", reviewMode: "delegated_owner_trial" };
    customer.ownerTrialAuthority = authority; args.aggregate.ownerTrialAuthority = authority;
    if (!matchesOwnerTrialAuthority(customer, args.aggregate, digest) || args.aggregate.state !== "generation_queued") throw new Error("Owner trial authority rejected.");
    await assertEditorialApproval(args.editorialApproval, args.jobId);
    const c = await ctx.db.query("customerFlowJobs").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    const f = await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    if (ticket.redeemed) {
      if (ticket.intakeDigest !== digest || !matchesOwnerTrialAuthority(c?.job, f?.aggregate, digest)) throw new Error("Owner trial replay conflict.");
      return { jobId: args.jobId, intakeDigest: digest, created: false };
    }
    if (c || f) throw new Error("Owner trial immutable job already exists.");
    await ctx.db.insert("customerFlowJobs", { jobId: args.jobId, job: customer });
    await ctx.db.insert("fulfillmentJobs", { jobId: args.jobId, aggregate: args.aggregate });
    await ctx.db.insert("fulfillmentGenerationEditorialApprovals", { jobId: args.jobId, approval: args.editorialApproval });
    await ctx.db.patch(ticket._id, { redeemed: true, intakeDigest: digest });
    return { jobId: args.jobId, intakeDigest: digest, created: true };
  },
});
export const readReviewContext = internalQueryGeneric({
  args: { operatorToken: v.string(), jobId: v.string(), decisionType: v.string() },
  handler: async (ctx, args) => {
    assertOwnerTrialOperator(args.operatorToken);
    const customer = await ctx.db.query("customerFlowJobs").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    const document = await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    await assertOwnerTrialPersistedAuthority(ctx, customer?.job, document?.aggregate);
    const prior = await ctx.db.query("ownerTrialReviews").withIndex("by_job_type", q => q.eq("jobId", args.jobId).eq("decisionType", args.decisionType)).unique();
    return { job: document.aggregate, receipt: prior?.receipt || null };
  },
});
export const commitReview = internalMutationGeneric({
  args: { operatorToken: v.string(), jobId: v.string(), expectedVersion: v.number(), aggregate: v.any(), approval: v.any(), receipt: v.any() },
  handler: async (ctx, args) => {
    assertOwnerTrialOperator(args.operatorToken);
    const customer = await ctx.db.query("customerFlowJobs").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    const document = await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    await assertOwnerTrialPersistedAuthority(ctx, customer?.job, document?.aggregate);
    const prior = await ctx.db.query("ownerTrialReviews").withIndex("by_job_type", q => q.eq("jobId", args.jobId).eq("decisionType", args.receipt.decisionType)).unique();
    if (prior) {
      if (stablePrivateValue(prior.receipt.binding) !== stablePrivateValue(args.receipt.binding)) throw new Error("Owner trial review replay conflict.");
      return prior.receipt.result;
    }
    if (document.aggregate.version !== args.expectedVersion) throw new Error("Owner trial review version conflict.");
    await assertOwnerTrialPersistedAuthority(ctx, customer.job, args.aggregate);
    if (args.aggregate.version !== args.expectedVersion + 1) throw new Error("Owner trial review transition conflict.");
    await ctx.db.insert("fulfillmentReviewApprovals", { approvalId: args.approval.approvalId, approval: args.approval });
    await ctx.db.insert("ownerTrialReviews", { jobId: args.jobId, decisionType: args.receipt.decisionType, receipt: args.receipt });
    await ctx.db.patch(document._id, { aggregate: args.aggregate });
    return args.receipt.result;
  },
});
export async function assertOwnerTrialPersistedAuthority(ctx, customer, job) {
  const digest = await hashTrial(stablePrivateValue(customer?.intake) || "");
  const ticket = customer?.ownerTrialAuthority ? await ctx.db.query("ownerTrialTickets")
    .withIndex("by_ticket_id", q => q.eq("ticketId", customer.ownerTrialAuthority.ticketId)).unique() : null;
  if (!matchesOwnerTrialAuthority(customer, job, digest) || !ticket?.redeemed || ticket.intakeDigest !== digest
    || ticket.binding.jobId !== job.jobId || ticket.binding.origin !== job.ownerTrialAuthority.origin
    || ticket.binding.recipient !== job.ownerTrialAuthority.recipient) throw new Error("Owner trial persisted intake authority rejected.");
  return job.ownerTrialAuthority;
}
