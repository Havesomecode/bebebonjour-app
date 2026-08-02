import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";

import { constructStripeWebhookEvent } from "../../src/webhooks/stripe.mjs";

const stripe = new Stripe("webhook-signature-test-only");
const secret = "whsec_test_secret";
const payload = JSON.stringify({
  id: "evt_stripe_001",
  object: "event",
  type: "payment_intent.succeeded",
});
const signature = stripe.webhooks.generateTestHeaderString({
  payload,
  secret,
  timestamp: 1785673800,
});

test("a correctly signed Stripe payload is accepted", () => {
  const event = constructStripeWebhookEvent(
    Buffer.from(payload, "utf8"),
    signature,
    secret,
    { tolerance: Number.POSITIVE_INFINITY },
  );

  assert.equal(event.id, "evt_stripe_001");
});

test("a tampered Stripe payload is rejected", () => {
  assert.throws(
    () => constructStripeWebhookEvent(
      Buffer.from(`${payload} `, "utf8"),
      signature,
      secret,
      { tolerance: Number.POSITIVE_INFINITY },
    ),
    /signature/i,
  );
});
