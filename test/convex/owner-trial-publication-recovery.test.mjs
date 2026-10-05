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
const modules = Object.fromEntries(["ownerTrial", "ownerTrialRuntime", "ownerTrialCompletion", "ownerTrialPublicationSupersession", "ownerTrialCompletionContinuation", "ownerTrialPublicationRecovery", "operations", "http", "fulfillment"]
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

test("real owner trial resolver and Vercel uploads satisfy strict backend fence digests", async () => {
  const f = await fixture({ publicNarration: true }), auth = await claimPublish(f);
  await dualFence(f, auth);
  const current = await job(f.t, f.jobId), attempt = current.stageAttempts.at(-1);
  const artifactSet = current.artifactSets.find(set => set.kind === "narration_review");
  const stopBeforeDeployment = new Error("Offline test deliberately stops before deployment creation");
  let fenceNumber = 1, artifactReads = 0;
  const uploadedBodies = [], acceptedFences = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin === "https://offline-fixture.convex.site" && url.pathname === "/completion/artifact") {
      assert.equal(url.searchParams.get("jobId"), f.jobId);
      assert.equal(init.headers["x-bebebonjour-command-id"], auth.commandId);
      const file = f.files.find(file => file.storageId === url.searchParams.get("storageId"));
      assert.ok(file);
      const bytes = await f.t.run(async ctx => (await ctx.storage.get(file.storageId)).arrayBuffer());
      artifactReads += 1;
      return new Response(bytes, { headers: { "cache-control": "private, no-store", "content-type": "application/octet-stream" } });
    }
    assert.equal(url.origin, "https://api.vercel.com");
    if (url.pathname === "/v7/deployments") return Response.json({ deployments: [], pagination: { next: null } });
    if (url.pathname === "/v2/files" && init.method === "POST") {
      assert.equal(acceptedFences.at(-1).effectMayBeIssued, true);
      uploadedBodies.push(Buffer.from(init.body));
      return Response.json({});
    }
    if (url.pathname === "/v13/deployments" && init.method === "POST") throw stopBeforeDeployment;
    throw new Error(`Unexpected offline transport: ${init.method || "GET"} ${url.pathname}`);
  };
  const revalidate = () => f.t.query(ref("ownerTrial:completionPolicy"), { completionToken, jobId: f.jobId });
  const resolver = createOwnerTrialPublicArtifactResolver({ policy: f.policy, token: completionToken,
    siteOrigin: "https://offline-fixture.convex.site", fetch, revalidate });
  const inspection = parseAuthoritativeVercelBuildInspection(Buffer.from(JSON.stringify({
    schemaVersion: "1.0", source: "vercel inspect --format=json", deploymentId: "dpl_offline_bootstrap",
    buildId: "build_offline_fixture", teamId: "team_offline", projectId: "prj_offline",
    projectName: "offline-trial", revisionId: "r1",
  })));
  const provider = createVercelTestAPublicationProvider({ token: "offline-vercel-test-token-not-credentials",
    buildInspection: inspection, stableOrigin: origin, canaryJobId: f.jobId,
    artifactResolver: resolver, fetch, requirePrivateDeploymentProtection: false });
  const request = { jobId: f.jobId, environment: "test", product: "announcement-page", revisionId: "r1",
    artifactSet, artifactSetId: artifactSet.artifactSetId, artifactManifestDigest: f.policy.manifestDigest,
    idempotencyKey: attempt.idempotencyKey, artifactReadAuthority: { workerId, commandId: auth.commandId, leaseToken: auth.leaseToken },
    async fenceExternalEffect(fence, invoke) {
      // The operations effect fence is established once by dualFence; each provider call fences the stage.
      const before = await job(f.t, f.jobId), running = before.stageAttempts.at(-1);
      const next = fenceExternalEffectTransition(before, { commandId: `effect-fence:${running.attemptId}:${++fenceNumber}`,
        stage: "publish", attemptId: running.attemptId, leaseToken: running.leaseToken, leaseMs: 300000, ...fence }, new Date().toISOString());
      await f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId,
        workerId, commandId: auth.commandId, leaseToken: auth.leaseToken, expectedVersion: before.version, aggregate: next });
      acceptedFences.push(fence);
      return invoke();
    },
  };
  await assert.rejects(() => provider.publish(request), error => error === stopBeforeDeployment || error.cause === stopBeforeDeployment);
  assert.equal(artifactReads, 2);
  assert.equal(uploadedBodies.length, 4);
  assert.ok(acceptedFences.every(fence => fence.effectMayBeIssued === true));
  assert.ok(uploadedBodies.some(bytes => bytes.includes(Buffer.from('content="noindex, nofollow, noarchive"'))));
  assert.ok(uploadedBodies.every(bytes => !bytes.includes(Buffer.from("offline-private-fixture-not-public"))));
  assert.equal((await job(f.t, f.jobId)).publication, null);
});
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
  return { ...f, auth, failed, binding, proof, args: { completionToken, recoveryToken, ...binding, proof } };
}
const recover = f => f.t.mutation(ref("ownerTrialPublicationRecovery:recoverPublicationAbsence"), f.args);

