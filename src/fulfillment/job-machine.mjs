import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJobScopedEditorialApprovalRecord } from "./job-scoped-editorial-approval-canonicalization.mjs";

export const EDITORIAL_POLICY_VERSION = "bebebonjour-editorial-v1";
export const RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID =
  "job_c633aa4c-0039-4257-8913-eaa6f6197d0c";

const FAILED_PREPARE_REVIEW_EDITORIAL_POLICY = Object.freeze({
  id: "unknown_name_general_wishes",
  preserveSubmittedName: true,
  meaningAllowed: false,
  scripturalNameAssociationAllowed: false,
  genericBlessingsAllowed: true,
  maxStage: "content_review_required",
});

const STAGES_BY_STATE = Object.freeze({
  generation_queued: "prepare_review",
  render_queued: "render_approved",
  tts_queued: "generate_tts",
  publish_ready: "publish",
  delivery_queued: "deliver",
});

const RUNNING_STATE_BY_STAGE = Object.freeze({
  prepare_review: "generating",
  render_approved: "rendering",
  generate_tts: "tts_generating",
  publish: "publishing",
  deliver: "sending",
});

const QUEUED_STATE_BY_STAGE = Object.freeze(
  Object.fromEntries(Object.entries(STAGES_BY_STATE).map(([state, stage]) => [stage, state])),
);

const REVIEW_OUTCOMES = new Set(["approved", "request_changes", "rejected"]);
const REVIEW_TYPES = new Set(["content", "narration"]);
const DIGEST_KEYS = ["pageDigest", "transcriptDigest", "assetManifestDigest"];

export function createJobAggregate(input, { commandId, at }) {
  assertNonEmptyString(commandId, "commandId");
  assertTimestamp(at, "creation timestamp");
  assertNonEmptyString(input?.jobId, "jobId");
  if (input.environment !== "test") {
    throw new Error("The local TEST-A job model accepts synthetic test jobs only.");
  }
  assertNonEmptyString(input.product, "product");
  assertDigest(input.intakeDigest, "intakeDigest");
  assertPaymentCorrelation(input.paymentCorrelation, input);
  const creationCommand = { commandId, input };

  return {
    schemaVersion: "1.0",
    authority: "convex-target/local-test-projection",
    jobId: input.jobId,
    environment: input.environment,
    product: input.product,
    intakeDigest: input.intakeDigest,
    paymentCorrelation: clone(input.paymentCorrelation),
    narrationRequired: input.narrationRequired === true,
    state: "awaiting_payment",
    version: 1,
    createdAt: at,
    updatedAt: at,
    currentRevisionId: null,
    publishedRevisionId: null,
    retry: null,
    payment: null,
    revisions: [],
    artifactSets: [],
    reviewDecisions: [],
    stageAttempts: [],
    publication: null,
    deliveryAttempts: [],
    events: [{
      eventId: eventId(input.jobId, commandId),
      commandId,
      commandDigest: commandReplayDigest("job_created", creationCommand),
      type: "job_created",
      at,
      state: "awaiting_payment",
    }],
  };
}

export function recordPaymentTransition(aggregate, payment, at) {
  return withCommand(aggregate, payment, "payment_recorded", at, (next) => {
    requireState(next, "awaiting_payment", "record payment");
    assertNonEmptyString(payment.providerEventId, "providerEventId");
    assertNonEmptyString(payment.providerPaymentId, "providerPaymentId");
    assertTimestamp(payment.recordedAt, "payment recordedAt");
    if (!isDeepStrictEqual(payment.correlation, next.paymentCorrelation)) {
      throw new Error("Payment correlation does not match the exact fulfillment job.");
    }
    next.payment = clone({
      providerEventId: payment.providerEventId,
      providerPaymentId: payment.providerPaymentId,
      correlation: payment.correlation,
      recordedAt: payment.recordedAt,
    });
    next.state = "generation_queued";
  }, {
    commandId: payment.commandId,
    providerPaymentId: payment.providerPaymentId,
    correlation: payment.correlation,
  });
}

export function nextStageForState(aggregate) {
  return STAGES_BY_STATE[aggregate.state] || null;
}

