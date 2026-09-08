import { internalQueryGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const createJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    aggregate: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertAggregateIdentity(args.jobId, args.aggregate);
    const existing = await findJob(context, args.jobId);
    if (existing) return { created: false, aggregate: existing.aggregate };
    await context.db.insert("fulfillmentJobs", {
      jobId: args.jobId,
      aggregate: args.aggregate,
    });
    return { created: true, aggregate: args.aggregate };
  },
});

export const getJob = queryGeneric({
  args: { backendToken: v.string(), jobId: v.string() },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    const document = await findJob(context, args.jobId);
    return document?.aggregate || null;
  },
});

export const saveReviewApproval = mutationGeneric({
  args: {
    backendToken: v.string(),
    approval: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertReviewApproval(args.approval);
    const existing = await findReviewApproval(context, args.approval.approvalId);
    if (existing) return { created: false, approval: existing.approval };
    await context.db.insert("fulfillmentReviewApprovals", {
      approvalId: args.approval.approvalId,
      approval: args.approval,
    });
    return { created: true, approval: args.approval };
  },
});

export const getReviewApproval = queryGeneric({
  args: { backendToken: v.string(), approvalId: v.string() },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertApprovalId(args.approvalId);
    const document = await findReviewApproval(context, args.approvalId);
    return document?.approval || null;
  },
});

export const getCompletionJob = queryGeneric({
  args: {
    completionToken: v.string(),
    workerId: v.optional(v.string()),
    commandId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    jobId: v.string(),
  },
  handler: async (context, args) => {
    assertCompletionAuthority(args.completionToken, args.jobId);
    const document = await findJob(context, args.jobId);
    return document?.aggregate || null;
  },
});

export const getCompletionReviewApproval = queryGeneric({
  args: { completionToken: v.string(), approvalId: v.string(), jobId: v.string() },
  handler: async (context, args) => {
    assertCompletionAuthority(args.completionToken, args.jobId);
    assertApprovalId(args.approvalId);
    const document = await findReviewApproval(context, args.approvalId);
    if (document?.approval?.binding?.jobId !== args.jobId) return null;
    return document.approval;
  },
});

export const replaceCompletionJob = mutationGeneric({
  args: {
    completionToken: v.string(),
    workerId: v.string(),
    commandId: v.string(),
    leaseToken: v.string(),
    jobId: v.string(),
    expectedVersion: v.number(),
    aggregate: v.any(),
  },
  handler: async (context, args) => {
    assertCompletionAuthority(args.completionToken, args.jobId);
    assertAggregateIdentity(args.jobId, args.aggregate);
    const document = await findJob(context, args.jobId);
    if (!document || document.aggregate.version !== args.expectedVersion) {
      return { updated: false, current: document?.aggregate || null };
    }
    const command = await assertActiveCompletionTransition(context, args, document.aggregate, args.aggregate);
    await assertCompletionReplacement(
      context,
      document.aggregate,
      args.aggregate,
      args.expectedVersion,
      args,
      command,
    );
    await context.db.patch(document._id, { aggregate: args.aggregate });
    return { updated: true, aggregate: args.aggregate };
  },
});

export const authorizeCompletionArtifactRead = internalQueryGeneric({
  args: {
    completionToken: v.string(),
    workerId: v.string(),
    commandId: v.string(),
    leaseToken: v.string(),
    jobId: v.string(),
    revisionId: v.string(),
    storageId: v.string(),
  },
  handler: async (context, args) => {
    assertCompletionAuthority(args.completionToken, args.jobId);
    await assertClaimedCompletionAuthority(context, args, "publish", { effectFenceRequired: true });
    const document = await findJob(context, args.jobId);
    const aggregate = document?.aggregate;
    const contentDecision = [...(aggregate?.reviewDecisions || [])].reverse().find((decision) => (
      decision.decisionType === "content" && decision.revisionId === args.revisionId
    ));
    if (!aggregate || aggregate.environment !== "test" || aggregate.product !== "announcement-page"
        || aggregate.currentRevisionId !== args.revisionId
        || contentDecision?.outcome !== "approved"
        || contentDecision.policyVersion !== "bebebonjour-editorial-v1") {
      throw new Error("Completion artifact synthetic identity is invalid.");
    }
    const source = [...(aggregate.artifactSets || [])].reverse().find((artifact) => (
      artifact.kind === "private_review" && artifact.revisionId === args.revisionId
    ));
    if (source?.assetManifestDigest !== contentDecision.artifactDigests?.assetManifestDigest) {
      throw new Error("Completion artifact is not bound to the approved manifest.");
    }
    const file = source?.files?.find((entry) => entry.storageId === args.storageId);
    if (!file) throw new Error("Completion artifact is not bound to the reviewed revision.");
    return file;
  },
});

