import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const createJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    idempotencyKey: v.union(v.string(), v.null()),
    requestDigest: v.string(),
    job: v.any(),
    response: v.any(),
    enqueueWorkItem: v.optional(v.boolean()),
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
    if (args.enqueueWorkItem === true) {
      await context.db.insert("customerFlowWorkItems", {
        jobId: args.job.jobId,
        source: "customer-intake",
        state: "pending",
        createdAt: args.job.createdAt,
        updatedAt: args.job.createdAt,
        attempts: 0,
        claim: null,
        kanbanTaskId: null,
        lastFailureReason: null,
      });
    }
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

export const claimWorkItems = mutationGeneric({
  args: {
    backendToken: v.string(),
    workerId: v.string(),
    limit: v.number(),
    nowMs: v.number(),
    leaseMs: v.number(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertWorkerRequest(args);

    const pending = await context.db
      .query("customerFlowWorkItems")
      .withIndex("by_state_and_updated_at", (query) => query.eq("state", "pending"))
      .take(args.limit);
    const remaining = args.limit - pending.length;
    const expired = remaining > 0
      ? (await context.db
        .query("customerFlowWorkItems")
        .withIndex("by_state_and_updated_at", (query) => query.eq("state", "claimed"))
        .collect())
        .filter((item) => item.claim?.leaseExpiresAtMs <= args.nowMs)
        .slice(0, remaining)
      : [];
    const claimed = [];

    for (const item of [...pending, ...expired]) {
      const claim = {
        workerId: args.workerId,
        claimedAtMs: args.nowMs,
        leaseExpiresAtMs: args.nowMs + args.leaseMs,
      };
      await context.db.patch(item._id, {
        state: "claimed",
        updatedAt: new Date(args.nowMs).toISOString(),
        attempts: item.attempts + 1,
        claim,
        lastFailureReason: null,
      });
      claimed.push({
        jobId: item.jobId,
        source: item.source,
        createdAt: item.createdAt,
        attempts: item.attempts + 1,
      });
    }
    return claimed;
  },
});

export const completeWorkItem = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    workerId: v.string(),
    kanbanTaskId: v.string(),
    nowMs: v.number(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertWorkIdentity(args.jobId, args.workerId);
    assertTimestampMilliseconds(args.nowMs);
    if (!/^t_[A-Za-z0-9_-]{4,64}$/.test(args.kanbanTaskId)) {
      throw new Error("Kanban task id is invalid.");
    }
    const item = await findWorkItem(context, args.jobId);
    if (!item) return { completed: false, kanbanTaskId: null };
    if (item.state === "completed") {
      if (item.kanbanTaskId !== args.kanbanTaskId) {
        throw new Error("Work item is already bound to another Kanban task.");
      }
      return { completed: false, kanbanTaskId: item.kanbanTaskId };
    }
    assertActiveClaim(item, args.workerId, args.nowMs);
    await context.db.patch(item._id, {
      state: "completed",
      updatedAt: new Date(args.nowMs).toISOString(),
      claim: null,
      kanbanTaskId: args.kanbanTaskId,
      lastFailureReason: null,
    });
    return { completed: true, kanbanTaskId: args.kanbanTaskId };
  },
});

export const releaseWorkItem = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    workerId: v.string(),
    reasonCode: v.string(),
    nowMs: v.number(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertWorkIdentity(args.jobId, args.workerId);
    assertTimestampMilliseconds(args.nowMs);
    if (args.reasonCode !== "kanban_create_failed") {
      throw new Error("Work item failure reason is invalid.");
    }
    const item = await findWorkItem(context, args.jobId);
    if (!item || item.state === "completed") return { released: false };
    assertActiveClaim(item, args.workerId, args.nowMs);
    await context.db.patch(item._id, {
      state: "pending",
      updatedAt: new Date(args.nowMs).toISOString(),
      claim: null,
      lastFailureReason: args.reasonCode,
    });
    return { released: true };
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

function findWorkItem(context, jobId) {
  return context.db
    .query("customerFlowWorkItems")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

function assertWorkerRequest(args) {
  assertWorkIdentity("job_placeholder", args.workerId);
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10
      || !Number.isSafeInteger(args.nowMs) || args.nowMs < 0
      || !Number.isInteger(args.leaseMs) || args.leaseMs < 30_000 || args.leaseMs > 300_000) {
    throw new Error("Work queue claim request is invalid.");
  }
}

function assertTimestampMilliseconds(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Work queue timestamp is invalid.");
  }
}

function assertWorkIdentity(jobId, workerId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)
      || !/^[A-Za-z0-9_-]{3,128}$/.test(workerId)) {
    throw new Error("Work queue identity is invalid.");
  }
}

function assertActiveClaim(item, workerId, nowMs) {
  if (item.state !== "claimed" || item.claim?.workerId !== workerId
      || item.claim.leaseExpiresAtMs < nowMs) {
    throw new Error("Work item claim is not active for this worker.");
  }
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
