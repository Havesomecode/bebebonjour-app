import Stripe from "stripe";

const signatureVerifier = new Stripe("webhook-signature-verification-only");

export function constructStripeWebhookEvent(rawBody, signature, signingSecret, options = {}) {
  if (!Buffer.isBuffer(rawBody)) {
    throw new Error("Stripe webhook body must be raw bytes.");
  }
  assertNonEmptyString(signature, "Stripe webhook signature");
  assertNonEmptyString(signingSecret, "Stripe webhook signing secret");

  return signatureVerifier.webhooks.constructEvent(
    rawBody,
    signature,
    signingSecret,
    options.tolerance ?? 300,
  );
}

export function normalizeStripePaymentEvent(event) {
  assertObject(event, "Stripe event");
  assertNonEmptyString(event.id, "Stripe event id");
  assertEqual(event.type, "payment_intent.succeeded", "Stripe event type");
  assertObject(event.data, "Stripe event data");
  assertObject(event.data.object, "Stripe payment intent");

  const paymentIntent = event.data.object;
  assertNonEmptyString(paymentIntent.id, "Stripe payment intent id");
  assertEqual(paymentIntent.object, "payment_intent", "Stripe object type");
  assertEqual(paymentIntent.status, "succeeded", "Stripe payment status");
  assertNonNegativeInteger(paymentIntent.amount_received, "Stripe amount received");
  assertCurrency(paymentIntent.currency);

  const email = paymentIntent.receipt_email
    || paymentIntent.charges?.data?.[0]?.billing_details?.email
    || null;
  if (email !== null) {
    assertNonEmptyString(email, "Stripe customer email");
  }

  return {
    source: {
      provider: "stripe",
      eventId: event.id,
      eventType: event.type,
    },
    payment: {
      provider: "stripe",
      paymentId: paymentIntent.id,
      amountMinor: paymentIntent.amount_received,
      currency: String(paymentIntent.currency).toUpperCase(),
      email: email?.trim() ?? null,
      status: "succeeded",
      verification: "verified_by_stripe",
    },
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function assertCurrency(value) {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value)) {
    throw new Error("Stripe payment currency must be a three-letter code.");
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} did not match the expected value.`);
  }
}