export function claimStageTransition(aggregate, claim, at) {
  return withCommand(aggregate, claim, "stage_claimed", at, (next) => {
    assertNonEmptyString(claim.stage, "stage");
    const expectedStage = nextStageForState(next);
    if (expectedStage !== claim.stage) {
      throw new Error(`Cannot claim ${claim.stage} while job is ${next.state}.`);
    }
    assertStageClaimEligible(next, claim.stage);
    assertNonEmptyString(claim.leaseToken, "leaseToken");
    assertPositiveInteger(claim.leaseMs, "leaseMs");
    assertPositiveInteger(claim.maxAttempts, "maxAttempts");
    const attemptNumber = next.stageAttempts.filter(
      (attempt) => attempt.stage === claim.stage && attempt.revisionId === next.currentRevisionId,
    ).length + 1;
    if (attemptNumber > claim.maxAttempts) {
      throw new Error(`Stage ${claim.stage} exhausted its explicitly configured attempt limit.`);
    }
    const revisionId = next.currentRevisionId;
    const attemptId = digestId("attempt", next.jobId, revisionId || "unassigned", claim.stage, String(attemptNumber));
    const operationNumber = next.stageAttempts.filter(
      (attempt) => attempt.stage === claim.stage
        && attempt.revisionId === revisionId
        && attempt.status === "completed",
    ).length + 1;
    const operationBinding = normalizeOperationBinding(claim.stage, claim.operationBinding);
    const operationsCommandId = normalizeOperationsCommandId(claim.operationsCommandId);
    next.stageAttempts.push({
      attemptId,
      stage: claim.stage,
      revisionId,
      attemptNumber,
      operationNumber,
      idempotencyKey: stageIdempotencyKey(next.jobId, revisionId, claim.stage, operationNumber),
      operationBinding,
      ...(operationsCommandId ? { operationsCommandId } : {}),
      status: "running",
      leaseToken: claim.leaseToken,
      leaseExpiresAt: new Date(Date.parse(at) + claim.leaseMs).toISOString(),
      startedAt: at,
      effectStartedAt: null,
      completedAt: null,
      failure: null,
    });
    next.state = RUNNING_STATE_BY_STAGE[claim.stage];
    next.retry = null;
  }, {
    commandId: claim.commandId,
    stage: claim.stage,
    leaseMs: claim.leaseMs,
    maxAttempts: claim.maxAttempts,
    operationBinding: claim.operationBinding || null,
    operationsCommandId: claim.operationsCommandId || null,
  });
}

export function markExternalEffectStartedTransition(aggregate, command, at) {
  return withCommand(aggregate, command, "external_effect_started", at, (next) => {
    if (command.stage !== "publish" && command.stage !== "deliver") {
      throw new Error("Only publication and delivery stages can start an external effect.");
    }
    const attempt = currentRunningAttempt(next, command.stage, command.leaseToken);
    if (attempt.attemptId !== command.attemptId) {
      throw new Error(`External effect marker must bind running attempt ${attempt.attemptId}.`);
    }
    if (Date.parse(at) >= Date.parse(attempt.leaseExpiresAt)) {
      throw new Error("External effect cannot start after its stage lease expired.");
    }
    if (attempt.effectStartedAt !== null) {
      throw new Error("External effect start is already persisted for this attempt.");
    }
    attempt.effectStartedAt = at;
  }, {
    commandId: command.commandId,
    stage: command.stage,
    attemptId: command.attemptId,
  });
}

export function fenceExternalEffectTransition(aggregate, command, at) {
  return withCommand(aggregate, command, "external_effect_fenced", at, (next) => {
    if (command.stage !== "publish" && command.stage !== "deliver") {
      throw new Error("Only publication and delivery stages can fence an external effect.");
    }
    assertPositiveInteger(command.leaseMs, "leaseMs");
    const attempt = currentRunningAttempt(next, command.stage, command.leaseToken);
    if (attempt.attemptId !== command.attemptId) {
      throw new Error(`External effect fence must bind running attempt ${attempt.attemptId}.`);
    }
    if (Date.parse(at) >= Date.parse(attempt.leaseExpiresAt)) {
      throw new Error("External effect cannot cross its provider boundary after the stage lease expired.");
    }
    if (command.effectMayBeIssued === true && attempt.effectStartedAt === null) {
      attempt.effectStartedAt = at;
    }
    attempt.leaseExpiresAt = new Date(Date.parse(at) + command.leaseMs).toISOString();
  }, {
    commandId: command.commandId,
    stage: command.stage,
    attemptId: command.attemptId,
    leaseMs: command.leaseMs,
    effectMayBeIssued: command.effectMayBeIssued === true,
  });
}

export function completeStageTransition(aggregate, completion, at) {
  return withCommand(aggregate, completion, "stage_completed", at, (next) => {
    const attempt = currentRunningAttempt(next, completion.stage, completion.leaseToken);
    if (Date.parse(at) >= Date.parse(attempt.leaseExpiresAt)) {
      throw new Error("Stage completion lease expired before output could be committed.");
    }
    switch (completion.stage) {
      case "prepare_review":
        completePreparedReview(next, completion.result, attempt);
        break;
      case "render_approved":
        completeApprovedRender(next, completion.result, attempt);
        break;
      case "generate_tts":
        completeNarrationGeneration(next, completion.result, attempt);
        break;
      case "publish":
        completePublication(next, completion.result, attempt);
        break;
      case "deliver":
        completeDeliverySend(next, completion.result, attempt);
        break;
      default:
        throw new Error(`Unsupported fulfillment stage: ${completion.stage}`);
    }
    attempt.status = "completed";
    attempt.completedAt = at;
    attempt.leaseToken = null;
    attempt.leaseExpiresAt = null;
  });
}

