export function createInMemoryCustomerFlowStore() {
  const jobs = new Map();
  const submissions = new Map();
  const providerEvents = new Map();

  return {
    async createJob(job, idempotencyKey, response, requestDigest) {
      const existing = idempotencyKey ? submissions.get(idempotencyKey) : null;
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          return { conflict: true, created: false, response: null };
        }
        return { conflict: false, created: false, response: clone(existing.response) };
      }
      if (jobs.has(job.jobId)) throw new Error("Duplicate customer-flow job id.");

      jobs.set(job.jobId, clone(job));
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
  };
}

function clone(value) {
  return structuredClone(value);
}
