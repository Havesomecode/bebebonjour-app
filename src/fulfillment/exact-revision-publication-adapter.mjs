const SAFE_ARTIFACT_KINDS = new Set(["prepared_bundle", "narration_review"]);

export function createExactRevisionPublicationAdapter(options = {}) {
  const provider = options.provider;
  if (typeof provider?.reconcile !== "function" || typeof provider?.publish !== "function") {
    throw new Error("A private publication provider with reconcile and publish methods is required.");
  }
  const stableOrigin = exactHttpsOrigin(options.stableOrigin);

  return {
    async reconcile(request) {
      const exactRequest = normalizeRequest(request);
      const receipt = await provider.reconcile(exactRequest);
      return receipt === null || receipt === undefined
        ? null
        : normalizeReceipt(receipt, exactRequest, stableOrigin);
    },

    async publish(request) {
      const exactRequest = normalizeRequest(request);
      return normalizeReceipt(await provider.publish(exactRequest), exactRequest, stableOrigin);
    },
  };
}

function normalizeRequest(request) {
  if (!request || request.environment !== "test" || request.product !== "announcement-page") {
    throw publicationError("Publication is restricted to the TEST-A announcement product.");
  }
  const { fenceExternalEffect, artifactReadAuthority, ...serializableRequest } = request;
  const exact = structuredClone(serializableRequest);
  if (fenceExternalEffect !== undefined) {
    if (typeof fenceExternalEffect !== "function") {
      throw publicationError("Publication external-effect fence is invalid.");
    }
    exact.fenceExternalEffect = fenceExternalEffect;
  }
  if (artifactReadAuthority !== undefined) {
    exact.artifactReadAuthority = normalizeArtifactReadAuthority(artifactReadAuthority);
  }
  requireIdentifier(exact.jobId, "publication job id");
  requireIdentifier(exact.revisionId, "publication revision id");
  requireIdentifier(exact.artifactSetId, "publication artifact set id");
  requireIdempotencyKey(exact.idempotencyKey);
  if (
    exact.reconciliationCursor !== undefined
    && (!Number.isSafeInteger(exact.reconciliationCursor) || exact.reconciliationCursor < 0)
  ) {
    throw publicationError("Publication reconciliation cursor is invalid.");
  }
  if (
    exact.priorEffectStartedAt !== undefined
    && !isRfc3339DateTime(exact.priorEffectStartedAt)
  ) {
    throw publicationError("Publication prior effect start time is invalid.");
  }
  if (exact.reconciliationOnly !== undefined && typeof exact.reconciliationOnly !== "boolean") {
    throw publicationError("Publication reconciliation mode is invalid.");
  }
  assertDigest(exact.artifactManifestDigest, "publication artifact manifest digest");
  const artifactSet = exact.artifactSet;
  if (
    !artifactSet
    || requireIdentifier(artifactSet.artifactSetId, "publication nested artifact set id") !== exact.artifactSetId
  ) {
    throw publicationError("Publication artifact set id does not match the exact persisted operation.");
  }
  if (
    !SAFE_ARTIFACT_KINDS.has(artifactSet.kind)
    || artifactSet.revisionId !== exact.revisionId
    || artifactSet.assetManifestDigest !== exact.artifactManifestDigest
    || !Array.isArray(artifactSet.files)
    || artifactSet.files.length === 0
  ) {
    throw publicationError("Publication artifact set does not match the exact revision and manifest.");
  }
  assertSafeRelativePath(artifactSet.manifestRef, "publication artifact manifest reference");
  for (const file of artifactSet.files) {
    assertSafeRelativePath(file?.path, "publication artifact path");
    assertDigest(file?.sha256, "publication artifact file digest");
    if (!Number.isSafeInteger(file?.bytes) || file.bytes < 0) {
      throw publicationError("Publication artifact byte count is invalid.");
    }
    requireNonEmptyString(file?.storageId, "publication artifact storage id");
  }
  return Object.freeze(exact);
}

function normalizeArtifactReadAuthority(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw publicationError("Publication artifact read authority is invalid.");
  }
  const exact = {};
  for (const name of ["workerId", "commandId", "leaseToken"]) {
    exact[name] = requireNonEmptyString(value[name], `publication ${name}`);
  }
  return Object.freeze(exact);
}

function normalizeReceipt(receipt, request, stableOrigin) {
  if (!receipt || typeof receipt !== "object") {
    throw publicationError("Publication provider returned no exact receipt.");
  }
  if (
    receipt.revisionId !== request.revisionId
    || receipt.artifactSetId !== request.artifactSetId
    || receipt.artifactManifestDigest !== request.artifactManifestDigest
    || receipt.idempotencyKey !== request.idempotencyKey
  ) {
    throw publicationError("Publication provider receipt does not match the exact persisted operation.");
  }
  const stableUrl = new URL(requireNonEmptyString(receipt.stableUrl, "publication stable URL"));
  if (
    stableUrl.origin !== stableOrigin
    || stableUrl.pathname !== `/announcements/${encodeURIComponent(request.jobId)}`
    || stableUrl.search !== ""
    || stableUrl.hash !== ""
  ) {
    throw publicationError("Publication provider receipt is outside the approved stable TEST-A path.");
  }
  return {
    provider: requireNonEmptyString(receipt.provider, "publication provider"),
    providerReceiptId: requireNonEmptyString(receipt.providerReceiptId, "publication provider receipt id"),
    stableUrl: stableUrl.href,
    revisionId: request.revisionId,
    artifactSetId: request.artifactSetId,
    artifactManifestDigest: request.artifactManifestDigest,
    idempotencyKey: request.idempotencyKey,
  };
}

function exactHttpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The publication stable origin must be an exact HTTPS origin.");
  }
  return url.origin;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw publicationError(`${label} is invalid.`);
  }
  return value;
}

function requireIdempotencyKey(value) {
  if (typeof value !== "string" || !/^bb_[a-f0-9]{64}$/.test(value)) {
    throw publicationError("Publication requires the persisted fulfillment idempotency key.");
  }
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw publicationError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw publicationError(`${label} is required.`);
  }
  return value.trim();
}

function assertSafeRelativePath(value, label) {
  const normalized = requireNonEmptyString(value, label);
  const segments = normalized.split("/");
  if (
    normalized.length > 512
    || normalized.startsWith("/")
    || normalized.includes("\\")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw publicationError(`${label} must be a safe relative path.`);
  }
  return normalized;
}

function isRfc3339DateTime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]
    && Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 59
    && Number(offsetHourText || 0) <= 23
    && Number(offsetMinuteText || 0) <= 59
  );
}

function publicationError(message) {
  const error = new Error(message);
  error.reasonCode = "publication_binding_invalid";
  error.retryable = false;
  return error;
}
