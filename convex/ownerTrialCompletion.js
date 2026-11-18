import { assertPublicPlaybackRepairLease, playbackApprovedPath } from "./ownerTrialPublicPlaybackRepair.js";
import { queryGeneric, mutationGeneric, internalQueryGeneric } from "convex/server";
import { assertSupersessionLease, approvedPublicPath } from "./ownerTrialPublicationSupersession.js";
import { assertPresentLease, findUnresolvedPresentCommand } from "./ownerTrialPublicationPresent.js";
import { v } from "convex/values";
import { verifiedCompletionContinuation } from "./ownerTrialCompletionContinuation.js";
import { verifiedPublicationRecoveryAllowance } from "./ownerTrialPublicationRecovery.js";
import { assertOwnerTrialPersistedAuthority, hashTrial } from "./ownerTrial.js";
import { stablePrivateValue as canonicalJson } from "../src/fulfillment/private-generation-authority.mjs";
import { OWNER_TRIAL_SOURCE, OWNER_TRIAL_RECIPIENT } from "../src/fulfillment/owner-trial-authority.mjs";

export const OWNER_TRIAL_WORKER_ID = "owner-trial-completion-worker";
export const OWNER_TRIAL_COMPLETION_ACTIONS = Object.freeze(["deliver", "publish", "queue_delivery"]);
const HEX = /^[a-f0-9]{64}$/u;
const lookup = (ctx, table, index, field, value) => ctx.db.query(table).withIndex(index, q => q.eq(field, value)).unique();

export function assertOwnerTrialCompletionToken(token) {
  const expected = process.env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN;
  const other = ["BEBEBONJOUR_OPERATIONS_TOKEN", "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN", "BEBEBONJOUR_TTS_WORKER_TOKEN",
    "BEBEBONJOUR_NARRATION_WORKER_TOKEN", "BEBEBONJOUR_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN", "CUSTOMER_FLOW_BACKEND_TOKEN", "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN",
    "BEBEBONJOUR_APPROVAL_HMAC_KEY", "BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN", "OWNER_TRIAL_INVOKE_SECRET", "CRON_SECRET"];
  if (process.env.BEBEBONJOUR_OWNER_TRIAL_ENABLED !== "true" || typeof expected !== "string" || expected.length < 32
      || token !== expected || other.some(name => process.env[name] === expected)) throw new Error("Owner trial completion unauthorized.");
}
export function assertOwnerTrialCompletionClaim(args) {
  if (!/^job_owner_trial_[a-f0-9]{32}$/u.test(args.jobId || "") || args.workerId !== OWNER_TRIAL_WORKER_ID
      || args.limit !== 1 || args.leaseMs !== 300000
      || canonicalJson([...args.actions].sort()) !== canonicalJson(OWNER_TRIAL_COMPLETION_ACTIONS)) {
    throw new Error("Owner trial completion claim scope rejected.");
  }
}
export function assertOwnerTrialCompletionCommand(command, args) {
  if (!/^job_owner_trial_[a-f0-9]{32}$/u.test(command?.jobId || "")
      || !OWNER_TRIAL_COMPLETION_ACTIONS.includes(command.action) || args.workerId !== OWNER_TRIAL_WORKER_ID
      || (args.leaseMs !== undefined && args.leaseMs !== 300000)) throw new Error("Owner trial completion command scope rejected.");
}

