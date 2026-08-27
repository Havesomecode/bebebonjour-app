import assert from "node:assert/strict";
import test from "node:test";

const tallyModule = await import("../../api/webhooks/tally.mjs");

test("Vercel Tally entrypoint exports a lazy Node handler", () => {
  assert.equal(typeof tallyModule.default, "function");
});