test("offline proof recovery preserves history and rebases the same failed command once", async () => {
  const f = await failedFixture(), before = await snapshot(f.t);
  const result = await recover(f), recovered = await job(f.t, f.jobId);
  assert.equal(result.recovered, true); assert.equal(recovered.state, "publish_ready");
  assert.equal(recovered.version, f.failed.version + 1);
  assert.deepEqual(recovered.stageAttempts, f.failed.stageAttempts.map(a => a.attemptId === f.binding.attemptId
    ? { ...a, status: "reconciled_absent" } : a));
  assert.deepEqual(recovered.events.slice(0, -1), f.failed.events);
  const after = await snapshot(f.t), original = before.customerFlowOperationsCommands[0], command = after.customerFlowOperationsCommands[0];
  assert.equal(command.commandId, original.commandId); assert.equal(command.attempts, 1);
  assert.equal(command.state, "pending"); assert.equal(command.expectedVersion, recovered.version);
  assert.deepEqual(command.payload, original.payload); assert.equal(command.lastFailureReason, original.lastFailureReason);
  assert.equal(after.ownerTrialPublicationRecoveries.length, 1);
  const replay = await recover(f); assert.equal(replay.recovered, false); assert.deepEqual(await snapshot(f.t), after);
});
import { createOwnerTrialCompletionCapabilities } from "../../src/fulfillment/owner-trial-completion-capabilities.mjs";
async function capabilities(f, trace, { failPublication = false } = {}) {
  const client = { query: (name, args) => f.t.query(ref(name), args), mutation: (name, args) => f.t.mutation(ref(name), args) };
  return createOwnerTrialCompletionCapabilities({ client, policy: f.policy,
    environment: { BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: completionToken,
      CONVEX_URL: "https://offline-fixture.convex.cloud", OWNER_TRIAL_RESEND_FROM: "trial@example.invalid" },
    resend: { emails: { send() { throw new Error("Offline publication fixture must not deliver"); } } },
    publicationProvider: {
      async reconcile(request) { trace.push(["reconcile", request]); return null; },
      async publish(request) { trace.push(["publish", request]);
        if (failPublication) throw new Error("Offline absent publication failure; requires a new signed census before retry");
        return { provider: "vercel", revisionId: request.revisionId,
        artifactManifestDigest: request.artifactManifestDigest, idempotencyKey: request.idempotencyKey,
        providerReceiptId: "offline-publication-only-not-live-evidence", stableUrl: `${origin}/announcements/${f.jobId}` }; },
    } });
}
test("offline trusted recovery reaches reconcile then publication through real command and backend second claim", async () => {
  const f = await failedFixture(); await recover(f);
  const [command] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
  assert.equal(command.commandId, f.binding.sourceCommandId); assert.equal(command.attempts, 2);
  const trace = [], cap = await capabilities(f, trace);
  const authority = { workerId, commandId: command.commandId, leaseToken: command.claim.leaseToken };
  await cap.fulfillmentOrchestrator.runExpectedStage(f.jobId, "publish", { operationsCommandId: command.commandId,
    workerAuthority: authority, operationsEffectBoundary: async (_, invoke) => {
      await f.t.mutation(ref("operations:fenceCommand"), { workerToken: completionToken, ...authority, leaseMs: 300000, effectMayBeIssued: true });
      return invoke();
    } });
  const after = await job(f.t, f.jobId);
  assert.equal(after.state, "published"); assert.deepEqual(trace.map(([m]) => m), ["reconcile", "publish"]);
  assert.equal(trace[1][1].reconciliationOnly, false); assert.equal(trace[1][1].idempotencyKey, f.binding.idempotencyKey);
  assert.equal(after.stageAttempts.at(-1).attemptNumber, 2);
  assert.deepEqual(after.stageAttempts.slice(0, -1), f.failed.stageAttempts.map(a => a.attemptId === f.binding.attemptId ? { ...a, status: "reconciled_absent" } : a));
  const beforeReplay = await snapshot(f.t); assert.equal((await recover(f)).recovered, false);
  assert.deepEqual(await snapshot(f.t), beforeReplay);
  const current = await job(f.t, f.jobId);
  const forged = { ...current, state: "publish_ready", publication: null };
  const third = claimStageTransition(forged, { commandId: `claim:${f.jobId}:r1:publish:3`, stage: "publish", leaseToken: "offline-third-stage-lease",
    leaseMs: 300000, maxAttempts: 3, operationBinding: null, operationsCommandId: command.commandId }, new Date().toISOString());
  // Offline adversarial aggregate input; real replaceJob must reject before any write.
  await patchJob(f.t, f.jobId, () => forged); const denied = await snapshot(f.t);
  await assert.rejects(f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId, ...authority,
    expectedVersion: current.version, aggregate: third })); assert.deepEqual(await snapshot(f.t), denied);
});

