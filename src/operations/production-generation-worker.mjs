import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCodexSubscriptionComposer } from "../fulfillment/codex-subscription-composer.mjs";
import { createHostedGenerationWorkspace } from "../fulfillment/hosted-generation-workspace.mjs";
import { createTestAGenerationRunner } from "../fulfillment/test-a-generation-runner.mjs";
import {
  createConvexCodexAuthStateStore,
  validateCodexAuthJson,
} from "../persistence/convex-codex-auth-state-store.mjs";
import { createConvexGenerationArtifactStore } from "../persistence/convex-generation-artifact-store.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";
import { materializePackagedCodexRuntime } from "./codex-packaged-runtime.mjs";

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
  const compositionConfig = codexCompositionConfig(options.environment || {});
  const createComposer = options.createCodexComposer || createCodexSubscriptionComposer;
  const createAuthStateStore = options.createCodexAuthStateStore || createConvexCodexAuthStateStore;
  const createCodexRuntime = options.createCodexRuntime || materializePackagedCodexRuntime;

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
          const authStateStore = createAuthStateStore({
            client,
            authorization,
            jobId,
            encryptionKey: compositionConfig.encryptionKey,
            authLeaseMs: compositionConfig.authLeaseMs,
          });
          let composerPromise = null;
          const compose = async (...args) => {
            composerPromise ||= (async () => {
              if (compositionConfig.bootstrapAuthJson !== null) {
                await authStateStore.initialize(compositionConfig.bootstrapAuthJson);
              }
              const executable = await createCodexRuntime({ destinationRoot: stagingRoot });
              return createComposer({
                authStateStore,
                environment: options.environment,
                executable,
                executableArgs: [],
                model: compositionConfig.model,
                timeoutMs: compositionConfig.timeoutMs,
              });
            })();
            const composer = await composerPromise;
            if (typeof composer?.compose !== "function") {
              throw new Error("Production Codex composition capability is invalid.");
            }
            return composer.compose(...args);
          };
          const runner = createRunner({
            editorialApproval,
            customerReader,
            store: fulfillmentStore,
            workspace,
            clock: options.clock,
            tokenFactory: options.tokenFactory,
            compose,
          });
          if (
            typeof runner?.generate !== "function"
            || Object.keys(runner).some((key) => key !== "generate")
          ) {
            throw new Error("Production generation runner is invalid.");
          }
          return await runner.generate(jobId, {
            operationsCommandId: generationOptions.operationsCommandId,
            operationsEffectBoundary: generationOptions.operationsEffectBoundary,
          });
        } finally {
          await rm(stagingRoot, { recursive: true, force: true });
        }
      },
    }),
  });
}

function codexCompositionConfig(environment) {
  if (environment.BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED !== "true") {
    throw new Error("BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED must equal true.");
  }
  const encryptionKey = environment.BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY;
  const keyBytes = typeof encryptionKey === "string" ? Buffer.from(encryptionKey, "base64url") : null;
  if (
    !keyBytes
    || keyBytes.byteLength !== 32
    || keyBytes.toString("base64url") !== encryptionKey
  ) {
    throw new Error("BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY must be a canonical 32-byte base64url key.");
  }
  const model = environment.BEBEBONJOUR_CODEX_MODEL;
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(model)) {
    throw new Error("BEBEBONJOUR_CODEX_MODEL is invalid.");
  }
  const timeoutMs = boundedInteger(
    environment.BEBEBONJOUR_CODEX_TIMEOUT_MS,
    "BEBEBONJOUR_CODEX_TIMEOUT_MS",
    1_000,
    240_000,
  );
  const authLeaseMs = boundedInteger(
    environment.BEBEBONJOUR_CODEX_AUTH_LEASE_MS,
    "BEBEBONJOUR_CODEX_AUTH_LEASE_MS",
    timeoutMs + 1_000,
    300_000,
  );
  const workerLeaseMs = boundedInteger(
    environment.BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS,
    "BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS",
    1_000,
    300_000,
  );
  if (timeoutMs !== 240_000 || authLeaseMs !== 290_000 || workerLeaseMs !== 300_000) {
    throw new Error("Generation timing must remain exactly 240000/290000/300000 ms.");
  }
  return Object.freeze({
    encryptionKey,
    model,
    timeoutMs,
    authLeaseMs,
    bootstrapAuthJson: optionalBootstrapAuthJson(environment.BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64),
  });
}

function optionalBootstrapAuthJson(value) {
  if (value === undefined) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 131_072
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64 is invalid.");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new Error("BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64 is invalid.");
  }
  try {
    return validateCodexAuthJson(bytes.toString("utf8")).toString("utf8");
  } catch {
    throw new Error("BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64 is invalid.");
  }
}

function boundedInteger(value, name, minimum, maximum) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid.`);
  }
  return parsed;
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
