import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import Stripe from "stripe";

import { createStripeCheckoutWebhookProcessor } from "../../src/customer-flow/stripe-checkout-webhook.mjs";

const stripe = new Stripe("sk_test_placeholder");
const signingSecret = "whsec_test_a_exact_raw_bytes";

test("Stripe Checkout webhook verifies exact raw bytes and records a paid test session", async () => {
  const calls = [];
  const event = {
    id: "evt_test_checkout_001",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_test_checkout_001",
        object: "checkout.session",
        livemode: false,
        payment_status: "paid",
        payment_intent: "pi_test_checkout_001",
        amount_total: 3900,
        currency: "eur",
        metadata: {
          project: "bebebonjour",
          product: "announcement-page",
          environment: "test",
          job_id: "job_test_001",
          intake_digest: "a".repeat(64),
        },
      },
    },
  };
  const rawBody = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: signingSecret,
    timestamp: 1_786_880_000,
  });
  const processor = createStripeCheckoutWebhookProcessor({
    stripe,
    signingSecret,
    service: {
      async recordPaymentSucceeded(payment) {
        calls.push(payment);
        return { jobId: "job_test_001", status: "generation_pending", payment: "paid" };
      },
    },
    toleranceSeconds: Number.MAX_SAFE_INTEGER,
  });

  const result = await processor(new TextEncoder().encode(rawBody), signature);

  assert.deepEqual(result, {
    received: true,
    duplicateSafe: true,
    jobId: "job_test_001",
    status: "generation_pending",
  });
  assert.deepEqual(calls, [{
    providerEventId: event.id,
    sessionId: event.data.object.id,
    paymentIntentId: event.data.object.payment_intent,
    amountMinor: 3900,
    currency: "EUR",
    livemode: false,
    metadata: event.data.object.metadata,
    payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
  }]);
});

test("signed Stripe contract mismatches are durably rejected and acknowledged", async () => {
  const event = {
    id: "evt_test_checkout_rejected",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_test_checkout_rejected",
        object: "checkout.session",
        livemode: false,
        payment_status: "paid",
        payment_intent: "pi_test_checkout_rejected",
        amount_total: 3800,
        currency: "eur",
        metadata: { environment: "test" },
      },
    },
  };
  const rawBody = JSON.stringify(event, null, 2);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: signingSecret,
    timestamp: 1_786_880_000,
  });
  const persisted = [];
  const processor = createStripeCheckoutWebhookProcessor({
    stripe,
    signingSecret,
    service: { async recordPaymentSucceeded() { assert.fail("rejected payment must not advance"); } },
    eventStore: {
      async recordProviderEvent(providerEventId, rejection) {
        persisted.push({ providerEventId, rejection });
        return { created: true, event: rejection };
      },
    },
    toleranceSeconds: Number.MAX_SAFE_INTEGER,
  });

  const result = await processor(new TextEncoder().encode(rawBody), signature);

  assert.deepEqual(result, {
    received: true,
    rejected: true,
    reasonCode: "payment_contract_mismatch",
  });
  assert.equal(persisted[0].providerEventId, event.id);
  assert.match(persisted[0].rejection.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(persisted[0]).includes(rawBody), false);
});

test("signed Stripe job-correlation failures are durably rejected and acknowledged", async () => {
  const event = {
    id: "evt_test_wrong_job",
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_test_wrong_job",
        livemode: false,
        payment_status: "paid",
        payment_intent: "pi_test_wrong_job",
        amount_total: 3900,
        currency: "eur",
        metadata: { environment: "test", job_id: "job_test_wrong" },
      },
    },
  };
  const persisted = [];
  const processor = createStripeCheckoutWebhookProcessor({
    stripe: { webhooks: { constructEvent: () => event } },
    signingSecret,
    service: {
      async recordPaymentSucceeded() {
        const error = new Error("wrong job");
        error.code = "payment_correlation_failed";
        throw error;
      },
    },
    eventStore: {
      async recordProviderEvent(providerEventId, rejection) {
        persisted.push({ providerEventId, rejection });
        return { created: true, event: rejection };
      },
    },
  });

  const result = await processor(new TextEncoder().encode('{"signed":"wrong-job"}'), "valid");

  assert.deepEqual(result, {
    received: true,
    rejected: true,
    reasonCode: "payment_correlation_failed",
  });
  assert.equal(persisted.length, 1);
});
