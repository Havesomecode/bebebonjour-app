import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { runOperationsWorkerCommand } from "../../src/operations/operations-worker-startup.mjs";

const environment = Object.freeze({
  CONVEX_URL: "https://test-a.convex.cloud",
  BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: "worker-token-with-at-least-thirty-two-bytes",
  BEBEBONJOUR_OPERATIONS_WORKER_ID: "production-worker-1",
  BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "",
});
const generationEnvironment = Object.freeze({
  ...environment,
  BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
  BEBEBONJOUR_OPERATIONS_WORKER_LIMIT: "5",
  BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS: "300000",
  BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED: "true",
  BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64url"),
  BEBEBONJOUR_CODEX_MODEL: "gpt-5.6-sol",
  BEBEBONJOUR_CODEX_TIMEOUT_MS: "240000",
  BEBEBONJOUR_CODEX_AUTH_LEASE_MS: "290000",
  CRON_SECRET: "cron-secret-with-at-least-thirty-two-bytes",
});


test("no-action production worker proves scoped health and claims no command class", async () => {
  const calls = [];
  const result = await runOperationsWorkerCommand({
    environment,
    client: {
      async query(name, input) {
        calls.push([name, structuredClone(input)]);
        return { protocolVersion: "1.0", scope: "worker" };
      },
      async mutation(name, input) {
        calls.push([name, structuredClone(input)]);
        return [];
      },
    },
  });

  assert.deepEqual(result, {
    status: "ok",
    protocolVersion: "1.0",
    workerId: "production-worker-1",
    enabledActionCount: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
  });
  assert.deepEqual(calls.map(([name]) => name), [
    "operations:workerHealth",
    "operations:claimCommands",
  ]);
  assert.deepEqual(calls[1][1].actions, []);
  assert.equal(JSON.stringify(result).includes(environment.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN), false);
});