test("offline fresh proof rejects role, job/provider/release/version drift, stale/future, partial/error/matched census with zero writes", async () => {
  const f = await failedFixture(), before = await snapshot(f.t);
  for (const change of [
    { completionToken: recoveryToken }, { recoveryToken: completionToken },
    { jobId: `job_owner_trial_${"f".repeat(32)}` }, { expectedVersion: f.binding.expectedVersion - 1 },
    { sourceCommandId: "command_offline_other_publication" }, { attemptId: `attempt_${"f".repeat(24)}` },
    { revisionId: "r2" }, { artifactManifestDigest: "f".repeat(64) }, { idempotencyKey: `bb_${"f".repeat(64)}` },
    { teamId: "team_other" }, { projectId: "prj_other" }, { projectName: "other" }, { origin: "https://other.example.invalid" },
  ]) {
    await assert.rejects(f.t.mutation(ref("ownerTrialPublicationRecovery:recoverPublicationAbsence"), { ...f.args, ...change }));
    assert.deepEqual(await snapshot(f.t), before);
  }
  for (const change of [ { observedAt: new Date(Date.now() - 61000).toISOString() },
    { observedAt: new Date(Date.now() + 60000).toISOString() }, { schemaVersion: "2.0" },
    ...[{ complete: false }, { pageCount: 0 }, { deploymentCount: -1 }, { terminalCursor: "more" },
      { digest: "broken" }, { exactMatchCount: 1 }, { ambiguousMatchCount: 1 }, { errorCount: 1 }].map(c => ({ census: { ...f.proof.census, ...c } })),
  ]) {
    const { signature, ...unsigned } = f.proof; const proof = await signPublicationAbsenceProof({ ...unsigned, ...change }, recoveryToken);
    await assert.rejects(f.t.mutation(ref("ownerTrialPublicationRecovery:recoverPublicationAbsence"), { ...f.args, proof }));
    assert.deepEqual(await snapshot(f.t), before);
  }
  await assert.rejects(f.t.mutation(ref("ownerTrialPublicationRecovery:recoverPublicationAbsence"), { ...f.args, proof: { ...f.proof, signature: "0".repeat(64) } }));
  assert.deepEqual(await snapshot(f.t), before);
  for (const name of ["OWNER_TRIAL_JOB_ID", "OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME"]) {
    const old = process.env[name]; delete process.env[name];
    try { await assert.rejects(recover(f)); } finally { process.env[name] = old; }
    assert.deepEqual(await snapshot(f.t), before);
  }
  for (const name of ["BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_APPROVAL_HMAC_KEY", "OWNER_TRIAL_INVOKE_SECRET", "BEBEBONJOUR_OPERATIONS_TOKEN"]) {
    const old = process.env[name]; process.env[name] = recoveryToken;
    try { await assert.rejects(recover(f)); } finally { old === undefined ? delete process.env[name] : process.env[name] = old; }
    assert.deepEqual(await snapshot(f.t), before);
  }
});