export function failStageTransition(aggregate, failure, policy, at) {
  return withCommand(aggregate, failure, "stage_failed", at, (next) => {
    const attempt = currentRunningAttempt(next, failure.stage, failure.leaseToken);
    assertNonEmptyString(failure.reasonCode, "failure reasonCode");
    if (!/^[a-z0-9_]{1,64}$/.test(failure.reasonCode)) {
      throw new Error("Failure reasonCode must be a bounded machine-readable value.");
    }
    if (
      Date.parse(at) >= Date.parse(attempt.leaseExpiresAt)
      && (failure.reasonCode !== "lease_expired" || failure.retryable !== true)
    ) {
      throw new Error("An expired lease can only be fenced as a retryable lease_expired failure.");
    }
    const maxAttempts = configuredPositiveInteger(policy?.maxAttemptsByStage?.[failure.stage], "max attempts");
    const retryable = failure.retryable === true && attempt.attemptNumber < maxAttempts;
    const unresolvedExternalEffect = next.stageAttempts.some((entry) => (
        entry.stage === attempt.stage
        && entry.revisionId === attempt.revisionId
        && entry.idempotencyKey === attempt.idempotencyKey
        && typeof entry.effectStartedAt === "string"
    ));
    attempt.status = retryable
      ? "retry_wait"
      : unresolvedExternalEffect
        ? "reconciliation_required"
        : "failed";
    attempt.completedAt = at;
    attempt.leaseToken = null;
    attempt.leaseExpiresAt = null;
    attempt.failure = { retryable, reasonCode: failure.reasonCode };

    if (retryable) {
      const backoffs = policy?.backoffMsByStage?.[failure.stage];
      if (!Array.isArray(backoffs) || backoffs.length < attempt.attemptNumber) {
        throw new Error(`Retry backoff for ${failure.stage} attempt ${attempt.attemptNumber} is not configured.`);
      }
      const backoffMs = configuredPositiveInteger(backoffs[attempt.attemptNumber - 1], "retry backoff");
      next.state = "retry_wait";
      next.retry = {
        stage: failure.stage,
        availableAt: new Date(Date.parse(at) + backoffMs).toISOString(),
      };
      return;
    }

    next.state = unresolvedExternalEffect ? "reconciliation_required" : "failed";
    next.retry = null;
  });
}

export function recoverFailedPrepareReviewTransition(aggregate, recovery, at) {
  return withCommand(aggregate, recovery, "failed_prepare_review_recovered", at, (next) => {
    const attempt = next.stageAttempts?.at(-1);
    const expectedCorrelation = {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId: RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID,
      intakeDigest: next.intakeDigest,
    };
    const expectedApproval = {
      approvalType: "job_scoped_editorial_policy",
      jobId: RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID,
      policy: FAILED_PREPARE_REVIEW_EDITORIAL_POLICY,
      record: recovery?.editorialApproval?.record,
      recordDigest: recovery?.editorialApproval?.recordDigest,
      sourceDigest: recovery?.editorialApproval?.sourceDigest,
      intakeDigest: next.intakeDigest,
    };
    const eligible =
      hasExactKeys(recovery, [
        "commandId",
        "editorialApproval",
        "failedAttemptId",
        "intakeDigest",
        "jobId",
        "paymentCorrelation",
      ])
      && hasExactKeys(recovery?.editorialApproval, [
        "approvalType",
        "intakeDigest",
        "jobId",
        "policy",
        "record",
        "recordDigest",
        "sourceDigest",
      ])
      && next.jobId === RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID
      && recovery.jobId === RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID
      && next.environment === "test"
      && next.product === "announcement-page"
      && next.state === "failed"
      && next.currentRevisionId === null
      && next.publishedRevisionId === null
      && next.retry === null
      && next.intakeDigest === recovery.intakeDigest
      && isDeepStrictEqual(next.paymentCorrelation, expectedCorrelation)
      && isDeepStrictEqual(recovery.paymentCorrelation, expectedCorrelation)
      && isDeepStrictEqual(next.payment?.correlation, expectedCorrelation)
      && typeof next.payment?.providerEventId === "string"
      && next.payment.providerEventId.length > 0
      && typeof next.payment?.providerPaymentId === "string"
      && next.payment.providerPaymentId.length > 0
      && Array.isArray(next.stageAttempts)
      && next.stageAttempts.length === 1
      && attempt?.attemptId === recovery.failedAttemptId
      && attempt?.stage === "prepare_review"
      && attempt?.revisionId === null
      && attempt?.attemptNumber === 1
      && attempt?.operationNumber === 1
      && attempt?.operationBinding === null
      && attempt?.status === "failed"
      && attempt?.effectStartedAt === null
      && attempt?.leaseToken === null
      && attempt?.leaseExpiresAt === null
      && typeof attempt?.completedAt === "string"
      && isDeepStrictEqual(attempt?.failure, { retryable: false, reasonCode: "stage_error" })
      && Array.isArray(next.revisions)
      && next.revisions.length === 0
      && Array.isArray(next.artifactSets)
      && next.artifactSets.length === 0
      && Array.isArray(next.reviewDecisions)
      && next.reviewDecisions.length === 0
      && next.publication === null
      && Array.isArray(next.deliveryAttempts)
      && next.deliveryAttempts.length === 0
      && DIGEST_PATTERN.test(recovery.editorialApproval.recordDigest || "")
      && DIGEST_PATTERN.test(recovery.editorialApproval.sourceDigest || "")
      && isValidFailedPrepareReviewApproval(recovery.editorialApproval.record)
      && recovery.editorialApproval.recordDigest === createHash("sha256")
        .update(serializeCanonicalJobScopedEditorialApprovalRecord(
          recovery.editorialApproval.record,
        ))
        .digest("hex")
      && recovery.editorialApproval.sourceDigest === recovery.editorialApproval.record.sourceDigest
      && isDeepStrictEqual(recovery.editorialApproval, expectedApproval);
    if (!eligible) {
      throw new Error("Failed prepare-review recovery rejected.");
    }
    next.state = "generation_queued";
  });
}

