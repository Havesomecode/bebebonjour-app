import { createHash } from "node:crypto";

export function createLocalPaymentGateway({ baseUrl = "http://127.0.0.1:8787" } = {}) {
  const origin = loopbackOrigin(baseUrl);
  const sessions = new Map();
  const sessionsByJob = new Map();

  return {
    sessions,
    hasCheckoutForJob(jobId) {
      return sessionsByJob.has(jobId);
    },
    async createCheckoutSession(request) {
      const existing = sessions.get(request.idempotencyKey);
      if (existing) return structuredClone(existing);
      const suffix = shortDigest(request.idempotencyKey);
      const session = {
        id: `cs_test_local_${suffix}`,
        url: `${origin}/test-checkout/${encodeURIComponent(request.jobId)}`,
        mode: "test",
      };
      sessions.set(request.idempotencyKey, session);
      sessionsByJob.set(request.jobId, session.id);
      return structuredClone(session);
    },
  };
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:"
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/") {
    throw new Error("Local adapter base URL must be a loopback HTTP origin.");
  }
  return url.origin;
}

function shortDigest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
