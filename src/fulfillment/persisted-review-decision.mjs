import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const APPROVAL_SCHEMA_VERSION = "1.0";
const REVIEW_STAGE_BY_TYPE = Object.freeze({
  content: "prepare_review",
  narration: "generate_tts",
});

export function signPersistedReviewApproval({ hmacKey, job, decision }) {
  const key = reviewKey(hmacKey);
  const binding = approvalBinding(job, decision);
  const unsignedDecision = normalizeUnsignedDecision(decision);
  const approvalId = `approval_${sha256(canonicalJson({
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    binding,
    decision: unsignedDecision,
  })).slice(0, 24)}`;
  const approval = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId,
    binding,
    decision: {
      ...unsignedDecision,
      commandId: `review:${approvalId}`,
    },
  };
  return {
    ...approval,
    signature: createHmac("sha256", key).update(canonicalJson(approval)).digest("hex"),
  };
}

export function createPersistedReviewDecisionVerifier({ hmacKey, approvalStore, fulfillmentStore }) {
  const key = reviewKey(hmacKey);
  if (typeof approvalStore?.getReviewApproval !== "function") {
    throw new Error("A persisted review approval store is required.");
  }
  if (typeof fulfillmentStore?.getJob !== "function") {
    throw new Error("The canonical fulfillment store is required for review verification.");
  }

  return async function verifyPersistedReviewDecision({ job, decision }) {
    const approvalId = requireApprovalId(decision?.approvalId);
    const approval = await approvalStore.getReviewApproval(approvalId);
    if (!approval) throw new Error("Persisted human review approval was not found.");
    verifyApprovalSignature(approval, key);
    const expected = signPersistedReviewApproval({
      hmacKey: key,
      job,
      decision: approval.decision,
    });
    if (!timingSafeTextEqual(approval.approvalId, expected.approvalId)
        || !timingSafeTextEqual(canonicalJson(approval.binding), canonicalJson(expected.binding))) {
      throw new Error("Persisted human review approval does not bind the current job run and manifest.");
    }
    const aggregate = await fulfillmentStore.getJob(job.jobId);
    assertExactPersistedArtifacts(aggregate, approval);
    return structuredClone({
      ...approval.decision,
      approvalId: approval.approvalId,
    });
  };
}

function assertExactPersistedArtifacts(aggregate, approval) {
  const expectedKind = approval.decision.decisionType === "content"
    ? "private_review"
    : "narration_review";
  const artifactSet = [...(aggregate?.artifactSets || [])].reverse().find((entry) => (
    entry.kind === expectedKind && entry.revisionId === approval.binding.revisionId
  ));
  const digests = approval.decision.artifactDigests;
  if (
    !artifactSet
    || artifactSet.pageDigest !== digests.pageDigest
    || artifactSet.transcriptDigest !== digests.transcriptDigest
    || artifactSet.assetManifestDigest !== digests.assetManifestDigest
    || artifactSet.assetManifestDigest !== approval.binding.artifactManifestDigest
  ) {
    throw new Error("Review approval does not match the exact persisted artifact manifest.");
  }
}

function approvalBinding(job, decision) {
  if (!job || job.environment !== "test" || job.product !== "announcement-page") {
    throw new Error("Persisted review approval is restricted to the TEST-A announcement product.");
  }
  if (decision?.revisionId !== job.currentRevisionId) {
    throw new Error("Persisted review approval must bind the current exact revision.");
  }
  const stage = REVIEW_STAGE_BY_TYPE[decision.decisionType];
  if (!stage) throw new Error("Persisted review approval decision type is invalid.");
  const attempt = [...(job.stageAttempts || [])].reverse().find((entry) => (
    entry.stage === stage
    && entry.status === "completed"
    && (decision.decisionType === "content" || entry.revisionId === job.currentRevisionId)
  ));
  if (!attempt?.attemptId) {
    throw new Error("Persisted review approval requires the completed exact generation run.");
  }
  const artifactManifestDigest = decision.artifactDigests?.assetManifestDigest;
  assertDigest(artifactManifestDigest, "review artifact manifest digest");
  assertDigest(job.intakeDigest, "review intake digest");
  return {
    jobId: requireIdentifier(job.jobId, "review job id"),
    intakeDigest: job.intakeDigest,
    environment: "test",
    product: "announcement-page",
    revisionId: job.currentRevisionId,
    runId: attempt.attemptId,
    artifactManifestDigest,
  };
}

function normalizeUnsignedDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error("A human review decision is required.");
  }
  assertOnlyKeys(decision, [
    "commandId",
    "decisionType",
    "revisionId",
    "outcome",
    "policyVersion",
    "rubricVersion",
    "reviewer",
    "decidedAt",
    "artifactDigests",
    "reasons",
  ], "review decision");
  assertOnlyKeys(decision.reviewer, ["id", "role", "competencies"], "reviewer");
  assertOnlyKeys(
    decision.artifactDigests,
    ["pageDigest", "transcriptDigest", "assetManifestDigest"],
    "review artifact digests",
  );
  const normalized = structuredClone(decision);
  delete normalized.commandId;
  return normalized;
}

function assertOnlyKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unexpected fields.`);
}

function verifyApprovalSignature(approval, key) {
  assertOnlyKeys(
    approval,
    ["schemaVersion", "approvalId", "binding", "decision", "signature"],
    "persisted review approval",
  );
  assertOnlyKeys(
    approval.binding,
    ["jobId", "intakeDigest", "environment", "product", "revisionId", "runId", "artifactManifestDigest"],
    "persisted review approval binding",
  );
  assertOnlyKeys(approval.decision, [
    "commandId",
    "decisionType",
    "revisionId",
    "outcome",
    "policyVersion",
    "rubricVersion",
    "reviewer",
    "decidedAt",
    "artifactDigests",
    "reasons",
  ], "persisted review decision");
  if (!approval || approval.schemaVersion !== APPROVAL_SCHEMA_VERSION) {
    throw new Error("Persisted human review approval schema is invalid.");
  }
  requireApprovalId(approval.approvalId);
  if (typeof approval.signature !== "string" || !/^[a-f0-9]{64}$/.test(approval.signature)) {
    throw new Error("Persisted human review approval signature is invalid.");
  }
  const signed = {
    schemaVersion: approval.schemaVersion,
    approvalId: approval.approvalId,
    binding: approval.binding,
    decision: approval.decision,
  };
  const expected = createHmac("sha256", key).update(canonicalJson(signed)).digest("hex");
  if (!timingSafeTextEqual(approval.signature, expected)) {
    throw new Error("Persisted human review approval signature verification failed.");
  }
}

function reviewKey(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value || "", "utf8");
  if (key.byteLength < 32) throw new Error("The operator review HMAC key must contain at least 32 bytes.");
  return key;
}

function requireApprovalId(value) {
  if (typeof value !== "string" || !/^approval_[a-f0-9]{24}$/.test(value)) {
    throw new Error("A persisted human review approval id is required.");
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function timingSafeTextEqual(left, right) {
  const first = Buffer.from(left || "", "utf8");
  const second = Buffer.from(right || "", "utf8");
  return first.length === second.length && timingSafeEqual(first, second);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  throw new Error("Persisted review approvals must contain deterministic JSON values only.");
}