export function resumeRetryTransition(aggregate, command, at) {
  return withCommand(aggregate, command, "retry_resumed", at, (next) => {
    requireState(next, "retry_wait", "resume retry");
    if (Date.parse(at) < Date.parse(next.retry?.availableAt || "")) {
      throw new Error("Retry is not available yet.");
    }
    const queuedState = QUEUED_STATE_BY_STAGE[next.retry.stage];
    if (!queuedState) throw new Error("Retry stage is invalid.");
    next.state = queuedState;
    next.retry = null;
  });
}

export function recordReviewDecisionTransition(aggregate, decision, at) {
  return withCommand(aggregate, decision, "review_decision_recorded", at, (next) => {
    if (decision.policyVersion !== EDITORIAL_POLICY_VERSION) {
      throw new Error(`Review requires policy version ${EDITORIAL_POLICY_VERSION}.`);
    }
    if (!REVIEW_TYPES.has(decision.decisionType)) throw new Error("Review decision type is invalid.");
    if (!REVIEW_OUTCOMES.has(decision.outcome)) throw new Error("Review outcome is invalid.");
    assertNonEmptyString(decision.rubricVersion, "rubricVersion");
    assertTimestamp(decision.decidedAt, "review decidedAt");
    assertReviewer(decision.reviewer);
    const operationsCommandId = normalizeOperationsCommandId(decision.operationsCommandId);
    const reasons = normalizeReviewReasons(decision.reasons);
    if (decision.revisionId !== next.currentRevisionId) {
      throw new Error("Review decision must bind the exact current revision.");
    }

    const expectedKind = decision.decisionType === "content" ? "private_review" : "narration_review";
    const requiredState = decision.decisionType === "content"
      ? "content_review_required"
      : "narration_review_required";
    requireState(next, requiredState, `record ${decision.decisionType} review`);
    const artifactSet = latestArtifactSet(next, expectedKind, decision.revisionId);
    if (!artifactSet || !isDeepStrictEqual(pickDigests(artifactSet), decision.artifactDigests)) {
      throw new Error("Review decision digests do not match the exact reviewed artifacts.");
    }

    const record = clone({
      decisionId: digestId(
        "review",
        next.jobId,
        decision.revisionId,
        decision.decisionType,
        decision.outcome,
        decision.decidedAt,
        decision.reviewer.id,
      ),
      ...(decision.approvalId ? { approvalId: reviewApprovalId(decision.approvalId) } : {}),
      ...(operationsCommandId ? { operationsCommandId } : {}),
      decisionType: decision.decisionType,
      revisionId: decision.revisionId,
      outcome: decision.outcome,
      policyVersion: decision.policyVersion,
      rubricVersion: decision.rubricVersion,
      reviewer: {
        id: decision.reviewer.id,
        role: decision.reviewer.role,
        competencies: decision.reviewer.competencies,
      },
      decidedAt: decision.decidedAt,
      artifactDigests: pickDigests(artifactSet),
      reasons,
    });
    next.reviewDecisions.push(record);

    if (decision.outcome === "rejected") {
      next.state = "rejected";
    } else if (decision.outcome === "request_changes") {
      next.state = decision.decisionType === "content" ? "generation_queued" : "tts_queued";
    } else if (decision.decisionType === "content") {
      next.state = "render_queued";
    } else {
      next.state = "publish_ready";
    }
  });
}

export function queueDeliveryTransition(aggregate, command, at) {
  return withCommand(aggregate, command, "delivery_queued", at, (next) => {
    if (next.state !== "published" || next.publishedRevisionId !== next.currentRevisionId) {
      throw new Error("Delivery requires the published exact revision.");
    }
    assertReleaseEligible(next);
    next.state = "delivery_queued";
  });
}

export function confirmDeliveryTransition(aggregate, confirmation, at) {
  return withCommand(aggregate, confirmation, "delivery_confirmed", at, (next) => {
    requireState(next, "sent", "confirm delivery");
    assertTimestamp(confirmation.recordedAt, "delivery recordedAt");
    if (confirmation.outcome !== "delivered") throw new Error("Delivery completion requires delivered outcome.");
    const delivery = next.deliveryAttempts.at(-1);
    if (!delivery || delivery.providerMessageId !== confirmation.providerMessageId) {
      throw new Error("Delivery confirmation does not match the exact provider message.");
    }
    assertReleaseEligible(next);
    if (next.publishedRevisionId !== next.currentRevisionId) {
      throw new Error("Completion requires the published exact revision.");
    }
    delivery.status = "delivered";
    delivery.deliveredAt = confirmation.recordedAt;
    delivery.lastOutcome = {
      outcome: "delivered",
      recordedAt: confirmation.recordedAt,
      retryable: false,
      reasonCode: null,
    };
    next.state = "complete";
  });
}