export const replaceJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    expectedVersion: v.number(),
    aggregate: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertAggregateIdentity(args.jobId, args.aggregate);
    const document = await findJob(context, args.jobId);
    if (!document) return { updated: false, current: null };
    if (document.aggregate.version !== args.expectedVersion) {
      return { updated: false, current: document.aggregate };
    }
    if (args.aggregate.version !== args.expectedVersion + 1) {
      throw new Error("Fulfillment replacement must increment version exactly once.");
    }
    await context.db.patch(document._id, { aggregate: args.aggregate });
    return { updated: true, aggregate: args.aggregate };
  },
});

function findJob(context, jobId) {
  return context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

function findReviewApproval(context, approvalId) {
  return context.db
    .query("fulfillmentReviewApprovals")
    .withIndex("by_approval_id", (query) => query.eq("approvalId", approvalId))
    .unique();
}

function assertAggregateIdentity(jobId, aggregate) {
  if (!aggregate || aggregate.jobId !== jobId) {
    throw new Error("Fulfillment aggregate must preserve the canonical job id.");
  }
}

function assertReviewApproval(approval) {
  const allowedFields = ["schemaVersion", "approvalId", "binding", "decision", "signature"];
  assertOnlyFields(approval, allowedFields);
  assertOnlyFields(
    approval.binding,
    ["jobId", "intakeDigest", "environment", "product", "revisionId", "runId", "artifactManifestDigest"],
  );
  assertOnlyFields(approval.decision, [
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
  ]);
  if (approval.decision.reviewer) {
    assertOnlyFields(approval.decision.reviewer, ["id", "role", "competencies"]);
  }
  if (approval.decision.artifactDigests) {
    assertOnlyFields(
      approval.decision.artifactDigests,
      ["pageDigest", "transcriptDigest", "assetManifestDigest"],
    );
  }
  assertApprovalId(approval?.approvalId);
  if (
    approval.schemaVersion !== "1.0"
    || !approval.binding
    || !approval.decision
    || typeof approval.signature !== "string"
    || !/^[a-f0-9]{64}$/.test(approval.signature)
  ) {
    throw new Error("Fulfillment review approval is invalid.");
  }
}

function assertOnlyFields(value, allowedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !allowedFields.includes(field))) {
    throw new Error("Fulfillment review approval contains unexpected fields.");
  }
}

function assertApprovalId(value) {
  if (typeof value !== "string" || !/^approval_[a-f0-9]{24}$/.test(value)) {
    throw new Error("Fulfillment review approval id is invalid.");
  }
}

function assertBackendToken(value) {
  const expected = process.env.CUSTOMER_FLOW_BACKEND_TOKEN;
  if (!expected || expected.length < 32 || value !== expected) {
    throw new Error("Customer-flow backend authorization failed.");
  }
}

async function assertClaimedCompletionAuthority(
  context,
  args,
  expectedAction,
  { effectFenceRequired = false } = {},
) {
  const command = await context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (query) => query.eq("commandId", args.commandId))
    .unique();
  if (!command
      || command.jobId !== args.jobId
      || command.action !== expectedAction
      || command.state !== "running"
      || command.claim?.workerId !== args.workerId
      || command.claim?.leaseToken !== args.leaseToken
      || (effectFenceRequired && !Number.isFinite(command.claim?.effectStartedAtMs))
      || !Number.isFinite(command.claim?.leaseExpiresAtMs)
      || command.claim.leaseExpiresAtMs <= Date.now()) {
    throw new Error("Completion command claim authorization failed.");
  }
  return command;
}

