import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const workerToken = "narration-worker-test-token-32-characters";
function fixture() {
  process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN = workerToken;
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN =
    "operator-narration-test-32-characters";
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./operations.js": () => import("../../convex/operations.js"),
    "./narration.js": () => import("../../convex/narration.js"),
    "./narrationRuntime.js": () => import("../../convex/narrationRuntime.js"),
    "./http.js": () => import("../../convex/http.js"),
  });
}
test("narration credential can claim only explicit job-bound narration work", async () => {
  const t = fixture();
  assert.equal(
    (await t.query(ref("operations:workerHealth"), { workerToken })).scope,
    "narration",
  );
  const args = {
    workerToken,
    workerId: "hosted-narration-worker",
    actions: [
      "approve_content",
      "render",
      "generate_narration",
      "approve_narration",
    ],
    jobId: "job_narration_test",
    limit: 1,
    leaseMs: 300000,
  };
  assert.deepEqual(await t.mutation(ref("operations:claimCommands"), args), []);
  for (const changes of [
    { actions: ["publish"] },
    { actions: ["generate"] },
    { actions: ["deliver"] },
    { jobId: undefined },
    { limit: 2 },
  ]) {
    await assert.rejects(
      t.mutation(ref("operations:claimCommands"), { ...args, ...changes }),
    );
  }
});