export function reconcileDeliveryTransition(aggregate, reconciliation, at) {
  return withCommand(aggregate, reconciliation, "delivery_status_reconciled", at, (next) => {
    requireState(next, "sent", "reconcile delivery status");
    assertTimestamp(reconciliation.recordedAt, "delivery reconciliation recordedAt");
    if (!new Set(["pending", "delivered", "failed"]).has(reconciliation.outcome)) {
      throw new Error("Delivery reconciliation outcome is invalid.");
    }
    const delivery = next.deliveryAttempts.at(-1);
    if (!delivery || delivery.providerMessageId !== reconciliation.providerMessageId) {
      throw new Error("Delivery reconciliation does not match the exact provider message.");
    }
    assertReleaseEligible(next);
    if (next.publishedRevisionId !== next.currentRevisionId) {
      throw new Error("Delivery reconciliation requires the published exact revision.");
    }
    const failed = reconciliation.outcome === "failed";
    if (failed) {
      assertNonEmptyString(reconciliation.reasonCode, "delivery reconciliation reasonCode");
      if (!/^[a-z0-9_]{1,64}$/.test(reconciliation.reasonCode)) {
        throw new Error("Delivery reconciliation reasonCode must be bounded and machine-readable.");
      }
      if (typeof reconciliation.retryable !== "boolean") {
        throw new Error("Failed delivery reconciliation requires a retryable classification.");
      }
    }
    delivery.lastOutcome = {
      outcome: reconciliation.outcome,
      recordedAt: reconciliation.recordedAt,
      retryable: failed ? reconciliation.retryable : false,
      reasonCode: failed ? reconciliation.reasonCode : null,
    };
    if (reconciliation.outcome === "delivered") {
      delivery.status = "delivered";
      delivery.deliveredAt = reconciliation.recordedAt;
      next.state = "complete";
    }
  });
}

export function statusFromAggregate(aggregate) {
  const contentDecision = latestApprovedDecision(aggregate, "content");
  const narrationDecision = latestApprovedDecision(aggregate, "narration");
  const persistedDelivery = aggregate.deliveryAttempts.at(-1) || null;
  const delivery = persistedDelivery ? {
    provider: persistedDelivery.provider,
    revisionId: persistedDelivery.revisionId,
    providerMessageId: persistedDelivery.providerMessageId,
    idempotencyKey: persistedDelivery.idempotencyKey,
    status: persistedDelivery.status,
    deliveredAt: persistedDelivery.deliveredAt,
    lastOutcome: persistedDelivery.lastOutcome || null,
  } : null;
  return clone({
    jobId: aggregate.jobId,
    environment: aggregate.environment,
    product: aggregate.product,
    intakeDigest: aggregate.intakeDigest,
    state: aggregate.state,
    version: aggregate.version,
    narrationRequired: aggregate.narrationRequired,
    createdAt: aggregate.createdAt,
    updatedAt: aggregate.updatedAt,
    currentRevisionId: aggregate.currentRevisionId,
    publishedRevisionId: aggregate.publishedRevisionId,
    retry: aggregate.retry,
    contentDecision,
    narrationDecision,
    publication: aggregate.publication,
    delivery,
    stageAttempts: aggregate.stageAttempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      stage: attempt.stage,
      revisionId: attempt.revisionId,
      attemptNumber: attempt.attemptNumber,
      operationNumber: attempt.operationNumber,
      idempotencyKey: attempt.idempotencyKey,
      status: attempt.status,
      effectStartedAt: attempt.effectStartedAt,
      failure: attempt.failure,
    })),
  });
}

export function externalEffectInputFromAggregate(aggregate, stage) {
  if (stage !== "publish" && stage !== "deliver") {
    throw new Error(`External effect input is not available for stage ${stage}.`);
  }
  assertReleaseEligible(aggregate);
  const releaseArtifacts = releaseArtifactSet(aggregate);
  const input = {
    jobId: aggregate.jobId,
    environment: aggregate.environment,
    product: aggregate.product,
    revisionId: aggregate.currentRevisionId,
    artifactSetId: releaseArtifacts.artifactSetId,
    artifactManifestDigest: releaseArtifacts.assetManifestDigest,
    artifactSet: releaseArtifacts,
  };
  if (stage === "publish") return clone(input);
  if (
    aggregate.publishedRevisionId !== aggregate.currentRevisionId
    || aggregate.publication?.status !== "published"
    || aggregate.publication.revisionId !== aggregate.currentRevisionId
    || aggregate.publication.artifactManifestDigest !== releaseArtifacts.assetManifestDigest
  ) {
    throw new Error("Delivery requires the published exact release artifacts.");
  }
  const deliveryAttempt = [...aggregate.stageAttempts].reverse().find(
    (attempt) => attempt.stage === "deliver" && attempt.revisionId === aggregate.currentRevisionId,
  );
  if (!deliveryAttempt?.operationBinding) {
    throw new Error("Delivery requires one persisted exact target binding.");
  }
  const firstOperationAttempt = aggregate.stageAttempts.find(
    (attempt) => attempt.stage === "deliver"
      && attempt.revisionId === aggregate.currentRevisionId
      && attempt.idempotencyKey === deliveryAttempt.idempotencyKey,
  );
  if (!firstOperationAttempt?.startedAt) {
    throw new Error("Delivery requires the persisted first operation attempt time.");
  }
  return clone({
    ...input,
    publication: aggregate.publication,
    delivery: aggregate.deliveryAttempts.at(-1) || null,
    deliveryTarget: deliveryAttempt.operationBinding,
    attemptStartedAt: firstOperationAttempt.startedAt,
  });
}

export function stageIdempotencyKey(jobId, revisionId, stage, operationNumber = 1) {
  assertPositiveInteger(operationNumber, "stage operation number");
  return `bb_${sha256([
    jobId,
    revisionId || "unassigned",
    stage,
    String(operationNumber),
  ].join("\0"))}`;
}

