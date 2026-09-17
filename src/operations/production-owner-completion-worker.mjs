import { ConvexHttpClient } from "convex/browser";

import { createOwnerCompletionCapabilities } from "../fulfillment/owner-completion-capabilities.mjs";
import { createOperationsWorkerRuntime } from "./operations-worker-runtime.mjs";
import { requireOwnerCompletionEnvironment } from "./owner-completion-policy.mjs";

export async function runOwnerCompletionWorkerCommand(options = {}) {
  const environment = options.environment || process.env;
  const policy = requireOwnerCompletionEnvironment(environment);
  const client = options.client || new ConvexHttpClient(environment.CONVEX_URL);
  const capabilities = options.capabilities || await createOwnerCompletionCapabilities({
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
  const runtime = createOperationsWorkerRuntime({
    client,
    workerToken: environment.BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN,
    enabledActions: policy.actions,
    fulfillmentOrchestrator: capabilities.fulfillmentOrchestrator,
    fulfillmentStore: capabilities.fulfillmentStore,
  });
  const health = await client.query("operations:workerHealth", {
    workerToken: environment.BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN,
  });
  if (health?.protocolVersion !== "1.0" || health?.scope !== "owner_completion") {
    throw new Error("Owner completion worker health protocol mismatch.");
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
