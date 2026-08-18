import { createHash } from "node:crypto";

const DELIVERY_OUTCOMES = new Set(["pending", "delivered", "failed"]);

export function createExternalEffectStageHandlers(options = {}) {
  const publicationAdapter = options.publicationAdapter;
  const deliveryAdapter = options.deliveryAdapter;
  const resolveDeliveryTarget = options.resolveDeliveryTarget;
  assertAdapter(publicationAdapter, "publication", ["reconcile", "publish"]);
  assertAdapter(deliveryAdapter, "delivery", ["reconcile", "send", "status"]);
  if (typeof resolveDeliveryTarget !== "function") {
    throw new Error("An explicit private delivery target resolver is required.");
  }

  return {
    async prepare_delivery(context) {
      const target = await resolveDeliveryTarget(context.job, null);
      assertDeliveryTarget(target);
      return deliveryTargetBinding(target);
    },

    async publish(context) {
      const operation = requireOperation(context, "publish");
      const request = Object.freeze({
        jobId: operation.jobId,
        environment: operation.environment,
        product: operation.product,
        revisionId: operation.revisionId,
        artifactSetId: operation.artifactSetId,
        artifactManifestDigest: operation.artifactManifestDigest,
        artifactSet: structuredClone(operation.artifactSet),
        idempotencyKey: requireIdempotencyKey(context),
      });
      const reconciled = await publicationAdapter.reconcile(request);
      const publication = reconciled || await publicationAdapter.publish(request);
      return { publication: normalizePublication(publication, request) };
    },

    async deliver(context) {
      const operation = requireOperation(context, "deliver");
      const reconciliationRequest = Object.freeze({
        jobId: operation.jobId,
        environment: operation.environment,
        product: operation.product,
        revisionId: operation.revisionId,
        artifactManifestDigest: operation.artifactManifestDigest,
        publication: structuredClone(operation.publication),
        targetDigest: operation.deliveryTarget.targetDigest,
        attemptStartedAt: operation.attemptStartedAt,
        idempotencyKey: requireIdempotencyKey(context),
      });
      const reconciled = await deliveryAdapter.reconcile(reconciliationRequest);
      if (reconciled) {
        return { delivery: normalizeDelivery(reconciled, reconciliationRequest) };
      }
      const target = await resolveDeliveryTarget(context.job, operation.deliveryTarget.targetRef);
      assertDeliveryTarget(target);
      const currentBinding = deliveryTargetBinding(target);
      if (
        currentBinding.targetRef !== operation.deliveryTarget.targetRef
        || currentBinding.targetDigest !== operation.deliveryTarget.targetDigest
      ) {
        throw providerResultError("Delivery target changed after the operation was claimed.");
      }
      const sendRequest = Object.freeze({
        ...reconciliationRequest,
        target: structuredClone(target),
      });
      return { delivery: normalizeDelivery(await deliveryAdapter.send(sendRequest), sendRequest) };
    },

    async reconcile_delivery(context) {
      const operation = requireOperation(context, "deliver");
      const delivery = operation.delivery;
      if (!delivery || delivery.status !== "sent") {
        throw new Error("Delivery reconciliation requires one exact sent provider message.");
      }
      const outcome = await deliveryAdapter.status(Object.freeze({
        jobId: operation.jobId,
        environment: operation.environment,
        revisionId: operation.revisionId,
        provider: delivery.provider,
        providerMessageId: delivery.providerMessageId,
        idempotencyKey: delivery.idempotencyKey,
      }));
      return normalizeDeliveryOutcome(outcome, delivery.providerMessageId);
    },
  };
}

function normalizePublication(value, request) {
  if (!value || typeof value !== "object") {
    throw providerResultError("Publication provider returned no receipt.");
  }
  if (value.revisionId !== request.revisionId) {
    throw providerResultError("Publication receipt revision does not match the requested revision.");
  }
  if (value.artifactManifestDigest !== request.artifactManifestDigest) {
    throw providerResultError("Publication receipt does not match the exact artifact manifest.");
  }
  if (value.idempotencyKey !== request.idempotencyKey) {
    throw providerResultError("Publication receipt does not match the exact persisted operation.");
  }
  for (const key of ["provider", "stableUrl", "providerReceiptId"]) {
    assertNonEmptyString(value[key], `publication ${key}`);
  }
  return {
    provider: value.provider,
    revisionId: value.revisionId,
    stableUrl: value.stableUrl,
    artifactManifestDigest: value.artifactManifestDigest,
    providerReceiptId: value.providerReceiptId,
  };
}

