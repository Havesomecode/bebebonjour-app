import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeStripePaymentEvent } from "../../src/webhooks/stripe.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/stripe-payment-succeeded.json", import.meta.url), "utf8"),
);

test("a successful Stripe payment normalizes to an authoritative payment record", () => {
  const result = normalizeStripePaymentEvent(fixture, {
    expectedAmountMinor: 3900,
    expectedCurrency: "EUR",
  });

  assert.deepEqual(result, {
    source: {
      provider: "stripe",
      eventId: "evt_stripe_001",
      eventType: "payment_intent.succeeded",
    },
    payment: {
      provider: "stripe",
      paymentId: "pi_test_001",
      amountMinor: 3900,
      currency: "EUR",
      email: "parent@example.com",
      status: "succeeded",
      verification: "verified_by_stripe",
    },
  });
});

test("a successful Stripe payment may omit customer email", () => {
  const withoutEmail = structuredClone(fixture);
  withoutEmail.data.object.receipt_email = null;

  const result = normalizeStripePaymentEvent(withoutEmail, {
    expectedAmountMinor: 3900,
    expectedCurrency: "EUR",
  });

  assert.equal(result.payment.email, null);
  assert.equal(result.payment.paymentId, "pi_test_001");
  assert.equal(result.payment.status, "succeeded");
});
