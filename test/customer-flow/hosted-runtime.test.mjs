import assert from "node:assert/strict";
import test from "node:test";

import { convexTest } from "convex-test";
import Stripe from "stripe";

import schema from "../../convex/schema.js";
import { createHostedCustomerFlowRuntime } from "../../src/customer-flow/hosted-runtime.mjs";

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

function convexFixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = environment.CUSTOMER_FLOW_BACKEND_TOKEN;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./customerFlow.js": () => import("../../convex/customerFlow.js"),
    "./fulfillment.js": () => import("../../convex/fulfillment.js"),
  });
}

test("hosted runtime persists intake and creates a correlated Stripe test checkout", async () => {
  const convexClient = convexFixture();
  const stripeCalls = [];
  const stripe = {
    checkout: {
      sessions: {
        async create(payload, options) {
          stripeCalls.push({ payload, options });
          return {
            id: "cs_test_hosted_001",
            url: "https://checkout.stripe.com/c/pay/test",
            livemode: false,
          };
        },
      },
    },
    webhooks: { constructEvent() { throw new Error("not used"); } },
  };
  const ids = ["job_test_hosted_001", "private-token-hosted-001"];
  const runtime = createHostedCustomerFlowRuntime({
    environment,
    convexClient,
    stripe,
    createId: () => ids.shift(),
    now: () => "2026-08-18T10:00:00.000Z",
  });
  const intake = {
    schemaVersion: "1.0",
    customer: { email: "hosted@example.test", consent: true },
    baby: { firstName: "Amal Test", gender: "girl" },
    languages: ["fr"],
    voicePreference: { enabled: false, gender: "neutral" },
  };

  const intakeResponse = await runtime.api.request("/api/customer-flow/v1/intakes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "intake:hosted-runtime-001",
      "x-test-a-access-token": environment.CUSTOMER_FLOW_TEST_ACCESS_TOKEN,
      origin: "https://bonjour.example.test",
    },
    body: JSON.stringify(intake),
  });
  const submission = await intakeResponse.json();
  const checkoutResponse = await runtime.api.request(
    `/api/customer-flow/v1/jobs/${submission.jobId}/checkout`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${submission.intakeToken}`,
        "x-test-a-access-token": environment.CUSTOMER_FLOW_TEST_ACCESS_TOKEN,
        origin: "https://bonjour.example.test",
      },
    },
  );

  assert.equal(intakeResponse.status, 201);
  assert.equal(checkoutResponse.status, 200);
  assert.equal((await checkoutResponse.json()).sessionId, "cs_test_hosted_001");
  assert.equal(stripeCalls[0].payload.metadata.job_id, submission.jobId);
  const persisted = await convexClient.run(async (context) => ({
    customerJobs: await context.db.query("customerFlowJobs").collect(),
    submissions: await context.db.query("customerFlowSubmissions").collect(),
    fulfillmentJobs: await context.db.query("fulfillmentJobs").collect(),
  }));
  assert.equal(persisted.customerJobs.length, 1);
  assert.equal(persisted.fulfillmentJobs[0].aggregate.state, "awaiting_payment");
  assert.equal(JSON.stringify(persisted).includes(submission.intakeToken), false);
  assert.match(persisted.submissions[0].response.intakeTokenCiphertext, /^v1\./);
});

test("hosted runtime advances one durable job from a signed Stripe test event", async () => {
  const convexClient = convexFixture();
  const signingStripe = new Stripe("sk_test_candidate_only");
  let checkoutPayload;
  const stripe = {
    checkout: {
      sessions: {
        async create(payload) {
          checkoutPayload = payload;
          return {
            id: "cs_test_hosted_002",
            url: "https://checkout.stripe.com/c/pay/test-two",
            livemode: false,
          };
        },
      },
    },
    webhooks: signingStripe.webhooks,
  };
  const ids = ["job_test_hosted_002", "private-token-hosted-002"];
  const runtime = createHostedCustomerFlowRuntime({
    environment,
    convexClient,
    stripe,
    createId: () => ids.shift(),
    now: () => "2026-08-18T10:00:00.000Z",
  });
  const intakeResponse = await runtime.api.request("/api/customer-flow/v1/intakes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-a-access-token": environment.CUSTOMER_FLOW_TEST_ACCESS_TOKEN,
      origin: "https://bonjour.example.test",
    },
    body: JSON.stringify({
      schemaVersion: "1.0",
      customer: { email: "payment@example.test", consent: true },
      baby: { firstName: "Noor Test", gender: "neutral" },
      languages: ["fr"],
      voicePreference: { enabled: false, gender: "neutral" },
    }),
  });
  const submission = await intakeResponse.json();
  await runtime.api.request(`/api/customer-flow/v1/jobs/${submission.jobId}/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${submission.intakeToken}`,
      "x-test-a-access-token": environment.CUSTOMER_FLOW_TEST_ACCESS_TOKEN,
      origin: "https://bonjour.example.test",
    },
  });
  const payload = JSON.stringify({
    id: "evt_test_hosted_002",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_test_hosted_002",
        object: "checkout.session",
        payment_status: "paid",
        livemode: false,
        amount_total: 3900,
        currency: "eur",
        payment_intent: "pi_test_hosted_002",
        metadata: checkoutPayload.metadata,
      },
    },
  });
  const signature = signingStripe.webhooks.generateTestHeaderString({
    payload,
    secret: environment.STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET,
  });

  const webhook = await runtime.api.request("/api/customer-flow/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
  const replay = await runtime.api.request("/api/customer-flow/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });

  assert.equal(webhook.status, 200);
  assert.equal(replay.status, 200);
  assert.equal((await webhook.json()).status, "generation_pending");
  const persisted = await convexClient.run(async (context) => ({
    customer: (await context.db.query("customerFlowJobs").collect())[0].job,
    fulfillment: (await context.db.query("fulfillmentJobs").collect())[0].aggregate,
    events: await context.db.query("customerFlowProviderEvents").collect(),
  }));
  assert.equal(persisted.customer.payment.status, "paid");
  assert.equal(persisted.fulfillment.state, "generation_queued");
  assert.equal(persisted.events.length, 1);
});