function normalizeDelivery(value, request) {
  if (!value || typeof value !== "object") {
    throw providerResultError("Delivery provider returned no acceptance receipt.");
  }
  if (value.revisionId !== request.revisionId) {
    throw providerResultError("Delivery receipt revision does not match the requested revision.");
  }
  if (
    value.idempotencyKey !== request.idempotencyKey
    || value.artifactManifestDigest !== request.artifactManifestDigest
    || value.targetDigest !== request.targetDigest
  ) {
    throw providerResultError("Delivery receipt does not match the exact persisted operation.");
  }
  for (const key of ["provider", "providerMessageId"]) {
    assertNonEmptyString(value[key], `delivery ${key}`);
  }
  return {
    provider: value.provider,
    revisionId: value.revisionId,
    providerMessageId: value.providerMessageId,
  };
}

function normalizeDeliveryOutcome(value, expectedMessageId) {
  if (!value || typeof value !== "object" || !DELIVERY_OUTCOMES.has(value.outcome)) {
    throw providerResultError("Delivery provider returned an invalid status outcome.");
  }
  if (value.providerMessageId !== expectedMessageId) {
    throw providerResultError("Delivery status does not match the exact provider message.");
  }
  assertTimestamp(value.recordedAt, "delivery recordedAt");
  if (value.outcome === "failed") {
    if (typeof value.retryable !== "boolean") {
      throw providerResultError("Failed delivery status requires a retryable classification.");
    }
    if (typeof value.reasonCode !== "string" || !/^[a-z0-9_]{1,64}$/.test(value.reasonCode)) {
      throw providerResultError("Failed delivery status requires a bounded reasonCode.");
    }
  }
  return {
    providerMessageId: value.providerMessageId,
    outcome: value.outcome,
    recordedAt: value.recordedAt,
    retryable: value.outcome === "failed" ? value.retryable : false,
    reasonCode: value.outcome === "failed" ? value.reasonCode : null,
  };
}

function requireOperation(context, expectedStage) {
  const operation = context?.operation;
  if (!operation || typeof operation !== "object") {
    throw new Error(`Persisted ${expectedStage} operation context is required.`);
  }
  if (context.stage !== expectedStage && context.stage !== "reconcile_delivery") {
    throw new Error(`External effect handler expected ${expectedStage} context.`);
  }
  assertNonEmptyString(operation.jobId, "operation jobId");
  assertNonEmptyString(operation.environment, "operation environment");
  assertNonEmptyString(operation.revisionId, "operation revisionId");
  assertDigest(operation.artifactManifestDigest, "operation artifactManifestDigest");
  return operation;
}

function requireIdempotencyKey(context) {
  const value = context?.idempotencyKey;
  if (typeof value !== "string" || !/^bb_[a-f0-9]{64}$/.test(value)) {
    throw new Error("A persisted fulfillment idempotency key is required.");
  }
  return value;
}

function assertDeliveryTarget(target) {
  if (!target || typeof target !== "object" || Object.keys(target).length === 0) {
    throw new Error("A private delivery target projection is required.");
  }
  assertNonEmptyString(target.targetRef, "delivery targetRef");
}

function deliveryTargetBinding(target) {
  return {
    targetRef: target.targetRef,
    targetDigest: createHash("sha256").update(canonicalJson(target)).digest("hex"),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Delivery target values must be JSON-serializable.");
  return serialized;
}

function assertAdapter(adapter, label, methods) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error(`A ${label} adapter is required.`);
  }
  for (const method of methods) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`${label} adapter method ${method} is required.`);
    }
  }
}

function providerResultError(message) {
  const error = new Error(message);
  error.reasonCode = "provider_receipt_invalid";
  error.retryable = false;
  return error;
}

function assertTimestamp(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw providerResultError(`${label} must be an ISO timestamp.`);
  }
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw providerResultError(`${label} is required.`);
  }
}
