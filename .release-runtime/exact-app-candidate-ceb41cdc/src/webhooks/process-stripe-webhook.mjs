import { WebhookRequestError } from "./errors.mjs";
import { buildWebhookEvidence, rejectionEventId } from "./evidence.mjs";
import {
  constructStripeWebhookEvent,
  normalizeStripePaymentEvent,
} from "./stripe.mjs";

export async function processStripeWebhook({ rawBody, signature, config, store }) {
  if (!Buffer.isBuffer(rawBody)) {
    throw new WebhookRequestError(400, "Stripe webhook body must be raw bytes.");
  }

  let rawEvent;
  try {
    rawEvent = constructStripeWebhookEvent(
      rawBody,
      signature,
      config?.signingSecret,
    );
  } catch (error) {
    throw new WebhookRequestError(401, "Invalid Stripe webhook signature.", { cause: error });
  }

  const evidence = buildWebhookEvidence(rawBody);

  let normalized;
  try {
    normalized = normalizeStripePaymentEvent(rawEvent, config.normalization);
  } catch (error) {
    return store.recordRejectedProviderEvent({
      provider: "stripe",
      eventId: rejectionEventId(rawEvent?.id, evidence.payloadSha256),
      reasonCode: "normalization_failed",
      payloadSha256: evidence.payloadSha256,
    });
  }

  return store.ingestStripePayment(normalized, evidence);
}
