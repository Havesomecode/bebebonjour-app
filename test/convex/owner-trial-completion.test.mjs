import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../support/legacy-schema.mjs";
import { claimStageTransition, fenceExternalEffectTransition } from "../../src/fulfillment/job-machine.mjs";

const operatorToken = "offline-trial-completion-operator-at-least-32-bytes";
const completionToken = "offline-trial-completion-worker-at-least-32-bytes";
const workerToken = "offline-trial-generation-worker-at-least-32-bytes";
const hmacKey = "offline-trial-review-signing-key-at-least-32-bytes";
const workerId = "owner-trial-completion-worker";
const origin = "https://owner-trial.example.invalid";
const sha = value => createHash("sha256").update(value).digest("hex");
const actions = ["publish", "queue_delivery", "deliver"];
const modules = Object.fromEntries(["ownerTrial", "ownerTrialRuntime", "ownerTrialCompletion", "ownerTrialPublicationSupersession", "ownerTrialCompletionContinuation", "operations", "http", "fulfillment"]
  .map(name => [`./${name}.js`, () => import(`../../convex/${name}.js`)]));

async function fixture({ publicDeclaredBytes } = {}) {
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
function httpRequest(f, auth, overrides = {}) {
  const params = { jobId: f.jobId, revisionId: f.policy.revisionId, storageId: f.files[0].storageId, ...overrides.params };
  const headers = { authorization: `Bearer ${completionToken}`, "x-bebebonjour-worker-id": workerId,
    "x-bebebonjour-command-id": auth.commandId, "x-bebebonjour-lease-token": auth.leaseToken, ...overrides.headers };
  return f.t.fetch(`/completion/artifact?${new URLSearchParams(params)}`, { headers });
}
const publicationOutcome = f => ({ code: "published", deploymentId: "offline-vercel-receipt", jobVersion: 6,
  productionUrl: `${origin}/announcements/${f.jobId}`, publicationId: "offline-vercel-receipt" });

test("trial completion credential is distinct, disabled/invalid credentials never fall back to ordinary worker", async () => {
  const f = await fixture();
  assert.deepEqual(await f.t.query(ref("operations:workerHealth"), { workerToken: completionToken, jobId: f.jobId }),
    { protocolVersion: "1.0", scope: "owner_trial_completion" });
  const before = await snapshot(f.t);
  await assert.rejects(f.t.query(ref("operations:workerHealth"), { workerToken: completionToken }), /Owner trial/);
  await assert.rejects(f.t.mutation(ref("operations:claimCommands"), { ...f.claimArgs, workerToken: "wrong" }), /Unauthorized/);
  await assert.rejects(f.t.query(ref("ownerTrial:completionPolicy"), { completionToken: workerToken, jobId: f.jobId }), /unauthorized/);
  await assert.rejects(f.t.query(ref("fulfillment:getJob"), { backendToken: completionToken, jobId: f.jobId }));
  process.env.BEBEBONJOUR_OWNER_TRIAL_ENABLED = "false";
  try { await assert.rejects(f.t.mutation(ref("operations:claimCommands"), f.claimArgs), /unauthorized/); }
  finally { process.env.BEBEBONJOUR_OWNER_TRIAL_ENABLED = "true"; }
  for (const name of ["BEBEBONJOUR_OPERATIONS_TOKEN", "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN",
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN", "BEBEBONJOUR_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_NARRATION_WORKER_TOKEN", "BEBEBONJOUR_TTS_WORKER_TOKEN", "CUSTOMER_FLOW_BACKEND_TOKEN",
    "BEBEBONJOUR_APPROVAL_HMAC_KEY", "CRON_SECRET"]) {
    const previous = process.env[name]; process.env[name] = completionToken;
    try {
      await assert.rejects(f.t.mutation(ref("operations:claimCommands"), f.claimArgs), /distinct|unauthorized/);
      await assert.rejects(f.t.query(ref("ownerTrial:completionPolicy"), { completionToken, jobId: f.jobId }), /unauthorized/);
    } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  }
  assert.deepEqual(await snapshot(f.t), before);
});

test("trial claims bind exact reviewed ticket job, actions, identity, limit and lease with no writes on rejection", async () => {
  const f = await fixture(); await requestPublish(f); const before = await snapshot(f.t);
  for (const overrides of [ { jobId: "job_other_customer_001" }, { jobId: `job_owner_trial_${"f".repeat(32)}` },
    { jobId: undefined }, { actions: ["generate"] }, { actions: [...actions, "retry"] },
    { actions: ["publish"] }, { workerId: "ordinary-worker" }, { limit: 2 }, { leaseMs: 299999 } ]) {
    await assert.rejects(f.t.mutation(ref("operations:claimCommands"), { ...f.claimArgs, ...overrides }));
    assert.deepEqual(await snapshot(f.t), before);
  }
  const [claimed] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
  assert.equal(claimed.jobId, f.jobId); assert.equal(claimed.claim.workerId, workerId);
});

test("cross-job/action/worker command ingress cannot fence, complete or fail with trial credential", async () => {
  const f = await fixture(), auth = await claimPublish(f);
  for (const change of [command => ({ ...command, jobId: "job_other_customer_001" }),
    command => ({ ...command, action: "generate" })]) {
    await f.t.run(async ctx => {
      const document = await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id", q => q.eq("commandId", auth.commandId)).unique();
      await ctx.db.patch(document._id, change({ jobId: f.jobId, action: "publish" }));
    });
    const before = await snapshot(f.t);
    await assert.rejects(f.t.mutation(ref("operations:fenceCommand"), { ...auth, leaseMs: 300000, effectMayBeIssued: false }), /scope/);
    await assert.rejects(f.t.mutation(ref("operations:completeCommand"), { ...auth, outcome: publicationOutcome(f) }), /scope/);
    await assert.rejects(f.t.mutation(ref("operations:failCommand"), { ...auth, retryable: false, reasonCode: "stage_error" }), /scope/);
    assert.deepEqual(await snapshot(f.t), before);
  }
  await f.t.run(async ctx => {
    const document = await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id", q => q.eq("commandId", auth.commandId)).unique();
    await ctx.db.patch(document._id, { jobId: f.jobId, action: "publish" });
  });
  await assert.rejects(f.t.mutation(ref("operations:fenceCommand"), { ...auth, workerId: "other-worker", leaseMs: 300000, effectMayBeIssued: false }), /scope/);
  await assert.rejects(f.t.mutation(ref("operations:fenceCommand"), { ...auth, leaseMs: 299999, effectMayBeIssued: false }), /scope/);
});

test("revoked trial policy blocks claims and scoped health even when no commands are pending", async () => {
  const f = await fixture(); await revoke(f); const before = await snapshot(f.t);
  await assert.rejects(f.t.query(ref("operations:workerHealth"), { workerToken: completionToken, jobId: f.jobId }), /Owner trial/);
  await assert.rejects(f.t.mutation(ref("operations:claimCommands"), f.claimArgs), /Owner trial/);
  await assert.rejects(f.t.query(ref("ownerTrialCompletion:getJob"), { completionToken, jobId: f.jobId }), /Owner trial/);
  assert.deepEqual(await snapshot(f.t), before);
});

test("persisted policy is revalidated before command fences, completion, failure and artifact reads", async () => {
  const f = await fixture(), auth = await claimPublish(f); await dualFence(f, auth); await revoke(f);
  const before = await snapshot(f.t);
  await assert.rejects(f.t.mutation(ref("operations:fenceCommand"), { ...auth, leaseMs: 300000, effectMayBeIssued: true }), /Owner trial/);
  await assert.rejects(f.t.mutation(ref("operations:completeCommand"), { ...auth, outcome: publicationOutcome(f) }), /Owner trial/);
  await assert.rejects(f.t.mutation(ref("operations:failCommand"), { ...auth, retryable: false, reasonCode: "stage_error" }), /Owner trial/);
  assert.equal((await httpRequest(f, auth)).status, 403);
  assert.deepEqual(await snapshot(f.t), before);
});

test("expired ticket and tampered signed delegated reviews are rejected at scoped health and claims", async () => {
  for (const mode of ["expired", "signature"]) {
    const f = await fixture();
    if (mode === "expired") await revoke(f, ticket => ({ ...ticket, binding: { ...ticket.binding, expiresAt: new Date(Date.now() - 1000).toISOString() } }));
    else await f.t.run(async ctx => {
      const document = await ctx.db.query("fulfillmentReviewApprovals").withIndex("by_approval_id", q => q.eq("approvalId", f.policy.narrationApprovalId)).unique();
      await ctx.db.patch(document._id, { approval: { ...document.approval, signature: "0".repeat(64) } });
    });
    const before = await snapshot(f.t);
    await assert.rejects(f.t.query(ref("operations:workerHealth"), { workerToken: completionToken, jobId: f.jobId }), /Owner trial/);
    await assert.rejects(f.t.mutation(ref("operations:claimCommands"), f.claimArgs), /Owner trial/);
    assert.deepEqual(await snapshot(f.t), before);
  }
});

test("HTTP trial artifacts require exact bebebonjour headers, publish dual fence, public file and storage availability", async () => {
  const f = await fixture(), auth = await claimPublish(f);
  assert.equal((await httpRequest(f, auth)).status, 403);
  await claimStage(f, auth);
  assert.equal((await httpRequest(f, auth)).status, 403);
  await f.t.mutation(ref("operations:fenceCommand"), { ...auth, leaseMs: 300000, effectMayBeIssued: true });
  assert.equal((await httpRequest(f, auth)).status, 403);
  const current = await job(f.t, f.jobId), attempt = current.stageAttempts.at(-1);
  const next = fenceExternalEffectTransition(current, { commandId: `effect-fence:${attempt.attemptId}:1`,
    stage: "publish", attemptId: attempt.attemptId, leaseToken: attempt.leaseToken, leaseMs: 300000, effectMayBeIssued: true }, new Date().toISOString());
  await f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId,
    workerId, commandId: auth.commandId, leaseToken: auth.leaseToken, expectedVersion: current.version, aggregate: next });
  const response = await httpRequest(f, auth);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.publicBytes);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  for (const overrides of [{ headers: { authorization: "Bearer wrong" } },
    { headers: { authorization: `Bearer ${workerToken}` } }, { headers: { "x-bebebonjour-worker-id": "other-worker" } },
    { headers: { "x-bebebonjour-command-id": "command_other_publication" } },
    { headers: { "x-bebebonjour-lease-token": "wrong-lease" } },
    { headers: { "x-bebebonjour-worker-id": "", "x-bebebonjour-command-id": "", "x-bebebonjour-lease-token": "",
      "x-completion-worker-id": workerId, "x-completion-command-id": auth.commandId, "x-completion-lease-token": auth.leaseToken } },
    { params: { jobId: `job_owner_trial_${"f".repeat(32)}` } }, { params: { revisionId: "r2" } },
    { params: { storageId: f.files[1].storageId } }]) {
    assert.equal((await httpRequest(f, auth, overrides)).status, 403);
  }
  await f.t.run(ctx => ctx.storage.delete(f.files[0].storageId));
  assert.equal((await httpRequest(f, auth)).status, 404);
});

test("HTTP trial artifacts retain declared storage-size equality and maximum byte checks", async () => {
  for (const [publicDeclaredBytes, status] of [[1, 404], [20 * 1024 * 1024 + 1, 413]]) {
    const f = await fixture({ publicDeclaredBytes }), auth = await claimPublish(f);
    await dualFence(f, auth);
    const response = await httpRequest(f, auth);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});
