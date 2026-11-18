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
  fulfillmentJobs: defineTable({
    jobId: v.string(),
    aggregate: v.any(),
  }).index("by_job_id", ["jobId"]),
});
