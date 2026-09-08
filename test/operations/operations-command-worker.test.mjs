import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperationsCommandWorker,
  OperationsCommandError,
} from "../../src/operations/operations-command-worker.mjs";
import { createOperationsActionHandlers } from "../../src/operations/operations-action-handlers.mjs";

function command(overrides = {}) {
  return {
    commandId: "command_worker_001",
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
    claim: {
      workerId: "worker-1",
      leaseToken: "lease-token-1",
      claimedAtMs: Date.parse("2026-09-02T21:59:00.000Z"),
      leaseExpiresAtMs: Date.parse("2026-09-02T22:02:00.000Z"),
    },
    ...overrides,
  };
}

test("worker executes claimed commands sequentially and records only bounded outcomes", async () => {
  const calls = [];
  const queue = {
    async claimCommands() {
      return [command(), command({ commandId: "command_worker_002", jobId: "job_ops_002" })];
    },
    async completeCommand(input) { calls.push(["complete", input]); },
    async failCommand(input) { calls.push(["fail", input]); },
    async fenceCommand(input) {
      calls.push(["fence", input]);
      return { active: true, command: command({ commandId: input.commandId }) };
    },
  };
  let concurrent = 0;
  let maximumConcurrent = 0;
  const worker = createOperationsCommandWorker({
    queue,
    handlers: {
      async generate({ jobId, fenceExternalEffect }) {
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        await Promise.resolve();
        concurrent -= 1;
        return fenceExternalEffect(async () => (
          { code: "generated", revisionId: `revision_${jobId}`, jobVersion: 4 }
        ));
      },
    },
    clock: () => new Date("2026-09-02T22:00:00.000Z"),
  });

  const result = await worker.runOnce({ workerId: "worker-1", limit: 2, leaseMs: 120_000 });

  assert.deepEqual(result, { claimed: 2, completed: 2, failed: 0 });
  assert.equal(maximumConcurrent, 1);
  assert.equal(calls.filter(([kind]) => kind === "complete").length, 2);
  assert.equal(calls.filter(([kind]) => kind === "fence").length, 4);
  assert.deepEqual(calls.find(([kind]) => kind === "complete")[1].outcome, {
    code: "generated",
    revisionId: "revision_job_ops_001",
    jobVersion: 4,
  });
  assert.equal(JSON.stringify(result).includes("job_ops_001"), false);
});

test("external-effect capability is single-use and carries deterministic provider idempotency", async () => {
  let effects = 0;
  const fences = [];
  const queue = {
    async claimCommands() { return [command({ action: "publish" })]; },
    async fenceCommand(input) {
      fences.push(input);
      return { active: true, command: command({ action: "publish" }) };
    },
    async completeCommand() {},
    async failCommand() { throw new Error("must not fail"); },
  };
  const worker = createOperationsCommandWorker({
    queue,
    handlers: {
      async publish({ fenceExternalEffect }) {
        const outcome = await fenceExternalEffect(async (effectContext) => {
          effects += 1;
          assert.deepEqual(effectContext, {
            idempotencyKey: "command_worker_001",
            fencingToken: "lease-token-1",
            leaseExpiresAtMs: Date.parse("2026-09-02T22:02:00.000Z"),
          });
          return { code: "published", publicationId: "publication_1", jobVersion: 4 };
        });
        await assert.rejects(
          fenceExternalEffect(async () => { effects += 1; }),
          /already.*used|already_used/i,
        );
        return outcome;
      },
    },
  });

  assert.deepEqual(
    await worker.runOnce({ workerId: "worker-1", limit: 1, leaseMs: 120_000 }),
    { claimed: 1, completed: 1, failed: 0 },
  );
  assert.equal(effects, 1);
  assert.equal(fences.length, 2);
});

test("a rejected completion is recorded and does not strand later claimed commands", async () => {
  const first = command({ commandId: "command_worker_complete_1", action: "render" });
  const second = command({ commandId: "command_worker_complete_2", action: "render" });
  const completed = [];
  const failed = [];
  const queue = {
    async claimCommands() { return [first, second]; },
    async fenceCommand(input) {
      return { active: true, command: input.commandId === first.commandId ? first : second };
    },
    async completeCommand(input) {
      if (input.commandId === first.commandId) throw new Error("authoritative state changed");
      completed.push(input.commandId);
    },
    async failCommand(input) { failed.push(input); },
  };
  const worker = createOperationsCommandWorker({
    queue,
    handlers: {
      async render() { return { code: "release_rendered", revisionId: "revision_1", artifactSetId: "artifact_1", jobVersion: 4 }; },
    },
  });

  assert.deepEqual(
    await worker.runOnce({ workerId: "worker-1", limit: 2, leaseMs: 120_000 }),
    { claimed: 2, completed: 1, failed: 1 },
  );
  assert.deepEqual(completed, [second.commandId]);
  assert.deepEqual(failed.map(({ commandId, reasonCode, retryable }) => ({ commandId, reasonCode, retryable })), [{
    commandId: first.commandId,
    reasonCode: "command_completion_rejected",
    retryable: false,
  }]);
});