// Keep raw review/expiry validation separate from the PRESENT verifier: the latter
// binds its signed policy to this exact result and must never recurse through delivery.
export async function ownerTrialCompletionPolicy(ctx, jobId) {
  const policy = await ownerTrialCompletionBasePolicy(ctx, jobId);
  const job = (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", jobId))?.aggregate;
  const present = await lookup(ctx, "ownerTrialPublicationPresentResults", "by_job_id", "jobId", jobId);
  const supersession = await lookup(ctx, "ownerTrialPublicationSupersessions", "by_job_id", "jobId", jobId);
  if ((job.publication || present || supersession) && await findUnresolvedPresentCommand(ctx, jobId, policy)) {
    throw new Error("Owner trial delivery has unresolved command authority.");
  }
  return policy;
}
export async function ownerTrialCompletionBasePolicy(ctx, jobId) {
  const policy = await reviewedOwnerTrialCompletionPolicy(ctx, jobId);
  const ticket = await lookup(ctx, "ownerTrialTickets", "by_ticket_id", "ticketId", policy.ticketId);
  const receipt = await verifiedCompletionContinuation(ctx, policy);
  if (!receipt && Date.parse(ticket.binding.expiresAt) > Date.now()) return policy;
  if (!receipt) throw new Error("Owner trial ticket is not active.");
  return { ...policy, continuationReceiptId: receipt.receiptId, completionExpiresAt: receipt.request.expiresAt };
}
// Internal shared validation only: no callable endpoint and no caller-controlled expiry bypass.
export async function reviewedOwnerTrialCompletionPolicy(ctx, jobId) {
  if (!/^job_owner_trial_[a-f0-9]{32}$/u.test(jobId || "")) throw new Error("Owner trial immutable job scope rejected.");
  const customer = (await lookup(ctx, "customerFlowJobs", "by_job_id", "jobId", jobId))?.job;
  const job = (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", jobId))?.aggregate;
  const authority = await assertOwnerTrialPersistedAuthority(ctx, customer, job);
  const ticket = await lookup(ctx, "ownerTrialTickets", "by_ticket_id", "ticketId", authority.ticketId);
  if (!ticket?.redeemed || ticket.binding.ownerSourceReference !== OWNER_TRIAL_SOURCE
      || ticket.binding.recipient !== OWNER_TRIAL_RECIPIENT || !Number.isFinite(Date.parse(ticket.binding.expiresAt))) throw new Error("Owner trial ticket is not active.");
  let origin;
  try { origin = new URL(authority.origin); } catch { throw new Error("Owner trial public origin rejected."); }
  if (origin.protocol !== "https:" || origin.origin !== authority.origin) throw new Error("Owner trial public origin rejected.");
  if (!["publish_ready", "publishing", "published", "delivery_queued", "sending", "sent", "complete", "failed",
    "reconciliation_required"].includes(job.state)) throw new Error("Owner trial release is not reviewed.");
  const releases = job.artifactSets.filter(a => a.kind === "narration_review" && a.revisionId === job.currentRevisionId);
  if (releases.length !== 1 || !HEX.test(releases[0].assetManifestDigest || "")) throw new Error("Owner trial exact release missing.");
  const policy = { jobId, revisionId: job.currentRevisionId, manifestDigest: releases[0].assetManifestDigest,
    recipient: authority.recipient, origin: authority.origin, ticketId: authority.ticketId,
    intakeDigest: job.intakeDigest, ownerSourceReference: OWNER_TRIAL_SOURCE,
    targetRef: `cloudflare:fictional:${jobId}`, workerId: OWNER_TRIAL_WORKER_ID };
  for (const type of ["content", "narration"]) {
    const receipt = await ctx.db.query("ownerTrialReviews").withIndex("by_job_type", q => q.eq("jobId", jobId).eq("decisionType", type)).unique();
    const id = receipt?.receipt?.result?.approvalId;
    const approval = (await lookup(ctx, "fulfillmentReviewApprovals", "by_approval_id", "approvalId", id || ""))?.approval;
    const source = job.artifactSets.filter(a => a.kind === (type === "content" ? "private_review" : "narration_review")
      && a.revisionId === job.currentRevisionId);
    const decision = approval?.decision;
    if (!/^approval_[a-f0-9]{24}$/u.test(id || "") || !approval || source.length !== 1
        || approval.schemaVersion !== "1.0" || approval.approvalId !== id
        || approval.binding?.jobId !== jobId || approval.binding?.revisionId !== job.currentRevisionId
        || approval.binding?.intakeDigest !== job.intakeDigest || approval.binding?.environment !== "test"
        || approval.binding?.product !== "announcement-page" || approval.binding?.artifactManifestDigest !== source[0].assetManifestDigest
        || decision?.decisionType !== type || decision.outcome !== "approved" || decision.revisionId !== job.currentRevisionId
        || decision.reviewer?.role !== "delegated_owner_trial" || !HEX.test(approval.signature || "")
        || !["pageDigest", "transcriptDigest", "assetManifestDigest"].every(k => decision.artifactDigests?.[k] === source[0][k])
        || receipt.receipt.binding.artifactManifestDigest !== source[0].assetManifestDigest
        || receipt.receipt.binding.acknowledgement !== `delegated-owner-trial-${type}-inspected-not-owner-acceptance`
        || !HEX.test(receipt.receipt.binding.evidenceDigest || "")) throw new Error("Owner trial signed delegated review rejected.");
    const hmac = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
    if (typeof hmac !== "string" || new TextEncoder().encode(hmac).length < 32) throw new Error("Owner trial signing key unavailable.");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(hmac), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = { schemaVersion: approval.schemaVersion, approvalId: id, binding: approval.binding, decision };
    const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalJson(signed))))]
      .map(x => x.toString(16).padStart(2, "0")).join("");
    const fields = ["decisionType", "revisionId", "outcome", "policyVersion", "rubricVersion", "reviewer", "decidedAt", "artifactDigests", "reasons"];
    if (signature !== approval.signature || job.reviewDecisions.filter(d => d.approvalId === id
      && fields.every(k => canonicalJson(d[k]) === canonicalJson(decision[k]))).length !== 1) throw new Error("Owner trial review authenticity rejected.");
    policy[`${type}ApprovalId`] = id;
  }
  const manifest = `${JSON.stringify({ schemaVersion: "1.0", kind: releases[0].kind, revisionId: releases[0].revisionId,
    files: releases[0].files.map(({ path, storageId, bytes, sha256 }) => ({ path, storageId, bytes, sha256 })) }, null, 2)}\n`;
  if (await hashTrial(manifest) !== policy.manifestDigest) throw new Error("Owner trial release manifest changed.");
  if (job.publication && (job.publication.stableUrl !== `${policy.origin}/announcements/${jobId}`
    || job.publication.revisionId !== policy.revisionId || job.publication.artifactManifestDigest !== policy.manifestDigest)) throw new Error("Owner trial publication binding changed.");
  const targetDigest = await hashTrial(canonicalJson({ targetRef: policy.targetRef, email: policy.recipient }));
  if (job.stageAttempts.some(a => a.stage === "deliver" && (a.operationBinding?.targetRef !== policy.targetRef
    || a.operationBinding?.targetDigest !== targetDigest)) || job.deliveryAttempts.some(a => a.targetRef !== policy.targetRef
      || a.revisionId !== policy.revisionId)) throw new Error("Owner trial recipient binding changed.");
  return policy;
}
export async function assertOwnerTrialCompletionRelease(ctx, jobId, aggregate) {
  const policy = await ownerTrialCompletionPolicy(ctx, jobId);
  const current = (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", jobId))?.aggregate;
  if (aggregate && (aggregate.jobId !== jobId || aggregate.currentRevisionId !== policy.revisionId
    || canonicalJson(aggregate.ownerTrialAuthority) !== canonicalJson(current.ownerTrialAuthority)
    || canonicalJson(aggregate.artifactSets) !== canonicalJson(current.artifactSets)
    || canonicalJson(aggregate.reviewDecisions) !== canonicalJson(current.reviewDecisions)
    || aggregate.payment !== null || aggregate.paymentCorrelation !== null)) throw new Error("Owner trial release authority changed.");
  return policy;
}
const readArgs = { completionToken: v.string(), jobId: v.string(), workerId: v.optional(v.string()),
  commandId: v.optional(v.string()), leaseToken: v.optional(v.string()) };
export const completionPolicy = queryGeneric({ args: { completionToken: v.string(), jobId: v.string() },
  handler: async (ctx, args) => { assertOwnerTrialCompletionToken(args.completionToken); return ownerTrialCompletionPolicy(ctx, args.jobId); } });

async function activeCommand(ctx, args, { effect = false, action } = {}) {
  const command = await lookup(ctx, "customerFlowOperationsCommands", "by_command_id", "commandId", args.commandId);
  assertOwnerTrialCompletionCommand(command, args);
  if (command.jobId !== args.jobId || command.state !== "running" || command.claim?.workerId !== args.workerId
    || command.claim?.leaseToken !== args.leaseToken || command.claim.leaseExpiresAtMs <= Date.now()
    || (action && command.action !== action) || (effect && !Number.isFinite(command.claim.effectStartedAtMs))) {
    throw new Error("Owner trial active command lease rejected.");
  }
  const policy = await ownerTrialCompletionPolicy(ctx, args.jobId);
  if (command.payload.revisionId !== policy.revisionId || command.payload.artifactManifestDigest !== policy.manifestDigest) {
    throw new Error("Owner trial command release binding rejected.");
  }
  return command;
}
export const getJob = queryGeneric({ args: readArgs, handler: async (ctx, args) => {
  assertOwnerTrialCompletionToken(args.completionToken); await ownerTrialCompletionPolicy(ctx, args.jobId);
  if (args.commandId || args.workerId || args.leaseToken) await activeCommand(ctx, args);
  return (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", args.jobId)).aggregate;
} });
export const getReviewApproval = queryGeneric({ args: { completionToken: v.string(), jobId: v.string(), approvalId: v.string() },
  handler: async (ctx, args) => {
    assertOwnerTrialCompletionToken(args.completionToken); const p = await ownerTrialCompletionPolicy(ctx, args.jobId);
    if (![p.contentApprovalId, p.narrationApprovalId].includes(args.approvalId)) throw new Error("Owner trial approval scope rejected.");
    return (await lookup(ctx, "fulfillmentReviewApprovals", "by_approval_id", "approvalId", args.approvalId)).approval;
  } });
export const replaceJob = mutationGeneric({ args: { ...readArgs, workerId: v.string(), commandId: v.string(), leaseToken: v.string(),
  expectedVersion: v.number(), aggregate: v.any() }, handler: async (ctx, args) => {
    assertOwnerTrialCompletionToken(args.completionToken);
    const command = await activeCommand(ctx, args);
    const document = await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", args.jobId);
    await assertOwnerTrialCompletionRelease(ctx, args.jobId, args.aggregate);
    if (document.aggregate.version !== args.expectedVersion) return { updated: false, current: document.aggregate };
    const current = document.aggregate, next = args.aggregate;
    const policy = await ownerTrialCompletionPolicy(ctx, args.jobId);
    const event = next.events?.at(-1);
    const stage = command.action === "publish" ? "publish" : "deliver";
    if (command.action === "queue_delivery") {
      if (current.state !== "published" || next.state !== "delivery_queued" || command.payload.publicationId !== current.publication?.providerReceiptId) {
        throw new Error("Owner trial delivery queue binding rejected.");
      }
    } else {
      const transitions = stage === "publish" ? ["publish_ready>publishing", "publishing>publishing", "publishing>published", "publishing>failed", "publishing>reconciliation_required"]
        : ["delivery_queued>sending", "sending>sending", "sending>sent", "sending>failed", "sending>reconciliation_required"];
      if (!transitions.includes(`${current.state}>${next.state}`)) throw new Error("Owner trial completion transition rejected.");
      if (event?.type === "stage_completed" || (event?.type === "external_effect_fenced" && next.stageAttempts.at(-1).effectStartedAt !== null)) {
        await activeCommand(ctx, args, { effect: true });
      }
    }
    const publicationRecovery = command.action === "publish"
      ? await verifiedPublicationRecoveryAllowance(ctx, policy, current, command) : null;
    await assertCompletionReplacement(ctx, current, next, args.expectedVersion, args, command, { ...policy, publicationRecovery });
    await ctx.db.patch(document._id, { aggregate: next });
    // Read the proposed persisted state through the same provenance/signature checks before commit.
    await ownerTrialCompletionPolicy(ctx, args.jobId);
    return { updated: true, aggregate: next };
  } });
export const authorizeArtifactRead = internalQueryGeneric({ args: { ...readArgs, workerId: v.string(), commandId: v.string(),
  leaseToken: v.string(), revisionId: v.string(), storageId: v.string() }, handler: async (ctx, args) => {
    assertOwnerTrialCompletionToken(args.completionToken);
    const repair=await lookup(ctx,"ownerTrialPublicPlaybackRepairs","by_job_id","jobId",args.jobId);
    if(repair?.authorization.commandId===args.commandId){
      const {a}=await assertPublicPlaybackRepairLease(ctx,args);
      if(args.revisionId!==a.binding.revisionId)throw new Error("Owner trial public artifact revision rejected.");
      const files=a.binding.files.filter(f=>f.storageId===args.storageId&&playbackApprovedPath(f.path));
      if(files.length!==1)throw new Error("Owner trial public artifact read scope rejected.");
      return files[0];
    }
    const supersession=await lookup(ctx,"ownerTrialPublicationSupersessions","by_job_id","jobId",args.jobId);
    if(supersession?.authorization.commandId===args.commandId){
      const {a}=await assertSupersessionLease(ctx,args);
      if(args.revisionId!==a.binding.revisionId)throw new Error("Owner trial public artifact revision rejected.");
      const files=a.binding.files.filter(f=>f.storageId===args.storageId&&approvedPublicPath(f.path));
      if(files.length!==1)throw new Error("Owner trial public artifact read scope rejected.");
      return files[0];
    }
    const policy = await ownerTrialCompletionPolicy(ctx, args.jobId);
    const job = (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", args.jobId)).aggregate;
    const attempt = job.stageAttempts.at(-1);
    const presentCommand = await lookup(ctx, "customerFlowOperationsCommands", "by_command_id", "commandId", args.commandId);
    const present = presentCommand?.action === "reconcile";
    if (present) await assertPresentLease(ctx, args, { effect: true });
    else await activeCommand(ctx, args, { effect: true, action: "publish" });
    if (args.revisionId !== policy.revisionId || (!present && (job.state !== "publishing" || attempt?.status !== "running"
      || attempt.operationsCommandId !== args.commandId || attempt.stage !== "publish"
      || !attempt.effectStartedAt || Date.parse(attempt.leaseExpiresAt) <= Date.now()))) throw new Error("Owner trial stage artifact fence rejected.");
    const release = job.artifactSets.find(a => a.kind === "narration_review" && a.revisionId === policy.revisionId);
    const files = release.files.filter(f => f.storageId === args.storageId && (/^deploy\/(?:fr\/|ar\/)?index\.html$/u.test(f.path)
      || /^(?:deploy\/(?:fr|ar)\/app\.js|deploy\/shared\/app\.css)$/u.test(f.path)
      || /^deploy\/_assets\/[a-z0-9]+(?:-[a-z0-9]+){0,30}\/(?:app\.js|phrase-progress\.mjs|styles\.css|og-image\.svg)$/u.test(f.path)
      || /^artifacts\/audio\/[A-Za-z0-9/_-]+\.mp3$/u.test(f.path)));
    if (files.length !== 1) throw new Error("Owner trial public artifact read scope rejected.");
    return files[0];
  } });

// Scope-local replay validators; legacy pinned completion entrypoints are unchanged.
async function assertCompletionReplacement(context, current, next, expectedVersion, args, command, canonical = null) {
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
    "publishing>failed", "publishing>reconciliation_required",
    "published>delivery_queued",
    "delivery_queued>sending",
    "sending>sending",
    "sending>sent",
    "sending>retry_wait",
    "sending>failed", "sending>reconciliation_required",
    "retry_wait>render_queued",
    "retry_wait>publish_ready",
    "retry_wait>delivery_queued",
  ]);
  const mutableFields = new Set([
    "artifactSets", "deliveryAttempts", "events", "publication", "publishedRevisionId",
    "retry", "reviewDecisions", "stageAttempts", "state", "updatedAt", "version",
  ]);
  const transition = `${current.state}>${next?.state}`;
  if (!isIsoTimestamp(next?.updatedAt)
      || !isIsoTimestamp(current.updatedAt)
      || Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("Completion replacement requires a monotonic timestamp.");
  }
  assertExactCompletionTransitionBoundary(current, next, transition);
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
      || !await validStageAttemptChange(current, next, transition, args, canonical)) {
    throw new Error("Completion worker replacement exceeds its synthetic stage authority.");
  }
  if (!await validCompletionEvent(current, next.events.at(-1), transition, next, args, command, canonical)) {
    throw new Error("Completion worker replacement lacks canonical transition evidence.");
  }
  await assertCompletionTransitionPayload(context, current, next, transition, args, canonical);
}

