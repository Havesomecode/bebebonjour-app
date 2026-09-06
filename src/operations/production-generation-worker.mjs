import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHostedGenerationWorkspace } from "../fulfillment/hosted-generation-workspace.mjs";
import { createTestAGenerationRunner } from "../fulfillment/test-a-generation-runner.mjs";
import { createConvexGenerationArtifactStore } from "../persistence/convex-generation-artifact-store.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";

const CLAIMED_FULFILLMENT_FUNCTIONS = Object.freeze({
  getJob: "generation:getClaimedFulfillmentJob",
  replaceJob: "generation:replaceClaimedFulfillmentJob",
});

export function createProductionGenerationWorker(options = {}) {
  const client = options.client;
  if (typeof client?.query !== "function" || typeof client?.mutation !== "function") {
    throw new Error("Production generation requires the canonical Convex client.");
  }
  const workerToken = requiredSecret(
    options.workerToken,
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
  );
  const createRunner = options.createGenerationRunner || createTestAGenerationRunner;
  if (typeof createRunner !== "function") {
    throw new Error("Production generation runner is invalid.");
  }

  function scopedFulfillmentStore(authority) {
    return createConvexFulfillmentStore({
      client,
      authorization: claimedAuthorization(workerToken, authority),
      functions: CLAIMED_FULFILLMENT_FUNCTIONS,
    });
  }

  return Object.freeze({
    fulfillmentStore: Object.freeze({
      getJob(jobId, authority) {
        return scopedFulfillmentStore(authority).getJob(jobId);
      },
    }),
    fulfillmentOrchestrator: Object.freeze({
      async runExpectedStage(jobId, stage, generationOptions = {}) {
        if (stage !== "prepare_review") {
          throw new Error("Production generation worker permits only prepare_review.");
        }
        if (typeof generationOptions.operationsEffectBoundary !== "function") {
          throw new Error("Production generation requires the Operations effect fence.");
        }
        const authorization = claimedAuthorization(workerToken, generationOptions.workerAuthority);
        return generationOptions.operationsEffectBoundary(
          Object.freeze({
            jobId,
            stage,
            operationsCommandId: generationOptions.operationsCommandId,
          }),
          async () => {
            const fulfillmentStore = scopedFulfillmentStore(generationOptions.workerAuthority);
            const artifactStore = options.artifactStore || createConvexGenerationArtifactStore({
              client,
              authorization,
              convexUrl: options.convexUrl || options.environment?.CONVEX_URL,
              fetchImpl: options.fetchImpl,
            });
            const editorialApproval = await artifactStore.readEditorialApproval(jobId);
            const customerReader = Object.freeze({
              readJob(claimedJobId) {
                return client.query("generation:readClaimedCustomerJob", {
                  ...authorization,
                  jobId: claimedJobId,
                });
              },
            });
            const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-"));
            try {
              const workspace = createHostedGenerationWorkspace({
                rootPath: stagingRoot,
                artifactStore,
              });
              const runner = createRunner({
                editorialApproval,
                customerReader,
                store: fulfillmentStore,
                workspace,
                clock: options.clock,
                tokenFactory: options.tokenFactory,
              });
              if (
                typeof runner?.generate !== "function"
                || Object.keys(runner).some((key) => key !== "generate")
              ) {
                throw new Error("Production generation runner is invalid.");
              }
              return await runner.generate(jobId, {
                operationsCommandId: generationOptions.operationsCommandId,
              });
            } finally {
              await rm(stagingRoot, { recursive: true, force: true });
            }
          },
        );
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
    throw new Error("Production generation requires an active worker claim.");
  }
  return Object.freeze({ workerToken, ...value });
}

function requiredSecret(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return value;
}
