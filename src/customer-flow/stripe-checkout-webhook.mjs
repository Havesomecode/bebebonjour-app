import { createHash } from "node:crypto";

const ACCEPTED_EVENT = "checkout.session.completed";

export class StripeCheckoutWebhookError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "StripeCheckoutWebhookError";
  }
}

export function createStripeCheckoutWebhookProcessor(options = {}) {
  const stripe = options.stripe;
  const service = options.service;
  const signingSecret = options.signingSecret;
  const eventStore = options.eventStore;
  const toleranceSeconds = options.toleranceSeconds;
  if (typeof stripe?.webhooks?.constructEvent !== "function") {
    throw new Error("A Stripe webhook verifier is required.");
  }
  if (typeof service?.recordPaymentSucceeded !== "function") {
    throw new Error("A customer-flow payment recorder is required.");
  }
  if (typeof signingSecret !== "string" || !signingSecret.startsWith("whsec_")) {
    throw new Error("A Stripe webhook signing secret is required.");
  }

  return async function processStripeCheckoutWebhook(rawBody, signature) {
    if (!(rawBody instanceof Uint8Array) || typeof signature !== "string" || signature.length === 0) {
      throw new Error("Stripe webhook raw bytes and signature are required.");
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        Buffer.from(rawBody),
        signature,
        signingSecret,
        toleranceSeconds,
      );
    } catch (error) {
      throw new StripeCheckoutWebhookError("Stripe webhook signature verification failed.", {
        cause: error,
      });
    }
    if (event.type !== ACCEPTED_EVENT) {
      return { received: true, ignored: true, eventType: event.type };
    }

    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    const session = event.data?.object;
    if (
      event.livemode !== false
      || session?.livemode !== false
      || session.payment_status !== "paid"
      || session.amount_total !== 3900
      || String(session.currency).toUpperCase() !== "EUR"
      || typeof session.id !== "string"
      || !session.id.startsWith("cs_test_")
      || typeof session.payment_intent !== "string"
      || !session.payment_intent.startsWith("pi_")
      || !session.metadata
      || session.metadata.environment !== "test"
    ) {
      return recordRejectedEvent(
        eventStore,
        event.id,
        payloadSha256,
        "payment_contract_mismatch",
      );
    }

    let status;
    try {
      status = await service.recordPaymentSucceeded({
        providerEventId: event.id,
        sessionId: session.id,
        paymentIntentId: session.payment_intent,
        amountMinor: session.amount_total,
        currency: String(session.currency).toUpperCase(),
        livemode: false,
        metadata: { ...session.metadata },
        payloadSha256,
      });
    } catch (error) {
      if (error?.code === "payment_correlation_failed") {
        return recordRejectedEvent(
          eventStore,
          event.id,
          payloadSha256,
          "payment_correlation_failed",
        );
      }
      throw error;
    }
    return {
      received: true,
      duplicateSafe: true,
      jobId: status.jobId,
      status: status.status,
    };
  };
}

async function recordRejectedEvent(eventStore, eventId, payloadSha256, reasonCode) {
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)
      || typeof eventStore?.recordProviderEvent !== "function") {
    throw new StripeCheckoutWebhookError(
      "Stripe Checkout event does not match the TEST-A payment contract.",
    );
  }
  const result = { received: true, rejected: true, reasonCode };
  const recorded = await eventStore.recordProviderEvent(eventId, {
    fingerprint: payloadSha256,
    payloadSha256,
    result,
  });
  if (recorded.event.fingerprint !== payloadSha256) {
    throw new StripeCheckoutWebhookError("Stripe event id was reused with different bytes.");
  }
  return recorded.event.result;
}
