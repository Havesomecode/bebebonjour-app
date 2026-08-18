import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const PRICE_MINOR = 3900;
const CURRENCY = "EUR";
const CHECKOUT_METADATA = Object.freeze({
  project: "bebebonjour",
  product: "announcement-page",
  environment: "test",
});
const RESEND_TEST_SINKS = new Set([
  "bounced@resend.dev",
  "complained@resend.dev",
  "delivered@resend.dev",
  "suppressed@resend.dev",
]);

export class CustomerFlowError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "CustomerFlowError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createCustomerFlowService({
  store,
  paymentGateway,
  fulfillmentOrchestrator = null,
  syntheticOnly = true,
  now = () => new Date().toISOString(),
  createId = defaultCreateId,
}) {
  if (!store) throw new Error("A customer-flow store is required.");
  if (!paymentGateway?.createCheckoutSession) throw new Error("A payment gateway is required.");
  if (fulfillmentOrchestrator && ["createJob", "recordPayment", "status"].some(
    (method) => typeof fulfillmentOrchestrator[method] !== "function",
  )) {
    throw new Error("The canonical fulfillment orchestrator contract is incomplete.");
  }

  const pendingCheckouts = new Map();

  return {
    submitIntake,
    getStatus,
    createCheckout,
    recordPaymentSucceeded,
  };

  async function submitIntake(input, options = {}) {
    const intake = normalizeIntake(input, syntheticOnly);
    const intakeDigest = digestJson(intake);
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const jobId = createId("job");
    const intakeToken = createId("token");
    const submittedAt = now();
    const canonicalIntake = {
      ...intake,
      requestId: jobId,
      submittedAt,
    };
    const response = { jobId, intakeToken, status: "payment_pending" };
    const result = await store.createJob({
      schemaVersion: "1.0",
      jobId,
      version: 1,
      createdAt: submittedAt,
      updatedAt: submittedAt,
      intake: canonicalIntake,
      intakeDigest,
      intakeTokenDigest: digestText(intakeToken),
      payment: { status: "pending", checkout: null, acceptedEventId: null },
    }, idempotencyKey, response, intakeDigest);
    if (result.conflict) {
      throw flowError(409, "idempotency_conflict", "Idempotency key was already used for another request.");
    }
    if (fulfillmentOrchestrator) {
      const persistedJob = await store.readJob(result.response.jobId);
      await fulfillmentOrchestrator.createJob(canonicalJobInput(persistedJob), {
        commandId: `customer-intake:${persistedJob.jobId}`,
      });
    }
    return result.response;
  }

  async function getStatus(jobId, intakeToken) {
    const job = await authenticatedJob(jobId, intakeToken);
    const canonical = fulfillmentOrchestrator
      ? await fulfillmentOrchestrator.status(job.jobId)
      : null;
    return publicStatus(job, canonical);
  }

  async function createCheckout(jobId, intakeToken) {
    const job = await authenticatedJob(jobId, intakeToken);
    if (job.payment.checkout) return checkoutResponse(job);
    if (pendingCheckouts.has(jobId)) return pendingCheckouts.get(jobId);

    const operation = createCheckoutForJob(job).finally(() => pendingCheckouts.delete(jobId));
    pendingCheckouts.set(jobId, operation);
    return operation;
  }

  async function createCheckoutForJob(job) {
    const metadata = paymentMetadata(job);
    const session = await paymentGateway.createCheckoutSession({
      amountMinor: PRICE_MINOR,
      currency: CURRENCY,
      jobId: job.jobId,
      customerEmail: job.intake.customer.email,
      metadata,
      paymentIntentMetadata: metadata,
      idempotencyKey: `checkout:${job.jobId}:${job.intakeDigest}`,
    });
    if (!isNonEmptyString(session?.id) || !isSafeUrl(session?.url) || session.mode !== "test") {
      throw new CustomerFlowError(502, "invalid_checkout_session", "Payment provider returned an invalid test session.");
    }

    const updated = await store.updateJob(job.jobId, (current) => {
      if (current.payment.checkout) return current;
      current.payment.checkout = {
        sessionId: session.id,
        checkoutUrl: session.url,
        mode: "test",
        metadata,
        createdAt: now(),
      };
      current.updatedAt = now();
      return current;
    });
    return checkoutResponse(updated);
  }

  async function recordPaymentSucceeded(event) {
    const normalized = normalizePaymentEvent(event);
    const fingerprint = normalized.payloadSha256 || digestJson(normalized);
    const replay = await store.readProviderEvent(normalized.providerEventId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw flowError(409, "payment_event_conflict", "Payment event replay did not match its original payload.");
      }
      if (replay.result) return replay.result;
    }

    const jobId = normalized.metadata.job_id;
    const job = await store.readJob(jobId);
    if (!job || !paymentMatchesJob(normalized, job)) {
      throw flowError(409, "payment_correlation_failed", "Payment could not be correlated to its canonical job.");
    }
    if (job.payment.status === "paid"
        && job.payment.paymentIntentId !== normalized.paymentIntentId) {
      throw flowError(409, "payment_event_conflict", "A different payment event is already bound to this job.");
    }

    const claim = await store.claimProviderEvent(normalized.providerEventId, fingerprint);
    if (claim.event.fingerprint !== fingerprint) {
      throw flowError(409, "payment_event_conflict", "Payment event replay did not match its original payload.");
    }
    if (claim.event.result) return claim.event.result;

    if (job.payment.status === "paid") {
      const canonical = fulfillmentOrchestrator
        ? await fulfillmentOrchestrator.status(jobId)
        : null;
      return completePaymentEvent(
        store,
        normalized.providerEventId,
        fingerprint,
        publicStatus(job, canonical),
      );
    }

    const canonical = fulfillmentOrchestrator
      ? await fulfillmentOrchestrator.recordPayment(jobId, {
          commandId: paymentCommandId(normalized),
          providerEventId: normalized.providerEventId,
          providerPaymentId: normalized.paymentIntentId,
          correlation: canonicalPaymentCorrelation(job),
          recordedAt: now(),
        })
      : null;

    const updated = await store.updateJob(jobId, (current) => {
      if (current.payment.status === "paid") {
        if (current.payment.paymentIntentId !== normalized.paymentIntentId) {
          throw flowError(409, "payment_event_conflict", "A different payment event is already bound to this job.");
        }
        return current;
      }
      current.payment = {
        ...current.payment,
        status: "paid",
        paymentIntentId: normalized.paymentIntentId,
        acceptedEventId: normalized.providerEventId,
        paidAt: now(),
      };
      current.updatedAt = now();
      return current;
    });
    const result = publicStatus(updated, canonical);
    return completePaymentEvent(store, normalized.providerEventId, fingerprint, result);
  }


  async function authenticatedJob(jobId, token) {
    if (!isNonEmptyString(jobId) || !isNonEmptyString(token)) throw notFound();
    const job = await store.readJob(jobId);
    if (!job || !safeDigestEqual(job.intakeTokenDigest, digestText(token))) throw notFound();
    return job;
  }

}

