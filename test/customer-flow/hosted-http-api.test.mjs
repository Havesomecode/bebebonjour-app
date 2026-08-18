import assert from "node:assert/strict";
import test from "node:test";

import { createHostedCustomerFlowHttpApi } from "../../src/customer-flow/hosted-http-api.mjs";
import { StripeCheckoutWebhookError } from "../../src/customer-flow/stripe-checkout-webhook.mjs";

function serviceStub() {
  return {
    async submitIntake() {
      return { jobId: "job_test_001", intakeToken: "private-token", status: "payment_pending" };
    },
    async getStatus() {
      return { jobId: "job_test_001", status: "payment_pending" };
    },
    async createCheckout() {
      return { sessionId: "cs_test_001", checkoutUrl: "https://checkout.stripe.com/test" };
    },
  };
}

test("hosted customer-flow API preserves Stripe webhook raw bytes and exposes fail-closed health", async () => {
  const calls = [];
  const stripeProcessor = async (rawBody, signature) => {
    calls.push({ rawBody: Buffer.from(rawBody), signature });
    return { received: true, duplicate: false, jobId: "job_test_001" };
  };
  const api = createHostedCustomerFlowHttpApi({
    service: serviceStub(),
    stripeProcessor,
    testAccessToken: "test-access-token-at-least-32-characters",
    allowedOrigins: ["https://bonjour.example.test"],
  });
  const payload = Buffer.from('{"id":"evt_test_001", "exact":"spacing matters"}', "utf8");

  const response = await api.request("/api/customer-flow/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test" },
    body: payload,
  });
  const health = await api.request("/api/customer-flow/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, duplicate: false, jobId: "job_test_001" });
  assert.deepEqual(calls, [{ rawBody: payload, signature: "t=1,v1=test" }]);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    boundary: "TEST-A",
    persistence: "convex-hosted",
    payment: "stripe-test-mode",
    delivery: "operator-gated-resend-test",
  });
});

test("hosted customer-flow API rejects invalid Stripe signatures without provider retries", async () => {
  const api = createHostedCustomerFlowHttpApi({
    service: serviceStub(),
    testAccessToken: "test-access-token-at-least-32-characters",
    stripeProcessor: async () => {
      throw new StripeCheckoutWebhookError("invalid signature");
    },
  });

  const response = await api.request("/api/customer-flow/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "bad" },
    body: "{}",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { received: false, error: "invalid_webhook" });
});

test("hosted customer-flow commands require the private TEST-A access token", async () => {
  const api = createHostedCustomerFlowHttpApi({
    service: serviceStub(),
    testAccessToken: "test-access-token-at-least-32-characters",
    stripeProcessor: async () => ({ received: true }),
  });
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "1.0" }),
  };

  const denied = await api.request("/api/customer-flow/v1/intakes", request);
  const allowed = await api.request("/api/customer-flow/v1/intakes", {
    ...request,
    headers: {
      ...request.headers,
      "x-test-a-access-token": "test-access-token-at-least-32-characters",
    },
  });

  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), {
    error: { code: "test_access_required", message: "TEST-A access is required." },
  });
  assert.equal(allowed.status, 201);
});

test("hosted customer-flow allows an approved-origin CORS preflight before access-token validation", async () => {
  const api = createHostedCustomerFlowHttpApi({
    service: serviceStub(),
    testAccessToken: "test-access-token-at-least-32-characters",
    stripeProcessor: async () => ({ received: true }),
    allowedOrigins: ["https://bonjour.example.test"],
  });

  const response = await api.request("/api/customer-flow/v1/intakes", {
    method: "OPTIONS",
    headers: {
      origin: "https://bonjour.example.test",
      "access-control-request-headers": "content-type,x-test-a-access-token",
      "access-control-request-method": "POST",
    },
  });

  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers"), /x-test-a-access-token/);
});
