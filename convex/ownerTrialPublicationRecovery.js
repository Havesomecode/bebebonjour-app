import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { hashTrial } from "./ownerTrial.js";
import { assertOwnerTrialCompletionToken, ownerTrialCompletionPolicy } from "./ownerTrialCompletion.js";
import { verifiedPublishedSupersession } from "./ownerTrialPublicationSupersession.js";
import { stablePrivateValue as canonicalJson } from "../src/fulfillment/private-generation-authority.mjs";
import { publicationAbsenceBinding, publicationRecoveryDigest, verifyPublicationAbsenceProof } from "../src/fulfillment/owner-trial-publication-recovery-proof.mjs";

const lookup = (ctx, table, index, field, value) => ctx.db.query(table).withIndex(index, q => q.eq(field, value)).unique();
const ROLE = "BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN";
const OTHER_ROLES = ["BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN", "OWNER_TRIAL_INVOKE_SECRET", "OWNER_TRIAL_COMPLETION_INVOKE_TOKEN",
  "OWNER_TRIAL_PUBLICATION_RECOVERY_INVOKE_TOKEN", "BEBEBONJOUR_OPERATIONS_TOKEN", "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
  "BEBEBONJOUR_TTS_WORKER_TOKEN", "BEBEBONJOUR_NARRATION_WORKER_TOKEN", "BEBEBONJOUR_COMPLETION_WORKER_TOKEN",
  "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN",
  "CUSTOMER_FLOW_BACKEND_TOKEN", "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN", "BEBEBONJOUR_APPROVAL_HMAC_KEY", "CRON_SECRET"];