test("offline duplicate concurrent recovery is atomic; altered receipt replay cannot write", async () => {
  const f = await failedFixture();
  const results = await Promise.allSettled([recover(f), recover(f)]);
  const after = await snapshot(f.t);
  assert.equal(after.ownerTrialPublicationRecoveries.length, 1); assert.equal((await job(f.t, f.jobId)).version, f.failed.version + 1);
  assert.equal(results.filter(r => r.status === "fulfilled" && r.value.recovered).length, 1);
  assert.equal((await recover(f)).recovered, false);
  const { signature, ...unsigned } = f.proof;
  const changed = await signPublicationAbsenceProof({ ...unsigned, census: { ...unsigned.census, digest: sha("another-census") } }, recoveryToken);
  await assert.rejects(f.t.mutation(ref("ownerTrialPublicationRecovery:recoverPublicationAbsence"), { ...f.args, proof: changed }), /replay changed/);
  assert.deepEqual(await snapshot(f.t), after);
});

test("offline revoked or unauthentic delegated approvals cannot authorize recovery", async () => {
  for (const mode of ["revoked", "signature"]) {
    const f = await failedFixture();
    if (mode === "revoked") await revoke(f);
    else await f.t.run(async ctx => {
      const doc = await ctx.db.query("fulfillmentReviewApprovals").withIndex("by_approval_id", q => q.eq("approvalId", f.policy.contentApprovalId)).unique();
      await ctx.db.patch(doc._id, { approval: { ...doc.approval, signature: "0".repeat(64) } });
    });
    const before = await snapshot(f.t); await assert.rejects(recover(f)); assert.deepEqual(await snapshot(f.t), before);
  }
});
import { createFulfillmentOrchestrator } from "../../src/fulfillment/job-orchestrator.mjs";
import { createExternalEffectStageHandlers } from "../../src/fulfillment/external-effect-stage-handlers.mjs";
import { completeStageTransition } from "../../src/fulfillment/job-machine.mjs";
test("offline forged rebase/status/event does not permit a second claim without a stored receipt", async () => {
  const f = await failedFixture();
  const forged = { ...f.failed, state: "publish_ready", stageAttempts: f.failed.stageAttempts.map(a =>
    a.attemptId === f.binding.attemptId ? { ...a, status: "reconciled_absent" } : a),
    events: [...f.failed.events, { eventId: "event_offline_forged", commandId: "offline_forged_receipt_event", commandDigest: sha("forged"),
      type: "owner_trial_publication_absence_recovered", at: new Date().toISOString(), state: "publish_ready" }] };
  await patchJob(f.t, f.jobId, () => forged);
  await f.t.run(async ctx => {
    const doc = await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id", q => q.eq("commandId", f.binding.sourceCommandId)).unique();
    await ctx.db.patch(doc._id, { state: "pending", expectedVersion: forged.version });
  });
  const [command] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
  assert.equal(await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"), { completionToken, jobId: f.jobId }), null);
  for (const maxAttempts of [2, 3]) {
    const next = claimStageTransition(forged, { commandId: `claim:${f.jobId}:r1:publish:2`, stage: "publish", leaseToken: "offline-forged-stage-lease",
      leaseMs: 300000, maxAttempts, operationBinding: null, operationsCommandId: command.commandId }, new Date().toISOString());
    const before = await snapshot(f.t);
    await assert.rejects(f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId, workerId,
      commandId: command.commandId, leaseToken: command.claim.leaseToken, expectedVersion: forged.version, aggregate: next }));
    assert.deepEqual(await snapshot(f.t), before);
  }
});

