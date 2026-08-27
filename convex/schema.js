import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
  fulfillmentJobs: defineTable({
    jobId: v.string(),
    aggregate: v.any(),
  }).index("by_job_id", ["jobId"]),
  fulfillmentReviewApprovals: defineTable({
    approvalId: v.string(),
    approval: v.any(),
  }).index("by_approval_id", ["approvalId"]),
});