test("a preflight fence failure does not strand later claimed commands", async () => {
  const first = command({ commandId: "command_worker_fence_1", action: "render" });
  const second = command({ commandId: "command_worker_fence_2", action: "render" });
  const completed = [];
  const queue = {
    async claimCommands() { return [first, second]; },
    async fenceCommand(input) {
      if (input.commandId === first.commandId) throw new Error("transient queue failure");
      return { active: true, command: second };
    },
    async completeCommand(input) { completed.push(input.commandId); },
    async failCommand() { throw new Error("must not fail an unverified claim"); },
  };
  const worker = createOperationsCommandWorker({
    queue,
    handlers: {
      async render() {
        return { code: "release_rendered", revisionId: "revision_1", artifactSetId: "artifact_1", jobVersion: 4 };
      },
    },
  });

  assert.deepEqual(
    await worker.runOnce({ workerId: "worker-1", limit: 2, leaseMs: 120_000 }),
    { claimed: 2, completed: 1, failed: 0, expired: 1 },
  );
  assert.deepEqual(completed, [second.commandId]);
});

test("an atomically recovered effect fence preserves active_claim_expired and is not failed twice", async () => {
  const claimed = command();
  let fenceCount = 0;
  const queue = {
    async claimCommands() { return [claimed]; },
    async fenceCommand() {
      fenceCount += 1;
      return fenceCount === 1
        ? { active: true, command: claimed }
        : { active: false, command: null };
    },
    async completeCommand() { throw new Error("must not complete"); },
    async failCommand() { throw new Error("must not fail an atomically recovered stage"); },
  };
  const worker = createOperationsCommandWorker({
    queue,
    handlers: {
      async generate({ fenceExternalEffect }) {
        return fenceExternalEffect(async () => {
          throw new Error("must not invoke provider mutation");
        });
      },
    },
  });

  assert.deepEqual(
    await worker.runOnce({ workerId: "worker-1", limit: 1, leaseMs: 120_000 }),
    { claimed: 1, completed: 0, failed: 0, expired: 1 },
  );
});

test("unsupported and classified handler failures are recorded without exception text", async () => {
  const failures = [];
  const claimed = [
    command({ commandId: "command_worker_003", action: "unknown_action" }),
    command({ commandId: "command_worker_004", action: "generate" }),
  ];
  const queue = {
    async claimCommands() { return claimed; },
    async completeCommand() { throw new Error("must not complete"); },
    async failCommand(input) { failures.push(input); },
    async fenceCommand(input) {
      return { active: true, command: claimed.find((entry) => entry.commandId === input.commandId) };
    },
  };
  const worker = createOperationsCommandWorker({
    queue,
    handlers: {
      async generate() {
        throw new OperationsCommandError("provider_unavailable", { retryable: true, cause: new Error("private detail") });
      },
    },
    clock: () => new Date("2026-09-02T22:00:00.000Z"),
  });

  const result = await worker.runOnce({ workerId: "worker-1", limit: 2, leaseMs: 120_000 });

  assert.deepEqual(result, { claimed: 2, completed: 0, failed: 2 });
  assert.deepEqual(failures.map(({ reasonCode, retryable }) => ({ reasonCode, retryable })), [
    { reasonCode: "unsupported_action", retryable: false },
    { reasonCode: "provider_unavailable", retryable: true },
  ]);
  assert.equal(JSON.stringify(failures).includes("private detail"), false);
});

test("worker preserves trusted action-handler retry classification", async () => {
  const failures = [];
  const claimed = command();
  const queue = {
    async claimCommands() { return [claimed]; },
    async fenceCommand() { return { active: true, command: claimed }; },
    async completeCommand() { throw new Error("must not complete"); },
    async failCommand(input) { failures.push(input); },
  };
  const handlers = createOperationsActionHandlers({
    operationsCheckout: { async createCheckout() {} },
    customerStore: { async readJob() { return null; } },
    fulfillmentOrchestrator: {
      async runExpectedStage(_jobId, _stage, options) {
        await options.operationsEffectBoundary({}, async () => {});
      },
      async recordReviewDecision() {},
      async queueDelivery() {},
      async resumeRetry() {},
    },
    fulfillmentStore: { async getJob() { return null; } },
    async authorizeReviewDecision() {},
    async reconcileExternalEffect() {},
  });
  const worker = createOperationsCommandWorker({ queue, handlers });

  assert.deepEqual(
    await worker.runOnce({ workerId: "worker-1", limit: 1, leaseMs: 120_000 }),
    { claimed: 1, completed: 0, failed: 1 },
  );
  assert.deepEqual(failures.map(({ reasonCode, retryable }) => ({ reasonCode, retryable })), [{
    reasonCode: "canonical_readback_missing",
    retryable: true,
  }]);
});

test("worker never invokes a handler after its command lease has expired", async () => {
  let handlerCalls = 0;
  const expired = command({
    action: "publish",
    claim: {
      workerId: "worker-1",
      leaseToken: "lease-token-expired",
      claimedAtMs: Date.parse("2026-09-02T21:50:00.000Z"),
      leaseExpiresAtMs: Date.parse("2026-09-02T21:59:00.000Z"),
    },
  });
  const queue = {
    async claimCommands() { return [expired]; },
    async fenceCommand() { return { active: false, command: null }; },
    async completeCommand() { throw new Error("must not complete"); },
    async failCommand() { throw new Error("must not fail an expired claim"); },
  };
  const worker = createOperationsCommandWorker({
    queue,
    handlers: { async publish() { handlerCalls += 1; } },
    clock: () => new Date("2026-09-02T22:00:00.000Z"),
  });

  const result = await worker.runOnce({ workerId: "worker-1", limit: 1, leaseMs: 120_000 });

  assert.deepEqual(result, { claimed: 1, completed: 0, failed: 0, expired: 1 });
  assert.equal(handlerCalls, 0);
});
