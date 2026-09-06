import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const operationAction = v.union(
  v.literal("create_checkout"),
  v.literal("generate"),
  v.literal("approve_content"),
  v.literal("request_content_changes"),
  v.literal("reject_content"),
  v.literal("render"),
  v.literal("generate_narration"),
  v.literal("approve_narration"),
  v.literal("request_narration_changes"),
  v.literal("reject_narration"),
  v.literal("publish"),
  v.literal("queue_delivery"),
  v.literal("deliver"),
  v.literal("retry"),
  v.literal("reconcile"),
);
const operationState = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("reconciliation_required"),
);
const operationClaim = v.union(v.null(), v.object({
  workerId: v.string(),
  leaseToken: v.string(),
  claimedAtMs: v.number(),
  leaseExpiresAtMs: v.number(),
  effectStartedAtMs: v.optional(v.number()),
}));
const operationPayload = v.object({
  revisionId: v.optional(v.string()),
  artifactManifestDigest: v.optional(v.string()),
  artifactDigests: v.optional(v.object({
    pageDigest: v.string(),
    transcriptDigest: v.string(),
    assetManifestDigest: v.string(),
  })),
  reasonCodes: v.optional(v.array(v.string())),
  publicationId: v.optional(v.string()),
  providerStatus: v.optional(v.string()),
  sourceCommandId: v.optional(v.string()),
});
const operationOutcome = v.union(v.null(), v.object({
  code: v.string(),
  jobVersion: v.number(),
  revisionId: v.optional(v.string()),
  artifactSetId: v.optional(v.string()),
  decisionId: v.optional(v.string()),
  checkoutSessionId: v.optional(v.string()),
  checkoutUrl: v.optional(v.string()),
  publicationId: v.optional(v.string()),
  deploymentId: v.optional(v.string()),
  productionUrl: v.optional(v.string()),
  deliveryAttemptId: v.optional(v.string()),
  providerMessageId: v.optional(v.string()),
  reconciledState: v.optional(v.string()),
  sourceCommandId: v.optional(v.string()),
  providerStatus: v.optional(v.string()),
}));

export default defineSchema({
  customerFlowJobs: defineTable({
    jobId: v.string(),
    job: v.any(),
  }).index("by_job_id", ["jobId"]),
  customerFlowSubmissions: defineTable({
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    response: v.any(),
  }).index("by_idempotency_key", ["idempotencyKey"]),
  customerFlowProviderEvents: defineTable({
    providerEventId: v.string(),
    event: v.any(),
  }).index("by_provider_event_id", ["providerEventId"]),
  customerFlowWorkItems: defineTable({
    jobId: v.string(),
    source: v.string(),
    state: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
    attempts: v.number(),
    claim: v.union(v.any(), v.null()),
    kanbanTaskId: v.union(v.string(), v.null()),
    lastFailureReason: v.union(v.string(), v.null()),
  })
    .index("by_job_id", ["jobId"])
    .index("by_state_and_updated_at", ["state", "updatedAt"]),
  customerFlowOperationsCommands: defineTable({
    commandId: v.string(),
    jobId: v.string(),
    action: operationAction,
    expectedState: v.string(),
    expectedVersion: v.number(),
    payload: operationPayload,
    requestedAt: v.string(),
    requestedBy: v.literal("primary_operator"),
    state: operationState,
    attempts: v.number(),
    claim: operationClaim,
    lastFailureReason: v.union(v.string(), v.null()),
    outcome: operationOutcome,
    updatedAt: v.string(),
  })
    .index("by_command_id", ["commandId"])
    .index("by_job_id_and_requested_at", ["jobId", "requestedAt"])
    .index("by_job_version", ["jobId", "expectedVersion"])
    .index("by_job_action_version", ["jobId", "action", "expectedVersion"])
    .index("by_job_id_and_state", ["jobId", "state"])
    .index("by_state_and_requested_at", ["state", "requestedAt"])
    .index("by_state_action_requested_at", ["state", "action", "requestedAt"])
    .index("by_state_and_claim_lease_expiry", ["state", "claim.leaseExpiresAtMs"])
    .index("by_state_action_claim_lease_expiry", ["state", "action", "claim.leaseExpiresAtMs"]),
  customerFlowOperationsLoginThrottle: defineTable({
    bucketKey: v.string(),
    windowStartedAtMs: v.number(),
    attempts: v.number(),
    blockedUntilMs: v.number(),
    updatedAtMs: v.number(),
  }).index("by_bucket_key", ["bucketKey"]),
  fulfillmentJobs: defineTable({
    jobId: v.string(),
    aggregate: v.any(),
  }).index("by_job_id", ["jobId"]),
  fulfillmentReviewApprovals: defineTable({
    approvalId: v.string(),
    approval: v.any(),
  }).index("by_approval_id", ["approvalId"]),
});