const COMPLETION_ACTION_BY_TRANSITION = Object.freeze({
  "content_review_required>render_queued": "approve_content",
  "render_queued>rendering": "render",
  "rendering>publish_ready": "render",
  "rendering>retry_wait": "render",
  "rendering>failed": "render",
  "publish_ready>publishing": "publish",
  "publishing>publishing": "publish",
  "publishing>published": "publish",
  "publishing>retry_wait": "publish",
  "publishing>failed": "publish",
  "published>delivery_queued": "queue_delivery",
  "delivery_queued>sending": "deliver",
  "sending>sending": "deliver",
  "sending>sent": "deliver",
  "sending>retry_wait": "deliver",
  "sending>failed": "deliver",
  "retry_wait>render_queued": "retry",
  "retry_wait>publish_ready": "retry",
  "retry_wait>delivery_queued": "retry",
});

async function assertActiveCompletionTransition(context, args, current, next) {
  const action = COMPLETION_ACTION_BY_TRANSITION[`${current.state}>${next?.state}`];
  if (!action || current.jobId !== args.jobId) {
    throw new Error("Completion replacement requires one active matching command claim.");
  }
  const command = await assertClaimedCompletionAuthority(context, args, action, {
    effectFenceRequired: action === "publish" || action === "deliver",
  });
  const origin = {
    approve_content: "content_review_required",
    render: "render_queued",
    publish: "publish_ready",
    queue_delivery: "published",
    deliver: "delivery_queued",
    retry: "retry_wait",
  }[action];
  const beginsCommand = current.state === origin;
  const activeAttempt = [...(current.stageAttempts || [])].reverse().find((attempt) => (
    attempt.status === "running" && attempt.operationsCommandId === args.commandId
  ));
  if (command.expectedState !== origin
      || (beginsCommand && command.expectedVersion !== current.version)
      || (!beginsCommand && !activeAttempt && action !== "retry")) {
    throw new Error("Completion command does not match its exact requested job transition.");
  }
  return command;
}

function assertCompletionAuthority(token, jobId) {
  const expected = process.env.BEBEBONJOUR_COMPLETION_WORKER_TOKEN;
  if (!expected || expected.length < 32 || token !== expected
      || jobId !== "job_03c25b08-8476-4fe1-923b-43d73feab3ff") {
    throw new Error("Completion worker authorization failed.");
  }
}

async function assertCompletionReplacement(context, current, next, expectedVersion, args, command) {
  const transitions = new Set([
    "content_review_required>render_queued",
    "render_queued>rendering",
    "rendering>publish_ready",
    "rendering>retry_wait",
    "rendering>failed",
    "publish_ready>publishing",
    "publishing>publishing",
    "publishing>published",
    "publishing>retry_wait",
    "publishing>failed",
    "published>delivery_queued",
    "delivery_queued>sending",
    "sending>sending",
    "sending>sent",
    "sending>retry_wait",
    "sending>failed",
    "retry_wait>render_queued",
    "retry_wait>publish_ready",
    "retry_wait>delivery_queued",
  ]);
  const mutableFields = new Set([
    "artifactSets", "deliveryAttempts", "events", "publication", "publishedRevisionId",
    "retry", "reviewDecisions", "stageAttempts", "state", "updatedAt", "version",
  ]);
  const transition = `${current.state}>${next?.state}`;
  const exactKeys = Object.keys(current).sort().join("\0") === Object.keys(next || {}).sort().join("\0");
  const immutableChanged = Object.keys(current).some((field) => (
    !mutableFields.has(field) && JSON.stringify(current[field]) !== JSON.stringify(next[field])
  ));
  if (!next || next.version !== expectedVersion + 1
      || next.environment !== "test" || next.product !== "announcement-page"
      || !transitions.has(transition)
      || !exactKeys
      || immutableChanged
      || appendDelta(current.events, next.events) !== 1
      || appendDelta(current.reviewDecisions, next.reviewDecisions)
        !== (transition === "content_review_required>render_queued" ? 1 : 0)
      || appendDelta(current.artifactSets, next.artifactSets)
        !== (transition === "rendering>publish_ready" ? 1 : 0)
      || appendDelta(current.deliveryAttempts, next.deliveryAttempts)
        !== (transition === "sending>sent" ? 1 : 0)
      || !await validStageAttemptChange(current, next, transition, args)) {
    throw new Error("Completion worker replacement exceeds its synthetic stage authority.");
  }
  if (!await validCompletionEvent(current, next.events.at(-1), transition, next, args, command)) {
    throw new Error("Completion worker replacement lacks canonical transition evidence.");
  }
  await assertCompletionTransitionPayload(context, current, next, transition, args);
}

