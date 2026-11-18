import assert from "node:assert/strict";
import test from "node:test";

const tallyModule = await import("../../api/webhooks/tally.mjs");
const stripeModule = await import("../../api/webhooks/stripe.mjs");

test("Vercel webhook entrypoints export lazy Node handlers", () => {
  assert.equal(typeof tallyModule.default, "function");
  assert.equal(typeof stripeModule.default, "function");
});