function recoveryRole(token) {
  const expected = process.env[ROLE];
  if (process.env.BEBEBONJOUR_OWNER_TRIAL_ENABLED !== "true" || typeof expected !== "string" || expected.length < 32
    || token !== expected || OTHER_ROLES.some(name => process.env[name] === expected)) throw new Error("Owner trial publication recovery role unauthorized.");
  return expected;
}
function scope(binding, policy) {
  if (!process.env.OWNER_TRIAL_JOB_ID || binding.jobId !== process.env.OWNER_TRIAL_JOB_ID
    || binding.jobId !== policy.jobId || binding.revisionId !== policy.revisionId
    || binding.artifactManifestDigest !== policy.manifestDigest || binding.origin !== policy.origin
    || !Number.isSafeInteger(binding.expectedVersion) || binding.expectedVersion < 1
    || !/^attempt_[a-f0-9]{24}$/u.test(binding.attemptId || "")
    || !/^bb_[a-f0-9]{64}$/u.test(binding.idempotencyKey || "")
    || ![ ["teamId", "OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID"], ["projectId", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID"],
      ["projectName", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME"] ].every(([key, name]) => process.env[name] && binding[key] === process.env[name])) {
    throw new Error("Owner trial publication recovery immutable provider/release scope rejected.");
  }
}
const receiptsFor = (ctx, jobId, revisionId) => ctx.db.query("ownerTrialPublicationRecoveries")
  .withIndex("by_job_revision", q => q.eq("jobId", jobId).eq("revisionId", revisionId)).collect();
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
function commandIdentity(command) {
  const { _id, _creationTime, state, expectedVersion, attempts, claim, outcome, lastFailureReason, updatedAt, ...identity } = command;
  return identity;
}
function rejected() { throw new Error("Owner trial publication stored recovery receipt rejected."); }
function eventVersion(aggregate, event) {
  const matches = aggregate.events.map((e, i) => same(e, event) ? i : -1).filter(i => i >= 0);
  if (matches.length !== 1) rejected();
  return aggregate.version - (aggregate.events.length - 1 - matches[0]);
}
async function verifyAttempt(aggregate, attempt, binding, ordinal, expectedVersion) {
  const expectedId = `attempt_${(await hashTrial(`${binding.jobId}\0${binding.revisionId}\0publish\0${ordinal}`)).slice(0, 24)}`;
  const expectedKey = `bb_${await hashTrial([binding.jobId, binding.revisionId, "publish", "1"].join("\0"))}`;
  const claimId = `claim:${binding.jobId}:${binding.revisionId}:publish:${ordinal}`;
  const claims = aggregate.events.filter(e => e.commandId === claimId);
  if (!attempt || attempt.stage !== "publish" || attempt.revisionId !== binding.revisionId
    || attempt.attemptId !== expectedId || attempt.attemptNumber !== ordinal || attempt.operationNumber !== 1
    || attempt.operationBinding !== null || attempt.idempotencyKey !== binding.idempotencyKey || binding.idempotencyKey !== expectedKey
    || attempt.operationsCommandId !== binding.sourceCommandId || claims.length !== 1) rejected();
  const claim = claims[0];
  const digest = await hashTrial(`stage_claimed\0${canonicalJson({ commandId: claimId, stage: "publish", leaseMs: 300000,
    maxAttempts: ordinal, operationBinding: null, operationsCommandId: binding.sourceCommandId })}`);
  if (claim.eventId !== `event_${(await hashTrial(`${binding.jobId}\0${claimId}`)).slice(0, 24)}`
    || claim.type !== "stage_claimed" || claim.state !== "publishing" || claim.commandDigest !== digest
    || claim.at !== attempt.startedAt || eventVersion(aggregate, claim) !== expectedVersion + 1) rejected();
}
function unresolvedAttempt(attempt) {
  return attempt?.status === "reconciliation_required" && Number.isFinite(Date.parse(attempt.startedAt))
    && Number.isFinite(Date.parse(attempt.effectStartedAt)) && attempt.failure
    && Number.isFinite(Date.parse(attempt.completedAt)) && Date.parse(attempt.startedAt) <= Date.parse(attempt.effectStartedAt)
    && Date.parse(attempt.effectStartedAt) <= Date.parse(attempt.completedAt)
    && attempt.leaseToken === null && attempt.leaseExpiresAt === null;
}

// Used internally by the normal completion replacement boundary. Aggregate events alone never authorize a retry.
export async function verifiedPublicationRecoveryAllowance(ctx, policy, aggregate, command, documents) {
  const docs = documents || await receiptsFor(ctx, policy.jobId, policy.revisionId);
  if (!docs.length) return null;
  // Keep legacy receipt bytes and schema intact. Sequence is derived, never caller supplied.
  const receipts = docs.map(d => d.receipt).sort((a, b) => a.originalAttempt.attemptNumber - b.originalAttempt.attemptNumber);
  const token = recoveryRole(process.env[ROLE]), first = receipts[0], latest = receipts.at(-1);
  const attempts = aggregate.stageAttempts.filter(a => a.stage === "publish" && a.revisionId === policy.revisionId);
  const source = command || await lookup(ctx, "customerFlowOperationsCommands", "by_command_id", "commandId", latest.binding.sourceCommandId);
  if (attempts.length < receipts.length || attempts.length > receipts.length + 1
    || aggregate.events.filter(e => e.type === "owner_trial_publication_absence_recovered").length !== receipts.length) rejected();
  for (const [i, r] of receipts.entries()) {
    scope(r.binding, policy);
    const original = r.originalAttempt, historical = r.originalCommand;
    const digest = await verifyPublicationAbsenceProof(r.proof, r.binding, token, { fresh: false });
    const expectedCommandId = `publication-absence:${r.receiptId}`;
    if (digest !== r.proofDigest || await publicationRecoveryDigest({ binding: r.binding, proof: r.proof }) !== r.requestDigest
      || r.receiptId !== `recovery_${r.requestDigest.slice(0, 24)}` || !unresolvedAttempt(original)
      || original.attemptId !== r.binding.attemptId || !same(attempts[i], { ...original, status: "reconciled_absent" })
      || !same(publicationAbsenceBinding({ ...r.binding, expectedVersion: first.binding.expectedVersion, attemptId: first.binding.attemptId }), first.binding)
      || !same(commandIdentity(historical), commandIdentity(first.originalCommand))
      || historical.commandId !== r.binding.sourceCommandId || historical.jobId !== policy.jobId || historical.action !== "publish"
      || historical.expectedState !== "publish_ready" || historical.state !== "reconciliation_required"
      || historical.claim !== null || historical.outcome !== null || historical.attempts !== i + 1
      || !Number.isSafeInteger(historical.expectedVersion) || historical.expectedVersion < 1
      || historical.expectedVersion >= r.binding.expectedVersion
      || (i > 0 && historical.expectedVersion !== receipts[i - 1].recoveredVersion)
      || r.recoveredVersion !== r.binding.expectedVersion + 1 || eventVersion(aggregate, r.event) !== r.recoveredVersion
      || !same(r.event, { eventId: `event_${(await hashTrial(`${policy.jobId}\0${expectedCommandId}`)).slice(0, 24)}`,
        commandId: expectedCommandId, commandDigest: r.requestDigest, type: "owner_trial_publication_absence_recovered", at: r.event.at, state: "publish_ready" })
      || !Number.isFinite(Date.parse(r.event.at)) || Date.parse(r.proof.observedAt) < Date.parse(original.completedAt)
      || Date.parse(r.event.at) < Date.parse(r.proof.observedAt) || Date.parse(r.event.at) - Date.parse(r.proof.observedAt) > 60000) rejected();
    await verifyAttempt(aggregate, original, r.binding, i + 1, historical.expectedVersion);
  }
  if (!source || !same(commandIdentity(source), commandIdentity(first.originalCommand))
    || source.expectedVersion !== latest.recoveredVersion || aggregate.version < latest.recoveredVersion
    || source.attempts !== (source.state === "pending" ? receipts.length : receipts.length + 1)
    || source.payload.revisionId !== policy.revisionId || source.payload.artifactManifestDigest !== policy.manifestDigest) rejected();
  if (attempts.length === receipts.length + 1) {
    await verifyAttempt(aggregate, attempts.at(-1), latest.binding, receipts.length + 1, latest.recoveredVersion);
    if (attempts.at(-1).status === "reconciled_absent") rejected();
  }
  return { receiptId: latest.receiptId, jobId: policy.jobId, revisionId: policy.revisionId,
    sourceCommandId: latest.binding.sourceCommandId, idempotencyKey: latest.binding.idempotencyKey,
    reconciledAttemptIds: receipts.map(r => r.binding.attemptId), maxAttempts: receipts.length + 1 };
}
const bindingArgs = { jobId: v.string(), expectedVersion: v.number(), sourceCommandId: v.string(), attemptId: v.string(),
  revisionId: v.string(), artifactManifestDigest: v.string(), idempotencyKey: v.string(), teamId: v.string(),
  projectId: v.string(), projectName: v.string(), origin: v.string() };
export const recoverPublicationAbsence = mutationGeneric({ args: { completionToken: v.string(), recoveryToken: v.string(), ...bindingArgs, proof: v.any() },
  handler: async (ctx, args) => {
    assertOwnerTrialCompletionToken(args.completionToken); const token = recoveryRole(args.recoveryToken);
    const policy = await ownerTrialCompletionPolicy(ctx, args.jobId), binding = publicationAbsenceBinding(args);
    scope(binding, policy);
    const document = await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", args.jobId);
    const source = await lookup(ctx, "customerFlowOperationsCommands", "by_command_id", "commandId", args.sourceCommandId);
    const documents = await receiptsFor(ctx, args.jobId, args.revisionId);
    const prior = documents.find(d => d.receipt.binding.attemptId === binding.attemptId);
    const requestDigest = await publicationRecoveryDigest({ binding, proof: args.proof });
    if (prior) {
      if (requestDigest !== prior.receipt.requestDigest) throw new Error("Owner trial publication recovery replay changed.");
      await verifiedPublicationRecoveryAllowance(ctx, policy, document.aggregate, source, documents);
      return { recovered: false, receiptId: prior.receipt.receiptId, recoveredVersion: prior.receipt.recoveredVersion };
    }
    const proofDigest = await verifyPublicationAbsenceProof(args.proof, binding, token);
    const current = document.aggregate, attempt = current.stageAttempts.at(-1);
    const allowance = await verifiedPublicationRecoveryAllowance(ctx, policy, current, source, documents);
    const ordinal = (allowance?.reconciledAttemptIds.length || 0) + 1;
    const publishAttempts = current.stageAttempts.filter(a => a.stage === "publish" && a.revisionId === policy.revisionId);
    if (current.state !== "reconciliation_required" || current.version !== args.expectedVersion || current.publication !== null
      || current.retry !== null || publishAttempts.length !== ordinal || attempt !== publishAttempts.at(-1)
      || publishAttempts.slice(0, -1).some((a, i) => a.status !== "reconciled_absent" || a.attemptId !== allowance?.reconciledAttemptIds[i])
      || attempt.attemptId !== args.attemptId || !unresolvedAttempt(attempt) || attempt.attemptNumber !== ordinal
      || attempt.operationNumber !== 1 || attempt.operationBinding !== null || attempt.revisionId !== args.revisionId
      || attempt.idempotencyKey !== args.idempotencyKey || attempt.operationsCommandId !== args.sourceCommandId
      || !Number.isFinite(Date.parse(attempt.effectStartedAt)) || !attempt.failure || !Number.isFinite(Date.parse(attempt.completedAt))
      || attempt.leaseToken !== null || attempt.leaseExpiresAt !== null
      || !source || source.jobId !== args.jobId || source.action !== "publish" || source.state !== "reconciliation_required"
      || source.claim !== null || source.attempts !== ordinal || source.outcome !== null || source.expectedState !== "publish_ready"
      || source.expectedVersion >= current.version || source.payload.revisionId !== args.revisionId
      || source.payload.artifactManifestDigest !== args.artifactManifestDigest
      || current.stageAttempts.some(a => a.status === "running")
      || (await ctx.db.query("customerFlowOperationsCommands").withIndex("by_job_id_and_state", q => q.eq("jobId", args.jobId).eq("state", "pending")).collect()).length
      || (await ctx.db.query("customerFlowOperationsCommands").withIndex("by_job_id_and_state", q => q.eq("jobId", args.jobId).eq("state", "running")).collect()).length) {
      throw new Error("Owner trial publication exact unresolved attempt/command rejected.");
    }
    await verifyAttempt(current, attempt, binding, ordinal, source.expectedVersion);
    const at = new Date(Date.now()).toISOString();
    if (Date.parse(at) < Date.parse(current.updatedAt) || Date.parse(args.proof.observedAt) < Date.parse(attempt.completedAt)) {
      throw new Error("Owner trial publication proof predates the failed effect.");
    }
    const receiptId = `recovery_${requestDigest.slice(0, 24)}`, commandId = `publication-absence:${receiptId}`;
    const event = { eventId: `event_${(await hashTrial(`${args.jobId}\0${commandId}`)).slice(0, 24)}`,
      commandId, commandDigest: requestDigest, type: "owner_trial_publication_absence_recovered", at, state: "publish_ready" };
    const aggregate = { ...current, state: "publish_ready", version: current.version + 1, updatedAt: at,
      stageAttempts: current.stageAttempts.map(a => a === attempt ? { ...a, status: "reconciled_absent" } : a), events: [...current.events, event] };
    const { _id, _creationTime, ...originalCommand } = source;
    const receipt = { receiptId, binding, requestDigest, proofDigest, proof: args.proof,
      originalAttempt: attempt, originalCommand, event, recoveredVersion: aggregate.version };
    await ctx.db.insert("ownerTrialPublicationRecoveries", { jobId: args.jobId, revisionId: args.revisionId, receipt });
    await ctx.db.patch(document._id, { aggregate });
    await ctx.db.patch(source._id, { state: "pending", expectedState: "publish_ready", expectedVersion: aggregate.version, updatedAt: at });
    await ownerTrialCompletionPolicy(ctx, args.jobId);
    return { recovered: true, receiptId, recoveredVersion: aggregate.version };
  } });
export const recoveryAllowance = queryGeneric({ args: { completionToken: v.string(), jobId: v.string() }, handler: async (ctx, args) => {
  assertOwnerTrialCompletionToken(args.completionToken);
  const policy = await ownerTrialCompletionPolicy(ctx, args.jobId);
  const supersession = await verifiedPublishedSupersession(ctx, args.jobId);
  // Operation 2 is separately authorized. Verify legacy operation-1 receipts
  // against its fully verified historical snapshot, including after delivery.
  const aggregate = supersession?.a.snapshot.originalAggregate
    || (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", args.jobId)).aggregate;
  return verifiedPublicationRecoveryAllowance(ctx, policy, aggregate);
} });