function appendDelta(current, next) {
  if (!Array.isArray(current) || !Array.isArray(next) || next.length < current.length) return -1;
  if (current.some((value, index) => JSON.stringify(value) !== JSON.stringify(next[index]))) return -1;
  return next.length - current.length;
}

const COMPLETION_STAGE_LEASE_MS = 300_000;
const COMPLETION_STAGE_MAX_ATTEMPTS = 2;
const COMPLETION_RETRY_BACKOFF_MS = 60_000;

async function validStageAttemptChange(currentAggregate, nextAggregate, transition, args) {
  const current = currentAggregate.stageAttempts;
  const next = nextAggregate.stageAttempts;
  const claims = new Set([
    "render_queued>rendering",
    "publish_ready>publishing",
    "delivery_queued>sending",
  ]);
  const updates = new Set([
    "rendering>publish_ready", "rendering>retry_wait", "rendering>failed",
    "publishing>publishing", "publishing>published", "publishing>retry_wait", "publishing>failed",
    "sending>sending", "sending>sent",
    "sending>retry_wait", "sending>failed",
  ]);
  if (claims.has(transition)) {
    if (appendDelta(current, next) !== 1) return false;
    const attempt = next.at(-1);
    const expectedStage = transition === "render_queued>rendering" ? "render_approved"
      : transition === "publish_ready>publishing" ? "publish" : "deliver";
    const expectedRevisionId = currentAggregate.currentRevisionId;
    const expectedAttemptNumber = current.filter((entry) => (
      entry.stage === expectedStage && entry.revisionId === expectedRevisionId
    )).length + 1;
    const expectedOperationNumber = current.filter((entry) => (
      entry.stage === expectedStage
      && entry.revisionId === expectedRevisionId
      && entry.status === "completed"
    )).length + 1;
    const expectedAttemptId = `attempt_${(await sha256Hex([
      currentAggregate.jobId,
      expectedRevisionId || "unassigned",
      expectedStage,
      String(expectedAttemptNumber),
    ].join("\0"))).slice(0, 24)}`;
    const expectedIdempotencyKey = `bb_${await sha256Hex([
      currentAggregate.jobId,
      expectedRevisionId || "unassigned",
      expectedStage,
      String(expectedOperationNumber),
    ].join("\0"))}`;
    const expectedLeaseExpiry = new Date(
      Date.parse(nextAggregate.updatedAt) + COMPLETION_STAGE_LEASE_MS,
    ).toISOString();
    return hasExactKeys(attempt, [
      "attemptId", "stage", "revisionId", "attemptNumber", "operationNumber",
      "idempotencyKey", "operationBinding", "operationsCommandId", "status", "leaseToken",
      "leaseExpiresAt", "startedAt", "effectStartedAt", "completedAt", "failure",
    ])
      && attempt.attemptId === expectedAttemptId
      && attempt.stage === expectedStage
      && attempt.revisionId === expectedRevisionId
      && attempt.attemptNumber === expectedAttemptNumber
      && expectedAttemptNumber <= COMPLETION_STAGE_MAX_ATTEMPTS
      && attempt.operationNumber === expectedOperationNumber
      && attempt.idempotencyKey === expectedIdempotencyKey
      && validCompletionOperationBinding(expectedStage, attempt.operationBinding)
      && attempt.operationsCommandId === args.commandId
      && attempt.status === "running"
      && typeof attempt.leaseToken === "string" && attempt.leaseToken.length >= 8
      && attempt.leaseToken !== args.leaseToken
      && attempt.leaseExpiresAt === expectedLeaseExpiry
      && attempt.startedAt === nextAggregate.updatedAt
      && attempt.effectStartedAt === null
      && attempt.completedAt === null
      && attempt.failure === null;
  }
  if (!updates.has(transition)) return appendDelta(current, next) === 0;
  if (!Array.isArray(current) || !Array.isArray(next) || current.length === 0 || next.length !== current.length) {
    return false;
  }
  const prior = current.at(-1);
  const updated = next.at(-1);
  const identifiersPreserved = current.slice(0, -1)
    .every((value, index) => JSON.stringify(value) === JSON.stringify(next[index]))
    && [
      "attemptId", "stage", "revisionId", "attemptNumber", "operationNumber",
      "idempotencyKey", "operationBinding", "operationsCommandId", "startedAt",
    ].every((field) => JSON.stringify(prior[field]) === JSON.stringify(updated[field]));
  if (!identifiersPreserved
      || prior.status !== "running"
      || typeof prior.leaseToken !== "string" || prior.leaseToken.length < 8
      || prior.leaseToken === args.leaseToken
      || updated.operationsCommandId !== args.commandId) return false;
  if (transition === "publishing>publishing" || transition === "sending>sending") {
    const expectedLeaseExpiry = new Date(
      Date.parse(nextAggregate.updatedAt) + COMPLETION_STAGE_LEASE_MS,
    ).toISOString();
    return updated.status === "running"
      && updated.leaseToken === prior.leaseToken
      && updated.completedAt === null
      && updated.failure === null
      && updated.leaseExpiresAt === expectedLeaseExpiry
      && updated.effectStartedAt === (prior.effectStartedAt || nextAggregate.updatedAt);
  }
  if (transition.endsWith(">retry_wait") || transition.endsWith(">failed")) {
    const retrying = transition.endsWith(">retry_wait");
    return updated.status === (retrying ? "retry_wait" : "failed")
      && updated.leaseToken === null
      && updated.leaseExpiresAt === null
      && updated.completedAt === nextAggregate.updatedAt
      && hasExactKeys(updated.failure, ["reasonCode", "retryable"])
      && /^[a-z0-9_]{1,64}$/.test(updated.failure.reasonCode)
      && updated.failure.retryable === retrying
      && (retrying
        ? hasExactKeys(nextAggregate.retry, ["availableAt", "stage"])
          && nextAggregate.retry.stage === prior.stage
          && nextAggregate.retry.availableAt === new Date(
            Date.parse(nextAggregate.updatedAt) + COMPLETION_RETRY_BACKOFF_MS,
          ).toISOString()
        : nextAggregate.retry === null);
  }
  return updated.status === "completed"
    && updated.leaseToken === null
    && updated.leaseExpiresAt === null
    && updated.completedAt === nextAggregate.updatedAt
    && updated.failure === null;
}

