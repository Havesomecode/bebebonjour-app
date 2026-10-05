"use node";
import { actionGeneric, makeFunctionReference as ref } from "convex/server";
import { v } from "convex/values";
import { createHash, randomBytes } from "node:crypto";
import { signPersistedReviewApproval } from "../src/fulfillment/persisted-review-decision.mjs";
import { recordReviewDecisionTransition, EDITORIAL_POLICY_VERSION } from "../src/fulfillment/job-machine.mjs";
import { createJobAggregate } from "../src/fulfillment/job-machine.mjs";
import { assertValidIntake } from "../scripts/lib/validators.mjs";
import { stablePrivateValue } from "../src/fulfillment/private-generation-authority.mjs";
import { assertOwnerTrialOperator, fixedOwnerTrialIntake, OWNER_TRIAL_SOURCE, OWNER_TRIAL_RECIPIENT } from "../src/fulfillment/owner-trial-authority.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
export const issueTicket = actionGeneric({
  args: { operatorToken: v.string(), idempotencyKey: v.string(), ownerSourceReference: v.string(),
    recipient: v.string(), origin: v.string(), expiresAt: v.string() },
  handler: async (ctx, args) => {
    assertOwnerTrialOperator(args.operatorToken);
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(args.idempotencyKey) || args.ownerSourceReference !== OWNER_TRIAL_SOURCE
      || args.recipient !== OWNER_TRIAL_RECIPIENT || !validOrigin(args.origin)) throw new Error("Owner trial ticket binding rejected.");
    const expiry = Date.parse(args.expiresAt);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== args.expiresAt
      || expiry <= Date.now() || expiry > Date.now() + 86400000) throw new Error("Owner trial ticket expiry rejected.");
    const id = hash(`delegated-owner-trial-v1:${args.idempotencyKey}`).slice(0, 32);
    const ticketSecret = randomBytes(32).toString("hex");
    const binding = { ticketId: `ticket_owner_trial_${id}`, jobId: `job_owner_trial_${id}`,
      ownerSourceReference: args.ownerSourceReference, recipient: args.recipient, origin: args.origin, expiresAt: args.expiresAt };
    const result = await ctx.runMutation(ref("ownerTrial:insertTicket"), {
      operatorToken: args.operatorToken, ticketDigest: hash(ticketSecret), binding });
    return { ...binding, issued: result.issued, ...(result.issued ? { ticketSecret } : {}) };
  },
});
export const redeemTicket = actionGeneric({
  args: { operatorToken: v.string(), ticketSecret: v.string(), jobId: v.string(), recipient: v.string() },
  handler: async (ctx, args) => {
    assertOwnerTrialOperator(args.operatorToken);
    if (!/^[a-f0-9]{64}$/u.test(args.ticketSecret) || !/^job_owner_trial_[a-f0-9]{32}$/u.test(args.jobId)
      || args.recipient !== OWNER_TRIAL_RECIPIENT) throw new Error("Owner trial redemption rejected.");
    const intake = fixedOwnerTrialIntake(args.jobId); assertValidIntake(intake);
    const intakeDigest = hash(stablePrivateValue(intake)), at = new Date().toISOString();
    const aggregate = createJobAggregate({ jobId: args.jobId, environment: "test", product: "announcement-page",
      intakeDigest, narrationRequired: true, paymentCorrelation: { project: "bebebonjour", product: "announcement-page",
        environment: "test", jobId: args.jobId, intakeDigest } }, { commandId: `owner-trial-create:${args.jobId}`, at });
    aggregate.paymentCorrelation = null; aggregate.state = "generation_queued"; aggregate.events[0].state = aggregate.state;
    aggregate.events[0].type = "owner_trial_payment_waived";
    const sourceEvidence = { kind: "kanban_human_decision", reference: OWNER_TRIAL_SOURCE };
    const record = { schemaVersion: "1.0", approvalType: "job_scoped_editorial_policy", jobId: args.jobId,
      policy: { id: "unknown_name_general_wishes", preserveSubmittedName: true, meaningAllowed: false,
        scripturalNameAssociationAllowed: false, genericBlessingsAllowed: true, maxStage: "content_review_required" },
      sourceEvidence, sourceDigest: hash(JSON.stringify(sourceEvidence)) };
    return ctx.runMutation(ref("ownerTrial:redeem"), { operatorToken: args.operatorToken, jobId: args.jobId,
      recipient: args.recipient, ticketDigest: hash(args.ticketSecret), intake, intakeDigest, aggregate,
      editorialApproval: { record, recordDigest: hash(`${JSON.stringify(record, null, 2)}\n`) } });
  },
});
export const feedback = actionGeneric({
  args: { operatorToken: v.string(), jobId: v.string() },
  handler: async (ctx, args) => {
    assertOwnerTrialOperator(args.operatorToken);
    const { job } = await ctx.runQuery(ref("ownerTrial:readReviewContext"), { ...args, decisionType: "content" });
    const projection = await ctx.runQuery(ref("operations:getJob"), args);
    if (!projection) throw new Error("Owner trial feedback unavailable.");
    const safe = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined)
      .map(key => [key, value[key]]));
    return {
      jobId: job.jobId, state: job.state, version: job.version,
      paymentDisposition: job.ownerTrialAuthority.paymentDisposition,
      reviewMode: job.ownerTrialAuthority.reviewMode,
      currentRevisionId: job.currentRevisionId,
      availableActions: projection.availableActions,
      events: job.events.map(event => safe(event, ["type", "at", "state", "commandId"])),
      stageAttempts: job.stageAttempts.map(attempt => safe(attempt,
        ["attemptId", "stage", "status", "startedAt", "completedAt", "reasonCode"])),
      commands: projection.commands.map(command => safe(command,
        ["commandId", "action", "state", "attempts", "lastFailureReason", "updatedAt"])),
      commandsHasMore: projection.commandsHasMore,
      commandCursor: projection.commandCursor,
      reviewDecisions: job.reviewDecisions.map(decision => ({
        decisionType: decision.decisionType, outcome: decision.outcome,
        reviewerRole: decision.reviewer.role, decidedAt: decision.decidedAt,
      })),
      publication: job.publication ? safe(job.publication, ["url", "publicationId", "publishedAt"]) : null,
      deliveryAttempts: job.deliveryAttempts.map(attempt => safe(attempt,
        ["deliveryId", "status", "sentAt", "reasonCode"])),
    };
  },
});
export const review = actionGeneric({
  args: { operatorToken: v.string(), jobId: v.string(), decisionType: v.string(), expectedVersion: v.number(),
    artifactManifestDigest: v.string(), evidenceDigest: v.string(), acknowledgement: v.string() },
  handler: async (ctx, args) => {
    assertOwnerTrialOperator(args.operatorToken);
    const type = args.decisionType;
    if (!["content", "narration"].includes(type) || !/^[a-f0-9]{64}$/u.test(args.evidenceDigest)
      || args.acknowledgement !== `delegated-owner-trial-${type}-inspected-not-owner-acceptance`) throw new Error("Owner trial delegated review evidence rejected.");
    const { job, receipt } = await ctx.runQuery(ref("ownerTrial:readReviewContext"), {
      operatorToken: args.operatorToken, jobId: args.jobId, decisionType: type });
    const binding = { expectedVersion: args.expectedVersion, artifactManifestDigest: args.artifactManifestDigest,
      evidenceDigest: args.evidenceDigest, acknowledgement: args.acknowledgement };
    if (receipt) {
      if (stablePrivateValue(receipt.binding) !== stablePrivateValue(binding)) throw new Error("Owner trial review replay conflict.");
      return receipt.result;
    }
    const artifact = job.artifactSets.filter(a => a.revisionId === job.currentRevisionId
      && a.kind === (type === "content" ? "private_review" : "narration_review"));
    if (job.state !== `${type}_review_required` || job.version !== args.expectedVersion || artifact.length !== 1
      || artifact[0].assetManifestDigest !== args.artifactManifestDigest) throw new Error("Owner trial stale review rejected.");
    const approval = signPersistedReviewApproval({ hmacKey: process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY, job,
      decision: { decisionType: type, revisionId: job.currentRevisionId, outcome: "approved",
        policyVersion: EDITORIAL_POLICY_VERSION, rubricVersion: `delegated-owner-trial-${type}-v1`,
        reviewer: { id: `delegated_trial_${args.evidenceDigest.slice(0, 24)}`, role: "delegated_owner_trial",
          competencies: [type === "content" ? "delegated_content_inspection" : "delegated_narration_technical_content_inspection"] },
        decidedAt: new Date().toISOString(), reasons: [], artifactDigests: Object.fromEntries(
          ["pageDigest", "transcriptDigest", "assetManifestDigest"].map(k => [k, artifact[0][k]])) } });
    const next = recordReviewDecisionTransition(job, { ...approval.decision, approvalId: approval.approvalId }, approval.decision.decidedAt);
    const result = { jobId: job.jobId, approvalId: approval.approvalId, state: next.state, version: next.version };
    return ctx.runMutation(ref("ownerTrial:commitReview"), { operatorToken: args.operatorToken, jobId: job.jobId,
      expectedVersion: job.version, aggregate: next, approval, receipt: { decisionType: type, binding, result } });
  },
});
function validOrigin(value) { try { return new URL(value).protocol === "https:" && new URL(value).origin === value; } catch { return false; } }
