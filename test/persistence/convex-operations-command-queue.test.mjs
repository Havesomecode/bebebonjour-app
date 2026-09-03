import assert from "node:assert/strict";
import test from "node:test";

import { createConvexOperationsCommandQueue } from "../../src/persistence/convex-operations-command-queue.mjs";

const workerToken = "worker-token-at-least-32-characters-long";

test("Convex operations queue forwards authorization only to server mutations", async () => {
  const calls = [];
  const client = {
    async mutation(name, payload) {
      calls.push({ name, payload });
      return name.endsWith("claimCommands") ? [{ commandId: "command_1" }] : { ok: true };
    },
  };
  const queue = createConvexOperationsCommandQueue({ client, workerToken });

  const claimed = await queue.claimCommands({ workerId: "worker-1", limit: 1, leaseMs: 120_000 });
  await queue.fenceCommand({
    commandId: "command_1",
    workerId: "worker-1",
    leaseToken: "lease-token-1",
    leaseMs: 120_000,
    effectMayBeIssued: true,
  });
  await queue.completeCommand({
    commandId: "command_1",
    workerId: "worker-1",
    leaseToken: "lease-token-1",
    outcome: { code: "generated" },
  });
  await queue.failCommand({
    commandId: "command_2",
    workerId: "worker-1",
    leaseToken: "lease-token-2",
    reasonCode: "provider_unavailable",
    retryable: true,
  });

  assert.equal(claimed.length, 1);
  assert.deepEqual(calls.map(({ name }) => name), [
    "operations:claimCommands",
    "operations:fenceCommand",
    "operations:completeCommand",
    "operations:failCommand",
  ]);
  assert(calls.every(({ payload }) => payload.workerToken === workerToken));
  assert.equal(JSON.stringify(claimed).includes(workerToken), false);
});

test("Convex operations queue rejects weak configuration before I/O", () => {
  assert.throws(() => createConvexOperationsCommandQueue({ client: {}, workerToken }), /mutation client/i);
  assert.throws(() => createConvexOperationsCommandQueue({ client: { mutation() {} }, workerToken: "short" }), /worker token/i);
});
