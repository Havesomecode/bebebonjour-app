import assert from "node:assert/strict";
import test from "node:test";

const environment = {
  CONVEX_URL: "https://test-a.convex.cloud",
  CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
  CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  CUSTOMER_FLOW_TEST_ACCESS_TOKEN: "test-access-token-at-least-32-characters",
  CUSTOMER_FLOW_ALLOWED_ORIGINS: '["https://bonjour.example.test"]',
  STRIPE_SECRET_KEY: "sk_test_candidate_only",
  STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET: "whsec_candidate_only",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://bonjour.example.test/suivi?checkout=success",
  STRIPE_CHECKOUT_CANCEL_URL: "https://bonjour.example.test/suivi?checkout=cancel",
  RESEND_API_KEY: "re_candidate_only",
  RESEND_FROM: "Bébé Bonjour <delivery@example.test>",
};

test("Vercel catch-all exports one Node handler for the hosted customer-flow API", async () => {
  Object.assign(process.env, environment);
  const entrypoint = await import("../../api/customer-flow/[...route].mjs");

  assert.equal(entrypoint.config.runtime, "nodejs");
  assert.equal(typeof entrypoint.default, "function");
});