function validCompletionOperationBinding(stage, binding) {
  if (stage !== "deliver") return binding === null;
  return hasExactKeys(binding, ["targetDigest", "targetRef"])
    && binding.targetRef === "resend:test-a-sink"
    && /^[a-f0-9]{64}$/.test(binding.targetDigest || "");
}

const COMPLETION_EVENT_TYPES_BY_TRANSITION = Object.freeze({
  "content_review_required>render_queued": ["review_decision_recorded"],
  "render_queued>rendering": ["stage_claimed"],
  "rendering>publish_ready": ["stage_completed"],
  "rendering>retry_wait": ["stage_failed"],
  "rendering>failed": ["stage_failed"],
  "publish_ready>publishing": ["stage_claimed"],
  "publishing>publishing": ["external_effect_fenced"],
  "publishing>published": ["stage_completed"],
  "publishing>retry_wait": ["stage_failed"],
  "publishing>failed": ["stage_failed"],
  "published>delivery_queued": ["delivery_queued"],
  "delivery_queued>sending": ["stage_claimed"],
  "sending>sending": ["external_effect_fenced"],
  "sending>sent": ["stage_completed"],
  "sending>retry_wait": ["stage_failed"],
  "sending>failed": ["stage_failed"],
  "retry_wait>render_queued": ["retry_resumed"],
  "retry_wait>publish_ready": ["retry_resumed"],
  "retry_wait>delivery_queued": ["retry_resumed"],
});

async function validCompletionEvent(current, event, transition, next, args, command) {
  const commandIdValid = validCompletionEventCommandId(current, event, transition, next, args);
  if (!commandIdValid) return false;
  const expectedEventId = `event_${(await sha256Hex(`${next.jobId}\0${event.commandId}`)).slice(0, 24)}`;
  const expectedCommandDigest = await completionCommandDigest(
    current,
    next,
    event,
    args,
    command,
  );

  return hasExactKeys(event, ["eventId", "commandId", "commandDigest", "type", "at", "state"])
    && event.eventId === expectedEventId
    && event.commandDigest === expectedCommandDigest
    && COMPLETION_EVENT_TYPES_BY_TRANSITION[transition]?.includes(event.type)
    && event.at === next.updatedAt
    && isIsoTimestamp(event.at)
    && event.state === next.state;
}

