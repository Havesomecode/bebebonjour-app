export function createInMemoryCustomerFlowStore() {
  const jobs = new Map();
  const submissions = new Map();
  const providerEvents = new Map();
  const workItems = new Map();

  return {
    async createJob(job, idempotencyKey, response, requestDigest, options = {}) {
      const existing = idempotencyKey ? submissions.get(idempotencyKey) : null;
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          return { conflict: true, created: false, response: null };
        }
        return { conflict: false, created: false, response: clone(existing.response) };
      }
      if (jobs.has(job.jobId)) throw new Error("Duplicate customer-flow job id.");

      jobs.set(job.jobId, clone(job));
      if (options.enqueueWorkItem === true) {
        workItems.set(job.jobId, {
          jobId: job.jobId,
          source: "customer-intake",
          state: "pending",
          createdAt: job.createdAt,
          updatedAt: job.createdAt,
          attempts: 0,
          claim: null,
          kanbanTaskId: null,
          lastFailureReason: null,
        });
      }
      if (idempotencyKey) {
        submissions.set(idempotencyKey, clone({ requestDigest, response }));
      }
      return { conflict: false, created: true, response: clone(response) };
    },

    async readJob(jobId) {
      const job = jobs.get(jobId);
      return job ? clone(job) : null;
    },

    async updateJob(jobId, update) {
      const current = jobs.get(jobId);
      if (!current) return null;
      const next = update(clone(current));
      if (!next || next.jobId !== jobId) {
        throw new Error("Customer-flow updates must preserve the canonical job id.");
      }
      next.version = current.version + 1;
      jobs.set(jobId, clone(next));
      return clone(next);
    },

    async readProviderEvent(providerEventId) {
      const event = providerEvents.get(providerEventId);
      return event ? clone(event) : null;
    },

    async claimProviderEvent(providerEventId, fingerprint) {
      const existing = providerEvents.get(providerEventId);
      if (existing) return { created: false, event: clone(existing) };
      const event = { fingerprint, result: null };
      providerEvents.set(providerEventId, clone(event));
      return { created: true, event: clone(event) };
    },

    async completeProviderEvent(providerEventId, fingerprint, result) {
      const existing = providerEvents.get(providerEventId);
      if (!existing || existing.fingerprint !== fingerprint) {
        return { completed: false, event: existing ? clone(existing) : null };
      }
      if (existing.result) return { completed: false, event: clone(existing) };
      const event = { fingerprint, result: clone(result) };
      providerEvents.set(providerEventId, clone(event));
      return { completed: true, event: clone(event) };
    },

    async recordProviderEvent(providerEventId, event) {
      const existing = providerEvents.get(providerEventId);
      if (existing) return { created: false, event: clone(existing) };
      providerEvents.set(providerEventId, clone(event));
      return { created: true, event: clone(event) };
    },

    async claimWorkItems({ workerId, limit, nowMs, leaseMs }) {
      const available = [...workItems.values()]
        .filter((item) => item.state === "pending"
          || (item.state === "claimed" && item.claim.leaseExpiresAtMs <= nowMs))
        .slice(0, limit);
      return available.map((item) => {
        item.state = "claimed";
        item.updatedAt = new Date(nowMs).toISOString();
        item.attempts += 1;
        item.claim = { workerId, claimedAtMs: nowMs, leaseExpiresAtMs: nowMs + leaseMs };
        item.lastFailureReason = null;
        return clone({
          jobId: item.jobId,
          source: item.source,
          createdAt: item.createdAt,
          attempts: item.attempts,
        });
      });
    },

    async completeWorkItem({ jobId, workerId, kanbanTaskId, nowMs }) {
      const item = workItems.get(jobId);
      if (!item || item.state === "completed") {
        return { completed: false, kanbanTaskId: item?.kanbanTaskId || null };
      }
      assertClaim(item, workerId, nowMs);
      item.state = "completed";
      item.updatedAt = new Date(nowMs).toISOString();
      item.claim = null;
      item.kanbanTaskId = kanbanTaskId;
      item.lastFailureReason = null;
      return { completed: true, kanbanTaskId };
    },

    async releaseWorkItem({ jobId, workerId, reasonCode, nowMs }) {
      const item = workItems.get(jobId);
      if (!item || item.state === "completed") return { released: false };
      assertClaim(item, workerId, nowMs);
      item.state = "pending";
      item.updatedAt = new Date(nowMs).toISOString();
      item.claim = null;
      item.lastFailureReason = reasonCode;
      return { released: true };
    },
  };
}

function assertClaim(item, workerId, nowMs) {
  if (item.state !== "claimed" || item.claim?.workerId !== workerId
      || item.claim.leaseExpiresAtMs < nowMs) {
    throw new Error("Work item claim is not active for this worker.");
  }
}

function clone(value) {
  return structuredClone(value);
}