test("offline orchestrator retains reconciliationOnly for arbitrary reconciled_absent history without backend allowance", async () => {
  const f = await failedFixture(); let current = { ...f.failed, state: "publish_ready", stageAttempts: f.failed.stageAttempts.map(a =>
    a.attemptId === f.binding.attemptId ? { ...a, status: "reconciled_absent" } : a) };
  let reconcileCalls = 0, publishCalls = 0;
  const handlers = createExternalEffectStageHandlers({ publicationAdapter: {
    async reconcile(request) { reconcileCalls++; assert.equal(request.reconciliationOnly, true); return null; },
    async publish() { publishCalls++; throw new Error("Unproven history must never publish"); },
  }, deliveryAdapter: { async reconcile() {}, async send() {}, async status() {} }, resolveDeliveryTarget: async () => ({}) });
  const store = { getJob: async () => structuredClone(current),
    async claimStage(_, args, at) { current = claimStageTransition(current, args, at); return { acquired: true, aggregate: structuredClone(current) }; },
    async failStage(_, args, policy, at) { current = failStageTransition(current, args, policy, at); return structuredClone(current); },
    async fenceExternalEffect(_, args, at) { current = fenceExternalEffectTransition(current, args, at); return structuredClone(current); },
    async completeStage(_, args, at) { current = completeStageTransition(current, args, at); return structuredClone(current); } };
  const orchestrator = createFulfillmentOrchestrator({ store, handlers, clock: () => new Date().toISOString(), tokenFactory: () => "offline-local-stage-lease",
    retryPolicy: { leaseMsByStage: { publish: 300000 }, maxAttemptsByStage: { publish: 2 }, backoffMsByStage: { publish: [60000] } } });
  await orchestrator.runExpectedStage(f.jobId, "publish", { operationsCommandId: f.binding.sourceCommandId });
  assert.equal(reconcileCalls, 1); assert.equal(publishCalls, 0); assert.equal(current.state, "reconciliation_required");
});

async function freshRecovery(f) {
  const current = await job(f.t, f.jobId), attempt = current.stageAttempts.at(-1);
  const binding = { ...f.binding, expectedVersion: current.version, attemptId: attempt.attemptId };
  const proof = await signPublicationAbsenceProof({ schemaVersion: "1.0", kind: "owner_trial_publication_absence", binding,
    observedAt: new Date().toISOString(), census: { ...f.proof.census,
      digest: sha(`offline-fresh-complete-census-for-attempt-${attempt.attemptNumber}-not-live-evidence`) } }, recoveryToken);
  return { ...f, binding, proof, args: { completionToken, recoveryToken, ...binding, proof } };
}
async function runRecoveredPublication(f, failPublication) {
  const [command] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
  assert.equal(command.commandId, f.binding.sourceCommandId);
  const trace = [], cap = await capabilities(f, trace, { failPublication });
  const authority = { workerId, commandId: command.commandId, leaseToken: command.claim.leaseToken };
  const result = await cap.fulfillmentOrchestrator.runExpectedStage(f.jobId, "publish", {
    operationsCommandId: command.commandId, workerAuthority: authority,
    operationsEffectBoundary: async (_, invoke) => {
      await f.t.mutation(ref("operations:fenceCommand"), { workerToken: completionToken, ...authority,
        leaseMs: 300000, effectMayBeIssued: true });
      return invoke();
    } });
  assert.deepEqual(trace.map(([method]) => method), ["reconcile", "publish"]);
  assert.equal(trace[1][1].reconciliationOnly, false);
  assert.equal(trace[1][1].idempotencyKey, f.binding.idempotencyKey);
  if (failPublication) await f.t.mutation(ref("operations:failCommand"), { workerToken: completionToken, ...authority,
    retryable: false, reasonCode: "canonical_provenance_missing" });
  return { command, authority, result };
}
for (const absentFailures of [2, 4]) {
  test(`offline iterative real Convex/command/orchestrator seam recovers ${absentFailures} successive absent failures then publishes`, async () => {
    const f = await failedFixture(), original = await snapshot(f.t), requests = [f];
    let firstReceipt;
    for (let ordinal = 1; ordinal <= absentFailures; ordinal++) {
      const request = ordinal === 1 ? f : await freshRecovery(f);
      if (ordinal > 1) requests.push(request);
      const before = await job(f.t, f.jobId);
      assert.equal(before.stageAttempts.at(-1).attemptNumber, ordinal);
      assert.equal((await recover(request)).recovered, true);
      const recovered = await snapshot(f.t);
      if (ordinal === 1) firstReceipt = JSON.stringify(recovered.ownerTrialPublicationRecoveries[0]);
      assert.equal(JSON.stringify(recovered.ownerTrialPublicationRecoveries[0]), firstReceipt);
      assert.equal(recovered.ownerTrialPublicationRecoveries.length, ordinal);
      const allowance = await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"), { completionToken, jobId: f.jobId });
      assert.equal(allowance.maxAttempts, ordinal + 1);
      assert.deepEqual(allowance.reconciledAttemptIds, before.stageAttempts.filter(a => a.stage === "publish").map(a => a.attemptId));
      for (const old of requests) {
        assert.equal((await recover(old)).recovered, false);
        assert.deepEqual(await snapshot(f.t), recovered);
      }
      await runRecoveredPublication(f, ordinal < absentFailures);
      const after = await job(f.t, f.jobId);
      assert.equal(after.stageAttempts.at(-1).attemptNumber, ordinal + 1);
      assert.equal(after.state, ordinal < absentFailures ? "reconciliation_required" : "published");
      assert.deepEqual(after.stageAttempts.slice(0, -1), before.stageAttempts.map(a => a.attemptId === request.binding.attemptId
        ? { ...a, status: "reconciled_absent" } : a));
      assert.deepEqual(after.artifactSets, f.failed.artifactSets);
      assert.deepEqual(after.events.slice(0, before.events.length), before.events);
      const progressed = await snapshot(f.t);
      for (const old of requests) {
        assert.equal((await recover(old)).recovered, false);
        assert.deepEqual(await snapshot(f.t), progressed);
      }
    }
    const after = await snapshot(f.t), command = after.customerFlowOperationsCommands[0];
    assert.equal(command.commandId, original.customerFlowOperationsCommands[0].commandId);
    assert.deepEqual(command.payload, original.customerFlowOperationsCommands[0].payload);
    assert.equal(command.requestedAt, original.customerFlowOperationsCommands[0].requestedAt);
    assert.equal(command.requestedBy, original.customerFlowOperationsCommands[0].requestedBy);
    assert.equal(command.attempts, absentFailures + 1);
    assert.equal(JSON.stringify(after.ownerTrialPublicationRecoveries[0]), firstReceipt);
  });
}

