import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";
import { claimStageTransition, fenceExternalEffectTransition, failStageTransition } from "../../src/fulfillment/job-machine.mjs";
import { createOwnerTrialPublicArtifactResolver } from "../../src/fulfillment/owner-trial-completion-capabilities.mjs";
import { createVercelTestAPublicationProvider, parseAuthoritativeVercelBuildInspection } from "../../src/fulfillment/vercel-test-a-publication-provider.mjs";

const operatorToken = "offline-trial-completion-operator-at-least-32-bytes";
const completionToken = "offline-trial-completion-worker-at-least-32-bytes";
const workerToken = "offline-trial-generation-worker-at-least-32-bytes";
const hmacKey = "offline-trial-review-signing-key-at-least-32-bytes";
const workerId = "owner-trial-completion-worker";
const origin = "https://owner-trial.example.invalid";
const sha = value => createHash("sha256").update(value).digest("hex");
const actions = ["publish", "queue_delivery", "deliver"];
const modules = Object.fromEntries(["ownerTrial", "ownerTrialRuntime", "ownerTrialCompletion", "ownerTrialPublicationSupersession", "ownerTrialPublicationRecovery", "ownerTrialCompletionContinuation", "operations", "http", "fulfillment"]
  .map(name => [`./${name}.js`, () => import(`../../convex/${name}.js`)]));

