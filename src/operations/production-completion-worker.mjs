import { ConvexHttpClient } from "convex/browser";

import { requireReviewedTestACompletionEnvironment } from "../config/test-a-hosted-provider-manifest.mjs";
import { createOperationsWorkerRuntime } from "./operations-worker-runtime.mjs";

export const TEST_A_COMPLETION_JOB_ID = "job_03c25b08-8476-4fe1-923b-43d73feab3ff";
export const TEST_A_COMPLETION_ACTIONS = Object.freeze([
  "approve_content",
  "render",
  "publish",
  "queue_delivery",
  "deliver",
  "retry",
]);
export const TEST_A_COMPLETION_LEASE_MS = 300_000;
const ACTION_SCOPE = TEST_A_COMPLETION_ACTIONS.join(",");
export function requireTestACompletionEnvironment(environment = process.env) {
  environment = requireReviewedTestACompletionEnvironment(environment);
  const jobId = requiredExact(
    environment,
    "BEBEBONJOUR_TEST_A_COMPLETION_JOB_ID",
    TEST_A_COMPLETION_JOB_ID,
  );
  requiredHttpsOrigin(environment, "CONVEX_URL");
  requiredSecret(environment, "BEBEBONJOUR_COMPLETION_WORKER_TOKEN", 32);
  requiredExact(environment, "BEBEBONJOUR_OPERATIONS_WORKER_ID", "test-a-completion-worker");
  requiredExact(environment, "BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS", ACTION_SCOPE);
  requiredExact(environment, "BEBEBONJOUR_OPERATIONS_WORKER_LIMIT", "1");
  requiredExact(environment, "BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS", String(TEST_A_COMPLETION_LEASE_MS));
  requiredSecret(environment, "BEBEBONJOUR_APPROVAL_HMAC_KEY", 32);
  const approvalId = requiredString(environment, "BEBEBONJOUR_TEST_A_APPROVAL_ID");
  if (!/^approval_[a-f0-9]{24}$/u.test(approvalId)) {
    throw new Error("TEST-A completion approval id is invalid.");
  }

  requiredString(environment, "VERCEL_TOKEN");
  requiredSecret(environment, "VERCEL_PROTECTION_BYPASS_SECRET", 32);
  requiredBase64(environment, "VERCEL_BUILD_INSPECTION_B64", 65_536);
  const resendApiKey = requiredString(environment, "RESEND_API_KEY");
  if (!resendApiKey.startsWith("re_")) throw new Error("TEST-A completion Resend key is invalid.");
  requiredString(environment, "RESEND_FROM");
  requiredHttpsOrigin(environment, "TEST_A_PUBLICATION_ORIGIN");
  for (const name of [
    "TEST_A_PUBLICATION_VERCEL_TEAM_ID",
    "TEST_A_PUBLICATION_VERCEL_PROJECT_ID",
    "TEST_A_PUBLICATION_VERCEL_PROJECT_NAME",
  ]) requiredString(environment, name);
  requiredSecret(environment, "CRON_SECRET", 32);
  if (environment.CRON_SECRET === environment.BEBEBONJOUR_COMPLETION_WORKER_TOKEN) {
    throw new Error("Completion CRON_SECRET must be distinct from the completion worker token.");
  }
  return Object.freeze({
    jobId,
    approvalId,
    workerId: "test-a-completion-worker",
    actions: TEST_A_COMPLETION_ACTIONS,
    limit: 1,
    leaseMs: TEST_A_COMPLETION_LEASE_MS,
  });
}

export async function runTestACompletionWorkerCommand(options = {}) {
  const environment = requireReviewedTestACompletionEnvironment(options.environment || process.env);
  const policy = requireTestACompletionEnvironment(environment);
  const client = options.client || new ConvexHttpClient(requiredHttpsOrigin(environment, "CONVEX_URL"));
  const createCapabilities = options.createCapabilities
    || (await import("../fulfillment/test-a-completion-capabilities.mjs")).createTestACompletionCapabilities;
  const capabilities = options.capabilities || await createCapabilities({
    environment,
    client,
    policy,
    fulfillmentStore: options.fulfillmentStore,
    fetch: options.fetch,
    resend: options.resend,
    publicationProvider: options.publicationProvider,
    clock: options.clock,
    tokenFactory: options.tokenFactory,
  });
  if (!capabilities) {
    throw new Error("TEST-A completion provider capabilities are unavailable.");
  }
  const runtime = createOperationsWorkerRuntime({
    client,
    workerToken: environment.BEBEBONJOUR_COMPLETION_WORKER_TOKEN,
    enabledActions: policy.actions,
    fulfillmentOrchestrator: capabilities.fulfillmentOrchestrator,
    fulfillmentStore: capabilities.fulfillmentStore,
    authorizeReviewDecision: capabilities.authorizeReviewDecision,
  });
  const health = await client.query("operations:workerHealth", {
    workerToken: environment.BEBEBONJOUR_COMPLETION_WORKER_TOKEN,
  });
  if (health?.protocolVersion !== "1.0" || health?.scope !== "completion") {
    throw new Error("TEST-A completion worker health protocol mismatch.");
  }
  const result = await runtime.runOnce(policy);
  return Object.freeze({
    status: "ok",
    protocolVersion: "1.0",
    workerId: policy.workerId,
    jobId: policy.jobId,
    enabledActionCount: policy.actions.length,
    ...result,
  });
}

function requiredExact(environment, name, expected) {
  const value = requiredString(environment, name);
  if (value !== expected) throw new Error(`${name} must match the exact TEST-A completion policy.`);
  return expected;
}

function requiredString(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  return value.trim();
}

function requiredSecret(environment, name, minimumBytes) {
  const value = requiredString(environment, name);
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes.`);
  }
  return value;
}

function requiredHttpsOrigin(environment, name) {
  const value = requiredString(environment, name);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return value;
}

function requiredBase64(environment, name, maximumBytes) {
  const value = requiredString(environment, name);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be canonical bounded base64.`);
  }
  return decoded;
}
