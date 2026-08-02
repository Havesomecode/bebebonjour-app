import { createHash } from "node:crypto";

export function buildWebhookEvidence(rawBody) {
  if (!Buffer.isBuffer(rawBody)) {
    throw new Error("Webhook evidence requires raw bytes.");
  }

  return {
    payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
  };
}

export function rejectionEventId(candidate, payloadSha256) {
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : `invalid_${payloadSha256}`;
}
