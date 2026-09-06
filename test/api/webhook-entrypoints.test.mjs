import assert from "node:assert/strict";
import test from "node:test";

const tallyModule = await import("../../api/webhooks/tally.mjs");
const workerModule = await import("../../generation-worker/api/worker.mjs");

test("Vercel Tally entrypoint exports a lazy Node handler", () => {
  assert.equal(typeof tallyModule.default, "function");
});

test("Vercel Operations worker entrypoint exports a lazy bounded Node handler", () => {
  assert.equal(workerModule.config.runtime, "nodejs");
  assert.equal(workerModule.config.maxDuration, 60);
  assert.equal(typeof workerModule.default, "function");
});