test("generation-only worker fences and completes one synthetic command without provider mutation", async () => {
  const calls = [];
  let syntheticEffects = 0;
  const command = {
    commandId: "command_synthetic_generate_000001",
    jobId: "job_synthetic_generate_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
    claim: {
      workerId: "production-worker-1",
      leaseToken: "synthetic-lease-token",
      leaseExpiresAtMs: Date.now() + 120_000,
    },
  };
  const result = await runOperationsWorkerCommand({
    environment: { ...environment, BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate" },
    client: {
      async query(name, input) {
        calls.push([name, structuredClone(input)]);
        return { protocolVersion: "1.0", scope: "worker" };
      },
      async mutation(name, input) {
        calls.push([name, structuredClone(input)]);
        if (name === "operations:claimCommands") return [structuredClone(command)];
        if (name === "operations:fenceCommand") return { active: true, command: structuredClone(command) };
        if (name === "operations:completeCommand") return { ok: true };
        throw new Error(`Unexpected mutation ${name}`);
      },
    },
    fulfillmentOrchestrator: {
      async runExpectedStage(jobId, stage, options) {
        assert.equal(jobId, command.jobId);
        assert.equal(stage, "prepare_review");
        await options.operationsEffectBoundary(stage, async ({ idempotencyKey }) => {
          assert.equal(idempotencyKey, command.commandId);
          syntheticEffects += 1;
        });
      },
    },
    fulfillmentStore: {
      async getJob(jobId) {
        assert.equal(jobId, command.jobId);
        return {
          version: 4,
          currentRevisionId: "revision_synthetic_001",
          artifactSets: [{
            artifactSetId: "artifact_set_synthetic_001",
            kind: "private_review",
            revisionId: "revision_synthetic_001",
            operationsCommandId: command.commandId,
          }],
        };
      },
    },
  });

  assert.deepEqual(result, {
    status: "ok",
    protocolVersion: "1.0",
    workerId: "production-worker-1",
    enabledActionCount: 1,
    claimed: 1,
    completed: 1,
    failed: 0,
  });
  assert.deepEqual(calls[1][1].actions, ["generate"]);
  assert.deepEqual(calls.map(([name]) => name), [
    "operations:workerHealth",
    "operations:claimCommands",
    "operations:fenceCommand",
    "operations:fenceCommand",
    "operations:completeCommand",
  ]);
  assert.equal(syntheticEffects, 1);
});

test("production generation entrypoint composes job-scoped generation without fulfillment injection", async () => {
  const jobId = "job_production_composition_001";
  const calls = [];
  let stageEffects = 0;
  const initializationOrder = [];
  const bootstrapAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: randomBytes(24).toString("base64url"),
      refresh_token: randomBytes(24).toString("base64url"),
    },
    last_refresh: "2026-09-06T00:00:00.000Z",
  });
  const command = {
    commandId: "command_production_generate_000001",
    jobId,
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
    claim: {
      workerId: "production-worker-1",
      leaseToken: "production-lease-token",
      leaseExpiresAtMs: Date.now() + 300_000,
    },
  };
  const client = {
    async query(name, input) {
      calls.push([name, structuredClone(input)]);
      if (name === "operations:workerHealth") return { protocolVersion: "1.0", scope: "worker" };
      if (name === "generation:getClaimedFulfillmentJob") {
        return {
          version: 4,
          currentRevisionId: "r1",
          artifactSets: [{
            artifactSetId: "artifact_set_production_001",
            kind: "private_review",
            revisionId: "r1",
            operationsCommandId: command.commandId,
          }],
        };
      }
      throw new Error(`Unexpected query ${name}`);
    },
    async mutation(name, input) {
      calls.push([name, structuredClone(input)]);
      if (name === "operations:claimCommands") return [structuredClone(command)];
      if (name === "operations:fenceCommand") return { active: true, command: structuredClone(command) };
      if (name === "operations:completeCommand") return { ok: true };
      throw new Error(`Unexpected mutation ${name}`);
    },
  };

  const result = await runOperationsWorkerCommand({
    environment: {
      ...generationEnvironment,
      BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64: Buffer.from(bootstrapAuthJson).toString("base64url"),
    },
    client,
    artifactStore: {
      async readEditorialApproval(receivedJobId) {
        assert.equal(receivedJobId, jobId);
        return { record: { jobId }, recordDigest: "a".repeat(64) };
      },
      async readArtifactSet() { return null; },
      async uploadArtifactSet() { throw new Error("Mock runner must not upload artifacts."); },
      async downloadArtifact() { throw new Error("Mock runner must not download artifacts."); },
    },
    createCodexAuthStateStore(options) {
      assert.equal(options.jobId, jobId);
      assert.equal(options.authorization.commandId, command.commandId);
      assert.equal(options.encryptionKey, generationEnvironment.BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY);
      return {
        kind: "synthetic-auth-store",
        async initialize(value) {
          assert.equal(value, bootstrapAuthJson);
          initializationOrder.push("auth_initialized");
        },
      };
    },
    async createCodexRuntime(options) {
      assert.deepEqual(initializationOrder, ["auth_initialized"]);
      assert.match(options.destinationRoot, /bebebonjour-generation-/u);
      return "/synthetic/codex";
    },
    createCodexComposer(options) {
      assert.equal(options.authStateStore.kind, "synthetic-auth-store");
      assert.equal(options.executable, "/synthetic/codex");
      assert.deepEqual(options.executableArgs, []);
      assert.equal(options.model, "gpt-5.6-sol");
      assert.equal(options.timeoutMs, 240_000);
      return { compose: async () => ({ synthetic: true }) };
    },
    createGenerationRunner(options) {
      assert.equal(options.editorialApproval.record.jobId, jobId);
      assert.equal(typeof options.customerReader.readJob, "function");
      assert.equal(typeof options.store.getJob, "function");
      assert.equal(typeof options.workspace.persistJobInput, "function");
      assert.equal(typeof options.compose, "function");
      return {
        async generate(receivedJobId, generationOptions) {
          assert.equal(receivedJobId, jobId);
          assert.equal(generationOptions.operationsCommandId, command.commandId);
          assert.equal(typeof generationOptions.operationsEffectBoundary, "function");
          await generationOptions.operationsEffectBoundary({
            jobId,
            stage: "prepare_review",
            attemptId: "attempt_production_generate_000001",
            operationsCommandId: command.commandId,
          }, async () => {
            assert.deepEqual(await options.compose({ synthetic: true }), { synthetic: true });
            stageEffects += 1;
          });
        },
      };
    },
  });

  assert.deepEqual(result, {
    status: "ok",
    protocolVersion: "1.0",
    workerId: "production-worker-1",
    enabledActionCount: 1,
    claimed: 1,
    completed: 1,
    failed: 0,
  });
  assert.equal(stageEffects, 1);
  assert.deepEqual(calls.map(([name]) => name), [
    "operations:workerHealth",
    "operations:claimCommands",
    "operations:fenceCommand",
    "operations:fenceCommand",
    "generation:getClaimedFulfillmentJob",
    "operations:completeCommand",
  ]);
});

