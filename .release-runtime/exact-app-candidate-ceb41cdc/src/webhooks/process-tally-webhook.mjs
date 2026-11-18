import { WebhookRequestError } from "./errors.mjs";
import { buildWebhookEvidence, rejectionEventId } from "./evidence.mjs";
import { normalizeTallySubmission, verifyTallySignature } from "./tally.mjs";

export async function processTallyWebhook({ rawBody, signature, config, store }) {
  if (!Buffer.isBuffer(rawBody)) {
    throw new WebhookRequestError(400, "Tally webhook body must be raw bytes.");
  }
  if (!verifyTallySignature(rawBody, signature, config?.signingSecret)) {
    throw new WebhookRequestError(401, "Invalid Tally webhook signature.");
  }

  const evidence = buildWebhookEvidence(rawBody);

  let rawEvent;
  try {
    rawEvent = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    return store.recordRejectedProviderEvent({
      provider: "tally",
      eventId: rejectionEventId(null, evidence.payloadSha256),
      reasonCode: "invalid_json",
      payloadSha256: evidence.payloadSha256,
    });
  }

  let normalized;
  try {
    normalized = normalizeTallySubmission(rawEvent, config.normalization);
  } catch (error) {
    return store.recordRejectedProviderEvent({
      provider: "tally",
      eventId: rejectionEventId(rawEvent?.eventId, evidence.payloadSha256),
      reasonCode: "normalization_failed",
      payloadSha256: evidence.payloadSha256,
    });
  }

  return store.ingestTallySubmission(normalized, evidence);
}
