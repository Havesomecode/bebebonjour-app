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
    await assertActiveCompletionTransition(context, args, document.aggregate, args.aggregate);
    await assertCompletionReplacement(context, document.aggregate, args.aggregate, args.expectedVersion, args);
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
  await assertClaimedCompletionAuthority(context, args, action, {
    effectFenceRequired: action === "publish" || action === "deliver",
  });
}

function assertCompletionAuthority(token, jobId) {
  const expected = process.env.BEBEBONJOUR_COMPLETION_WORKER_TOKEN;
  if (!expected || expected.length < 32 || token !== expected
      || jobId !== "job_03c25b08-8476-4fe1-923b-43d73feab3ff") {
    throw new Error("Completion worker authorization failed.");
  }
}

async function assertCompletionReplacement(context, current, next, expectedVersion, args) {
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
      || !validStageAttemptChange(current.stageAttempts, next.stageAttempts, transition, args)) {
    throw new Error("Completion worker replacement exceeds its synthetic stage authority.");
  }
  if (!validCompletionEvent(next.events.at(-1), transition, next, args)) {
    throw new Error("Completion worker replacement lacks canonical transition evidence.");
  }
  await assertCompletionTransitionPayload(context, current, next, transition, args);
}

function appendDelta(current, next) {
  if (!Array.isArray(current) || !Array.isArray(next) || next.length < current.length) return -1;
  if (current.some((value, index) => JSON.stringify(value) !== JSON.stringify(next[index]))) return -1;
  return next.length - current.length;
}

function validStageAttemptChange(current, next, transition, args) {
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
    return hasExactKeys(attempt, [
      "attemptId", "stage", "revisionId", "attemptNumber", "operationNumber",
      "idempotencyKey", "operationBinding", "operationsCommandId", "status", "leaseToken",
      "leaseExpiresAt", "startedAt", "effectStartedAt", "completedAt", "failure",
    ])
      && typeof attempt.attemptId === "string" && attempt.attemptId.length > 0
      && attempt.stage === expectedStage
      && typeof attempt.revisionId === "string" && attempt.revisionId.length > 0
      && Number.isInteger(attempt.attemptNumber) && attempt.attemptNumber > 0
      && Number.isInteger(attempt.operationNumber) && attempt.operationNumber > 0
      && /^bb_[a-f0-9]{64}$/.test(attempt.idempotencyKey || "")
      && attempt.operationsCommandId === args.commandId
      && attempt.status === "running"
      && attempt.leaseToken === args.leaseToken
      && isIsoTimestamp(attempt.leaseExpiresAt)
      && isIsoTimestamp(attempt.startedAt)
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
    && current.at(-1).attemptId === next.at(-1).attemptId
    && current.at(-1).stage === next.at(-1).stage
    && current.at(-1).revisionId === next.at(-1).revisionId
    && current.at(-1).idempotencyKey === next.at(-1).idempotencyKey
    && current.at(-1).operationsCommandId === next.at(-1).operationsCommandId;
  if (!identifiersPreserved || updated.operationsCommandId !== args.commandId) return false;
  if (transition === "publishing>publishing" || transition === "sending>sending") {
    return updated.status === "running"
      && updated.leaseToken === args.leaseToken
      && updated.completedAt === null
      && updated.failure === null
      && isIsoTimestamp(updated.leaseExpiresAt)
      && (updated.effectStartedAt === prior.effectStartedAt || isIsoTimestamp(updated.effectStartedAt));
  }
  if (transition.endsWith(">retry_wait") || transition.endsWith(">failed")) {
    return ["retry_wait", "failed", "reconciliation_required"].includes(updated.status)
      && updated.leaseToken === null
      && updated.leaseExpiresAt === null
      && isIsoTimestamp(updated.completedAt)
      && updated.failure && typeof updated.failure.reasonCode === "string"
      && typeof updated.failure.retryable === "boolean";
  }
  return updated.status === "completed"
    && updated.leaseToken === null
    && updated.leaseExpiresAt === null
    && isIsoTimestamp(updated.completedAt)
    && updated.failure === null;
}

const COMPLETION_EVENT_TYPES_BY_TRANSITION = Object.freeze({
  "content_review_required>render_queued": ["review_decision_recorded"],
  "render_queued>rendering": ["stage_claimed"],
  "rendering>publish_ready": ["stage_completed"],
  "rendering>retry_wait": ["stage_failed"],
  "rendering>failed": ["stage_failed"],
  "publish_ready>publishing": ["stage_claimed"],
  "publishing>publishing": ["external_effect_started", "external_effect_fenced"],
  "publishing>published": ["stage_completed"],
  "publishing>retry_wait": ["stage_failed"],
  "publishing>failed": ["stage_failed"],
  "published>delivery_queued": ["delivery_queued"],
  "delivery_queued>sending": ["stage_claimed"],
  "sending>sending": ["external_effect_started", "external_effect_fenced"],
  "sending>sent": ["stage_completed"],
  "sending>retry_wait": ["stage_failed"],
  "sending>failed": ["stage_failed"],
  "retry_wait>render_queued": ["retry_resumed"],
  "retry_wait>publish_ready": ["retry_resumed"],
  "retry_wait>delivery_queued": ["retry_resumed"],
});

function validCompletionEvent(event, transition, next, args) {
  return hasExactKeys(event, ["eventId", "commandId", "commandDigest", "type", "at", "state"])
    && typeof event.eventId === "string" && event.eventId.length > 0
    && event.commandId === args.commandId
    && /^[a-f0-9]{64}$/.test(event.commandDigest || "")
    && COMPLETION_EVENT_TYPES_BY_TRANSITION[transition]?.includes(event.type)
    && event.at === next.updatedAt
    && isIsoTimestamp(event.at)
    && event.state === next.state;
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
