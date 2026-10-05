import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";
import { retryPreEffectFailure } from "../../convex/privateGeneration.js";
import { claimStageTransition, failStageTransition } from "../../src/fulfillment/job-machine.mjs";
import { serializeCanonicalJobScopedEditorialApprovalRecord } from "../../src/fulfillment/job-scoped-editorial-approval-canonicalization.mjs";
import { stablePrivateValue } from "../../src/fulfillment/private-generation-authority.mjs";

const operatorToken = "offline-private-retry-operator-token-32-characters";
const workerToken = "offline-private-retry-worker-token-32-characters";
const backendToken = "offline-private-retry-backend-token-32-characters";
const hash = value => createHash("sha256").update(value).digest("hex");
const endpoint = "privateGeneration:retryPreEffectFailure";
function fixture() {
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  process.env.BEBEBONJOUR_PRIVATE_GENERATION_TESTS_ENABLED = "true";
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./privateGeneration.js": () => import("../../convex/privateGeneration.js"),
    "./privateGenerationRuntime.js": () => import("../../convex/privateGenerationRuntime.js"),
    "./operations.js": () => import("../../convex/operations.js"),
    "./generation.js": () => import("../../convex/generation.js"),
    "./automaticGeneration.js": () => import("../../convex/automaticGeneration.js"),
  });
}
async function snapshot(t) {
  return t.run(async ctx => Object.fromEntries(await Promise.all([
    ...Object.keys(schema.tables),
  ].map(async table => [table, await ctx.db.query(table).collect()]))));
}
async function failedFixture() {
  const t = fixture();
  const { jobId, intakeDigest } = await t.action(ref("privateGenerationRuntime:createFictionalTest"), {
    operatorToken, acknowledgement: "fictional-unpaid-codex-private-review-only",
    ownerSourceReference: "kanban:t_offline_retry_fixture", idempotencyKey: "offline-private-retry-001",
  });
  // Synthetic, explicitly offline approval fixture; never a real human approval.
  const sourceEvidence = { kind: "kanban_human_decision", reference: "kanban:t_offline_retry_policy" };
  const record = { schemaVersion: "1.0", approvalType: "job_scoped_editorial_policy", jobId,
    policy: { id: "unknown_name_general_wishes", preserveSubmittedName: true, meaningAllowed: false,
      scripturalNameAssociationAllowed: false, genericBlessingsAllowed: true, maxStage: "content_review_required" },
    sourceEvidence, sourceDigest: hash(JSON.stringify(sourceEvidence)) };
  const editorialApprovalDigest = hash(`${JSON.stringify(record, null, 2)}\n`);
  await t.mutation(ref("generation:saveEditorialApproval"), {
    backendToken, jobId, approval: { record, recordDigest: editorialApprovalDigest },
  });
  const sourceCommandId = "command_offline_private_preflight_failure";
  await t.mutation(ref("operations:requestCommand"), {
    operatorToken, jobId, commandId: sourceCommandId, action: "generate", payload: {},
    expectedState: "generation_queued", expectedVersion: 1,
  });
  const [command] = await t.mutation(ref("operations:claimCommands"), {
    workerToken, workerId: "offline-retry-worker", actions: ["generate"], limit: 1, leaseMs: 300_000, jobId,
  });
  const auth = { workerToken, workerId: command.claim.workerId, leaseToken: command.claim.leaseToken,
    commandId: sourceCommandId, jobId };
  const initial = (await snapshot(t)).fulfillmentJobs[0].aggregate;
  const startedAt = new Date().toISOString();
  const claimed = claimStageTransition(initial, {
    commandId: `claim:${sourceCommandId}:prepare_review`, stage: "prepare_review",
    operationsCommandId: sourceCommandId, leaseToken: "offline-stage-lease", leaseMs: 300_000, maxAttempts: 3,
  }, startedAt);
  await t.mutation(ref("generation:replaceClaimedFulfillmentJob"), { ...auth, expectedVersion: 1, aggregate: claimed });
  const failedAttemptId = claimed.stageAttempts[0].attemptId;
  const failed = failStageTransition(claimed, {
    commandId: `fail:${failedAttemptId}:stage_error`, stage: "prepare_review", leaseToken: "offline-stage-lease",
    reasonCode: "stage_error", retryable: false,
  }, { maxAttemptsByStage: { prepare_review: 3 } }, new Date().toISOString());
  // Seed the canonical terminal snapshot: the current claimed-write API requires
  // an effect fence after claim, including a failed write. Do not fabricate one.
  await t.run(async ctx => {
    const document = await ctx.db.query("fulfillmentJobs").first();
    await ctx.db.patch(document._id, { aggregate: failed });
  });
  const { jobId: ignored, ...commandAuth } = auth;
  await t.mutation(ref("operations:failCommand"), { ...commandAuth, reasonCode: "generation_stage_failed", retryable: false });
  return { t, args: { operatorToken, jobId, intakeDigest, sourceCommandId, failedAttemptId,
    editorialApprovalDigest, expectedVersion: 3, recoveryId: "private_retry_offline_001" } };
}

