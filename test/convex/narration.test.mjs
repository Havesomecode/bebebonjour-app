import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const controlToken = "narration-control-test-token-32-characters";
const workerToken = "tts-worker-test-token-32-characters-long";
function fixture() {
  process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN = controlToken;
  process.env.BEBEBONJOUR_TTS_WORKER_TOKEN = workerToken;
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
test("TTS credential can claim only generate_narration work", async () => {
  const t = fixture();
  assert.equal(
    (await t.query(ref("operations:workerHealth"), { workerToken })).scope,
    "narration_generation",
  );
  const args = {
    workerToken,
    workerId: "hosted-narration-worker",
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  };
  assert.deepEqual(await t.mutation(ref("operations:claimCommands"), args), []);
  assert.deepEqual(
    await t.mutation(ref("operations:claimCommands"), {
      ...args,
      jobId: "job_narration_test",
    }),
    [],
  );
  for (const changes of [
    { actions: ["approve_content"] },
    { actions: ["render"] },
    { actions: ["approve_narration"] },
    { actions: ["publish"] },
    { actions: ["generate"] },
    { actions: ["deliver"] },
    { actions: [] },
    { actions: ["generate_narration", "render"] },
    { workerId: "some-other-worker" },
    { jobId: "invalid" },
    { limit: 2 },
    { leaseMs: 120000 },
  ]) {
    await assert.rejects(
      t.mutation(ref("operations:claimCommands"), { ...args, ...changes }),
    );
  }
  assert.equal(
    (await t.query(ref("operations:workerHealth"), {
      workerToken: controlToken,
    })).scope,
    "narration",
  );
});