async function fixture({ publicDeclaredBytes, publicAssets = false, publicNarration = false } = {}) {
  Object.assign(process.env, { BEBEBONJOUR_OWNER_TRIAL_ENABLED: "true",
    BEBEBONJOUR_OPERATIONS_TOKEN: operatorToken, BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: workerToken,
    BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: completionToken,
    BEBEBONJOUR_APPROVAL_HMAC_KEY: hmacKey });
  const t = convexTest(schema, { ...modules, "./_generated/server.js": () => import("convex/server") });
  const ticket = await t.action(ref("ownerTrialRuntime:issueTicket"), { operatorToken,
    idempotencyKey: "offline-completion-scope-fixture", ownerSourceReference: "kanban:t_4b1eb28f",
    recipient: "z@havesomecode.io", origin, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const jobId = ticket.jobId;
  await t.action(ref("ownerTrialRuntime:redeemTicket"), { operatorToken, ticketSecret: ticket.ticketSecret,
    jobId, recipient: "z@havesomecode.io" });
  // Explicitly labelled unit fixture artifacts, not claimed generation/provider evidence.
  // Both delegated reviews and signatures are made through the production review action.
  const publicBytes = Buffer.from("<!doctype html><html><head></head><body>Offline fictional fixture</body></html>");
  const privateBytes = Buffer.from("offline-private-fixture-not-public");
  const files = await t.run(async ctx => Promise.all([
    ["deploy/index.html", publicBytes], ["artifacts/current/intake.json", privateBytes],
    ...(publicNarration ? [["artifacts/audio/fr/intro.mp3", Buffer.from("offline-unit-audio-bytes-not-real-narration")]] : []),
    ...(publicAssets ? ["deploy/fr/app.js", "deploy/ar/app.js", "deploy/shared/app.css",
      "deploy/fr/other.js", "deploy/shared/other.css", "deploy/fr/manifest.json", "deploy/.env"]
      .map(path => [path, Buffer.from("offline-fixture-static-bytes")]) : []),
  ].map(async ([path, bytes]) => ({ path, storageId: await ctx.storage.store(new Blob([bytes])),
    bytes: path === "deploy/index.html" ? publicDeclaredBytes ?? bytes.length : bytes.length,
    sha256: sha(bytes) }))));
  const makeArtifact = kind => ({ artifactSetId: `artifact_offline_${kind}`, kind, revisionId: "r1",
    files, pageDigest: sha("offline-page"), transcriptDigest: sha("offline-transcript"),
    assetManifestDigest: sha(`${JSON.stringify({ schemaVersion: "1.0", kind, revisionId: "r1",
      files: files.map(({ path, storageId, bytes, sha256 }) => ({ path, storageId, bytes, sha256 })) }, null, 2)}\n`) });
  const content = makeArtifact("private_review"), narration = makeArtifact("narration_review");
  await patchJob(t, jobId, job => ({ ...job, state: "content_review_required", currentRevisionId: "r1",
    revisions: [{ revisionId: "r1", ordinal: 1, inputDigest: job.intakeDigest, createdAt: job.createdAt }],
    artifactSets: [content], stageAttempts: [{ stage: "prepare_review", status: "completed",
      attemptId: "offline-unit-content-run", revisionId: "r1" }] }));
  await review(t, jobId, "content", content);
  await patchJob(t, jobId, job => ({ ...job, state: "narration_review_required", artifactSets: [...job.artifactSets, makeArtifact("prepared_bundle"), narration],
    stageAttempts: [...job.stageAttempts, { stage: "generate_tts", status: "completed",
      attemptId: "offline-unit-narration-run", revisionId: "r1" }] }));
  await review(t, jobId, "narration", narration);
  const policy = await t.query(ref("ownerTrial:completionPolicy"), { completionToken, jobId });
  const claimArgs = { workerToken: completionToken, workerId, jobId, actions, limit: 1, leaseMs: 300000 };
  return { t, ticket, jobId, policy, claimArgs, files, publicBytes };
}
async function job(t, jobId) {
  return t.run(async ctx => (await ctx.db.query("fulfillmentJobs")
    .withIndex("by_job_id", q => q.eq("jobId", jobId)).unique()).aggregate);
}
async function patchJob(t, jobId, change) {
  return t.run(async ctx => {
    const document = await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", jobId)).unique();
    await ctx.db.patch(document._id, { aggregate: change(document.aggregate) });
  });
}
async function review(t, jobId, decisionType, artifact) {
  return t.action(ref("ownerTrialRuntime:review"), { operatorToken, jobId, decisionType,
    expectedVersion: (await job(t, jobId)).version, artifactManifestDigest: artifact.assetManifestDigest,
    evidenceDigest: sha(`offline-unit-${decisionType}-inspection-not-personal-owner-acceptance`),
    acknowledgement: `delegated-owner-trial-${decisionType}-inspected-not-owner-acceptance` });
}
async function snapshot(t) {
  return t.run(async ctx => Object.fromEntries(await Promise.all(Object.keys(schema.tables)
    .map(async name => [name, await ctx.db.query(name).collect()]))));
}
async function requestPublish(f) {
  const current = await job(f.t, f.jobId);
  return f.t.mutation(ref("operations:requestCommand"), { operatorToken, jobId: f.jobId,
    commandId: "command_offline_trial_publication", action: "publish", expectedState: current.state,
    expectedVersion: current.version, payload: { revisionId: f.policy.revisionId, artifactManifestDigest: f.policy.manifestDigest } });
}
async function claimPublish(f) {
  await requestPublish(f);
  const [command] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
  assert.equal(command.action, "publish");
  return { workerToken: completionToken, workerId, commandId: command.commandId, leaseToken: command.claim.leaseToken };
}
async function claimStage(f, auth) {
  const current = await job(f.t, f.jobId);
  const next = claimStageTransition(current, { commandId: `claim:${f.jobId}:r1:publish:1`, stage: "publish",
    leaseToken: "offline-stage-lease-distinct-from-command", leaseMs: 300000, maxAttempts: 1,
    operationBinding: null, operationsCommandId: auth.commandId }, new Date().toISOString());
  await f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId,
    workerId, commandId: auth.commandId, leaseToken: auth.leaseToken, expectedVersion: current.version, aggregate: next });
}
async function dualFence(f, auth) {
  await claimStage(f, auth);
  await f.t.mutation(ref("operations:fenceCommand"), { ...auth, leaseMs: 300000, effectMayBeIssued: true });
  const current = await job(f.t, f.jobId), attempt = current.stageAttempts.at(-1);
  const next = fenceExternalEffectTransition(current, { commandId: `effect-fence:${attempt.attemptId}:1`,
    stage: "publish", attemptId: attempt.attemptId, leaseToken: attempt.leaseToken, leaseMs: 300000, effectMayBeIssued: true }, new Date().toISOString());
  await f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId,
    workerId, commandId: auth.commandId, leaseToken: auth.leaseToken, expectedVersion: current.version, aggregate: next });
}
async function revoke(f, change = ticket => ({ ...ticket, redeemed: false })) {
  await f.t.run(async ctx => {
    const ticket = await ctx.db.query("ownerTrialTickets").withIndex("by_ticket_id", q => q.eq("ticketId", f.ticket.ticketId)).unique();
    const { _id, _creationTime, ...next } = change(ticket);
    await ctx.db.replace(ticket._id, next);
  });
}