test("offline second recovery needs its own fresh complete proof and remains atomic under concurrent requests", async () => {
  const f = await failedFixture(); await recover(f); await runRecoveredPublication(f, true);
  const fresh = await freshRecovery(f), before = await snapshot(f.t);
  for (const old of [f, { ...fresh, args: { ...fresh.args, proof: f.proof } }]) {
    if (old === f) assert.equal((await recover(old)).recovered, false);
    else await assert.rejects(recover(old));
    assert.deepEqual(await snapshot(f.t), before);
  }
  for (const change of [{ observedAt: new Date(Date.now() - 61000).toISOString() },
    { observedAt: new Date(Date.parse(fresh.proof.observedAt) + 60000).toISOString() },
    ...[{ complete: false }, { terminalCursor: "more" }, { exactMatchCount: 1 }, { ambiguousMatchCount: 1 }, { errorCount: 1 }]
      .map(c => ({ census: { ...fresh.proof.census, ...c } })),
  ]) {
    const { signature, ...unsigned } = fresh.proof;
    const proof = await signPublicationAbsenceProof({ ...unsigned, ...change }, recoveryToken);
    await assert.rejects(recover({ ...fresh, args: { ...fresh.args, proof } }));
    assert.deepEqual(await snapshot(f.t), before);
  }
  for (const change of [{ completionToken: recoveryToken }, { recoveryToken: completionToken },
    { expectedVersion: fresh.binding.expectedVersion - 1 }, { attemptId: f.binding.attemptId },
    { sourceCommandId: "command_offline_other_publication" }, { teamId: "team_other" },
    { projectId: "prj_other" }, { projectName: "other" }, { origin: "https://other.example.invalid" },
    { revisionId: "r2" }, { idempotencyKey: `bb_${"f".repeat(64)}` }]) {
    await assert.rejects(recover({ ...fresh, args: { ...fresh.args, ...change } }));
    assert.deepEqual(await snapshot(f.t), before);
  }
  const { signature, ...unsigned } = fresh.proof;
  const different = await signPublicationAbsenceProof({ ...unsigned, census: { ...unsigned.census, digest: sha("offline-second-independent-census") } }, recoveryToken);
  const results = await Promise.allSettled([recover(fresh), recover({ ...fresh, args: { ...fresh.args, proof: different } })]);
  const after = await snapshot(f.t);
  assert.equal(results.filter(r => r.status === "fulfilled" && r.value.recovered).length, 1);
  assert.equal(after.ownerTrialPublicationRecoveries.length, 2);
  assert.equal((await job(f.t, f.jobId)).version, fresh.binding.expectedVersion + 1);
  assert.equal(JSON.stringify(after.ownerTrialPublicationRecoveries[0]), JSON.stringify(before.ownerTrialPublicationRecoveries[0]));
  const loser = results[0].status === "fulfilled" ? { ...fresh, args: { ...fresh.args, proof: different } } : fresh;
  await assert.rejects(recover(loser), /replay changed/); assert.deepEqual(await snapshot(f.t), after);
});