const COMPLETION_OWNED_FIELDS_BY_TRANSITION = Object.freeze({
  "content_review_required>render_queued": ["reviewDecisions"],
  "render_queued>rendering": ["stageAttempts"],
  "rendering>publish_ready": ["artifactSets", "stageAttempts"],
  "rendering>retry_wait": ["retry", "stageAttempts"],
  "rendering>failed": ["retry", "stageAttempts"],
  "publish_ready>publishing": ["stageAttempts"],
  "publishing>publishing": ["stageAttempts"],
  "publishing>published": ["publication", "publishedRevisionId", "stageAttempts"],
  "publishing>retry_wait": ["retry", "stageAttempts"],
  "publishing>failed": ["retry", "stageAttempts"],
  "publishing>reconciliation_required": ["retry", "stageAttempts"],
  "published>delivery_queued": [],
  "delivery_queued>sending": ["stageAttempts"],
  "sending>sending": ["stageAttempts"],
  "sending>sent": ["deliveryAttempts", "stageAttempts"],
  "sending>retry_wait": ["retry", "stageAttempts"],
  "sending>failed": ["retry", "stageAttempts"],
  "sending>reconciliation_required": ["retry", "stageAttempts"],
  "retry_wait>render_queued": ["retry"],
  "retry_wait>publish_ready": ["retry"],
  "retry_wait>delivery_queued": ["retry"],
});

