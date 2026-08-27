import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { normalizeTallyIntake, TallyIntakeError } from "./tally-intake.mjs";

export function createTallyIntakeProcessor({ service, eventStore, config }) {
  if (!service?.submitIntake || !eventStore?.claimProviderEvent || !eventStore?.completeProviderEvent) {
    throw new Error("Tally intake processor dependencies are incomplete.");
  }
  assertConfig(config);

  return async function processTallyIntake({ rawBody, signature }) {
    const body = normalizeRawBody(rawBody);
    verifySignature(body, signature, config.signingSecret);
    const fingerprint = createHash("sha256").update(body).digest("hex");
    let event;
    let parseError = null;
    try {
      event = parseEvent(body);
    } catch (error) {
      parseError = error;
    }
    const providerEventId = providerEventIdentity(event, fingerprint);
    const claim = await eventStore.claimProviderEvent(providerEventId, fingerprint);
    if (!claim.created) {
      if (claim.event.fingerprint !== fingerprint) {
        throw new TallyIntakeError(409, "provider_event_conflict", "Tally event id was reused for a different payload.");
      }
      if (claim.event.result) return replayResult(claim.event.result);
    }

    let normalized;
    try {
      if (parseError) throw parseError;
      normalized = normalizeTallyIntake(event, config);
    } catch (error) {
      if (!(error instanceof TallyIntakeError) || error.statusCode >= 500) throw error;
      const rejected = { outcome: "rejected", reasonCode: error.code };
      const completion = await eventStore.completeProviderEvent(
        providerEventId,
        fingerprint,
        rejected,
      );
      const durable = completion.event?.result || rejected;
      return {
        accepted: true,
        duplicate: completion.completed === false,
        rejected: true,
        reasonCode: durable.reasonCode,
      };
    }

    const idempotencyKey = `tally:${normalized.source.submissionId}`;
    const result = await service.submitIntake(normalized.intake, { idempotencyKey });
    const completion = await eventStore.completeProviderEvent(
      providerEventId,
      fingerprint,
      { outcome: "accepted", jobId: result.jobId, status: result.status },
    );
    const durableResult = completion.event?.result || {
      outcome: "accepted",
      jobId: result.jobId,
      status: result.status,
    };

    return {
      accepted: true,
      duplicate: result.replayed === true || completion.completed === false,
      jobId: durableResult.jobId,
    };
  };
}

function providerEventIdentity(event, fingerprint) {
  const eventId = event?.eventId;
  return typeof eventId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(eventId)
    ? eventId
    : `tally_rejected_${fingerprint.slice(0, 32)}`;
}

function replayResult(result) {
  if (result?.outcome === "rejected") {
    return {
      accepted: true,
      duplicate: true,
      rejected: true,
      reasonCode: result.reasonCode,
    };
  }
  return {
    accepted: true,
    duplicate: true,
    jobId: result?.jobId,
  };
}

export function verifyTallySignature(rawBody, signature, signingSecret) {
  verifySignature(normalizeRawBody(rawBody), signature, signingSecret);
  return true;
}

function verifySignature(rawBody, signature, signingSecret) {
  if (typeof signature !== "string" || !signature || typeof signingSecret !== "string") {
    throw new TallyIntakeError(401, "invalid_tally_signature", "Tally signature is invalid.");
  }
  const expected = Buffer.from(createHmac("sha256", signingSecret).update(rawBody).digest("base64"));
  const actual = Buffer.from(signature.trim());
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TallyIntakeError(401, "invalid_tally_signature", "Tally signature is invalid.");
  }
}

function normalizeRawBody(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  throw new TallyIntakeError(400, "invalid_tally_body", "Tally payload is invalid.");
}

function parseEvent(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new TallyIntakeError(400, "invalid_tally_json", "Tally payload is invalid.");
  }
}

function assertConfig(config) {
  if (!config || typeof config !== "object" || typeof config.signingSecret !== "string"
      || Buffer.byteLength(config.signingSecret) < 32
      || typeof config.expectedFormId !== "string" || !config.expectedFormId
      || !config.fieldMap) {
    throw new Error("Tally intake configuration is invalid.");
  }
}
