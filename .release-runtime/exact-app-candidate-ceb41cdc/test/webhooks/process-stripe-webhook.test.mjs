import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Stripe from "stripe";

import { processStripeWebhook } from "../../src/webhooks/process-stripe-webhook.mjs";

const rawBody = await readFile(
  new URL("../fixtures/stripe-payment-succeeded.json", import.meta.url),
);
const signingSecret = "whsec_test_secret";
const stripe = new Stripe("webhook-signature-test-only");
const signature = stripe.webhooks.generateTestHeaderString({
  payload: rawBody.toString("utf8"),
  secret: signingSecret,
});

function recordingStore() {
  const calls = [];
  return {
    calls,
    async ingestStripePayment(normalized, evidence) {
      calls.push({ method: "ingest", normalized, evidence });
      return { duplicate: false, paymentId: "pi_test_001", status: "succeeded" };
    },
    async recordRejectedProviderEvent(rejection) {
      calls.push({ method: "reject", rejection });
      return { duplicate: false, rejected: true };
    },
  };
}

const config = {
  signingSecret,
  normalization: {
    expectedAmountMinor: 3900,
    expectedCurrency: "EUR",
  },
};

test("a signed successful Stripe webhook is persisted once", async () => {
  const store = recordingStore();

  const result = await processStripeWebhook({ rawBody, signature, config, store });

  assert.deepEqual(result, {
    duplicate: false,
    paymentId: "pi_test_001",
    status: "succeeded",
  });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].method, "ingest");
  assert.equal(store.calls[0].normalized.source.eventId, "evt_stripe_001");
  assert.equal(store.calls[0].normalized.payment.paymentId, "pi_test_001");
  assert.equal(
    store.calls[0].evidence.payloadSha256,
    createHash("sha256").update(rawBody).digest("hex"),
  );
});

test("an invalid Stripe webhook signature performs no persistence", async () => {
  const store = recordingStore();

  await assert.rejects(
    processStripeWebhook({ rawBody, signature: "invalid", config, store }),
    (error) => error.statusCode === 401 && /signature/i.test(error.message),
  );
  assert.equal(store.calls.length, 0);
});

test("a signed Stripe payment mismatch is persisted for blocked reconciliation", async () => {
  const event = JSON.parse(rawBody.toString("utf8"));
  event.data.object.amount_received = 4000;
  const mismatchedBody = Buffer.from(JSON.stringify(event), "utf8");
  const mismatchedSignature = stripe.webhooks.generateTestHeaderString({
    payload: mismatchedBody.toString("utf8"),
    secret: signingSecret,
  });
  const store = recordingStore();

  await processStripeWebhook({
    rawBody: mismatchedBody,
    signature: mismatchedSignature,
    config,
    store,
  });

  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].normalized.payment.amountMinor, 4000);
});

test("a signed business-invalid Stripe webhook is durably rejected without raw payload persistence", async () => {
  const event = JSON.parse(rawBody.toString("utf8"));
  event.type = "payment_intent.processing";
  const invalidBody = Buffer.from(JSON.stringify(event), "utf8");
  const invalidSignature = stripe.webhooks.generateTestHeaderString({
    payload: invalidBody.toString("utf8"),
    secret: signingSecret,
  });
  const store = recordingStore();

  const result = await processStripeWebhook({
    rawBody: invalidBody,
    signature: invalidSignature,
    config,
    store,
  });

  assert.deepEqual(result, { duplicate: false, rejected: true });
  assert.deepEqual(store.calls, [
    {
      method: "reject",
      rejection: {
        provider: "stripe",
        eventId: "evt_stripe_001",
        reasonCode: "normalization_failed",
        payloadSha256: createHash("sha256").update(invalidBody).digest("hex"),
      },
    },
  ]);
});
