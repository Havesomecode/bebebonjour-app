import { internalMutationGeneric, mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { assertEditorialApproval } from "./generation.js";
import { assertPrivateGenerationOperator, matchesPrivateGenerationAuthority, stablePrivateValue } from "../src/fulfillment/private-generation-authority.mjs";
export const insertFictionalTest = internalMutationGeneric({
  args: { operatorToken: v.string(), customer: v.any(), aggregate: v.any() },
  handler: async (ctx, { operatorToken, customer, aggregate }) => {
    assertPrivateGenerationOperator(operatorToken);
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stablePrivateValue(customer.intake)));
    const digest = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (!matchesPrivateGenerationAuthority(customer, aggregate, digest)
      || aggregate.state !== "generation_queued" || aggregate.version !== 1
      || aggregate.currentRevisionId !== null || aggregate.artifactSets.length !== 0
      || aggregate.reviewDecisions.length !== 0 || aggregate.stageAttempts.length !== 0) {
      throw new Error("Invalid private fictional job.");
    }
    const existing = await ctx.db.query("customerFlowJobs").withIndex("by_job_id", q => q.eq("jobId", customer.jobId)).unique();
    const fulfillment = await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", customer.jobId)).unique();
    if (existing || fulfillment) {
      if (!existing || !fulfillment
        || !matchesPrivateGenerationAuthority(existing.job, fulfillment.aggregate, digest)
        || stablePrivateValue(existing.job.privateTestAuthority) !== stablePrivateValue(customer.privateTestAuthority)) {
        throw new Error("Private fictional idempotency conflict.");
      }
      return { jobId: customer.jobId, intakeDigest: digest, created: false };
    }
    await ctx.db.insert("customerFlowJobs", { jobId: customer.jobId, job: customer });
    await ctx.db.insert("fulfillmentJobs", { jobId: aggregate.jobId, aggregate });
    return { jobId: customer.jobId, intakeDigest: digest, created: true };
  },
});

