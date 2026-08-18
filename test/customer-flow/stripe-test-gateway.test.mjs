import assert from "node:assert/strict";
import test from "node:test";

import { createStripeTestPaymentGateway } from "../../src/customer-flow/stripe-test-gateway.mjs";

const checkoutRequest = {
  amountMinor: 3900,
  currency: "EUR",
  jobId: "job_test_001",
  customerEmail: "customer@example.test",
  metadata: {
    project: "bebebonjour",
    product: "announcement-page",
    environment: "test",
    job_id: "job_test_001",
    intake_digest: "a".repeat(64),
  },
  paymentIntentMetadata: {
    project: "bebebonjour",
    product: "announcement-page",
    environment: "test",
    job_id: "job_test_001",
    intake_digest: "a".repeat(64),
  },
  idempotencyKey: `checkout:job_test_001:${"a".repeat(64)}`,
};

test("Stripe test gateway creates one project-correlated EUR checkout session", async () => {
  const calls = [];
  const stripe = {
    checkout: {
      sessions: {
        async create(payload, options) {
          calls.push({ payload, options });
          return {
            id: "cs_test_001",
            url: "https://checkout.stripe.test/c/pay/cs_test_001",
            livemode: false,
          };
        },
      },
    },
  };
  const gateway = createStripeTestPaymentGateway({
    stripe,
    successUrl: "https://app.example.test/payment/complete?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://app.example.test/payment/cancelled",
  });

  const result = await gateway.createCheckoutSession(checkoutRequest);

  assert.deepEqual(result, {
    id: "cs_test_001",
    url: "https://checkout.stripe.test/c/pay/cs_test_001",
    mode: "test",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { idempotencyKey: checkoutRequest.idempotencyKey });
  assert.deepEqual(calls[0].payload.metadata, checkoutRequest.metadata);
  assert.deepEqual(calls[0].payload.payment_intent_data.metadata, checkoutRequest.paymentIntentMetadata);
  assert.equal(calls[0].payload.line_items[0].price_data.unit_amount, 3900);
  assert.equal(calls[0].payload.line_items[0].price_data.currency, "eur");
  assert.equal(calls[0].payload.mode, "payment");
  assert.equal(calls[0].payload.customer_email, checkoutRequest.customerEmail);
});
