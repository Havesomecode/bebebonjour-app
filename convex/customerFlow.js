import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const createJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    idempotencyKey: v.union(v.string(), v.null()),
    requestDigest: v.string(),
    job: v.any(),
    response: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    if (args.response?.intakeToken !== undefined
        || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          args.response?.intakeTokenCiphertext || "",
        )) {
      throw new Error("Customer idempotency response requires an encrypted intake token.");
    }
    if (args.job?.jobId !== args.response?.jobId) {
      throw new Error("Customer job and idempotency response must reference the same canonical job.");
    }
    if (args.job?.version !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(args.job.jobId || "")
        || !/^[a-f0-9]{64}$/.test(args.requestDigest)) {
      throw new Error("Customer job creation payload is invalid.");
    }
    if (args.idempotencyKey) {
      const existing = await context.db
        .query("customerFlowSubmissions")
        .withIndex("by_idempotency_key", (query) => query.eq("idempotencyKey", args.idempotencyKey))
        .unique();
      if (existing) {
        if (existing.requestDigest !== args.requestDigest) {
          return { conflict: true, created: false, response: null };
        }
        return { conflict: false, created: false, response: existing.response };
      }
    }

    const duplicateJob = await context.db
      .query("customerFlowJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", args.job.jobId))
      .unique();
    if (duplicateJob) throw new Error("Duplicate customer-flow job id.");

    await context.db.insert("customerFlowJobs", { jobId: args.job.jobId, job: args.job });
    if (args.idempotencyKey) {
      await context.db.insert("customerFlowSubmissions", {
        idempotencyKey: args.idempotencyKey,
        requestDigest: args.requestDigest,
        response: args.response,
      });
    }
    return { conflict: false, created: true, response: args.response };
  },
});

export const readJob = queryGeneric({
  args: { backendToken: v.string(), jobId: v.string() },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    const document = await findJob(context, args.jobId);
    return document?.job || null;
  },
});

export const replaceJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    expectedVersion: v.number(),
    job: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    const document = await findJob(context, args.job.jobId);
    if (!document) return { updated: false, current: null };
    if (document.job.version !== args.expectedVersion) {
      return { updated: false, current: document.job };
    }
    if (args.job.version !== args.expectedVersion + 1) {
      throw new Error("Customer-flow replacement must increment version exactly once.");
    }
    await context.db.patch(document._id, { job: args.job });
    return { updated: true, job: args.job };
  },
});

export const readProviderEvent = queryGeneric({
  args: { backendToken: v.string(), providerEventId: v.string() },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    const document = await findProviderEvent(context, args.providerEventId);
    return document?.event || null;
  },
});

export const claimProviderEvent = mutationGeneric({
  args: {
    backendToken: v.string(),
    providerEventId: v.string(),
    fingerprint: v.string(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertProviderEventIdentity(args.providerEventId, args.fingerprint);
    const existing = await findProviderEvent(context, args.providerEventId);
    if (existing) return { created: false, event: existing.event };
    const event = { fingerprint: args.fingerprint, result: null };
    await context.db.insert("customerFlowProviderEvents", {
      providerEventId: args.providerEventId,
      event,
    });
    return { created: true, event };
  },
});

export const completeProviderEvent = mutationGeneric({
  args: {
    backendToken: v.string(),
    providerEventId: v.string(),
    fingerprint: v.string(),
    result: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertProviderEventIdentity(args.providerEventId, args.fingerprint);
    if (!args.result || typeof args.result !== "object") {
      throw new Error("Provider event completion result is invalid.");
    }
    const existing = await findProviderEvent(context, args.providerEventId);
    if (!existing || existing.event.fingerprint !== args.fingerprint) {
      return { completed: false, event: existing?.event || null };
    }
    if (existing.event.result) return { completed: false, event: existing.event };
    const event = { fingerprint: args.fingerprint, result: args.result };
    await context.db.patch(existing._id, { event });
    return { completed: true, event };
  },
});

export const recordProviderEvent = mutationGeneric({
  args: {
    backendToken: v.string(),
    providerEventId: v.string(),
    event: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(args.providerEventId)
        || !/^[a-f0-9]{64}$/.test(args.event?.fingerprint || "")
        || !args.event?.result || typeof args.event.result !== "object") {
      throw new Error("Provider event record is invalid.");
    }
    const existing = await findProviderEvent(context, args.providerEventId);
    if (existing) return { created: false, event: existing.event };
    await context.db.insert("customerFlowProviderEvents", {
      providerEventId: args.providerEventId,
      event: args.event,
    });
    return { created: true, event: args.event };
  },
});

function findJob(context, jobId) {
  return context.db
    .query("customerFlowJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

function findProviderEvent(context, providerEventId) {
  return context.db
    .query("customerFlowProviderEvents")
    .withIndex("by_provider_event_id", (query) => query.eq("providerEventId", providerEventId))
    .unique();
}

function assertProviderEventIdentity(providerEventId, fingerprint) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerEventId)
      || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("Provider event identity is invalid.");
  }
}

function assertBackendToken(value) {
  const expected = process.env.CUSTOMER_FLOW_BACKEND_TOKEN;
  if (!expected || expected.length < 32 || value !== expected) {
    throw new Error("Customer-flow backend authorization failed.");
  }
}
