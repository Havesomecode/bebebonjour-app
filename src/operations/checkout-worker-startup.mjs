import { ConvexHttpClient } from "convex/browser";

import { createProductionCheckoutWorker } from "./production-checkout-worker.mjs";
import { createOperationsWorkerRuntime } from "./operations-worker-runtime.mjs";

const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;

// The public HTTP route may import only checkout capabilities, never the
// private generation or publication operator graph.
export async function runCheckoutWorkerCommand({ client, environment = process.env, jobId } = {}) {
  if (!JOB_ID.test(jobId || "") || jobId !== environment.BEBEBONJOUR_CHECKOUT_JOB_ID
      || environment.BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS !== "create_checkout"
      || environment.BEBEBONJOUR_OPERATIONS_WORKER_LIMIT !== "1"
      || environment.BEBEBONJOUR_OPERATIONS_WORKER_ID !== "checkout-worker-fictional-26sep") {
    throw new Error("Checkout worker requires one pinned job and checkout-only scope.");
  }
  const workerToken = environment.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN;
  if (typeof workerToken !== "string" || Buffer.byteLength(workerToken) < 32) {
    throw new Error("Checkout worker token is unavailable.");
  }
  const convex = client || new ConvexHttpClient(environment.CONVEX_URL);
  const health = await convex.query("operations:workerHealth", { workerToken });
  if (health?.protocolVersion !== "1.0" || health?.scope !== "worker") {
    throw new Error("Checkout-only worker scope is unavailable.");
  }
  const { operationsCheckout, customerStore } = createProductionCheckoutWorker({ client: convex, environment });
  const runtime = createOperationsWorkerRuntime({
    client: convex, workerToken, enabledActions: ["create_checkout"],
    operationsCheckout, customerStore,
  });
  return runtime.runOnce({
    jobId, workerId: environment.BEBEBONJOUR_OPERATIONS_WORKER_ID, limit: 1, leaseMs: 120_000,
  });
}