function completePreparedReview(next, result, attempt) {
  if (next.state !== "generating") throw new Error("Prepared review completion is out of sequence.");
  assertRevision(result?.revision, next);
  const currentRevision = next.revisions.find(
    (revision) => revision.revisionId === next.currentRevisionId,
  );
  const expectedOrdinal = currentRevision ? currentRevision.ordinal + 1 : 1;
  if (result.revision.ordinal !== expectedOrdinal) {
    throw new Error("Prepared content rework must create the next monotonic revision.");
  }
  const existing = next.revisions.find((revision) => revision.revisionId === result.revision.revisionId);
  if (existing) {
    throw new Error("Prepared content rework cannot overwrite an existing revision.");
  }
  next.revisions.push(clone(result.revision));
  next.currentRevisionId = result.revision.revisionId;
  addArtifactSet(next, result.artifactSet, "private_review", attempt.operationsCommandId);
  next.state = "content_review_required";
}

function completeApprovedRender(next, result, attempt) {
  if (next.state !== "rendering") throw new Error("Approved render completion is out of sequence.");
  const contentDecision = assertApprovedContent(next);
  addArtifactSet(next, result?.artifactSet, "prepared_bundle", attempt.operationsCommandId);
  const preparedBundle = latestArtifactSet(next, "prepared_bundle", next.currentRevisionId);
  if (!next.narrationRequired && !isDeepStrictEqual(
    contentDecision.artifactDigests,
    pickDigests(preparedBundle),
  )) {
    throw new Error("Non-narrated release requires the exact content-approved artifact digests.");
  }
  next.state = next.narrationRequired ? "tts_queued" : "publish_ready";
}

function completeNarrationGeneration(next, result, attempt) {
  if (next.state !== "tts_generating") throw new Error("Narration completion is out of sequence.");
  assertApprovedContent(next);
  addArtifactSet(next, result?.artifactSet, "narration_review", attempt.operationsCommandId);
  next.state = "narration_review_required";
}

function completePublication(next, result, attempt) {
  if (next.state !== "publishing") throw new Error("Publication completion is out of sequence.");
  assertReleaseEligible(next);
  const publication = result?.publication;
  if (publication?.revisionId !== next.currentRevisionId) {
    throw new Error("Publication must bind the exact approved revision.");
  }
  assertNonEmptyString(publication.provider, "publication provider");
  assertNonEmptyString(publication.stableUrl, "publication stableUrl");
  assertDigest(publication.artifactManifestDigest, "publication artifactManifestDigest");
  assertNonEmptyString(publication.providerReceiptId, "publication providerReceiptId");
  const releaseArtifacts = releaseArtifactSet(next);
  if (publication.artifactManifestDigest !== releaseArtifacts.assetManifestDigest) {
    throw new Error("Publication manifest does not match the exact approved release bundle.");
  }
  next.publication = clone({
    provider: publication.provider,
    revisionId: publication.revisionId,
    stableUrl: publication.stableUrl,
    artifactManifestDigest: publication.artifactManifestDigest,
    providerReceiptId: publication.providerReceiptId,
    idempotencyKey: attempt.idempotencyKey,
    ...(attempt.operationsCommandId ? { operationsCommandId: attempt.operationsCommandId } : {}),
    status: "published",
  });
  next.publishedRevisionId = next.currentRevisionId;
  next.state = "published";
}

function completeDeliverySend(next, result, attempt) {
  if (next.state !== "sending") throw new Error("Delivery send completion is out of sequence.");
  assertReleaseEligible(next);
  if (next.publishedRevisionId !== next.currentRevisionId) {
    throw new Error("Delivery must bind the published exact revision.");
  }
  const delivery = result?.delivery;
  if (delivery?.revisionId !== next.currentRevisionId) {
    throw new Error("Delivery must bind the exact approved revision.");
  }
  assertNonEmptyString(delivery.provider, "delivery provider");
  assertNonEmptyString(delivery.providerMessageId, "delivery providerMessageId");
  next.deliveryAttempts.push(clone({
    provider: delivery.provider,
    revisionId: delivery.revisionId,
    providerMessageId: delivery.providerMessageId,
    idempotencyKey: attempt.idempotencyKey,
    ...(attempt.operationsCommandId ? { operationsCommandId: attempt.operationsCommandId } : {}),
    targetRef: attempt.operationBinding.targetRef,
    status: "sent",
    deliveredAt: null,
    lastOutcome: null,
  }));
  next.state = "sent";
}

function addArtifactSet(next, artifactSet, expectedKind, operationsCommandId = null) {
  if (artifactSet?.kind !== expectedKind || artifactSet.revisionId !== next.currentRevisionId) {
    throw new Error(`${expectedKind} artifacts must bind the exact current revision.`);
  }
  for (const key of DIGEST_KEYS) assertDigest(artifactSet[key], `${expectedKind}.${key}`);
  const references = normalizeArtifactReferences(artifactSet);
  const normalized = clone({
    artifactSetId: digestId(
      "artifacts",
      next.jobId,
      artifactSet.revisionId,
      artifactSet.kind,
      ...DIGEST_KEYS.map((key) => artifactSet[key]),
    ),
    kind: artifactSet.kind,
    revisionId: artifactSet.revisionId,
    ...(operationsCommandId ? { operationsCommandId } : {}),
    ...pickDigests(artifactSet),
    ...references,
  });
  const existing = next.artifactSets.find((entry) => entry.artifactSetId === normalized.artifactSetId);
  if (existing && !isDeepStrictEqual(existing, normalized)) {
    throw new Error("Artifact set identity cannot be rebound to different immutable references.");
  }
  if (!existing) next.artifactSets.push(normalized);
}