async function completePaymentEvent(store, providerEventId, fingerprint, result) {
  const completed = await store.completeProviderEvent(providerEventId, fingerprint, result);
  if (completed.event?.fingerprint !== fingerprint) {
    throw flowError(409, "payment_event_conflict", "Payment event replay did not match its original payload.");
  }
  return completed.event.result;
}

function paymentCommandId(payment) {
  return `stripe-payment:${digestJson({
    jobId: payment.metadata.job_id,
    sessionId: payment.sessionId,
    paymentIntentId: payment.paymentIntentId,
  })}`;
}

function normalizeIntake(input, syntheticOnly) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidIntake();
  const customer = input.customer;
  const baby = input.baby;
  const voice = input.voicePreference;
  if (!customer || !isEmail(customer.email) || customer.consent !== true
      || (syntheticOnly && !isSyntheticTestEmail(customer.email))) invalidIntake();
  if (!baby || !boundedText(baby.firstName, 1, 100)) invalidIntake();
  if (baby.nameArabic !== undefined && !boundedText(baby.nameArabic, 1, 100)) invalidIntake();
  if (!["girl", "boy", "neutral"].includes(baby.gender)) invalidIntake();
  if (baby.birthDate !== undefined && !isIsoDate(baby.birthDate)) invalidIntake();
  if (!Array.isArray(input.languages) || input.languages.length < 1 || input.languages.length > 2
      || new Set(input.languages).size !== input.languages.length
      || input.languages.some((language) => !["fr", "ar"].includes(language))) invalidIntake();
  if (!voice || typeof voice.enabled !== "boolean"
      || !["male", "female", "neutral"].includes(voice.gender)) invalidIntake();
  if (input.request !== undefined && !boundedText(input.request, 0, 2000)) invalidIntake();
  if (input.schemaVersion !== "1.0") invalidIntake();

  return structuredClone(input);
}

function invalidIntake() {
  throw flowError(400, "invalid_intake", "Submitted intake fields are invalid.");
}

function isSyntheticTestEmail(value) {
  const email = value.toLowerCase();
  return email.endsWith(".test") || RESEND_TEST_SINKS.has(email);
}

