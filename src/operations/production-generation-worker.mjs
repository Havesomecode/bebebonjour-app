import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadJobScopedGenerationApproval } from "../fulfillment/job-scoped-generation-approval.mjs";
import { createTestAGenerationRunner } from "../fulfillment/test-a-generation-runner.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";

const defaultRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

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
  const { configuredRoot, artifactRoot } = requirePrivateArtifactRoot(
    environment.BEBEBONJOUR_GENERATION_ARTIFACT_ROOT,
    options.repositoryRoot || defaultRepositoryRoot,
  );
  const createRunner = options.createGenerationRunner || createTestAGenerationRunner;
  if (typeof createRunner !== "function") {
    throw new Error("Production generation runner is invalid.");
  }
  const fulfillmentStore = createConvexFulfillmentStore({ client, backendToken });
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
        const approvalPath = path.join(configuredRoot, "approvals", `${jobId}.json`);
        const editorialApproval = await loadJobScopedGenerationApproval({
          jobId,
          artifactRoot,
          configuredRoot,
          approvalPath,
        });
        const runner = createRunner({
          artifactRoot,
          editorialApproval,
          customerReader,
          store: fulfillmentStore,
        });
        if (
          typeof runner?.generate !== "function"
          || Object.keys(runner).some((key) => key !== "generate")
        ) {
          throw new Error("Production generation runner is invalid.");
        }
        return generationOptions.operationsEffectBoundary(
          Object.freeze({
            jobId,
            stage,
            operationsCommandId: generationOptions.operationsCommandId,
          }),
          () => runner.generate(jobId, {
            operationsCommandId: generationOptions.operationsCommandId,
          }),
        );
      },
    }),
  });
}

function requirePrivateArtifactRoot(value, repositoryRoot) {
  if (typeof value !== "string" || value.trim() !== value || !path.isAbsolute(value)) {
    throw new Error("BEBEBONJOUR_GENERATION_ARTIFACT_ROOT must be an absolute private directory.");
  }
  let metadata;
  let artifactRoot;
  let canonicalRepository;
  try {
    metadata = lstatSync(value);
    artifactRoot = realpathSync(value);
    canonicalRepository = realpathSync(repositoryRoot);
  } catch {
    throw new Error("BEBEBONJOUR_GENERATION_ARTIFACT_ROOT must be an existing private directory.");
  }
  const relative = path.relative(canonicalRepository, artifactRoot);
  const repositoryRelativeToArtifact = path.relative(artifactRoot, canonicalRepository);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
    || relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
    || repositoryRelativeToArtifact === ""
    || (!repositoryRelativeToArtifact.startsWith("..") && !path.isAbsolute(repositoryRelativeToArtifact))
  ) {
    throw new Error("BEBEBONJOUR_GENERATION_ARTIFACT_ROOT is not an isolated private directory.");
  }
  return Object.freeze({ configuredRoot: value, artifactRoot });
}

function requiredSecret(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return value;
}
