import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHostedGenerationWorkspace } from "../fulfillment/hosted-generation-workspace.mjs";
import { createTestAGenerationRunner } from "../fulfillment/test-a-generation-runner.mjs";
import { createConvexGenerationArtifactStore } from "../persistence/convex-generation-artifact-store.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";

export function createProductionGenerationWorker(options = {}) {
  const environment = options.environment || process.env;
  const client = options.client;
  if (typeof client?.query !== "function" || typeof client?.mutation !== "function") {
    throw new Error("Production generation requires the canonical Convex client.");
  }
  const backendToken = requiredSecret(
    environment.CUSTOMER_FLOW_BACKEND_TOKEN,
    "CUSTOMER_FLOW_BACKEND_TOKEN",
  );
  const workerToken = requiredSecret(
    options.workerToken,
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
  );
  if (backendToken === workerToken) {
    throw new Error("Operations worker and customer-flow backend credentials must be distinct.");
  }
  const createRunner = options.createGenerationRunner || createTestAGenerationRunner;
  if (typeof createRunner !== "function") {
    throw new Error("Production generation runner is invalid.");
  }
  const fulfillmentStore = createConvexFulfillmentStore({ client, backendToken });
  const artifactStore = options.artifactStore || createConvexGenerationArtifactStore({
    client,
    workerToken,
    fetchImpl: options.fetchImpl,
  });
  const customerReader = Object.freeze({
    readJob(jobId) {
      return client.query("customerFlow:readJob", { backendToken, jobId });
    },
  });

  return Object.freeze({
    fulfillmentStore,
    fulfillmentOrchestrator: Object.freeze({
      async runExpectedStage(jobId, stage, generationOptions = {}) {
        if (stage !== "prepare_review") {
          throw new Error("Production generation worker permits only prepare_review.");
        }
        if (typeof generationOptions.operationsEffectBoundary !== "function") {
          throw new Error("Production generation requires the Operations effect fence.");
        }
        const editorialApproval = await artifactStore.readEditorialApproval(jobId);
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
          return await generationOptions.operationsEffectBoundary(
            Object.freeze({
              jobId,
              stage,
              operationsCommandId: generationOptions.operationsCommandId,
            }),
            () => runner.generate(jobId, {
              operationsCommandId: generationOptions.operationsCommandId,
            }),
          );
        } finally {
          await rm(stagingRoot, { recursive: true, force: true });
        }
      },
    }),
  });
}

function requiredSecret(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return value;
}