test("offline iterative receipt gaps, duplicates, ordinal/version/proof/event/source tampering reject without writes", async () => {
  for (const mode of ["gap", "duplicate", "ordinal", "historical_counter", "historical_version", "recovered_version",
    "proof", "event", "historical_effect", "attempt_duplicate", "latest_counter", "latest_version", "source_identity", "source_payload", "provider_drift"]) {
    const f = await failedFixture(); await recover(f); await runRecoveredPublication(f, true);
    const second = await freshRecovery(f); await recover(second); await runRecoveredPublication(f, true);
    const third = await freshRecovery(f);
    await f.t.run(async ctx => {
      const rows = await ctx.db.query("ownerTrialPublicationRecoveries").withIndex("by_job_revision", q => q.eq("jobId", f.jobId).eq("revisionId", "r1")).collect();
      const latest = rows.at(-1), receipt = structuredClone(latest.receipt);
      if (mode === "gap") await ctx.db.delete(rows[0]._id);
      else if (mode === "duplicate") await ctx.db.insert("ownerTrialPublicationRecoveries", { jobId: f.jobId, revisionId: "r1", receipt: rows[0].receipt });
      else if (["ordinal", "historical_counter", "historical_version", "recovered_version", "proof", "event"].includes(mode)) {
        if (mode === "ordinal") receipt.originalAttempt.attemptNumber++;
        if (mode === "historical_counter") receipt.originalCommand.attempts++;
        if (mode === "historical_version") receipt.originalCommand.expectedVersion++;
        if (mode === "recovered_version") receipt.recoveredVersion++;
        if (mode === "proof") receipt.proof.signature = "0".repeat(64);
        if (mode === "event") receipt.event.commandDigest = "0".repeat(64);
        await ctx.db.patch(latest._id, { receipt });
      } else if (["historical_effect", "attempt_duplicate"].includes(mode)) {
        const doc = await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", f.jobId)).unique();
        const aggregate = structuredClone(doc.aggregate);
        if (mode === "historical_effect") aggregate.stageAttempts.find(a => a.stage === "publish").effectStartedAt = new Date().toISOString();
        else aggregate.stageAttempts.push(structuredClone(aggregate.stageAttempts.at(-1)));
        await ctx.db.patch(doc._id, { aggregate });
      } else if (mode === "provider_drift") process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID = "prj_other";
      else {
        const source = await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id", q => q.eq("commandId", f.binding.sourceCommandId)).unique();
        await ctx.db.patch(source._id, mode === "latest_counter" ? { attempts: source.attempts + 1 }
          : mode === "latest_version" ? { expectedVersion: source.expectedVersion + 1 }
          : mode === "source_identity" ? { requestedAt: new Date(Date.parse(source.requestedAt) + 1).toISOString() }
          : { payload: { ...source.payload, artifactManifestDigest: "0".repeat(64) } });
      }
    });
    const before = await snapshot(f.t);
    await assert.rejects(f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"), { completionToken, jobId: f.jobId }), mode);
    await assert.rejects(recover(third), mode);
    await assert.rejects(recover(f), mode);
    assert.deepEqual(await snapshot(f.t), before, mode);
    process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID = "prj_offline";
  }
});

test("offline iterative next claim rejects altered finite ceiling and unbacked fourth claim without writes", async () => {
  const f = await failedFixture(); await recover(f); await runRecoveredPublication(f, true);
  const second = await freshRecovery(f); await recover(second);
  const [command] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
  const authority = { workerId, commandId: command.commandId, leaseToken: command.claim.leaseToken };
  const current = await job(f.t, f.jobId), before = await snapshot(f.t);
  for (const maxAttempts of [4, 1000000]) {
    const next = claimStageTransition(current, { commandId: `claim:${f.jobId}:r1:publish:3`, stage: "publish",
      leaseToken: "offline-forged-third-stage-lease", leaseMs: 300000, maxAttempts,
      operationBinding: null, operationsCommandId: command.commandId }, new Date().toISOString());
    await assert.rejects(f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId,
      ...authority, expectedVersion: current.version, aggregate: next }));
    assert.deepEqual(await snapshot(f.t), before);
  }
  const trace = [], cap = await capabilities(f, trace, { failPublication: true });
  await cap.fulfillmentOrchestrator.runExpectedStage(f.jobId, "publish", { operationsCommandId: command.commandId,
    workerAuthority: authority, operationsEffectBoundary: async (_, invoke) => {
      await f.t.mutation(ref("operations:fenceCommand"), { workerToken: completionToken, ...authority,
        leaseMs: 300000, effectMayBeIssued: true }); return invoke();
    } });
  const failed = await job(f.t, f.jobId);
  await patchJob(f.t, f.jobId, j => ({ ...j, state: "publish_ready", stageAttempts: j.stageAttempts.map(a =>
    a.attemptId === j.stageAttempts.at(-1).attemptId ? { ...a, status: "reconciled_absent" } : a) }));
  const forged = await job(f.t, f.jobId), denied = await snapshot(f.t);
  const next = claimStageTransition(forged, { commandId: `claim:${f.jobId}:r1:publish:4`, stage: "publish",
    leaseToken: "offline-forged-fourth-stage-lease", leaseMs: 300000, maxAttempts: 4,
    operationBinding: null, operationsCommandId: command.commandId }, new Date().toISOString());
  await assert.rejects(f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId,
    ...authority, expectedVersion: failed.version, aggregate: next }));
  assert.deepEqual(await snapshot(f.t), denied);
});

