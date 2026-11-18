import { createRequire } from "node:module";

import {
  OWNER_COMPLETION_JOB_ID,
  OWNER_COMPLETION_MANIFEST_DIGEST,
  OWNER_COMPLETION_REVISION_ID,
  OWNER_DELIVERY_EMAIL,
} from "../operations/owner-completion-policy.mjs";

const MAX_IDEMPOTENCY_AGE_MS = 23 * 60 * 60 * 1000;
const TARGET_REF = "resend:owner:z-at-havesomecode";
const require = createRequire(import.meta.url);

export function createResendOwnerDeliveryAdapter(options = {}) {
  const resend = options.resend || createResendClient(options.apiKey);
  const from = requireString(options.from, "Resend owner from address");
  const stableUrl = exactStableUrl(options.stableUrl);
  const clock = options.clock || (() => new Date().toISOString());
  return Object.freeze({
    async reconcile() {
      // Resend has no lookup by idempotency key. A persisted started effect must
      // be reconciled manually; this adapter never guesses and never re-sends.
      return null;
    },
    async send(request) {
      assertOwnerRequest(request, clock(), stableUrl);
      const { data, error } = await fencedProviderMutation(request, () => resend.emails.send({
        from,
        to: [OWNER_DELIVERY_EMAIL],
        subject: "Votre annonce Bébé Bonjour est prête",
        html: deliveryHtml(request.publication.stableUrl),
      }, { idempotencyKey: request.idempotencyKey }));
      if (error || !data?.id) {
        const failure = new Error("Resend did not accept the exact owner delivery request.", { cause: error });
        failure.reasonCode = "resend_send_failed";
        failure.retryable = false;
        throw failure;
      }
      return Object.freeze({
        provider: "resend",
        providerMessageId: data.id,
        revisionId: request.revisionId,
        artifactManifestDigest: request.artifactManifestDigest,
        targetDigest: request.targetDigest,
        idempotencyKey: request.idempotencyKey,
      });
    },
    async status(request) {
      assertOwnerIdentity(request);
      const providerMessageId = requireString(request.providerMessageId, "Resend owner provider message id");
      const { data, error } = await resend.emails.get(providerMessageId);
      if (error || !data?.last_event) {
        const failure = new Error("Resend owner message status is unavailable.", { cause: error });
        failure.reasonCode = "resend_status_failed";
        failure.retryable = true;
        throw failure;
      }
      return deliveryOutcome(providerMessageId, data.last_event, clock());
    },
  });
}

async function fencedProviderMutation(request, providerMutation) {
  if (typeof request?.fenceExternalEffect !== "function") {
    throw new Error("Resend owner delivery requires a persisted provider-mutation lease fence.");
  }
  return request.fenceExternalEffect({ effectMayBeIssued: true }, providerMutation);
}

function assertOwnerRequest(request, now, stableUrl) {
  assertOwnerIdentity(request);
  if (request.target?.email !== OWNER_DELIVERY_EMAIL || request.target?.targetRef !== TARGET_REF) {
    throw new Error("Resend delivery is restricted to the exact owner recipient.");
  }
  if (!/^bb_[a-f0-9]{64}$/u.test(request.idempotencyKey || "")) {
    throw new Error("Owner delivery idempotency key is invalid.");
  }
  const startedAt = Date.parse(request.attemptStartedAt);
  const checkedAt = Date.parse(now);
  if (!Number.isFinite(startedAt) || !Number.isFinite(checkedAt)
      || checkedAt < startedAt || checkedAt - startedAt >= MAX_IDEMPOTENCY_AGE_MS) {
    throw new Error("Owner delivery is outside the safe Resend idempotency window.");
  }
  if (request.publication?.stableUrl !== stableUrl) {
    throw new Error("Owner delivery publication URL is not the exact configured stable URL.");
  }
}

function exactStableUrl(value) {
  const normalized = requireString(value, "Owner delivery stable URL");
  const url = new URL(normalized);
  if (url.protocol !== "https:"
      || url.href !== normalized
      || url.search
      || url.hash
      || url.pathname !== `/announcements/${OWNER_COMPLETION_JOB_ID}`) {
    throw new Error("Owner delivery stable URL is invalid.");
  }
  return normalized;
}

function assertOwnerIdentity(request) {
  if (request?.environment !== "test"
      || request.jobId !== OWNER_COMPLETION_JOB_ID
      || request.revisionId !== OWNER_COMPLETION_REVISION_ID
      || request.artifactManifestDigest !== OWNER_COMPLETION_MANIFEST_DIGEST) {
    throw new Error("Resend delivery is restricted to the exact owner approved job.");
  }
}

function deliveryOutcome(providerMessageId, event, recordedAt) {
  if (new Set(["clicked", "delivered", "opened"]).has(event)) {
    return { providerMessageId, outcome: "delivered", recordedAt, retryable: false, reasonCode: null };
  }
  if (new Set(["delivery_delayed", "queued", "scheduled", "sent"]).has(event)) {
    return { providerMessageId, outcome: "pending", recordedAt, retryable: false, reasonCode: null };
  }
  return {
    providerMessageId,
    outcome: "failed",
    recordedAt,
    retryable: false,
    reasonCode: `resend_${String(event).replaceAll(/[^a-z0-9]+/g, "_")}`.slice(0, 64),
  };
}

function createResendClient(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.startsWith("re_")) throw new Error("A Resend API key is required.");
  const { Resend } = require("resend");
  return new Resend(apiKey);
}

function deliveryHtml(stableUrl) {
  const url = escapeHtml(stableUrl);
  return `<p>Bonjour,</p><p>Votre annonce Bébé Bonjour est prête.</p><p><a href="${url}">Découvrir l’annonce</a></p>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
  return value.trim();
}
