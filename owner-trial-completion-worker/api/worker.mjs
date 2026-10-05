import { createLazyOperationsWorkerHttpHandler } from "../../src/http/operations-worker-handler.mjs";
import { runOwnerTrialCompletionWorkerCommand } from "../../src/operations/owner-trial-completion-worker.mjs";

export const config = { runtime: "nodejs", maxDuration: 300 };

export function createOwnerTrialCompletionHttpHandler(options = {}) {
  const environment = options.environment || process.env;
  const secret = environment.OWNER_TRIAL_INVOKE_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Owner trial manual invocation secret is required.");
  }
  const jobId = environment.OWNER_TRIAL_JOB_ID;
  if (!/^job_owner_trial_[a-f0-9]{32}$/u.test(jobId || "")) {
    throw new Error("Owner trial manual invocation job binding is required.");
  }
  return createLazyOperationsWorkerHttpHandler({ cronSecret: secret,
    runWorker: options.runWorker || (() => runOwnerTrialCompletionWorkerCommand({ environment, jobId })) });
}

export default async function ownerTrialCompletionHandler(request, response) {
  try {
    return await createOwnerTrialCompletionHttpHandler()(request, response);
  } catch {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.statusCode = 500;
    response.end(JSON.stringify({ status: "error", code: "worker_configuration_rejected" }));
  }
}
