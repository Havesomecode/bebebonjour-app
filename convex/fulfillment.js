import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const createJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    aggregate: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertAggregateIdentity(args.jobId, args.aggregate);
    const existing = await findJob(context, args.jobId);
    if (existing) return { created: false, aggregate: existing.aggregate };
    await context.db.insert("fulfillmentJobs", {
      jobId: args.jobId,
      aggregate: args.aggregate,
    });
    return { created: true, aggregate: args.aggregate };
  },
});

export const getJob = queryGeneric({
  args: { backendToken: v.string(), jobId: v.string() },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    const document = await findJob(context, args.jobId);
    return document?.aggregate || null;
  },
});

export const replaceJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    expectedVersion: v.number(),
    aggregate: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertAggregateIdentity(args.jobId, args.aggregate);
    const document = await findJob(context, args.jobId);
    if (!document) return { updated: false, current: null };
    if (document.aggregate.version !== args.expectedVersion) {
      return { updated: false, current: document.aggregate };
    }
    if (args.aggregate.version !== args.expectedVersion + 1) {
      throw new Error("Fulfillment replacement must increment version exactly once.");
    }
    await context.db.patch(document._id, { aggregate: args.aggregate });
    return { updated: true, aggregate: args.aggregate };
  },
});

function findJob(context, jobId) {
  return context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

function assertAggregateIdentity(jobId, aggregate) {
  if (!aggregate || aggregate.jobId !== jobId) {
    throw new Error("Fulfillment aggregate must preserve the canonical job id.");
  }
}

function assertBackendToken(value) {
  const expected = process.env.CUSTOMER_FLOW_BACKEND_TOKEN;
  if (!expected || expected.length < 32 || value !== expected) {
    throw new Error("Customer-flow backend authorization failed.");
  }
}