async function completionCommandDigest(current, next, event, args, command) {
  const attempt = next.stageAttempts?.at(-1);
  let replayPayload;
  if (event.type === "stage_claimed") {
    replayPayload = {
      commandId: event.commandId,
      stage: attempt.stage,
      leaseMs: COMPLETION_STAGE_LEASE_MS,
      maxAttempts: COMPLETION_STAGE_MAX_ATTEMPTS,
      operationBinding: attempt.operationBinding,
      operationsCommandId: args.commandId,
    };
  } else if (event.type === "external_effect_fenced") {
    replayPayload = {
      commandId: event.commandId,
      stage: attempt.stage,
      attemptId: attempt.attemptId,
      leaseMs: COMPLETION_STAGE_LEASE_MS,
      effectMayBeIssued: true,
    };
  } else if (event.type === "stage_completed") {
    replayPayload = {
      commandId: event.commandId,
      stage: attempt.stage,
      leaseToken: current.stageAttempts.at(-1).leaseToken,
      result: canonicalCompletionResult(next, attempt.stage),
    };
  } else if (event.type === "stage_failed") {
    replayPayload = {
      commandId: event.commandId,
      stage: attempt.stage,
      leaseToken: current.stageAttempts.at(-1).leaseToken,
      retryable: attempt.failure.retryable,
      reasonCode: attempt.failure.reasonCode,
    };
  } else if (event.type === "review_decision_recorded") {
    const decision = next.reviewDecisions.at(-1);
    replayPayload = {
      commandId: args.commandId,
      operationsCommandId: args.commandId,
      ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
      decisionType: decision.decisionType,
      revisionId: decision.revisionId,
      outcome: decision.outcome,
      policyVersion: decision.policyVersion,
      rubricVersion: decision.rubricVersion,
      reviewer: decision.reviewer,
      decidedAt: decision.decidedAt,
      artifactDigests: decision.artifactDigests,
      reasons: decision.reasons,
    };
  } else if (event.type === "delivery_queued") {
    replayPayload = {
      commandId: args.commandId,
      revisionId: command.payload.revisionId,
      publicationId: command.payload.publicationId,
    };
  } else if (event.type === "retry_resumed") {
    replayPayload = { commandId: args.commandId };
  } else {
    return null;
  }
  return sha256Hex(`${event.type}\0${canonicalJson(replayPayload)}`);
}

function canonicalCompletionResult(next, stage) {
  if (stage === "render_approved") {
    const artifactSet = structuredClone(next.artifactSets.at(-1));
    delete artifactSet.operationsCommandId;
    return { artifactSet };
  }
  if (stage === "publish") {
    const { provider, revisionId, stableUrl, artifactManifestDigest, providerReceiptId } = next.publication;
    return { publication: { provider, revisionId, stableUrl, artifactManifestDigest, providerReceiptId } };
  }
  if (stage === "deliver") {
    const { provider, revisionId, providerMessageId } = next.deliveryAttempts.at(-1);
    return { delivery: { provider, revisionId, providerMessageId } };
  }
  return null;
}

function validCompletionEventCommandId(current, event, transition, next, args) {
  if ([
    "content_review_required>render_queued",
    "published>delivery_queued",
    "retry_wait>render_queued",
    "retry_wait>publish_ready",
    "retry_wait>delivery_queued",
  ].includes(transition)) return event.commandId === args.commandId;

  const attempt = next.stageAttempts?.at(-1);
  if (!attempt || attempt.operationsCommandId !== args.commandId) return false;
  if (event.type === "stage_claimed") {
    return event.commandId === [
      "claim",
      next.jobId,
      attempt.revisionId || "unassigned",
      attempt.stage,
      attempt.attemptNumber,
    ].join(":");
  }
  if (event.type === "stage_completed") {
    return event.commandId === `complete:${attempt.attemptId}`;
  }
  if (event.type === "stage_failed") {
    return event.commandId === `fail:${attempt.attemptId}:${attempt.failure?.reasonCode}`
      || (attempt.failure?.reasonCode === "lease_expired"
        && event.commandId === `expire:${attempt.attemptId}`);
  }
  if (event.type === "external_effect_fenced") {
    const priorFenceCount = current.events.filter((entry) => (
      entry.commandId.startsWith(`effect-fence:${attempt.attemptId}:`)
    )).length;
    return event.commandId === `effect-fence:${attempt.attemptId}:${priorFenceCount + 1}`;
  }
  return false;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isIsoTimestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical completion values must be finite.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical completion values must be deterministic JSON.");
}