async function changeAggregate(t, change) {
  await t.run(async ctx => {
    const document = await ctx.db.query("fulfillmentJobs").first();
    change(document.aggregate);
    await ctx.db.patch(document._id, { aggregate: document.aggregate });
  });
}
async function capturedFailureFixture() {
  const t = fixture();
  const captured = JSON.parse(await readFile(new URL("../fixtures/private-generation-failed-live-readback.json", import.meta.url), "utf8"));
  const jobId = captured.fulfillment.jobId;
  // Exact captured fictional failure; the protected customer projection omits
  // its authority, whose identical stored binding is supplied by the aggregate.
  await t.run(async ctx => {
    await ctx.db.insert("customerFlowJobs", { jobId, job: { ...captured.customer,
      privateTestAuthority: captured.fulfillment.privateTestAuthority } });
    await ctx.db.insert("fulfillmentJobs", { jobId, aggregate: captured.fulfillment });
    await ctx.db.insert("customerFlowOperationsCommands", captured.commands[0]);
  });
  // Offline approval fixture, not a new real owner decision.
  const sourceEvidence = { kind: "kanban_human_decision", reference: "kanban:t_offline_captured_policy" };
  const record = { schemaVersion: "1.0", approvalType: "job_scoped_editorial_policy", jobId,
    policy: { id: "unknown_name_general_wishes", preserveSubmittedName: true, meaningAllowed: false,
      scripturalNameAssociationAllowed: false, genericBlessingsAllowed: true, maxStage: "content_review_required" },
    sourceEvidence, sourceDigest: hash(JSON.stringify(sourceEvidence)) };
  const editorialApprovalDigest = hash(serializeCanonicalJobScopedEditorialApprovalRecord(record));
  await t.mutation(ref("generation:saveEditorialApproval"), {
    backendToken, jobId, approval: { record, recordDigest: editorialApprovalDigest },
  });
  return { t, args: { operatorToken, jobId, intakeDigest: captured.customer.intakeDigest,
    sourceCommandId: captured.commands[0].commandId,
    failedAttemptId: captured.fulfillment.stageAttempts[0].attemptId,
    expectedVersion: captured.fulfillment.version, editorialApprovalDigest,
    recoveryId: "private_retry_captured_001" } };
}

test("captured live-shape failure rejects retry and preserves reconciliation; artifact absence is not a provider receipt", async () => {
  const { t, args } = await capturedFailureFixture();
  const before = await snapshot(t);
  assert.equal(before.customerFlowOperationsCommands[0].state, "reconciliation_required");
  await rejectsUnchanged(t, args, /provider absence unproven/u);
  await rejectsUnchanged(t, args, /provider absence unproven/u);
  const after = await snapshot(t);
  assert.deepEqual(after, before);
  assert.equal(after.fulfillmentJobs[0].aggregate.version, 3);
  assert.equal(after.fulfillmentJobs[0].aggregate.state, "failed");
  assert.equal(after.customerFlowOperationsCommands.length, 1);
  assert.equal(after.customerFlowOperationsCommands[0].lastFailureReason, "generation_stage_failed");
  assert.equal(after.fulfillmentJobs[0].aggregate.events.some(event => event.commandId === args.recoveryId), false);
  assert.deepEqual((await t.query(ref("operations:getJob"), { operatorToken, jobId: args.jobId })).availableActions, ["reconcile"]);
  await assert.rejects(t.mutation(ref("operations:requestCommand"), { operatorToken, jobId: args.jobId,
    commandId: "command_offline_captured_retry_v4", action: "generate", payload: {},
    expectedState: "failed", expectedVersion: 3 }), /not available/u);
  assert.deepEqual(await snapshot(t), before);
});