function assertStageClaimEligible(aggregate, stage) {
  if (stage === "publish") assertReleaseEligible(aggregate);
  if (stage === "deliver") {
    assertReleaseEligible(aggregate);
    if (
      aggregate.publishedRevisionId !== aggregate.currentRevisionId
      || aggregate.publication?.status !== "published"
      || aggregate.publication.revisionId !== aggregate.currentRevisionId
    ) {
      throw new Error("Delivery requires the published exact revision.");
    }
  }
}

const OPERATIONS_COMMAND_ID_PATTERN = /^command_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

function normalizeOperationsCommandId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !OPERATIONS_COMMAND_ID_PATTERN.test(value)) {
    throw new Error("operationsCommandId must be a valid immutable operations command identifier.");
  }
  return value;
}

function normalizeOperationBinding(stage, binding) {
  if (stage !== "deliver") {
    if (binding !== undefined && binding !== null) {
      throw new Error(`Stage ${stage} cannot persist a delivery target binding.`);
    }
    return null;
  }
  assertNonEmptyString(binding?.targetRef, "delivery targetRef");
  assertDigest(binding?.targetDigest, "delivery targetDigest");
  if (Object.keys(binding).some((key) => key !== "targetRef" && key !== "targetDigest")) {
    throw new Error("Delivery target binding must contain only the opaque reference and digest.");
  }
  return clone({ targetRef: binding.targetRef, targetDigest: binding.targetDigest });
}

function assertReleaseEligible(aggregate) {
  const contentDecision = assertApprovedContent(aggregate);
  const preparedBundle = latestArtifactSet(aggregate, "prepared_bundle", aggregate.currentRevisionId);
  if (!preparedBundle) {
    throw new Error("Release requires the exact prepared bundle.");
  }
  if (!aggregate.narrationRequired && !isDeepStrictEqual(
    contentDecision.artifactDigests,
    pickDigests(preparedBundle),
  )) {
    throw new Error("Non-narrated release requires the exact content-approved artifact digests.");
  }
  if (aggregate.narrationRequired && !latestApprovedDecision(aggregate, "narration")) {
    throw new Error("Release requires exact narration approval under the approved policy.");
  }
  releaseArtifactSet(aggregate);
}

function releaseArtifactSet(aggregate) {
  const kind = aggregate.narrationRequired ? "narration_review" : "prepared_bundle";
  const artifactSet = latestArtifactSet(aggregate, kind, aggregate.currentRevisionId);
  if (!artifactSet) throw new Error(`Release requires the exact ${kind} artifacts.`);
  return artifactSet;
}

function assertApprovedContent(aggregate) {
  const decision = latestApprovedDecision(aggregate, "content");
  if (!decision) throw new Error("Current content approval is required.");
  return decision;
}

function latestApprovedDecision(aggregate, type) {
  const decision = [...aggregate.reviewDecisions].reverse().find(
    (decision) => decision.decisionType === type
      && decision.revisionId === aggregate.currentRevisionId,
  ) || null;
  if (decision?.outcome !== "approved" || decision.policyVersion !== EDITORIAL_POLICY_VERSION) {
    return null;
  }
  const kind = type === "content" ? "private_review" : "narration_review";
  const artifactSet = latestArtifactSet(aggregate, kind, aggregate.currentRevisionId);
  if (!artifactSet || !isDeepStrictEqual(decision.artifactDigests, pickDigests(artifactSet))) {
    return null;
  }
  return decision;
}

function latestArtifactSet(aggregate, kind, revisionId) {
  return [...aggregate.artifactSets].reverse().find(
    (artifact) => artifact.kind === kind && artifact.revisionId === revisionId,
  ) || null;
}

function pickDigests(artifactSet) {
  return Object.fromEntries(DIGEST_KEYS.map((key) => [key, artifactSet[key]]));
}

function currentRunningAttempt(aggregate, stage, leaseToken) {
  const attempt = [...aggregate.stageAttempts].reverse().find(
    (entry) => entry.stage === stage && entry.status === "running",
  );
  if (!attempt || attempt.leaseToken !== leaseToken) {
    throw new Error("Stage completion requires the current exact lease token.");
  }
  return attempt;
}

function withCommand(aggregate, command, eventType, at, mutate, replayPayload = command) {
  const commandId = command?.commandId;
  assertNonEmptyString(commandId, "commandId");
  assertTimestamp(at, "transition timestamp");
  const commandDigest = commandReplayDigest(eventType, replayPayload);
  const replay = aggregate.events.find((event) => event.commandId === commandId);
  if (replay) {
    if (replay.type !== eventType || replay.commandDigest !== commandDigest) {
      throw new Error("Command replay does not match its original operation and payload.");
    }
    return clone(aggregate);
  }
  if (Date.parse(at) < Date.parse(aggregate.updatedAt)) {
    throw new Error("Transition timestamp cannot precede the aggregate's current version.");
  }
  const next = clone(aggregate);
  mutate(next);
  next.version += 1;
  next.updatedAt = at;
  next.events.push({
    eventId: eventId(next.jobId, commandId),
    commandId,
    commandDigest,
    type: eventType,
    at,
    state: next.state,
  });
  return next;
}

