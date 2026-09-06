import assert from "node:assert/strict";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";

const listJobs = makeFunctionReference("operations:listJobs");
const requestCommand = makeFunctionReference("operations:requestCommand");
const claimCommands = makeFunctionReference("operations:claimCommands");
const operatorToken = "operator-token-at-least-32-characters";
const workerToken = "worker-token-at-least-32-characters__";
const rateLimitToken = "rate-limit-token-at-least-32-characters";

function fixture() {
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  process.env.BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN = rateLimitToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./operations.js": () => import("../../convex/operations.js"),
  });
}

test("operator and worker credentials cannot cross privilege boundaries", async () => {
  const convex = fixture();
  await assert.rejects(
    convex.query(listJobs, { operatorToken: workerToken, paginationOpts: { cursor: null, numItems: 1 } }),
    /Unauthorized/u,
  );
  await assert.rejects(
    convex.mutation(claimCommands, { workerToken: operatorToken, workerId: "worker-1", actions: [], limit: 1, leaseMs: 60_000 }),
    /Unauthorized/u,
  );
  await assert.rejects(
    convex.mutation(requestCommand, {
      operatorToken: workerToken,
      commandId: "command_authorization_00000001",
      jobId: "job_authorization_001",
      action: "generate",
      expectedState: "generation_queued",
      expectedVersion: 1,
      payload: {},
    }),
    /Unauthorized/u,
  );
});

test("operations credential scopes reject a shared configured secret", async () => {
  const shared = "shared-operations-secret-at-least-32-bytes";
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = shared;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = shared;
  process.env.BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN = shared;
  const convex = convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./operations.js": () => import("../../convex/operations.js"),
  });

  await assert.rejects(
    convex.query(listJobs, { operatorToken: shared, paginationOpts: { cursor: null, numItems: 1 } }),
    /distinct|Unauthorized/u,
  );
});
