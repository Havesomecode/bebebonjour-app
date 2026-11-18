const NARRATION_ACTION = "narration:generateNarrationReview";
const NARRATION_FULFILLMENT_READ = "narration:readNarrationFulfillmentJob";

export function createProductionNarrationWorker(options = {}) {
  const client = options.client;
  if (
    typeof client?.query !== "function"
    || typeof client?.action !== "function"
  ) {
    throw new Error("Production narration requires a Convex client with query and action methods.");
  }
  const workerToken = requiredSecret(
    options.workerToken,
    "BEBEBONJOUR_NARRATION_WORKER_TOKEN",
  );

  function authorizationFor(workerAuthority) {
    return claimedAuthorization(workerToken, workerAuthority);
  }

  return Object.freeze({
    fulfillmentStore: Object.freeze({
      getJob(jobId, workerAuthority) {
        return client.query(NARRATION_FULFILLMENT_READ, {
          ...authorizationFor(workerAuthority),
          jobId,
        });
      },
    }),
    fulfillmentOrchestrator: Object.freeze({
      async runExpectedStage(jobId, stage, options = {}) {
        if (stage !== "generate_tts") {
          throw new Error("Production narration worker permits only generate_tts.");
        }
        if (typeof options.operationsEffectBoundary !== "function") {
          throw new Error("Production narration requires the Operations effect fence.");
        }
        const authorization = authorizationFor(options.workerAuthority);
        return options.operationsEffectBoundary({
          jobId,
          stage,
          operationsCommandId: options.operationsCommandId,
        }, () => client.action(NARRATION_ACTION, { ...authorization, jobId }));
      },
    }),
  });
}

function claimedAuthorization(workerToken, value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== "commandId\0leaseToken\0workerId"
    || typeof value.commandId !== "string"
    || value.commandId === ""
    || typeof value.workerId !== "string"
    || value.workerId === ""
    || typeof value.leaseToken !== "string"
    || value.leaseToken.length < 8
  ) {
    throw new Error("Production narration requires an active worker claim.");
  }
  return Object.freeze({ workerToken, ...value });
}

function requiredSecret(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return value;
}