import { signPublicationAbsenceProof } from "../../src/fulfillment/owner-trial-publication-recovery-proof.mjs";
const recoveryToken = "offline-publication-recovery-role-at-least-32-bytes";
async function failedFixture() {
  const f = await fixture(), auth = await claimPublish(f); await dualFence(f, auth);
  const current = await job(f.t, f.jobId), attempt = current.stageAttempts.at(-1);
  const failed = failStageTransition(current, { commandId: `fail:${attempt.attemptId}:publication_scope_invalid`,
    stage: "publish", leaseToken: attempt.leaseToken, reasonCode: "publication_scope_invalid", retryable: false },
    { maxAttemptsByStage: { publish: 1 } }, new Date().toISOString());
  await f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId, workerId,
    commandId: auth.commandId, leaseToken: auth.leaseToken, expectedVersion: current.version, aggregate: failed });
  await f.t.mutation(ref("operations:failCommand"), { ...auth, retryable: false, reasonCode: "canonical_provenance_missing" });
  Object.assign(process.env, { BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN: recoveryToken,
    OWNER_TRIAL_JOB_ID: f.jobId, OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID: "team_offline",
    OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID: "prj_offline", OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME: "offline-trial" });
  const binding = { jobId: f.jobId, expectedVersion: failed.version, sourceCommandId: auth.commandId,
    attemptId: attempt.attemptId, revisionId: f.policy.revisionId, artifactManifestDigest: f.policy.manifestDigest,
    idempotencyKey: attempt.idempotencyKey, teamId: "team_offline", projectId: "prj_offline", projectName: "offline-trial", origin };
  const unsigned = { schemaVersion: "1.0", kind: "owner_trial_publication_absence", binding,
    observedAt: new Date().toISOString(), census: { complete: true, pageCount: 1, deploymentCount: 1,
      digest: sha("offline-complete-census-not-live-evidence"), exactMatchCount: 0, ambiguousMatchCount: 0,
      errorCount: 0, terminalCursor: null } };
  const proof = await signPublicationAbsenceProof(unsigned, recoveryToken);
  const continuationContext = await f.t.query(ref("ownerTrialCompletionContinuation:authorizationContext"), { operatorToken, completionToken, jobId: f.jobId });
  return { ...f, auth, failed, binding, proof, continuationContext, args: { completionToken, recoveryToken, ...binding, proof } };
}
const recover = f => f.t.mutation(ref("ownerTrialPublicationRecovery:recoverPublicationAbsence"), f.args);


const grant = (f, changes = {}) => ({ operatorToken, completionToken, jobId: f.jobId,
  expectedVersion: f.failed.version, expectedBindingDigest: f.continuationContext.bindingDigest, previousReceiptId: null, ownerSourceReference: "kanban:t_4b1eb28f",
  authorizationReference: "kanban:t_4b1eb28f:completion:offline-window-1",
  expiresAt: new Date(Date.now() + 3600000).toISOString(), ...changes });