function assertExactCompletionTransitionBoundary(current, next, transition) {
  const transitionOwned = COMPLETION_OWNED_FIELDS_BY_TRANSITION[transition];
  if (!next || !transitionOwned) return;
  const owned = new Set(["events", "state", "updatedAt", "version", ...transitionOwned]);
  const unrelatedChanged = Object.keys(current).some((field) => (
    !owned.has(field) && JSON.stringify(current[field]) !== JSON.stringify(next[field])
  ));
  if (unrelatedChanged) {
    throw new Error(
      "Completion worker replacement exceeds its synthetic stage authority: exact transition mutation boundary.",
    );
  }
}

function appendDelta(current, next) {
  if (!Array.isArray(current) || !Array.isArray(next) || next.length < current.length) return -1;
  if (current.some((value, index) => JSON.stringify(value) !== JSON.stringify(next[index]))) return -1;
  return next.length - current.length;
}

const COMPLETION_STAGE_LEASE_MS = 300_000;
const COMPLETION_STAGE_MAX_ATTEMPTS = 1;
const COMPLETION_RETRY_BACKOFF_MS = 60_000;
const COMPLETION_STAGE_ATTEMPT_FIELDS = Object.freeze([
  "attemptId", "stage", "revisionId", "attemptNumber", "operationNumber",
  "idempotencyKey", "operationBinding", "operationsCommandId", "status", "leaseToken",
  "leaseExpiresAt", "startedAt", "effectStartedAt", "completedAt", "failure",
]);
const COMPLETION_FAILURE_REASON_CODES_BY_STAGE = Object.freeze({
  render_approved: new Set(["lease_expired", "provider_unavailable", "stage_error"]),
  publish: new Set([
    "lease_expired", "provider_outcome_unknown", "provider_receipt_invalid", "provider_unavailable",
    "publication_binding_invalid", "publication_provider_unavailable", "publication_scope_invalid",
    "publication_source_binding_invalid", "stage_error",
  ]),
  deliver: new Set([
    "lease_expired", "provider_outcome_unknown", "provider_receipt_invalid", "provider_unavailable",
    "cloudflare_send_uncertain", "cloudflare_recipient_rejected",
    "cloudflare_configuration_invalid", "cloudflare_input_invalid", "cloudflare_fence_required",
    "cloudflare_fence_repeated", "cloudflare_policy_invalid", "cloudflare_status_unavailable", "stage_error",
  ]),
});