async function assertCompletionTransitionPayload(context, current, next, transition, args) {
  if (transition === "content_review_required>render_queued") {
    const decision = next.reviewDecisions.at(-1);
    const source = current.artifactSets.find((artifact) => (
      artifact.kind === "private_review" && artifact.revisionId === current.currentRevisionId
    ));
    if (decision?.decisionType !== "content" || decision.outcome !== "approved"
        || decision.revisionId !== current.currentRevisionId
        || decision.operationsCommandId !== args.commandId
        || decision.artifactDigests?.pageDigest !== source?.pageDigest
        || decision.artifactDigests?.transcriptDigest !== source?.transcriptDigest
        || decision.artifactDigests?.assetManifestDigest !== source?.assetManifestDigest) {
      throw new Error("Completion approval does not bind the reviewed synthetic artifact.");
    }
    const approval = (await findReviewApproval(context, decision.approvalId))?.approval;
    if (!approval || approval.binding?.jobId !== current.jobId
        || approval.binding?.intakeDigest !== current.intakeDigest
        || approval.binding?.environment !== current.environment
        || approval.binding?.product !== current.product
        || approval.binding?.revisionId !== current.currentRevisionId
        || approval.binding?.artifactManifestDigest !== source.assetManifestDigest
        || approval.decision?.decisionType !== decision.decisionType
        || approval.decision?.outcome !== decision.outcome
        || approval.decision?.policyVersion !== decision.policyVersion
        || approval.decision?.rubricVersion !== decision.rubricVersion
        || approval.decision?.decidedAt !== decision.decidedAt
        || JSON.stringify(approval.decision?.reviewer) !== JSON.stringify(decision.reviewer)
        || JSON.stringify(approval.decision?.artifactDigests) !== JSON.stringify(decision.artifactDigests)
        || JSON.stringify(approval.decision?.reasons || []) !== JSON.stringify(decision.reasons || [])) {
      throw new Error("Completion approval does not match the persisted human decision.");
    }
  }
  if (transition === "rendering>publish_ready") {
    const source = current.artifactSets.find((artifact) => (
      artifact.kind === "private_review" && artifact.revisionId === current.currentRevisionId
    ));
    const prepared = next.artifactSets.at(-1);
    if (!isExactCompletionPromotion(current, source, prepared)) {
      throw new Error("Completion render does not preserve the approved synthetic artifact bytes.");
    }
  }
  if (transition === "publishing>published") {
    const origin = process.env.TEST_A_PUBLICATION_ORIGIN;
    if (next.publication?.provider !== "vercel" || next.publication.status !== "published"
        || next.publication.revisionId !== current.currentRevisionId
        || next.publication.stableUrl !== `${origin}/announcements/${current.jobId}`
        || next.publishedRevisionId !== current.currentRevisionId) {
      throw new Error("Completion publication exceeds the exact private synthetic target.");
    }
  }
  if (transition === "sending>sent") {
    const delivery = next.deliveryAttempts.at(-1);
    if (delivery?.provider !== "resend" || delivery.targetRef !== "resend:test-a-sink"
        || delivery.revisionId !== current.currentRevisionId || delivery.status !== "sent") {
      throw new Error("Completion delivery exceeds the exact Resend test sink.");
    }
  }
  if (next.retry && !new Set(["render_approved", "publish", "deliver"]).has(next.retry.stage)) {
    throw new Error("Completion retry exceeds the completion-only stages.");
  }
}

function isExactCompletionPromotion(current, source, prepared) {
  if (!source || prepared?.kind !== "prepared_bundle" || prepared.revisionId !== current.currentRevisionId
      || prepared.pageDigest !== source.pageDigest || prepared.transcriptDigest !== source.transcriptDigest
      || prepared.manifestRef
        !== `jobs/${current.jobId}/revisions/${current.currentRevisionId}/manifests/prepared_bundle.json`
      || !Array.isArray(source.files) || source.files.length === 0
      || !Array.isArray(prepared.files) || prepared.files.length !== source.files.length) return false;
  const namespace = source.files[0].path.split("/")[1];
  return Boolean(namespace) && source.files.every((file, index) => (
    file.path.startsWith(`private-preview/${namespace}/`)
    && JSON.stringify(prepared.files[index]) === JSON.stringify({
      ...file,
      path: `deploy/${file.path.slice(`private-preview/${namespace}/`.length)}`,
    })
  ));
}
