import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOperationsWorkerCommand } from "../../src/operations/operations-worker-startup.mjs";

const environment = Object.freeze({
  CONVEX_URL: "https://test-a.convex.cloud",
  BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: "worker-token-with-at-least-thirty-two-bytes",
  BEBEBONJOUR_OPERATIONS_WORKER_ID: "production-worker-1",
  BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "",
});

async function productionGenerationRoot(t, jobId) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-operations-generation-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const artifactRoot = path.join(parent, "artifacts");
  const approvalRoot = path.join(artifactRoot, "approvals");
  await mkdir(approvalRoot, { recursive: true, mode: 0o700 });
  await chmod(artifactRoot, 0o700);
  const sourceEvidence = {
    kind: "kanban_human_decision",
    reference: "kanban:t_synthetic_authority",
  };
  const record = {
    schemaVersion: "1.0",
    approvalType: "job_scoped_editorial_policy",
    jobId,
    policy: {
      id: "unknown_name_general_wishes",
      preserveSubmittedName: true,
      meaningAllowed: false,
      scripturalNameAssociationAllowed: false,
      genericBlessingsAllowed: true,
      maxStage: "content_review_required",
    },
    sourceEvidence,
    sourceDigest: createHash("sha256")
      .update(JSON.stringify(sourceEvidence))
      .digest("hex"),
  };
  await writeFile(
    path.join(approvalRoot, `${jobId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o400 },
  );
  return artifactRoot;
}

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

test("production generation entrypoint composes job-scoped generation without fulfillment injection", async (t) => {
  const jobId = "job_production_composition_001";
  const artifactRoot = await productionGenerationRoot(t, jobId);
  const canonicalArtifactRoot = await realpath(artifactRoot);
  const calls = [];
  let stageEffects = 0;
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
      leaseExpiresAtMs: Date.now() + 120_000,
    },
  };
  const client = {
    async query(name, input) {
      calls.push([name, structuredClone(input)]);
      if (name === "operations:workerHealth") return { protocolVersion: "1.0", scope: "worker" };
      if (name === "fulfillment:getJob") {
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
      ...environment,
      BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
      CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-with-at-least-thirty-two-bytes",
      BEBEBONJOUR_GENERATION_ARTIFACT_ROOT: artifactRoot,
    },
    client,
    createGenerationRunner(options) {
      assert.equal(options.artifactRoot, canonicalArtifactRoot);
      assert.equal(options.editorialApproval.record.jobId, jobId);
      assert.equal(typeof options.customerReader.readJob, "function");
      assert.equal(typeof options.store.getJob, "function");
      return {
        async generate(receivedJobId, generationOptions) {
          assert.equal(receivedJobId, jobId);
          assert.equal(generationOptions.operationsCommandId, command.commandId);
          assert.equal(generationOptions.operationsEffectBoundary, undefined);
          stageEffects += 1;
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
    "fulfillment:getJob",
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

test("production generation rejects missing or invalid private configuration before queue access", async (t) => {
  const artifactRoot = await productionGenerationRoot(t, "job_invalid_configuration_001");
  const invalidRoot = path.join(path.dirname(artifactRoot), "invalid-root");
  await mkdir(invalidRoot, { mode: 0o755 });
  const environments = [
    {
      ...environment,
      BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
      BEBEBONJOUR_GENERATION_ARTIFACT_ROOT: artifactRoot,
    },
    {
      ...environment,
      BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
      CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-with-at-least-thirty-two-bytes",
      BEBEBONJOUR_GENERATION_ARTIFACT_ROOT: invalidRoot,
    },
    {
      ...environment,
      BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
      CUSTOMER_FLOW_BACKEND_TOKEN: environment.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN,
      BEBEBONJOUR_GENERATION_ARTIFACT_ROOT: artifactRoot,
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
      /(CUSTOMER_FLOW_BACKEND_TOKEN|isolated private directory|credentials must be distinct)/u,
    );
    assert.equal(calls, 0);
  }

  const nestedRepository = path.join(artifactRoot, "nested-repository");
  await mkdir(nestedRepository);
  let ancestorCalls = 0;
  await assert.rejects(
    runOperationsWorkerCommand({
      environment: {
        ...environment,
        BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
        CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-with-at-least-thirty-two-bytes",
        BEBEBONJOUR_GENERATION_ARTIFACT_ROOT: artifactRoot,
      },
      repositoryRoot: nestedRepository,
      client: {
        async query() { ancestorCalls += 1; },
        async mutation() { ancestorCalls += 1; },
      },
    }),
    /isolated private directory/u,
  );
  assert.equal(ancestorCalls, 0);
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
