import assert from "node:assert/strict";
import test from "node:test";

import { createOperationsWorkerRuntime } from "../../src/operations/operations-worker-runtime.mjs";

const workerToken = "worker-token-with-at-least-thirty-two-bytes";

function dependencies(overrides = {}) {
  let customer = {
    jobId: "job_runtime_001",
    version: 2,
    payment: { checkout: null },
  };
  const calls = [];
  const client = {
    async mutation(name, input) {
      calls.push([name, structuredClone(input)]);
      if (name === "operations:claimCommands") {
        return [{
          commandId: "command_runtime_checkout_000001",
          jobId: "job_runtime_001",
          action: "create_checkout",
          expectedState: "awaiting_payment",
          expectedVersion: 1,
          payload: {},
          claim: {
            workerId: "runtime-worker",
            leaseToken: "lease_runtime_001",
            leaseExpiresAtMs: Date.now() + 60_000,
          },
        }];
      }
      if (name === "operations:fenceCommand") {
        return {
          active: true,
          command: {
            commandId: input.commandId,
            jobId: "job_runtime_001",
            action: "create_checkout",
            expectedState: "awaiting_payment",
            expectedVersion: 1,
            payload: {},
            claim: {
              workerId: input.workerId,
              leaseToken: input.leaseToken,
              leaseExpiresAtMs: Date.now() + 60_000,
            },
          },
        };
      }
      if (name === "operations:completeCommand") return { completed: true };
      throw new Error(`Unexpected mutation ${name}`);
    },
  };
  const operationsCheckout = {
    async createCheckout(jobId, commandId) {
      calls.push(["provider:checkout", jobId, commandId]);
      customer = {
        ...customer,
        version: 3,
        payment: {
          checkout: {
            sessionId: "cs_runtime_001",
            checkoutUrl: "https://checkout.example.test/runtime",
            operationsCommandId: commandId,
          },
        },
      };
    },
  };
  const fulfillmentOrchestrator = {
    async runExpectedStage() {},
    async recordReviewDecision() {},
    async queueDelivery() {},
    async resumeRetry() {},
  };
  return {
    calls,
    options: {
      client,
      workerToken,
      operationsCheckout,
      customerStore: { async readJob() { return structuredClone(customer); } },
      fulfillmentOrchestrator,
      fulfillmentStore: { async getJob() { return { version: 1, events: [] }; } },
      async authorizeReviewDecision() { throw new Error("not used"); },
      async reconcileExternalEffect() { throw new Error("not used"); },
      ...overrides,
    },
  };
}

test("worker runtime composes the scoped Convex queue with canonical action handlers", async () => {
  const { calls, options } = dependencies();
  const runtime = createOperationsWorkerRuntime(options);
  const result = await runtime.runOnce({ workerId: "runtime-worker", limit: 1, leaseMs: 60_000 });

  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.equal(calls.filter(([name]) => name === "operations:fenceCommand").length, 2);
  assert.deepEqual(
    calls.find(([name]) => name === "provider:checkout"),
    ["provider:checkout", "job_runtime_001", "command_runtime_checkout_000001"],
  );
  const completion = calls.find(([name]) => name === "operations:completeCommand");
  assert.deepEqual(completion[1].outcome, {
    code: "checkout_available",
    checkoutSessionId: "cs_runtime_001",
    checkoutUrl: "https://checkout.example.test/runtime",
    jobVersion: 3,
  });
  for (const [name, input] of calls.filter(([name]) => name.startsWith("operations:"))) {
    assert.equal(input.workerToken, workerToken, `${name} did not receive the scoped worker token`);
  }
});

test("worker runtime supports an explicit no-action health deployment without provider capabilities", async () => {
  const calls = [];
  const runtime = createOperationsWorkerRuntime({
    client: {
      async mutation(name, input) {
        calls.push([name, structuredClone(input)]);
        if (name === "operations:claimCommands") return [];
        throw new Error(`Unexpected mutation ${name}`);
      },
    },
    workerToken,
    enabledActions: [],
  });
  assert.deepEqual(
    await runtime.runOnce({ workerId: "health-worker", limit: 1, leaseMs: 60_000 }),
    { claimed: 0, completed: 0, failed: 0 },
  );
  assert.deepEqual(calls, [["operations:claimCommands", {
    workerToken,
    workerId: "health-worker",
    actions: [],
    limit: 1,
    leaseMs: 60_000,
  }]]);
});

test("worker runtime rejects missing trusted capabilities before claiming commands", () => {
  const { options } = dependencies({ operationsCheckout: null });
  assert.throws(
    () => createOperationsWorkerRuntime(options),
    /createCheckout/u,
  );
});
