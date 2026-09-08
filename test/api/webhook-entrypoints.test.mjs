import assert from "node:assert/strict";
import test from "node:test";

const tallyModule = await import("../../api/webhooks/tally.mjs");
const workerModule = await import("../../generation-worker/api/worker.mjs");
const completionWorkerModule = await import("../../completion-worker/api/worker.mjs");

test("Vercel Tally entrypoint exports a lazy Node handler", () => {
  assert.equal(typeof tallyModule.default, "function");
});

test("Vercel Operations worker entrypoint exports a lazy bounded Node handler", () => {
  assert.equal(workerModule.config.runtime, "nodejs");
  assert.equal(workerModule.config.maxDuration, 300);
  assert.equal(typeof workerModule.default, "function");
});

test("Vercel completion worker entrypoint exports a lazy bounded Node handler", () => {
  assert.equal(completionWorkerModule.config.runtime, "nodejs");
  assert.equal(completionWorkerModule.config.maxDuration, 300);
  assert.equal(typeof completionWorkerModule.default, "function");
});
