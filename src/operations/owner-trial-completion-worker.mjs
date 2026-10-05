import { ConvexHttpClient } from "convex/browser";
import { createOperationsWorkerRuntime } from "./operations-worker-runtime.mjs";
import { createOwnerTrialCompletionCapabilities } from "../fulfillment/owner-trial-completion-capabilities.mjs";

export const OWNER_TRIAL_COMPLETION_WORKER_ID = "owner-trial-completion-worker";
export const OWNER_TRIAL_COMPLETION_ACTIONS = Object.freeze(["publish", "queue_delivery", "deliver"]);

export async function runOwnerTrialCompletionWorkerCommand(options = {}) {
  if (options.supersedePresent === true) {
    const { runOwnerTrialPublicationSupersession } = await import("./owner-trial-publication-supersession-worker.mjs");
    return runOwnerTrialPublicationSupersession(options);
  }
  if (options.reconcilePresent === true) {
    const { runOwnerTrialPresentReconciliation } = await import("./owner-trial-present-reconciliation-worker.mjs");
    return runOwnerTrialPresentReconciliation(options);
  }
  const environment = options.environment || process.env;
  const jobId = options.jobId;
  const token = environment.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN;
  if (!/^job_owner_trial_[a-f0-9]{32}$/u.test(jobId || "") || typeof token !== "string" || token.length < 32) {
    throw new Error("Owner trial completion requires the exact ticket job and scoped worker token.");
  }
  for (const name of ["CRON_SECRET", "BEBEBONJOUR_OPERATIONS_TOKEN", "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
    "BEBEBONJOUR_TTS_WORKER_TOKEN", "BEBEBONJOUR_NARRATION_WORKER_TOKEN", "CUSTOMER_FLOW_BACKEND_TOKEN",
    "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_APPROVAL_HMAC_KEY"]) {
    if (environment[name] === token) throw new Error("Owner trial completion credentials must be role-separated.");
  }
  const client = options.client || new ConvexHttpClient(environment.CONVEX_URL);
  // No automatic enqueue: only the operator-requested exact ticket job is claimed.
  const policy = await client.query("ownerTrial:completionPolicy", { completionToken: token, jobId });
  if (policy?.jobId !== jobId || policy.workerId !== OWNER_TRIAL_COMPLETION_WORKER_ID) {
    throw new Error("Owner trial backend completion policy is unavailable.");
  }
  const capabilities = await createOwnerTrialCompletionCapabilities({ ...options, environment, policy, client });
  const runtime = createOperationsWorkerRuntime({ client, workerToken: token,
    enabledActions: OWNER_TRIAL_COMPLETION_ACTIONS,
    fulfillmentStore: capabilities.fulfillmentStore,
    fulfillmentOrchestrator: capabilities.fulfillmentOrchestrator });
  const result = await runtime.runOnce({ workerId: OWNER_TRIAL_COMPLETION_WORKER_ID,
    actions: OWNER_TRIAL_COMPLETION_ACTIONS, jobId, limit: 1, leaseMs: 300_000 });
  return Object.freeze({ status: "ok", workerId: OWNER_TRIAL_COMPLETION_WORKER_ID, jobId, ...result });
}
