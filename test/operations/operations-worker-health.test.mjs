import assert from "node:assert/strict";
import test from "node:test";

import { runOperationsWorkerHealth } from "../../src/operations/operations-worker-health.mjs";

const environment = Object.freeze({
  CONVEX_URL: "https://test-a.convex.cloud",
  BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: "worker-token-with-at-least-thirty-two-bytes",
  BEBEBONJOUR_OPERATIONS_WORKER_ID: "vercel-health-only-1",
  BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "",
});

test("Vercel health worker queries health without claiming or executing commands", async () => {
  const calls = [];
  const result = await runOperationsWorkerHealth({
    environment,
    client: {
      async query(name, input) {
        calls.push([name, structuredClone(input)]);
        return { protocolVersion: "1.0", scope: "worker" };
      },
      async mutation() {
        throw new Error("Health-only worker must not mutate Convex state.");
      },
    },
  });

  assert.deepEqual(calls, [[
    "operations:workerHealth",
    { workerToken: environment.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN },
  ]]);
  assert.deepEqual(result, {
    status: "ok",
    protocolVersion: "1.0",
    workerId: "vercel-health-only-1",
    enabledActionCount: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
  });
});

test("Vercel health worker rejects every executable action scope before Convex access", async () => {
  let queries = 0;

  await assert.rejects(
    runOperationsWorkerHealth({
      environment: {
        ...environment,
        BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
      },
      client: {
        async query() {
          queries += 1;
          return { protocolVersion: "1.0", scope: "worker" };
        },
      },
    }),
    /requires an empty action scope/u,
  );
  assert.equal(queries, 0);
});
