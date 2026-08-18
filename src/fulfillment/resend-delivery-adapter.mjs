import { Resend } from "resend";

const RESEND_TEST_SINK = "delivered@resend.dev";
const MAX_IDEMPOTENCY_AGE_MS = 23 * 60 * 60 * 1000;

export function createResendDeliveryAdapter(options = {}) {
  const resend = options.resend || createResendClient(options.apiKey);
  const from = requireNonEmptyString(options.from, "Resend from address");
  const clock = options.clock || (() => new Date().toISOString());

  return {
    async reconcile() {
      // Resend has no lookup by idempotency key. send() therefore fails closed
      // before the provider's 24-hour idempotency retention window expires.
      return null;
    },

    async send(request) {
      assertTestDeliveryRequest(request, clock());
      const { data, error } = await resend.emails.send({
        from,
        to: request.target.email,
        subject: "Votre annonce Bébé Bonjour est prête",
        html: deliveryHtml(request.publication.stableUrl),
      }, {
        idempotencyKey: request.idempotencyKey,
      });
      if (error || !data?.id) {
        const failure = new Error("Resend did not accept the delivery request.", { cause: error });
        failure.reasonCode = "resend_send_failed";
        failure.retryable = true;
        throw failure;
      }
      return {
        provider: "resend",
        providerMessageId: data.id,
        revisionId: request.revisionId,
        artifactManifestDigest: request.artifactManifestDigest,
        targetDigest: request.targetDigest,
        idempotencyKey: request.idempotencyKey,
      };
    },

    async status(request) {
      if (request?.environment !== "test") {
        throw new Error("Resend status checks are restricted to test jobs.");
      }
      const providerMessageId = requireNonEmptyString(
        request.providerMessageId,
        "Resend provider message id",
      );
      const { data, error } = await resend.emails.get(providerMessageId);
      if (error || !data?.last_event) {
        const failure = new Error("Resend message status is unavailable.", { cause: error });
        failure.reasonCode = "resend_status_failed";
        failure.retryable = true;
        throw failure;
      }
      return deliveryOutcome(providerMessageId, data.last_event, clock());
    },
  };
}

function deliveryOutcome(providerMessageId, event, recordedAt) {
  const delivered = new Set(["clicked", "delivered", "opened"]);
  const pending = new Set(["delivery_delayed", "queued", "scheduled", "sent"]);
  if (delivered.has(event)) {
    return { providerMessageId, outcome: "delivered", recordedAt, retryable: false, reasonCode: null };
  }
  if (pending.has(event)) {
    return { providerMessageId, outcome: "pending", recordedAt, retryable: false, reasonCode: null };
  }
  const reasonCode = `resend_${String(event).replaceAll(/[^a-z0-9]+/g, "_")}`.slice(0, 64);
  return { providerMessageId, outcome: "failed", recordedAt, retryable: false, reasonCode };
}

function createResendClient(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.startsWith("re_")) {
    throw new Error("A Resend API key is required.");
  }
  return new Resend(apiKey);
}

function assertTestDeliveryRequest(request, now) {
  if (!request || request.environment !== "test") {
    throw new Error("Resend delivery is restricted to operator-approved test jobs.");
  }
  if (requireNonEmptyString(request.target?.email, "delivery email").toLowerCase() !== RESEND_TEST_SINK) {
    throw new Error("Resend TEST-A delivery must use the documented test sink.");
  }
  requireNonEmptyString(request.idempotencyKey, "delivery idempotency key");
  const startedAt = Date.parse(request.attemptStartedAt);
  const checkedAt = Date.parse(now);
  if (!Number.isFinite(startedAt) || !Number.isFinite(checkedAt)
      || checkedAt < startedAt || checkedAt - startedAt >= MAX_IDEMPOTENCY_AGE_MS) {
    throw new Error("Resend delivery is outside the safe provider idempotency window.");
  }
  const url = new URL(request.publication?.stableUrl);
  if (url.protocol !== "https:") throw new Error("Delivery publication URL must use HTTPS.");
}

function deliveryHtml(stableUrl) {
  const url = escapeHtml(stableUrl);
  return `<p>Bonjour,</p><p>Votre annonce Bébé Bonjour est prête.</p><p><a href="${url}">Découvrir l’annonce</a></p>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}