async function validStageAttemptChange(currentAggregate, nextAggregate, transition, args, canonical) {
  const current = currentAggregate.stageAttempts;
  const next = nextAggregate.stageAttempts;
  const claims = new Set([
    "render_queued>rendering",
    "publish_ready>publishing",
    "delivery_queued>sending",
  ]);
  const updates = new Set([
    "rendering>publish_ready", "rendering>retry_wait", "rendering>failed",
    "publishing>publishing", "publishing>published", "publishing>retry_wait", "publishing>failed", "publishing>reconciliation_required",
    "sending>sending", "sending>sent",
    "sending>retry_wait", "sending>failed", "sending>reconciliation_required",
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
    return hasExactKeys(attempt, COMPLETION_STAGE_ATTEMPT_FIELDS)
      && attempt.attemptId === expectedAttemptId
      && attempt.stage === expectedStage
      && attempt.revisionId === expectedRevisionId
      && attempt.attemptNumber === expectedAttemptNumber
      && expectedAttemptNumber === (expectedStage === "publish" && canonical?.publicationRecovery ? canonical.publicationRecovery.maxAttempts : COMPLETION_STAGE_MAX_ATTEMPTS)
      && attempt.operationNumber === expectedOperationNumber
      && attempt.idempotencyKey === expectedIdempotencyKey
      && await validCompletionOperationBinding(expectedStage, attempt.operationBinding, canonical)
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
  const leaseExpiredFailure = updated.failure?.reasonCode === "lease_expired";
  const transitionBeforeLeaseExpiry = isIsoTimestamp(prior.leaseExpiresAt)
    && Date.parse(nextAggregate.updatedAt) < Date.parse(prior.leaseExpiresAt);
  const identifiersPreserved = current.slice(0, -1)
    .every((value, index) => JSON.stringify(value) === JSON.stringify(next[index]))
    && [
      "attemptId", "stage", "revisionId", "attemptNumber", "operationNumber",
      "idempotencyKey", "operationBinding", "operationsCommandId", "startedAt",
    ].every((field) => JSON.stringify(prior[field]) === JSON.stringify(updated[field]));
  if (!hasExactKeys(prior, COMPLETION_STAGE_ATTEMPT_FIELDS)
      || !hasExactKeys(updated, COMPLETION_STAGE_ATTEMPT_FIELDS)
      || !identifiersPreserved
      || prior.status !== "running"
      || typeof prior.leaseToken !== "string" || prior.leaseToken.length < 8
      || prior.leaseToken === args.leaseToken
      || (leaseExpiredFailure
        ? Date.parse(nextAggregate.updatedAt) < Date.parse(prior.leaseExpiresAt)
        : !transitionBeforeLeaseExpiry)
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
  if (transition.endsWith(">retry_wait") || transition.endsWith(">failed") || transition.endsWith(">reconciliation_required")) {
    const retrying = transition.endsWith(">retry_wait");
    return updated.status === (retrying ? "retry_wait" : prior.effectStartedAt ? "reconciliation_required" : "failed")
      && updated.leaseToken === null
      && updated.leaseExpiresAt === null
      && updated.completedAt === nextAggregate.updatedAt
      && hasExactKeys(updated.failure, ["reasonCode", "retryable"])
      && COMPLETION_FAILURE_REASON_CODES_BY_STAGE[updated.stage]?.has(updated.failure.reasonCode)
      && updated.failure.retryable === retrying
      && updated.effectStartedAt === prior.effectStartedAt
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
    && updated.effectStartedAt === prior.effectStartedAt
    && updated.failure === null;
}

async function validCompletionOperationBinding(stage, binding, canonical) {
  if (stage !== "deliver") return binding === null;
  if (!canonical) return false;
  const targetRef = `cloudflare:fictional:${canonical.jobId}`;
  const email = canonical.recipient;
  const expectedTargetDigest = await sha256Hex(canonicalJson({
    targetRef, email,
  }));
  return hasExactKeys(binding, ["targetDigest", "targetRef"])
    && binding.targetRef === targetRef
    && binding.targetDigest === expectedTargetDigest;
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
  "publishing>reconciliation_required": ["stage_failed"],
  "published>delivery_queued": ["delivery_queued"],
  "delivery_queued>sending": ["stage_claimed"],
  "sending>sending": ["external_effect_fenced"],
  "sending>sent": ["stage_completed"],
  "sending>retry_wait": ["stage_failed"],
  "sending>failed": ["stage_failed"],
  "sending>reconciliation_required": ["stage_failed"],
  "retry_wait>render_queued": ["retry_resumed"],
  "retry_wait>publish_ready": ["retry_resumed"],
  "retry_wait>delivery_queued": ["retry_resumed"],
});

async function validCompletionEvent(current, event, transition, next, args, command, canonical) {
  const commandIdValid = validCompletionEventCommandId(current, event, transition, next, args);
  if (!commandIdValid) return false;
  const expectedEventId = `event_${(await sha256Hex(`${next.jobId}\0${event.commandId}`)).slice(0, 24)}`;
  const expectedCommandDigest = await completionCommandDigest(
    current,
    next,
    event,
    args,
    command,
    canonical,
  );

  return hasExactKeys(event, ["eventId", "commandId", "commandDigest", "type", "at", "state"])
    && event.eventId === expectedEventId
    && (event.commandDigest === expectedCommandDigest || (event.type === "stage_failed" && event.commandDigest === await sha256Hex(`stage_failed\0${canonicalJson({commandId: event.commandId, stage: next.stageAttempts.at(-1).stage, leaseToken: current.stageAttempts.at(-1).leaseToken, retryable: true, reasonCode: next.stageAttempts.at(-1).failure.reasonCode})}`)))
    && COMPLETION_EVENT_TYPES_BY_TRANSITION[transition]?.includes(event.type)
    && event.at === next.updatedAt
    && isIsoTimestamp(event.at)
    && event.state === next.state;
}

async function completionCommandDigest(current, next, event, args, command, canonical) {
  const attempt = next.stageAttempts?.at(-1);
  let replayPayload;
  if (event.type === "stage_claimed") {
    replayPayload = {
      commandId: event.commandId,
      stage: attempt.stage,
      leaseMs: COMPLETION_STAGE_LEASE_MS,
      maxAttempts: attempt.stage === "publish" && canonical?.publicationRecovery ? canonical.publicationRecovery.maxAttempts : COMPLETION_STAGE_MAX_ATTEMPTS,
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

function unusedLegacyCanonicalJson(value) {
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


async function assertCompletionTransitionPayload(ctx, current, next, transition, args, policy) {
  const attempt = current.stageAttempts.at(-1);
  if (transition === "publishing>published") {
    const p = next.publication;
    if (!attempt.effectStartedAt || !p || p.provider !== "vercel" || p.status !== "published"
      || p.stableUrl !== `${policy.origin}/announcements/${policy.jobId}` || p.revisionId !== policy.revisionId
      || p.artifactManifestDigest !== policy.manifestDigest || !/^[A-Za-z0-9_-]{1,160}$/u.test(p.providerReceiptId || "")
      || p.operationsCommandId !== args.commandId || p.idempotencyKey !== attempt.idempotencyKey
      || next.publishedRevisionId !== policy.revisionId
      || !hasExactKeys(p, ["provider", "revisionId", "stableUrl", "artifactManifestDigest", "providerReceiptId", "idempotencyKey", "operationsCommandId", "status"])) throw new Error("Owner trial exact publication receipt rejected.");
  }
  if (transition === "sending>sent") {
    const d = next.deliveryAttempts.at(-1);
    if (!attempt.effectStartedAt || !d || d.provider !== "cloudflare" || d.status !== "sent" || d.revisionId !== policy.revisionId
      || d.targetRef !== policy.targetRef || d.targetRef !== attempt.operationBinding?.targetRef
      || !/^[\x21-\x7e]{1,998}$/u.test(d.providerMessageId || "")
      || d.operationsCommandId !== args.commandId || d.idempotencyKey !== attempt.idempotencyKey
      || d.deliveredAt !== null || d.lastOutcome !== null
      || !hasExactKeys(d, ["provider", "revisionId", "providerMessageId", "idempotencyKey", "operationsCommandId", "targetRef", "status", "deliveredAt", "lastOutcome"])) throw new Error("Owner trial exact delivery receipt rejected.");
  }
  if (next.retry !== null) throw new Error("Owner trial uncertain effect cannot be retried automatically.");
}