async function rejectsUnchanged(t, args, pattern = /Private pre-effect retry/u) {
  const before = await snapshot(t);
  const writes = [];
  await t.run(async ctx => {
    const db = new Proxy(ctx.db, { get(target, property) {
      if (["insert", "patch", "replace", "delete"].includes(property)) return (...values) => {
        writes.push({ method: property, values });
        throw new Error("Unexpected retry write.");
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await assert.rejects(retryPreEffectFailure._handler({ ...ctx, db }, args), pattern);
  });
  assert.deepEqual(writes, []);
  await assert.rejects(t.mutation(ref(endpoint), args), pattern);
  assert.deepEqual(await snapshot(t), before);
}

test("exact recovery replay returns the original result without changing any persisted bytes", async () => {
  const { t, args } = await failedFixture();
  const result = await t.mutation(ref(endpoint), args);
  const after = await snapshot(t);
  assert.deepEqual(await t.mutation(ref(endpoint), args), result);
  assert.deepEqual(await snapshot(t), after);
  // A receipt remains the original result, not a reconstruction from later state.
  await changeAggregate(t, f => { f.state = "generating"; f.version += 1; });
  const progressed = await snapshot(t);
  assert.deepEqual(await t.mutation(ref(endpoint), args), result);
  assert.deepEqual(await snapshot(t), progressed);
  for (const changed of [
    { intakeDigest: "a".repeat(64) }, { sourceCommandId: "command_offline_wrong_source" },
    { failedAttemptId: `attempt_${"a".repeat(24)}` }, { expectedVersion: 4 },
    { editorialApprovalDigest: "a".repeat(64) },
  ]) {
    await rejectsUnchanged(t, { ...args, ...changed });
  }
});

test("canonical editorial policy, source and record digests are revalidated for first use and replay", async () => {
  const changes = [
    v => { v.record.policy.meaningAllowed = true; },
    v => { v.record.policy.preserveSubmittedName = false; },
    v => { v.record.policy.scripturalNameAssociationAllowed = true; },
    v => { v.record.policy.genericBlessingsAllowed = false; },
    v => { v.record.policy.maxStage = "publish"; },
    v => { v.record.policy.id = "near_match_unknown_name_general_wishes"; },
    v => { v.record.policy.extraAuthority = "publish"; },
    v => { delete v.record.policy.maxStage; },
    v => { v.record.schemaVersion = "2.0"; },
    v => { v.record.approvalType = "automatic_approval"; },
    v => { v.record.jobId = "job_offline_other_approval"; },
    v => { v.record.extra = true; },
    v => { v.extra = true; },
    v => { v.record.sourceEvidence.kind = "machine_decision"; },
    v => { v.record.sourceEvidence.reference = "kanban:t_x"; },
    v => { v.record.sourceEvidence.reference += " trailing"; },
    v => { v.record.sourceEvidence.extra = true; },
    v => { v.record.sourceDigest = "b".repeat(64); },
    v => { v.recordDigest = "c".repeat(64); },
  ];
  for (const replay of [false, true]) for (const change of changes) {
    const { t, args } = await failedFixture();
    if (replay) await t.mutation(ref(endpoint), args);
    const changedArgs = { ...args };
    await t.run(async ctx => {
      const document = await ctx.db.query("fulfillmentGenerationEditorialApprovals").first();
      const value = document.approval;
      change(value);
      // Rehash structurally valid edits too: checking only a digest equality is insufficient.
      if (value.recordDigest !== "c".repeat(64)) {
        value.recordDigest = hash(serializeCanonicalJobScopedEditorialApprovalRecord(value.record));
      }
      if (!replay) changedArgs.editorialApprovalDigest = value.recordDigest;
      await ctx.db.patch(document._id, { approval: value });
    });
    await rejectsUnchanged(t, changedArgs);
  }
  for (const replay of [false, true]) {
    const { t, args } = await failedFixture();
    if (replay) await t.mutation(ref(endpoint), args);
    await t.run(async ctx => {
      const document = await ctx.db.query("fulfillmentGenerationEditorialApprovals").first();
      await ctx.db.delete(document._id);
    });
    await rejectsUnchanged(t, args);
  }
});

test("generation artifact table orphans reject retry even when the aggregate is empty", async () => {
  for (const kind of ["private_review", "prepared_bundle", "narration_audio", "unknown_offline_kind"]) {
    const { t, args } = await failedFixture();
    await t.run(ctx => ctx.db.insert("fulfillmentGenerationArtifactSets", {
      jobId: args.jobId, revisionId: "r99", kind, artifactSet: { orphan: true },
    }));
    await rejectsUnchanged(t, args);
  }
});

test("other-job generation artifact records do not block the exact empty private job", async () => {
  const { t, args } = await failedFixture();
  await t.run(ctx => ctx.db.insert("fulfillmentGenerationArtifactSets", {
    jobId: "job_offline_other_artifacts", revisionId: "r1", kind: "private_review", artifactSet: {},
  }));
  assert.equal((await t.mutation(ref(endpoint), args)).restored, true);
});

test("retry rejects every near-match terminal attempt or nonempty aggregate without mutation", async () => {
  for (const change of [
    f => { f.revisions.push({ revisionId: "r1" }); },
    f => { f.artifactSets.push({ revisionId: "r1" }); },
    f => { f.reviewDecisions.push({ decisionId: "offline-decision" }); },
    f => { f.deliveryAttempts.push({ deliveryAttemptId: "offline-delivery" }); },
    f => { f.publication = { publicationId: "offline-publication" }; },
    f => { f.currentRevisionId = "r1"; },
    f => { f.publishedRevisionId = "r1"; },
    f => { f.retry = { stage: "prepare_review" }; },
    f => { f.stageAttempts.push(structuredClone(f.stageAttempts[0])); },
    f => { f.stageAttempts[0].revisionId = "r1"; },
    f => { f.stageAttempts[0].attemptNumber = 2; },
    f => { f.stageAttempts[0].operationNumber = 2; },
    f => { f.stageAttempts[0].status = "reconciliation_required"; },
    f => { f.stageAttempts[0].stage = "generate_tts"; },
    f => { f.stageAttempts[0].effectStartedAt = f.updatedAt; },
    f => { delete f.stageAttempts[0].effectStartedAt; },
    f => { f.stageAttempts[0].operationBinding = {}; },
    f => { delete f.stageAttempts[0].operationBinding; },
    f => { f.stageAttempts[0].leaseToken = "offline-active-lease"; },
    f => { f.stageAttempts[0].leaseExpiresAt = f.updatedAt; },
    f => { f.stageAttempts[0].completedAt = null; },
    f => { f.stageAttempts[0].completedAt = "not-a-timestamp"; },
    f => { f.stageAttempts[0].failure.retryable = true; },
    f => { f.stageAttempts[0].failure.reasonCode = "lease_expired"; },
    f => { f.events.at(-1).type = "external_effect_started"; },
    f => { f.events.at(-1).commandId = "fail:offline-other:stage_error"; },
    f => { f.events.pop(); },
    f => { f.events.push({ type: "stage_failed", commandId: "ambiguous-offline", state: "failed" }); },
  ]) {
    const { t, args } = await failedFixture();
    await changeAggregate(t, change);
    await rejectsUnchanged(t, args);
  }
});

test("retry rejects ambiguous command histories and nonexact terminal generate commands", async () => {
  for (const change of [
    c => { c.expectedState = "tts_queued"; },
    c => { c.expectedVersion = 2; },
    c => { c.attempts = 2; },
    c => { c.attempts = 0; },
    c => { c.requestedBy = "automatic_generation"; },
    c => { c.payload = { sourceCommandId: "command_offline_other" }; },
    c => { c.supersedesCommandId = "command_offline_other"; },
    c => { c.state = "pending"; },
    c => { c.action = "generate_narration"; },
    c => { c.claim = { workerId: "offline", leaseToken: "offline", claimedAtMs: 1,
      leaseExpiresAtMs: 2, effectStartedAtMs: 1 }; },
    c => { c.outcome = { code: "completed", jobVersion: 3 }; },
    c => { c.lastFailureReason = "unknown_failure"; },
  ]) {
    const { t, args } = await failedFixture();
    await t.run(async ctx => {
      const source = await ctx.db.query("customerFlowOperationsCommands").first();
      change(source);
      const { _id, _creationTime, ...fields } = source;
      await ctx.db.replace(_id, fields);
    });
    await rejectsUnchanged(t, args);
  }
  for (const state of ["pending", "running", "reconciliation_required", "completed", "failed"]) {
    const { t, args } = await failedFixture();
    await t.run(async ctx => {
      const source = await ctx.db.query("customerFlowOperationsCommands").first();
      const { _id, _creationTime, ...fields } = source;
      await ctx.db.insert("customerFlowOperationsCommands", { ...fields,
        commandId: "command_offline_ambiguous_second", state });
    });
    await rejectsUnchanged(t, args);
  }
});

test("exact pre-effect retry restores the same job without enqueuing or rewriting failure/approval history", async () => {
  const { t, args } = await failedFixture();
  const before = await snapshot(t);
  const result = await t.mutation(ref(endpoint), args);
  assert.deepEqual(result, { jobId: args.jobId, state: "generation_queued", version: 4,
    recoveryId: args.recoveryId, sourceCommandId: args.sourceCommandId, failedAttemptId: args.failedAttemptId,
    restored: true });
  const after = await snapshot(t);
  const original = before.fulfillmentJobs[0].aggregate;
  const next = after.fulfillmentJobs[0].aggregate;
  assert.equal(next.state, "generation_queued");
  assert.equal(next.version, original.version + 1);
  assert.deepEqual(next.stageAttempts, original.stageAttempts);
  assert.deepEqual(next.events.slice(0, -1), original.events);
  assert.equal(next.events.at(-1).type, "private_generation_pre_effect_retry_authorized");
  assert.equal(next.events.at(-1).commandId, args.recoveryId);
  for (const key of Object.keys(original).filter(key => !["state", "version", "updatedAt", "events"].includes(key))) {
    assert.deepEqual(next[key], original[key], key);
  }
  for (const table of Object.keys(before).filter(table => table !== "fulfillmentJobs")) {
    assert.deepEqual(after[table], before[table], table);
  }
  assert.deepEqual((await t.query(ref("operations:getJob"), { operatorToken, jobId: args.jobId })).availableActions, ["generate"]);
  await assert.rejects(t.mutation(ref("operations:requestCommand"), { operatorToken, jobId: args.jobId,
    commandId: "command_offline_forbidden_reconcile", action: "reconcile", expectedState: "generation_queued",
    expectedVersion: 4, payload: { sourceCommandId: args.sourceCommandId, providerStatus: "confirmed_absent" } }), /not available/u);
});

test("retry rejects malformed identifiers and stale or noninteger versions without writes", async () => {
  for (const changed of [
    { recoveryId: "" }, { recoveryId: "private_retry_\ninvalid" },
    { recoveryId: "private_retry_" + "x".repeat(129) }, { recoveryId: "command_ordinary_recovery" },
    { jobId: "job_private_codex_invalid" }, { sourceCommandId: "command_\ninvalid" },
    { failedAttemptId: "attempt_../invalid" }, { intakeDigest: "D".repeat(64) },
    { editorialApprovalDigest: "d".repeat(63) },
    { expectedVersion: 2 }, { expectedVersion: 4 }, { expectedVersion: 3.5 }, { expectedVersion: -1 },
  ]) {
    const { t, args } = await failedFixture();
    await rejectsUnchanged(t, { ...args, ...changed });
  }
});

test("retry requires the enabled distinct operator credential on first use and replay", async () => {
  for (const replay of [false, true]) {
    for (const forbidden of ["CUSTOMER_FLOW_BACKEND_TOKEN", "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
      "BEBEBONJOUR_NARRATION_WORKER_TOKEN", "BEBEBONJOUR_TTS_WORKER_TOKEN",
      "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN",
      "BEBEBONJOUR_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN"]) {
      const { t, args } = await failedFixture();
      if (replay) await t.mutation(ref(endpoint), args);
      const old = process.env[forbidden];
      try {
        process.env[forbidden] = operatorToken;
        await rejectsUnchanged(t, args, /disabled or unauthorized/u);
      } finally {
        if (old === undefined) delete process.env[forbidden]; else process.env[forbidden] = old;
      }
    }
    for (const changed of [{ operatorToken: workerToken }, { operatorToken: backendToken },
      { operatorToken: "wrong" }]) {
      const { t, args } = await failedFixture();
      if (replay) await t.mutation(ref(endpoint), args);
      await rejectsUnchanged(t, { ...args, ...changed }, /disabled or unauthorized/u);
    }
    const { t, args } = await failedFixture();
    if (replay) await t.mutation(ref(endpoint), args);
    process.env.BEBEBONJOUR_PRIVATE_GENERATION_TESTS_ENABLED = "false";
    try { await rejectsUnchanged(t, args, /disabled or unauthorized/u); }
    finally { process.env.BEBEBONJOUR_PRIVATE_GENERATION_TESTS_ENABLED = "true"; }
  }
});

test("retry rejects removed markers, intake drift, payment and environmental authority drift", async () => {
  for (const replay of [false, true]) for (const change of [
    (c, f) => { delete c.privateTestAuthority; },
    (c, f) => { delete f.privateTestAuthority; },
    (c, f) => { delete c.privateTestAuthority; delete f.privateTestAuthority; f.product = "ordinary"; },
    (c, f) => { c.intake.baby.firstName = "Drifted"; },
    (c, f) => { c.payment.status = "paid"; },
    (c, f) => { c.payment.paidAt = c.createdAt; },
    (c, f) => { c.payment.checkout = {}; },
    (c, f) => { f.payment = {}; },
    (c, f) => { f.paymentCorrelation = {}; },
    (c, f) => { f.environment = "production"; },
    (c, f) => { f.product = "operator_narration_test"; },
    (c, f) => { f.narrationRequired = false; },
    (c, f) => { c.privateTestAuthority.extra = "publish"; f.privateTestAuthority.extra = "publish"; },
    (c, f) => { c.privateTestAuthority.intakeDigest = "a".repeat(64); },
  ]) {
    const { t, args } = await failedFixture();
    if (replay) await t.mutation(ref(endpoint), args);
    await t.run(async ctx => {
      const c = await ctx.db.query("customerFlowJobs").first();
      const f = await ctx.db.query("fulfillmentJobs").first();
      change(c.job, f.aggregate);
      await ctx.db.patch(c._id, { job: c.job });
      await ctx.db.patch(f._id, { aggregate: f.aggregate });
    });
    await rejectsUnchanged(t, args);
  }
});

test("recovery receipts reject corrupted identity, result, timestamp or original command evidence", async () => {
  for (const change of [
    e => { e.eventId = "event_forged"; },
    e => { e.result.jobId = "job_offline_other"; },
    e => { e.result.version = 999; },
    e => { e.result.extra = "publish"; },
    e => { e.state = "published"; },
    e => { e.at = "not-a-timestamp"; },
    e => { e.sourceDisposition = { before: { state: "completed" } }; },
    e => { e.sourceDisposition = { beforeDigest: "a".repeat(64) }; },
    e => { e.sourceDisposition = { after: { state: "completed" } }; },
  ]) {
    const { t, args } = await failedFixture();
    await t.mutation(ref(endpoint), args);
    await changeAggregate(t, f => change(f.events.at(-1)));
    await rejectsUnchanged(t, args);
  }
});

test("prior unsafe reconciliation disposition is not accepted as independent composer-absence evidence on replay", async () => {
  // Synthetic legacy receipt regression, NOT proof about the captured live job.
  const { t, args } = await failedFixture();
  await t.mutation(ref(endpoint), args);
  await t.run(async ctx => {
    const document = await ctx.db.query("fulfillmentJobs").first();
    const source = await ctx.db.query("customerFlowOperationsCommands").first();
    const { _id, _creationTime, ...before } = source;
    before.state = "reconciliation_required";
    const event = document.aggregate.events.at(-1);
    const after = { state: "failed", lastFailureReason: "private_pre_effect_failure_confirmed_absent", updatedAt: event.at };
    event.sourceDisposition = { before, beforeDigest: hash(stablePrivateValue(before)), after };
    await ctx.db.patch(document._id, { aggregate: document.aggregate });
    await ctx.db.patch(source._id, after);
  });
  await rejectsUnchanged(t, args, /idempotency conflict/u);
});

test("reconciliation source is rejected before even an exact failed-command replay can return", async () => {
  const { t, args } = await failedFixture();
  await t.mutation(ref(endpoint), args);
  await t.run(async ctx => {
    const source = await ctx.db.query("customerFlowOperationsCommands").first();
    await ctx.db.patch(source._id, { state: "reconciliation_required" });
  });
  await rejectsUnchanged(t, args, /provider absence unproven/u);
});