test("worker startup fails before queue access when an uncomposed action is enabled", async () => {
  let calls = 0;
  await assert.rejects(
    runOperationsWorkerCommand({
      environment: { ...environment, BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "publish" },
      client: {
        async query() { calls += 1; },
        async mutation() { calls += 1; },
      },
    }),
    /only the generate action/u,
  );
  assert.equal(calls, 0);
});

test("production generation rejects incomplete or broad runtime authority before queue access", async () => {
  const environments = [
    {
      ...environment,
      BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
    },
    {
      ...generationEnvironment,
      CUSTOMER_FLOW_BACKEND_TOKEN: "broad-backend-token-with-at-least-thirty-two-bytes",
    },
  ];
  for (const invalidEnvironment of environments) {
    let calls = 0;
    await assert.rejects(
      runOperationsWorkerCommand({
        environment: invalidEnvironment,
        client: {
          async query() { calls += 1; },
          async mutation() { calls += 1; },
        },
      }),
      /(is required|CUSTOMER_FLOW_BACKEND_TOKEN is forbidden)/u,
    );
    assert.equal(calls, 0);
  }
});

test("production generation rejects a cron secret equal to the worker token before queue access", async () => {
  let calls = 0;
  await assert.rejects(
    runOperationsWorkerCommand({
      environment: {
        ...generationEnvironment,
        CRON_SECRET: generationEnvironment.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN,
      },
      client: {
        async query() { calls += 1; },
        async mutation() { calls += 1; },
      },
    }),
    /CRON_SECRET must be distinct from BEBEBONJOUR_OPERATIONS_WORKER_TOKEN/u,
  );
  assert.equal(calls, 0);
});

test("production generation rejects invalid Codex bootstrap and lease windows before queue access", async () => {
  const environments = [
    {
      ...generationEnvironment,
      BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64: "not+canonical",
    },
    {
      ...generationEnvironment,
      BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS: "119999",
    },
  ];
  for (const invalidEnvironment of environments) {
    let calls = 0;
    await assert.rejects(
      runOperationsWorkerCommand({
        environment: invalidEnvironment,
        client: {
          async query() { calls += 1; },
          async mutation() { calls += 1; },
        },
      }),
      /(BOOTSTRAP_B64 is invalid|Generation timing must remain exactly)/u,
    );
    assert.equal(calls, 0);
  }
});

test("worker startup rejects a mismatched health protocol before claiming", async () => {
  let mutations = 0;
  await assert.rejects(
    runOperationsWorkerCommand({
      environment,
      client: {
        async query() { return { protocolVersion: "2.0", scope: "worker" }; },
        async mutation() { mutations += 1; return []; },
      },
    }),
    /health protocol/u,
  );
  assert.equal(mutations, 0);
});