export function commandReplayDigest(eventType, command) {
  assertNonEmptyString(eventType, "eventType");
  return sha256(`${eventType}\0${canonicalJson(command)}`);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Commands must contain deterministic JSON values only.");
}

function eventId(jobId, commandId) {
  return digestId("event", jobId, commandId);
}

function digestId(prefix, ...parts) {
  return `${prefix}_${sha256(parts.join("\0")).slice(0, 24)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertRevision(revision, aggregate) {
  assertPositiveInteger(revision?.ordinal, "revision ordinal");
  if (revision?.revisionId !== `r${revision.ordinal}`) {
    throw new Error("Revision identity must match its monotonic ordinal.");
  }
  assertDigest(revision.inputDigest, "revision inputDigest");
  if (revision.inputDigest !== aggregate.intakeDigest) {
    throw new Error("Revision input digest must remain bound to the job intake.");
  }
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && sortedExpectedKeys.every((key, index) => actualKeys[index] === key);
}

function isValidFailedPrepareReviewApproval(record) {
  if (
    !hasExactKeys(record, [
      "approvalType",
      "jobId",
      "policy",
      "schemaVersion",
      "sourceDigest",
      "sourceEvidence",
    ])
    || !hasExactKeys(record?.sourceEvidence, ["kind", "reference"])
    || record.schemaVersion !== "1.0"
    || record.approvalType !== "job_scoped_editorial_policy"
    || record.jobId !== RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID
    || !isDeepStrictEqual(record.policy, FAILED_PREPARE_REVIEW_EDITORIAL_POLICY)
    || record.sourceEvidence.kind !== "kanban_human_decision"
    || !/^kanban:t_[A-Za-z0-9_-]{3,128}$/.test(record.sourceEvidence.reference || "")
  ) {
    return false;
  }
  return record.sourceDigest === createHash("sha256")
    .update(JSON.stringify(record.sourceEvidence))
    .digest("hex");
}

function assertPaymentCorrelation(correlation, input) {
  const expected = {
    project: "bebebonjour",
    product: input.product,
    environment: input.environment,
    jobId: input.jobId,
    intakeDigest: input.intakeDigest,
  };
  if (!isDeepStrictEqual(correlation, expected)) {
    throw new Error("Payment correlation must bind project, product, environment, job, and intake digest.");
  }
}

function reviewApprovalId(value) {
  if (typeof value !== "string" || !/^approval_[a-f0-9]{24}$/.test(value)) {
    throw new Error("Review approval id is invalid.");
  }
  return value;
}

function assertReviewer(reviewer) {
  assertNonEmptyString(reviewer?.id, "reviewer id");
  assertNonEmptyString(reviewer?.role, "reviewer role");
  if (!Array.isArray(reviewer.competencies) || reviewer.competencies.length === 0) {
    throw new Error("Reviewer competencies are required.");
  }
  for (const competency of reviewer.competencies) assertNonEmptyString(competency, "reviewer competency");
  if (new Set(reviewer.competencies).size !== reviewer.competencies.length) {
    throw new Error("Reviewer competencies must be unique.");
  }
}

function normalizeReviewReasons(reasons) {
  if (reasons === undefined) return [];
  if (!Array.isArray(reasons) || reasons.length > 32) {
    throw new Error("Bounded review evidence permits at most 32 reasons.");
  }
  for (const reason of reasons) {
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) {
      throw new Error("Bounded review evidence requires non-empty reasons of at most 500 characters.");
    }
  }
  return reasons;
}

function normalizeArtifactReferences(artifactSet) {
  const hasManifest = artifactSet.manifestRef !== undefined;
  const hasFiles = artifactSet.files !== undefined;
  if (!hasManifest && !hasFiles) return {};
  if (!hasManifest || !hasFiles) {
    throw new Error("Artifact manifestRef and files must be persisted together.");
  }
  assertNonEmptyString(artifactSet.manifestRef, "artifact manifestRef");
  if (!Array.isArray(artifactSet.files)) throw new Error("Artifact files must be an ordered array.");
  let priorPath = null;
  const files = artifactSet.files.map((file) => {
    assertNonEmptyString(file?.path, "artifact file path");
    if (
      file.path.startsWith("/")
      || file.path.includes("\\")
      || file.path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("Artifact file paths must be normalized relative POSIX paths.");
    }
    if (priorPath !== null && file.path <= priorPath) {
      throw new Error("Artifact files must use unique paths in lexicographic order.");
    }
    priorPath = file.path;
    assertDigest(file.sha256, `artifact file ${file.path} sha256`);
    if (!Number.isInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Artifact file ${file.path} bytes must be a non-negative integer.`);
    }
    assertNonEmptyString(file.storageId, `artifact file ${file.path} storageId`);
    return {
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      storageId: file.storageId,
    };
  });
  return { manifestRef: artifactSet.manifestRef, files };
}

function requireState(aggregate, expected, action) {
  if (aggregate.state !== expected) {
    throw new Error(`Cannot ${action} while job is ${aggregate.state}; expected ${expected}.`);
  }
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertTimestamp(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

function configuredPositiveInteger(value, label) {
  assertPositiveInteger(value, label);
  return value;
}

function clone(value) {
  return structuredClone(value);
}