test("offline stored recovery authority rejects mutated proof, historical effect, event or command payload before claim", async () => {
  for (const mode of ["proof", "historical_effect", "event", "command_payload"]) {
    const f = await failedFixture(); await recover(f);
    const [command] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
    await f.t.run(async ctx => {
      if (mode === "proof") {
        const doc = await ctx.db.query("ownerTrialPublicationRecoveries").withIndex("by_job_revision", q => q.eq("jobId", f.jobId).eq("revisionId", "r1")).unique();
        await ctx.db.patch(doc._id, { receipt: { ...doc.receipt, proof: { ...doc.receipt.proof, signature: "0".repeat(64) } } });
      } else if (mode === "command_payload") {
        const doc = await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id", q => q.eq("commandId", command.commandId)).unique();
        await ctx.db.patch(doc._id, { payload: { ...doc.payload, sourceCommandId: "command_offline_changed_payload" } });
      } else {
        const doc = await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", f.jobId)).unique();
        const aggregate = structuredClone(doc.aggregate);
        if (mode === "event") aggregate.events.at(-1).commandDigest = "0".repeat(64);
        else aggregate.stageAttempts.at(-1).effectStartedAt = new Date().toISOString();
        await ctx.db.patch(doc._id, { aggregate });
      }
    });
    const current = await job(f.t, f.jobId), before = await snapshot(f.t);
    await assert.rejects(f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"), { completionToken, jobId: f.jobId }));
    const next = claimStageTransition(current, { commandId: `claim:${f.jobId}:r1:publish:2`, stage: "publish", leaseToken: "offline-tamper-stage-lease",
      leaseMs: 300000, maxAttempts: 2, operationBinding: null, operationsCommandId: command.commandId }, new Date().toISOString());
    await assert.rejects(f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId, workerId,
      commandId: command.commandId, leaseToken: command.claim.leaseToken, expectedVersion: current.version, aggregate: next }));
    assert.deepEqual(await snapshot(f.t), before);
  }
});