const issue = (f, args) => f.t.mutation(ref("ownerTrialCompletionContinuation:authorizeContinuation"), args);
const policyFor = f => f.t.query(ref("ownerTrial:completionPolicy"), { completionToken, jobId: f.jobId });
function expire(clock, f) { clock.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.ticket.expiresAt) + 1 }); }
const withoutContinuations = snap => { const { ownerTrialCompletionContinuations, ...rest } = snap; return rest; };
test("expired redeemed exact trial requires explicit append-only dual-role completion continuation", async clock => {
  const f = await failedFixture(); expire(clock, f);
  const before = await snapshot(f.t);
  await assert.rejects(policyFor(f), /ticket is not active/);
  const args = grant(f), result = await issue(f, args);
  assert.equal(result.issued, true);
  const after = await snapshot(f.t);
  assert.deepEqual(withoutContinuations(after), withoutContinuations(before));
  assert.equal(after.ownerTrialCompletionContinuations.length, 1);
  const policy = await policyFor(f);
  assert.equal(policy.continuationReceiptId, result.receiptId);
  assert.equal(policy.completionExpiresAt, args.expiresAt);
  assert.equal(policy.revisionId, f.policy.revisionId);
  assert.equal(await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"), { completionToken, jobId: f.jobId }), null);
  assert.equal((await issue(f, args)).issued, false);
  assert.deepEqual(await snapshot(f.t), after);
  // Continuation alone never makes an uncertain failed publication claimable.
  assert.deepEqual(await f.t.mutation(ref("operations:claimCommands"), f.claimArgs), []);
  assert.deepEqual(await snapshot(f.t), after);
  const { signature, ...unsigned } = f.proof;
  const proof = await signPublicationAbsenceProof({ ...unsigned, observedAt: new Date().toISOString() }, recoveryToken);
  assert.equal((await recover({ ...f, args: { ...f.args, proof } })).recovered, true);
  assert.equal((await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"), { completionToken, jobId: f.jobId })).maxAttempts, 2);
});

test("continuation cannot be bypassed by restoring original ticket expiry", async clock => {
  const f = await failedFixture(); expire(clock, f); await issue(f, grant(f));
  await revoke(f, ticket => ({ ...ticket, binding: { ...ticket.binding, expiresAt: new Date(Date.now() + 3600000).toISOString() } }));
  const before = await snapshot(f.t);
  await assert.rejects(policyFor(f));
  assert.deepEqual(await snapshot(f.t), before);
});

test("only dual-role owner can append a new nonoverlapping finite window; concurrent grants serialize", async clock => {
  const f = await failedFixture(); expire(clock, f);
  const original = await snapshot(f.t), firstArgs = grant(f), first = await issue(f, firstArgs);
  const firstSnapshot = await snapshot(f.t);
  await assert.rejects(issue(f, grant(f, { previousReceiptId: first.receiptId,
    authorizationReference: "kanban:t_4b1eb28f:completion:offline-window-2" })));
  clock.mock.timers.setTime(Date.parse(firstArgs.expiresAt));
  await assert.rejects(policyFor(f)); await assert.rejects(issue(f, firstArgs));
  const args = grant(f, { previousReceiptId: first.receiptId, authorizationReference: "kanban:t_4b1eb28f:completion:offline-window-2" });
  await assert.rejects(issue(f, { ...args, operatorToken: completionToken }));
  await assert.rejects(issue(f, { ...args, previousReceiptId: null }));
  assert.deepEqual(await snapshot(f.t), firstSnapshot);
  const results = await Promise.allSettled([issue(f, args), issue(f, { ...args,
    authorizationReference: "kanban:t_4b1eb28f:completion:offline-window-3" })]);
  assert.equal(results.filter(r => r.status === "fulfilled" && r.value.issued).length, 1);
  const after = await snapshot(f.t);
  assert.equal(after.ownerTrialCompletionContinuations.length, 2);
  assert.deepEqual(after.ownerTrialCompletionContinuations[0], firstSnapshot.ownerTrialCompletionContinuations[0]);
  assert.deepEqual(withoutContinuations(after), withoutContinuations(original));
  assert.notEqual((await policyFor(f)).continuationReceiptId, first.receiptId);
});

test("continuation issuance denies missing/wrong/shared owner and completion roles, stale scope and invalid windows without writes", async clock => {
  const f = await failedFixture(); expire(clock, f); const args = grant(f), before = await snapshot(f.t);
  for (const change of [{ operatorToken: undefined }, { completionToken: undefined }, { operatorToken: "wrong-owner" },
    { operatorToken: completionToken }, { completionToken: operatorToken }, { completionToken: recoveryToken },
    { jobId: `job_owner_trial_${"f".repeat(32)}` }, { jobId: "job_ordinary" },
    { expectedVersion: f.failed.version - 1 }, { ownerSourceReference: "kanban:other" },
    { previousReceiptId: `continuation_${"f".repeat(24)}` }, { authorizationReference: "unbound" },
    { expiresAt: new Date(Date.now()).toISOString() }, { expiresAt: new Date(Date.now() + 86400001).toISOString() },
    { expiresAt: "2026-10-05" }, { scopes: ["generate"] }, { providerAbsent: true }, { ownerAuthorized: true },
  ]) { await assert.rejects(issue(f, { ...args, ...change })); assert.deepEqual(await snapshot(f.t), before); }
  for (const name of ["BEBEBONJOUR_OPERATIONS_WORKER_TOKEN", "BEBEBONJOUR_APPROVAL_HMAC_KEY",
    "BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN", "OWNER_TRIAL_INVOKE_SECRET"]) {
    const old = process.env[name]; process.env[name] = operatorToken;
    try { await assert.rejects(issue(f, args)); } finally { old === undefined ? delete process.env[name] : process.env[name] = old; }
    assert.deepEqual(await snapshot(f.t), before);
  }
  const pin = process.env.OWNER_TRIAL_JOB_ID; delete process.env.OWNER_TRIAL_JOB_ID;
  try { await assert.rejects(issue(f, args)); } finally { process.env.OWNER_TRIAL_JOB_ID = pin; }
  assert.deepEqual(await snapshot(f.t), before);
});

test("active ordinary ticket behavior unchanged and continuation cannot revive generation/narration or acceptance", async clock => {
  const f = await failedFixture();
  assert.deepEqual(await policyFor(f), f.policy); await assert.rejects(issue(f, grant(f)));
  expire(clock, f); await issue(f, grant(f)); const before = await snapshot(f.t);
  for (const actions of [["generate"], ["generate_narration"], ["approve_content"], ["approve_narration"], ["render"], ["reconcile"]]) {
    await assert.rejects(f.t.mutation(ref("operations:claimCommands"), { ...f.claimArgs, actions }));
    assert.deepEqual(await snapshot(f.t), before);
  }
  await assert.rejects(f.t.action(ref("ownerTrialRuntime:redeemTicket"), { operatorToken,
    jobId: f.jobId, recipient: "z@havesomecode.io", ticketSecret: f.ticket.ticketSecret }));
  assert.deepEqual(await snapshot(f.t), before);
});

for (const mode of ["unredeemed", "ticketDigest", "ticketExpiry", "intake", "revision", "artifact", "review", "reviewReceipt", "approvalSignature",
  "recipient", "origin", "payment", "policy", "generationHistory", "continuationSignature", "continuationScope", "continuationSequence", "continuationDuplicate"]) {
  test(`exact continuation rejects ${mode} drift without writes`, async clock => {
    const f = await failedFixture(); expire(clock, f); const args = grant(f); await issue(f, args);
    await f.t.run(async ctx => {
      const get = (table, index, field, value) => ctx.db.query(table).withIndex(index, q => q.eq(field, value)).unique();
      if (["unredeemed", "ticketDigest", "ticketExpiry"].includes(mode)) {
        const row = await get("ownerTrialTickets", "by_ticket_id", "ticketId", f.ticket.ticketId);
        await ctx.db.patch(row._id, mode === "unredeemed" ? { redeemed: false } : mode === "ticketDigest" ? { ticketDigest: "0".repeat(64) }
          : { binding: { ...row.binding, expiresAt: new Date(Date.parse(row.binding.expiresAt) - 1).toISOString() } });
      } else if (mode === "intake") {
        const row = await get("customerFlowJobs", "by_job_id", "jobId", f.jobId);
        const customer = structuredClone(row.job); customer.intake.notes.specificDemands += " changed";
        await ctx.db.patch(row._id, { job: customer });
      } else if (mode === "reviewReceipt") {
        const row = await ctx.db.query("ownerTrialReviews").withIndex("by_job_type", q => q.eq("jobId", f.jobId).eq("decisionType", "content")).unique();
        await ctx.db.patch(row._id, { receipt: { ...row.receipt, binding: { ...row.receipt.binding, evidenceDigest: "0".repeat(64) } } });
      } else if (mode === "approvalSignature") {
        const row = await get("fulfillmentReviewApprovals", "by_approval_id", "approvalId", f.policy.contentApprovalId);
        await ctx.db.patch(row._id, { approval: { ...row.approval, signature: "0".repeat(64) } });
      } else if (mode.startsWith("continuation")) {
        const row = await ctx.db.query("ownerTrialCompletionContinuations").withIndex("by_job_id", q => q.eq("jobId", f.jobId)).unique();
        const receipt = structuredClone(row.receipt);
        if (mode === "continuationDuplicate") await ctx.db.insert("ownerTrialCompletionContinuations", { jobId: f.jobId, receipt });
        else {
          if (mode === "continuationSignature") receipt.signature = "0".repeat(64);
          if (mode === "continuationSequence") receipt.sequence++;
          if (mode === "continuationScope") receipt.binding.actions.push("generate");
          await ctx.db.patch(row._id, { receipt });
        }
      } else if (mode === "policy") process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID = "prj_changed";
      else {
        const row = await get("fulfillmentJobs", "by_job_id", "jobId", f.jobId), aggregate = structuredClone(row.aggregate);
        if (mode === "revision") aggregate.currentRevisionId = "r2";
        if (mode === "artifact") aggregate.artifactSets[0].files[0].sha256 = "0".repeat(64);
        if (mode === "review") aggregate.reviewDecisions[0].reasons.push("changed");
        if (mode === "recipient") aggregate.ownerTrialAuthority.recipient = "someone@example.invalid";
        if (mode === "origin") aggregate.ownerTrialAuthority.origin = "https://other.example.invalid";
        if (mode === "payment") aggregate.payment = { status: "paid" };
        if (mode === "generationHistory") aggregate.stageAttempts[0].status = "running";
        await ctx.db.patch(row._id, { aggregate });
      }
    });
    const before = await snapshot(f.t);
    await assert.rejects(policyFor(f)); await assert.rejects(issue(f, args));
    await assert.rejects(f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"), { completionToken, jobId: f.jobId }));
    assert.deepEqual(await snapshot(f.t), before);
    process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID = "prj_offline";
  });
}

test("owner authorization pins the inspected binding before first issuance, rejecting pre-grant drift", async clock => {
  const f = await failedFixture(); expire(clock, f);
  const context = await f.t.query(ref("ownerTrialCompletionContinuation:authorizationContext"), { operatorToken, completionToken, jobId: f.jobId });
  await patchJob(f.t, f.jobId, job => ({ ...job, revisions: job.revisions.map(r => ({ ...r, createdAt: new Date(Date.parse(r.createdAt) + 1).toISOString() })) }));
  const before = await snapshot(f.t);
  await assert.rejects(issue(f, grant(f, { expectedBindingDigest: context.bindingDigest })));
  assert.deepEqual(await snapshot(f.t), before);
});

import { runOwnerTrialCompletionWorkerCommand } from "../../src/operations/owner-trial-completion-worker.mjs";
test("expired-ticket continuation drives real worker dual fences, fresh recovery after every failed attempt, then exact owner-only delivery", async clock => {
  const f = await failedFixture(); expire(clock, f); const args = grant(f); await issue(f, args);
  const immutable = await snapshot(f.t), calls = { publishes: 0, sends: [] };
  const client = Object.fromEntries(["query", "mutation", "action"].map(k => [k, (name, input) => f.t[k](ref(name), input)]));
  const options = { client, jobId: f.jobId,
    publicationProvider: { reconcile: async () => null, publish: async req => {
      calls.publishes++;
      if (calls.publishes === 1) throw new Error("Synthetic absent effect failure; not live evidence.");
      return req.fenceExternalEffect({ effectMayBeIssued: true }, async () => ({ provider: "vercel", providerReceiptId: "offline-continuation-publication",
        revisionId: f.policy.revisionId, stableUrl: `${origin}/announcements/${f.jobId}`, artifactManifestDigest: f.policy.manifestDigest,
        idempotencyKey: req.idempotencyKey }));
    } },
    resend: { emails: { send: async (input, opts) => { calls.sends.push({ input, opts }); return { data: { id: "offline-continuation-resend" } }; } } },
    environment: { CONVEX_URL: "https://offline-fixture.convex.cloud", BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: completionToken,
      BEBEBONJOUR_APPROVAL_HMAC_KEY: hmacKey, OWNER_TRIAL_VERCEL_BUILD_INSPECTION_B64: Buffer.from(JSON.stringify({ schemaVersion: "1.0",
        revisionId: "r1", teamId: "team_offline", projectId: "prj_offline", projectName: "offline-trial", framework: null,
        buildCommand: null, devCommand: null, installCommand: null, outputDirectory: null })).toString("base64"),
      OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID: "team_offline", OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID: "prj_offline",
      OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME: "offline-trial", VERCEL_TOKEN: "offline-labelled-vercel",
      RESEND_API_KEY: "offline-labelled-resend", OWNER_TRIAL_RESEND_FROM: "Trial <trial@example.invalid>" } };
  for (const ordinal of [1, 2]) {
    const current = await job(f.t, f.jobId), attempt = current.stageAttempts.at(-1);
    const binding = { ...f.binding, expectedVersion: current.version, attemptId: attempt.attemptId };
    if (ordinal === 2) {
      assert.equal(current.state, "reconciliation_required");
      assert.equal((await runOwnerTrialCompletionWorkerCommand(options)).claimed, 0);
      assert.equal(calls.publishes, 1);
      await assert.rejects(recover({ ...f, args: { ...f.args, ...binding } }));
    }
    const { signature, ...unsigned } = f.proof;
    const proof = await signPublicationAbsenceProof({ ...unsigned, binding, observedAt: new Date().toISOString(),
      census: { ...unsigned.census, digest: sha(`offline-window-attempt-${ordinal}`) } }, recoveryToken);
    await recover({ ...f, args: { ...f.args, ...binding, proof } });
    const output = await runOwnerTrialCompletionWorkerCommand(options);
    assert.equal(output.claimed, 1);
    assert.equal((await job(f.t, f.jobId)).state, ordinal === 1 ? "reconciliation_required" : "published", JSON.stringify(output));
  }
  for (const action of ["queue_delivery", "deliver"]) {
    const current = await job(f.t, f.jobId);
    await f.t.mutation(ref("operations:requestCommand"), { operatorToken, jobId: f.jobId, commandId: `command_offline_continuation_${action}`,
      action, expectedState: current.state, expectedVersion: current.version, payload: { revisionId: f.policy.revisionId,
        artifactManifestDigest: f.policy.manifestDigest, publicationId: current.publication.providerReceiptId } });
    const output = await runOwnerTrialCompletionWorkerCommand(options); assert.equal(output.completed, 1, JSON.stringify(output));
  }
  const sent = await job(f.t, f.jobId); assert.equal(sent.state, "sent");
  assert.equal(calls.publishes, 2); assert.equal(calls.sends.length, 1);
  assert.deepEqual(calls.sends[0].input.to, ["z@havesomecode.io"]);
  assert.equal(calls.sends[0].input.cc, undefined); assert.equal(calls.sends[0].input.bcc, undefined);
  assert.equal(sent.deliveryAttempts[0].deliveredAt, null);
  const after = await snapshot(f.t);
  for (const table of ["ownerTrialTickets", "ownerTrialReviews", "fulfillmentReviewApprovals", "fulfillmentGenerationEditorialApprovals", "customerFlowJobs", "ownerTrialCompletionContinuations"]) {
    assert.deepEqual(after[table], immutable[table]);
  }
  assert.equal(after.ownerTrialPublicationRecoveries.length, 2);
  assert.equal((await issue(f, args)).issued, false); assert.deepEqual(await snapshot(f.t), after);
  clock.mock.timers.setTime(Date.parse(args.expiresAt));
  await assert.rejects(runOwnerTrialCompletionWorkerCommand(options));
  assert.equal(calls.publishes, 2); assert.equal(calls.sends.length, 1); assert.deepEqual(await snapshot(f.t), after);
});

test("identical concurrent issuance is inert and changed replay does not write", async clock => {
  const f = await failedFixture(); expire(clock, f); const args = grant(f, { expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const results = await Promise.all([issue(f, args), issue(f, args)]);
  assert.equal(results.filter(r => r.issued).length, 1); const before = await snapshot(f.t);
  await assert.rejects(issue(f, { ...args, expiresAt: new Date(Date.parse(args.expiresAt) - 1).toISOString() }));
  assert.deepEqual(await snapshot(f.t), before);
});
for (const state of ["pending", "running"]) {
  test(`continuation issuance rejects ${state} canonical command without touching it`, async clock => {
    const f = await failedFixture(); expire(clock, f);
    await f.t.run(async ctx => {
      const row = await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id", q => q.eq("commandId", f.binding.sourceCommandId)).unique();
      await ctx.db.patch(row._id, { state });
    });
    const before = await snapshot(f.t); await assert.rejects(issue(f, grant(f))); assert.deepEqual(await snapshot(f.t), before);
  });
}
for (const mode of ["ticket", "artifact", "policy", "reviewReceipt"]) {
  test(`first issuance rejects inspected ${mode} drift`, async clock => {
    const f = await failedFixture(); expire(clock, f); const args = grant(f);
    if (mode === "ticket") await revoke(f, t => ({ ...t, ticketDigest: "0".repeat(64) }));
    if (mode === "artifact") await patchJob(f.t, f.jobId, j => ({ ...j, artifactSets: j.artifactSets.map((a, i) => i ? a : { ...a, artifactSetId: "changed" }) }));
    if (mode === "policy") process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID = "prj_changed";
    if (mode === "reviewReceipt") await f.t.run(async ctx => {
      const row = await ctx.db.query("ownerTrialReviews").withIndex("by_job_type", q => q.eq("jobId", f.jobId).eq("decisionType", "content")).unique();
      await ctx.db.patch(row._id, { receipt: { ...row.receipt, binding: { ...row.receipt.binding, evidenceDigest: "0".repeat(64) } } });
    });
    const before = await snapshot(f.t); await assert.rejects(issue(f, args)); assert.deepEqual(await snapshot(f.t), before);
    process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID = "prj_offline";
  });
}
