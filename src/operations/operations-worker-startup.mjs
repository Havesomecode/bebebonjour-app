import { ConvexHttpClient } from "convex/browser";

import { requireReviewedTestAGenerationEnvironment } from "../config/test-a-hosted-provider-manifest.mjs";
import { createOperationsWorkerRuntime } from "./operations-worker-runtime.mjs";
import { createProductionGenerationWorker } from "./production-generation-worker.mjs";

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u;
const ALL_ACTIONS = new Set([
  "create_checkout", "generate", "approve_content", "request_content_changes", "reject_content",
  "render", "generate_narration", "approve_narration", "request_narration_changes", "reject_narration",
  "publish", "queue_delivery", "deliver", "retry", "reconcile",
]);

export async function runOperationsWorkerCommand(options = {}) {
  const environment = options.environment || process.env;
  const convexUrl = requiredHttpsOrigin(environment.CONVEX_URL, "CONVEX_URL");
  const workerToken = requiredSecret(
    environment.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN,
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
  );
  const workerId = requiredWorkerId(environment.BEBEBONJOUR_OPERATIONS_WORKER_ID);
  const enabledActions = parseActionScope(environment.BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS || "");
  const limit = boundedInteger(environment.BEBEBONJOUR_OPERATIONS_WORKER_LIMIT, 5, 1, 20);
  const leaseMs = boundedInteger(environment.BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS, 120_000, 1_000, 600_000);
  const client = options.client || new ConvexHttpClient(convexUrl);
  if (typeof client.query !== "function" || typeof client.mutation !== "function") {
    throw new Error("Operations worker Convex client is invalid.");
  }
  const injectedCapabilities = [
    options.operationsCheckout,
    options.customerStore,
    options.fulfillmentOrchestrator,
    options.fulfillmentStore,
    options.authorizeReviewDecision,
    options.reconcileExternalEffect,
  ].some((value) => value !== undefined);
  if (!injectedCapabilities && enabledActions.some((action) => action !== "generate")) {
    throw new Error("Production Operations worker permits only the generate action.");
  }
  if (!injectedCapabilities && enabledActions.includes("generate")) {
    requireReviewedTestAGenerationEnvironment(environment);
  }
  const productionGeneration = !injectedCapabilities && enabledActions.includes("generate")
    ? createProductionGenerationWorker({
        environment,
        client,
        convexUrl,
        workerToken,
        createGenerationRunner: options.createGenerationRunner,
        artifactStore: options.artifactStore,
        fetchImpl: options.fetchImpl,
        clock: options.clock,
        tokenFactory: options.tokenFactory,
      })
    : {};

  const runtime = createOperationsWorkerRuntime({
    client,
    workerToken,
    enabledActions,
    operationsCheckout: options.operationsCheckout,
    customerStore: options.customerStore,
    fulfillmentOrchestrator: options.fulfillmentOrchestrator || productionGeneration.fulfillmentOrchestrator,
    fulfillmentStore: options.fulfillmentStore || productionGeneration.fulfillmentStore,
    authorizeReviewDecision: options.authorizeReviewDecision,
    reconcileExternalEffect: options.reconcileExternalEffect,
  });
  const health = await client.query("operations:workerHealth", { workerToken });
  if (!health
    || Object.keys(health).sort().join("\0") !== "protocolVersion\0scope"
    || health.protocolVersion !== "1.0"
    || health.scope !== "worker") {
    throw new Error("Operations worker health protocol mismatch.");
  }
  const result = await runtime.runOnce({ workerId, limit, leaseMs });
  assertRunResult(result);
  return Object.freeze({
    status: "ok",
    protocolVersion: health.protocolVersion,
    workerId,
    enabledActionCount: enabledActions.length,
    ...result,
  });
}

export function parseActionScope(value) {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new Error("Operations worker action scope is invalid.");
  }
  const actions = value === "" ? [] : value.split(",");
  if (new Set(actions).size !== actions.length
    || actions.some((action) => !ALL_ACTIONS.has(action))) {
    throw new Error("Operations worker action scope is invalid.");
  }
  return Object.freeze([...actions].sort());
}

function requiredHttpsOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  if (url.protocol !== "https:"
    || url.origin !== value
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return value;
}

function requiredSecret(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return value;
}

function requiredWorkerId(value) {
  if (typeof value !== "string" || !WORKER_ID.test(value)) {
    throw new Error("BEBEBONJOUR_OPERATIONS_WORKER_ID is invalid.");
  }
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("Operations worker numeric configuration is invalid.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Operations worker numeric configuration is invalid.");
  }
  return parsed;
}

function assertRunResult(value) {
  if (!value
    || !Number.isInteger(value.claimed)
    || !Number.isInteger(value.completed)
    || !Number.isInteger(value.failed)
    || (value.expired !== undefined && !Number.isInteger(value.expired))) {
    throw new Error("Operations worker result is invalid.");
  }
}