function normalizePaymentEvent(event) {
  if (!event || typeof event !== "object") {
    throw flowError(400, "invalid_payment_event", "Payment event is invalid.");
  }
  assertIdentifier(event.providerEventId, "Payment event id");
  assertIdentifier(event.sessionId, "Checkout session id");
  assertIdentifier(event.paymentIntentId, "Payment intent id");
  if (event.amountMinor !== PRICE_MINOR || String(event.currency).toUpperCase() !== CURRENCY
      || event.livemode !== false || !event.metadata || typeof event.metadata !== "object") {
    throw flowError(409, "payment_correlation_failed", "Payment could not be correlated to its canonical job.");
  }
  if (event.payloadSha256 !== undefined && !/^[a-f0-9]{64}$/.test(event.payloadSha256)) {
    throw flowError(400, "invalid_payment_event", "Payment event is invalid.");
  }
  return {
    providerEventId: event.providerEventId,
    sessionId: event.sessionId,
    paymentIntentId: event.paymentIntentId,
    amountMinor: event.amountMinor,
    currency: CURRENCY,
    livemode: false,
    metadata: { ...event.metadata },
    payloadSha256: event.payloadSha256 || null,
  };
}

function paymentMatchesJob(event, job) {
  const expected = paymentMetadata(job);
  return job.payment.checkout?.sessionId === event.sessionId
    && Object.entries(expected).every(([key, value]) => event.metadata[key] === value);
}

function paymentMetadata(job) {
  return {
    ...CHECKOUT_METADATA,
    job_id: job.jobId,
    intake_digest: job.intakeDigest,
  };
}

function canonicalPaymentCorrelation(job) {
  return {
    project: CHECKOUT_METADATA.project,
    product: CHECKOUT_METADATA.product,
    environment: CHECKOUT_METADATA.environment,
    jobId: job.jobId,
    intakeDigest: job.intakeDigest,
  };
}

function canonicalJobInput(job) {
  return {
    jobId: job.jobId,
    environment: "test",
    product: CHECKOUT_METADATA.product,
    intakeDigest: job.intakeDigest,
    paymentCorrelation: canonicalPaymentCorrelation(job),
    narrationRequired: job.intake.voicePreference.enabled === true,
  };
}

function checkoutResponse(job) {
  return {
    sessionId: job.payment.checkout.sessionId,
    checkoutUrl: job.payment.checkout.checkoutUrl,
    metadata: structuredClone(job.payment.checkout.metadata),
  };
}

function publicStatus(job, canonical = null) {
  if (canonical) return canonicalPublicStatus(job, canonical);
  return {
    jobId: job.jobId,
    status: job.payment.status === "paid" ? "generation_pending" : "payment_pending",
    payment: job.payment.status === "paid" ? "paid" : "pending",
    review: "not_ready",
    delivery: "not_ready",
  };
}

function canonicalPublicStatus(job, canonical) {
  const state = canonical.state;
  const result = {
    jobId: job.jobId,
    status: canonicalCustomerState(state),
    payment: state === "awaiting_payment" ? "pending" : "paid",
    review: canonicalReviewState(state),
    delivery: ["sent", "complete"].includes(state)
      ? "accepted"
      : ["published", "delivery_queued", "sending"].includes(state)
        ? "ready"
        : "not_ready",
  };
  if (state === "complete" && isSafeUrl(canonical.publication?.stableUrl)) {
    result.stableUrl = canonical.publication.stableUrl;
  }
  return result;
}

function canonicalCustomerState(state) {
  if (state === "awaiting_payment") return "payment_pending";
  if (["generation_queued", "generating"].includes(state)) return "generation_pending";
  if ([
    "content_review_required",
    "render_queued",
    "rendering",
    "tts_queued",
    "tts_generating",
    "narration_review_required",
    "rejected",
  ].includes(state)) return "review_required";
  if (["publish_ready", "publishing"].includes(state)) return "publication_ready";
  if (["published", "delivery_queued", "sending", "sent"].includes(state)) return "delivery_ready";
  if (state === "complete") return "complete";
  if (state === "failed") return "failed";
  return "processing";
}

function canonicalReviewState(state) {
  if (["awaiting_payment", "generation_queued", "generating"].includes(state)) return "not_ready";
  if (state === "rejected") return "changes_required";
  if (["publish_ready", "publishing", "published", "delivery_queued", "sending", "sent", "complete"].includes(state)) {
    return "approved";
  }
  return "pending";
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw flowError(400, "invalid_identifier", `${label} is invalid.`);
  }
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{8,160}$/.test(value)) {
    throw flowError(400, "invalid_idempotency_key", "Idempotency key is invalid.");
  }
  return value;
}

function defaultCreateId(kind) {
  if (kind === "job") return `job_${randomUUID().replaceAll("-", "")}`;
  if (kind === "token") return `tok_${randomBytes(32).toString("base64url")}`;
  return `${kind}_${randomUUID().replaceAll("-", "")}`;
}

function digestJson(value) {
  return digestText(stableStringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(first, second) {
  const a = Buffer.from(first || "", "utf8");
  const b = Buffer.from(second || "", "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isSafeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function isEmail(value) {
  return typeof value === "string" && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function boundedText(value, minimum, maximum) {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function notFound() {
  return flowError(404, "job_not_found", "Job was not found.");
}

function flowError(statusCode, code, message) {
  return new CustomerFlowError(statusCode, code, message);
}
