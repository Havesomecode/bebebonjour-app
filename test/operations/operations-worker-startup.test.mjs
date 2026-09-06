import assert from "node:assert/strict";
import test from "node:test";

import { runOperationsWorkerCommand } from "../../src/operations/operations-worker-startup.mjs";

const environment = Object.freeze({
  CONVEX_URL: "https://test-a.convex.cloud",
  BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: "worker-token-with-at-least-thirty-two-bytes",
  BEBEBONJOUR_OPERATIONS_WORKER_ID: "production-worker-1",
  BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "",
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
    /runExpectedStage/u,
  );
  assert.equal(calls, 0);
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