// Admission only: the operator must separately request a fresh generate command.
// This is not provider reconciliation or a customer/narration retry capability.
export const retryPreEffectFailure = mutationGeneric({
  args: {
    operatorToken: v.string(), jobId: v.string(), intakeDigest: v.string(),
    sourceCommandId: v.string(), failedAttemptId: v.string(), expectedVersion: v.number(),
    editorialApprovalDigest: v.string(), recoveryId: v.string(),
  },
  handler: async (ctx, args) => {
    assertPrivateGenerationOperator(args.operatorToken);
    if (!/^job_private_codex_[a-f0-9]{32}$/u.test(args.jobId)
      || !/^command_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(args.sourceCommandId)
      || !/^attempt_[a-f0-9]{24}$/u.test(args.failedAttemptId)
      || !/^private_retry_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(args.recoveryId)
      || !/^[a-f0-9]{64}$/u.test(args.intakeDigest)
      || !/^[a-f0-9]{64}$/u.test(args.editorialApprovalDigest)
      || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1) {
      throw new Error("Private pre-effect retry identifiers/version rejected.");
    }
    const customer = await ctx.db.query("customerFlowJobs")
      .withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    const fulfillment = await ctx.db.query("fulfillmentJobs")
      .withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    const aggregate = fulfillment?.aggregate;
    if (!customer || !aggregate) {
      throw new Error("Private pre-effect retry state/version rejected.");
    }
    const digest = await privateRetryHash(stablePrivateValue(customer.job.intake));
    if (args.intakeDigest !== digest || !matchesPrivateGenerationAuthority(customer.job, aggregate, digest)) {
      throw new Error("Private pre-effect retry authority rejected.");
    }
    const binding = { jobId: args.jobId, intakeDigest: args.intakeDigest,
      sourceCommandId: args.sourceCommandId, failedAttemptId: args.failedAttemptId,
      expectedVersion: args.expectedVersion, editorialApprovalDigest: args.editorialApprovalDigest,
      recoveryId: args.recoveryId };
    const bindingDigest = await privateRetryHash(stablePrivateValue(binding));
    const result = { jobId: args.jobId, state: "generation_queued", version: args.expectedVersion + 1,
      recoveryId: args.recoveryId, sourceCommandId: args.sourceCommandId,
      failedAttemptId: args.failedAttemptId, restored: true };
    const eventId = `event_${(await privateRetryHash(`${args.jobId}\0${args.recoveryId}`)).slice(0, 24)}`;
    const approval = await ctx.db.query("fulfillmentGenerationEditorialApprovals")
      .withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    try {
      // Use the canonical save API's exact shape, policy, source-reference,
      // source digest and canonical record digest validation, including replay.
      await assertEditorialApproval(approval?.approval, args.jobId);
      if (approval.approval.recordDigest !== args.editorialApprovalDigest) throw new Error("Digest mismatch.");
    } catch {
      throw new Error("Private pre-effect retry editorial approval rejected.");
    }
    const source = await ctx.db.query("customerFlowOperationsCommands")
      .withIndex("by_command_id", q => q.eq("commandId", args.sourceCommandId)).unique();
    // generate is Operations-fenced BEFORE the local stage invokes compose.
    // prepare_review has no provider-specific stage fence; compose may succeed
    // before prepareReview fails and cleanup leaves no artifacts. No existing
    // independent durable composer-absence evidence is available here.
    if (source?.state === "reconciliation_required") {
      throw new Error("Private pre-effect retry provider absence unproven.");
    }
    const replay = aggregate.events?.filter(event => event.commandId === args.recoveryId) || [];
    if (replay.length) {
      if (replay.length !== 1 || replay[0].type !== "private_generation_pre_effect_retry_authorized"
        || stablePrivateValue(replay[0].binding) !== stablePrivateValue(binding)
        || replay[0].commandDigest !== bindingDigest || replay[0].eventId !== eventId
        || replay[0].state !== "generation_queued" || !privateRetryTimestamp(replay[0].at)
        || stablePrivateValue(replay[0].result) !== stablePrivateValue(result)
        || replay[0].sourceDisposition !== null) {
        throw new Error("Private pre-effect retry idempotency conflict.");
      }
      return replay[0].result;
    }
    if (aggregate.version !== args.expectedVersion || aggregate.state !== "failed") {
      throw new Error("Private pre-effect retry state/version rejected.");
    }
    const commands = await ctx.db.query("customerFlowOperationsCommands")
      .withIndex("by_job_id_and_requested_at", q => q.eq("jobId", args.jobId)).collect();
    const attempt = aggregate.stageAttempts?.[0];
    if (source?.jobId !== args.jobId || source.action !== "generate"
      || source.state !== "failed"
      || commands.length !== 1 || commands[0].commandId !== args.sourceCommandId
      || source.expectedState !== "generation_queued" || source.expectedVersion !== 1
      || source.attempts !== 1 || source.requestedBy !== "primary_operator"
      || source.supersedesCommandId !== undefined || stablePrivateValue(source.payload) !== "{}"
      || source.claim !== null || source.outcome !== null
      || source.lastFailureReason !== "generation_stage_failed"
      || attempt?.attemptId !== args.failedAttemptId || attempt.operationsCommandId !== source.commandId
      || attempt.stage !== "prepare_review" || attempt.status !== "failed"
      || attempt.effectStartedAt !== null || attempt.operationBinding !== null
      || aggregate.stageAttempts.length !== 1 || attempt.revisionId !== null
      || attempt.attemptNumber !== 1 || attempt.operationNumber !== 1
      || attempt.leaseToken !== null || attempt.leaseExpiresAt !== null
      || !privateRetryTimestamp(attempt.completedAt)
      || !privateRetryTimestamp(attempt.startedAt) || !privateRetryTimestamp(source.requestedAt)
      || !privateRetryTimestamp(source.updatedAt)
      || source.requestedAt > attempt.startedAt || attempt.startedAt > attempt.completedAt
      || source.updatedAt < attempt.completedAt
      || stablePrivateValue(attempt.failure) !== stablePrivateValue({ retryable: false, reasonCode: "stage_error" })
      || aggregate.currentRevisionId !== null || aggregate.publishedRevisionId !== null
      || aggregate.retry !== null || aggregate.publication !== null
      || ["revisions", "artifactSets", "reviewDecisions", "deliveryAttempts"].some(
        key => !Array.isArray(aggregate[key]) || aggregate[key].length !== 0)
      || aggregate.events?.length !== 3
      || aggregate.events[0]?.type !== "job_created" || aggregate.events[0]?.state !== "generation_queued"
      || aggregate.events[0]?.commandId !== `private-create:${aggregate.privateTestAuthority.creationKeyDigest}`
      || aggregate.events[1]?.type !== "stage_claimed" || aggregate.events[1]?.state !== "generating"
      || aggregate.events[1]?.at !== attempt.startedAt
      || aggregate.events[2]?.type !== "stage_failed" || aggregate.events[2]?.state !== "failed"
      || aggregate.events[2]?.commandId !== `fail:${attempt.attemptId}:stage_error`
      || aggregate.events[2]?.at !== attempt.completedAt || aggregate.updatedAt !== attempt.completedAt) {
      throw new Error("Private pre-effect retry failure binding rejected.");
    }
    // Prefix scan covers every revision and kind, including orphan records not
    // linked from the aggregate; any committed generation evidence forbids retry.
    const artifact = await ctx.db.query("fulfillmentGenerationArtifactSets")
      .withIndex("by_job_revision_kind", q => q.eq("jobId", args.jobId)).first();
    if (artifact) throw new Error("Private pre-effect retry generation artifacts rejected.");
    const at = new Date().toISOString();
    const next = structuredClone(aggregate);
    next.state = "generation_queued";
    next.version += 1;
    next.updatedAt = at;
    next.events.push({ eventId,
      commandId: args.recoveryId, commandDigest: bindingDigest,
      type: "private_generation_pre_effect_retry_authorized", at, state: next.state, binding, result, sourceDisposition: null });
    await ctx.db.patch(fulfillment._id, { aggregate: next });
    return result;
  },
});

function privateRetryTimestamp(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

async function privateRetryHash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

