import { ConvexHttpClient } from "convex/browser";

import { createOperationsWorkerRuntime } from "./operations-worker-runtime.mjs";

const ACTIONS = Object.freeze(["publish", "queue_delivery", "deliver"]);
const LEASE_MS = 300_000;
const OWNER_JOB_ID = "job_narration_test_650a15d1-39bd-4dec-bc0d-3519ace71aa7";
const TEST_A_JOB_ID = "job_03c25b08-8476-4fe1-923b-43d73feab3ff";

export function requireCanonicalTestCompletionEnvironment(environment = process.env) {
  const jobId = required(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_JOB_ID");
  if (!/^job_[A-Za-z0-9_-]{1,156}$/u.test(jobId) || [OWNER_JOB_ID, TEST_A_JOB_ID].includes(jobId)) {
    throw new Error("Canonical completion requires a distinct fictional TEST job ID.");
  }
  const revisionId = required(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_REVISION_ID");
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(revisionId)) throw new Error("Canonical completion revision is invalid.");
  const manifestDigest = required(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_MANIFEST_DIGEST");
  if (!/^[a-f0-9]{64}$/u.test(manifestDigest)) throw new Error("Canonical completion manifest digest is invalid.");
  const contentApprovalId = approvalId(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID");
  const narrationApprovalId = environment.BEBEBONJOUR_CANONICAL_COMPLETION_NARRATION_APPROVAL_ID
    ? approvalId(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_NARRATION_APPROVAL_ID") : null;
  const recipient = required(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT");
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(recipient)
      || recipient.toLowerCase() === "z@havesomecode.io") {
    throw new Error("Canonical completion requires an explicit disposable recipient, not the owner.");
  }
  exact(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_ID", "canonical-test-completion-worker");
  exact(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_ACTIONS", ACTIONS.join(","));
  exact(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_LIMIT", "1");
  exact(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_LEASE_MS", String(LEASE_MS));
  secret(environment, "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN");
  secret(environment, "BEBEBONJOUR_APPROVAL_HMAC_KEY");
  secret(environment, "CRON_SECRET");
  if (environment.CRON_SECRET === environment.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN
      || environment.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN === environment.BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN
      || environment.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN === environment.BEBEBONJOUR_COMPLETION_WORKER_TOKEN) {
    throw new Error("Canonical completion requires a distinct scoped worker token.");
  }
  origin(environment, "CONVEX_URL");
  origin(environment, "CANONICAL_PUBLICATION_ORIGIN");
  for (const name of ["CANONICAL_PUBLICATION_VERCEL_TEAM_ID", "CANONICAL_PUBLICATION_VERCEL_PROJECT_ID",
    "CANONICAL_PUBLICATION_VERCEL_PROJECT_NAME", "VERCEL_TOKEN"]) required(environment, name);
  secret(environment, "VERCEL_PROTECTION_BYPASS_SECRET");
  const encoded = required(environment, "VERCEL_BUILD_INSPECTION_B64");
  const inspection = Buffer.from(encoded, "base64");
  if (!inspection.length || inspection.length > 65_536 || inspection.toString("base64") !== encoded) {
    throw new Error("Canonical Vercel inspection must be canonical bounded base64.");
  }
  return Object.freeze({ jobId, revisionId, manifestDigest, contentApprovalId, narrationApprovalId, recipient,
    targetRef: `cloudflare:fictional:${jobId}`, workerId: "canonical-test-completion-worker", actions: ACTIONS,
    limit: 1, leaseMs: LEASE_MS });
}

export async function runCanonicalTestCompletionWorkerCommand(options = {}) {
  const environment = options.environment || process.env;
  const policy = requireCanonicalTestCompletionEnvironment(environment);
  const client = options.client || new ConvexHttpClient(environment.CONVEX_URL);
  const health = await client.query("operations:workerHealth", {
    workerToken: environment.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN,
  });
  if (health?.protocolVersion !== "1.0" || health?.scope !== "canonical_test_completion") {
    throw new Error("Canonical TEST completion backend scope/protocol is unavailable; refusing to claim commands.");
  }
  const createCapabilities = options.createCapabilities ||
    (await import("../fulfillment/canonical-test-completion-capabilities.mjs")).createCanonicalTestCompletionCapabilities;
  const capabilities = options.capabilities || await createCapabilities({ ...options, environment, policy, client });
  // The backend enqueues only a signed, exact, configured release.
  await client.mutation("operations:queueCanonicalPublication", {
    workerToken: environment.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN,
    jobId: policy.jobId,
  });
  const runtime = createOperationsWorkerRuntime({
    client, workerToken: environment.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN,
    enabledActions: policy.actions, fulfillmentOrchestrator: capabilities.fulfillmentOrchestrator,
    fulfillmentStore: capabilities.fulfillmentStore,
  });
  const result = await runtime.runOnce(policy);
  return Object.freeze({ status: "ok", workerId: policy.workerId, jobId: policy.jobId, ...result });
}

function required(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error(`${name} is required exactly.`);
  return value;
}
function exact(environment, name, expected) {
  if (required(environment, name) !== expected) throw new Error(`${name} must match the exact canonical TEST completion scope.`);
}
function secret(environment, name) {
  if (Buffer.byteLength(required(environment, name), "utf8") < 32) throw new Error(`${name} must have 32 bytes.`);
}
function approvalId(environment, name) {
  const value = required(environment, name);
  if (!/^approval_[a-f0-9]{24}$/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}
function origin(environment, name) {
  const value = required(environment, name);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return value;
}
