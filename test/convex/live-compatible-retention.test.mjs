import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const backendToken = "synthetic-backend-retention-token-32-long";
const canonicalToken = "synthetic-canonical-retention-token-32-long";
const controlToken = "synthetic-narration-control-token-32-long";
const ttsToken = "synthetic-narration-generation-token-32-long";
const jobId = "job_retention_fictional_001";
const revisionId = "r1";
const digest = "a".repeat(64);
const at = "2026-10-01T12:00:00.000Z";
function fixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN = canonicalToken;
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_JOB_ID = jobId;
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_REVISION_ID = revisionId;
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_MANIFEST_DIGEST = digest;
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT = "fictional@example.invalid";
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID = `approval_${"1".repeat(24)}`;
  delete process.env.BEBEBONJOUR_CANONICAL_COMPLETION_NARRATION_APPROVAL_ID;
  process.env.CANONICAL_PUBLICATION_ORIGIN = "https://fictional.example.invalid";
  process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = "synthetic-approval-hmac-key-32-long";
  process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN = controlToken;
  process.env.BEBEBONJOUR_TTS_WORKER_TOKEN = ttsToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./operations.js": () => import("../../convex/operations.js"),
    "./customerFlow.js": () => import("../../convex/customerFlow.js"),
    "./generation.js": () => import("../../convex/generation.js"),
    "./fulfillment.js": () => import("../../convex/fulfillment.js"),
    "./narration.js": () => import("../../convex/narration.js"),
  });
}
function customer(paid = true) {
  return { jobId, version: 1, intakeDigest: digest, payment: {
    status: paid ? "paid" : "pending", paymentIntentId: "pi_synthetic", acceptedEventId: "evt_synthetic",
  } };
}
function aggregate(state = "generation_queued", narrationRequired = false) {
  const correlation = { project: "bebebonjour", product: "announcement-page", environment: "test", jobId, intakeDigest: digest };
  return { jobId, state, version: 2, product: "announcement-page", environment: "test", intakeDigest: digest,
    currentRevisionId: revisionId, narrationRequired, artifactSets: [], reviewDecisions: [], stageAttempts: [], events: [],
    paymentCorrelation: correlation, payment: { providerPaymentId: "pi_synthetic", providerEventId: "evt_synthetic", correlation } };
}
function editorialApproval(conversation = false) {
  const sourceEvidence = conversation
    ? { kind: "conversation_human_decision", reference: `hermes:session:20261001_120000_abcdef:sha256:${digest}` }
    : { kind: "kanban_human_decision", reference: "kanban:t_synthetic_retention" };
  const record = { schemaVersion: "1.0", approvalType: "job_scoped_editorial_policy", jobId,
    policy: { id: "unknown_name_general_wishes", preserveSubmittedName: true, meaningAllowed: false,
      scripturalNameAssociationAllowed: false, genericBlessingsAllowed: true, maxStage: "content_review_required" },
    sourceEvidence, sourceDigest: hash(JSON.stringify(sourceEvidence)) };
  return { record, recordDigest: hash(`${JSON.stringify(record, null, 2)}\n`) };
}
async function rows(t) {
  return t.run((ctx) => ctx.db.query("customerFlowOperationsCommands").collect());
}
async function seedGeneration(t, paid = true, mutate = () => {}) {
  const job = aggregate(); mutate(job);
  await t.run(async (ctx) => {
    await ctx.db.insert("customerFlowJobs", { jobId, job: customer(paid) });
    await ctx.db.insert("fulfillmentJobs", { jobId, aggregate: job });
  });
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function seedRelease(t) {
  const job = aggregate("publish_ready");
  const artifactDigests = { pageDigest: "b".repeat(64), transcriptDigest: "c".repeat(64), assetManifestDigest: digest };
  job.artifactSets = ["private_review", "prepared_bundle"].map((kind) => ({ kind, revisionId, ...artifactDigests,
    files: [{ path: "index.html", storageId: "synthetic_storage", bytes: 1, sha256: "d".repeat(64) }] }));
  const decision = { decisionType: "content", outcome: "approved", revisionId, artifactDigests };
  job.reviewDecisions = [decision];
  const approval = { schemaVersion: "1.0", approvalId: process.env.BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID,
    binding: { jobId, revisionId, intakeDigest: digest, environment: "test", product: "announcement-page", artifactManifestDigest: digest }, decision };
  approval.signature = createHmac("sha256", process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY).update(canonicalJson(approval)).digest("hex");
  await t.run(async (ctx) => {
    await ctx.db.insert("customerFlowJobs", { jobId, job: customer() });
    await ctx.db.insert("fulfillmentJobs", { jobId, aggregate: job });
    await ctx.db.insert("fulfillmentReviewApprovals", { approvalId: approval.approvalId, approval });
  });
  return job;
}

test("live schema retains the canonical scope table and all four historical requestedBy actors", async () => {
  const t = fixture();
  assert.deepEqual(schema.tables.canonicalCompletionScopes?.export().indexes, [{ indexDescriptor: "by_scope", fields: ["scope"] }]);
  const actors = ["primary_operator", "automatic_generation", "automatic_narration_progression", "automatic_canonical_completion"];
  for (const [index, requestedBy] of actors.entries()) {
    await t.run((ctx) => ctx.db.insert("customerFlowOperationsCommands", {
      commandId: `command_synthetic_actor_${index}`, jobId, action: "generate", expectedState: "generation_queued", expectedVersion: 2,
      payload: {}, requestedAt: at, requestedBy, state: "pending", attempts: 0, claim: null, lastFailureReason: null, outcome: null, updatedAt: at,
    }));
  }
  assert.deepEqual((await rows(t)).map((row) => row.requestedBy), actors);
  await t.run((ctx) => ctx.db.insert("canonicalCompletionScopes", { scope: "canonical_test_completion", binding: { synthetic: true } }));
});

test("approved paid generation queues once for either gate order and never automatically retries", async () => {
  for (const paidFirst of [true, false]) {
    const t = fixture(); await seedGeneration(t, paidFirst);
    const approval = editorialApproval();
    await t.mutation(ref("generation:saveEditorialApproval"), { backendToken, jobId, approval });
    assert.equal((await rows(t)).length, paidFirst ? 1 : 0);
    if (!paidFirst) await t.mutation(ref("customerFlow:replaceJob"), {
      backendToken, expectedVersion: 1, job: { ...customer(), version: 2 },
    });
    const commands = await rows(t);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].requestedBy, "automatic_generation");
    assert.equal(commands[0].commandId, `command_auto_${hash(`${jobId}\0${2}\0generate`).slice(0, 32)}`);
    await t.run((ctx) => ctx.db.patch(commands[0]._id, { state: "failed" }));
    await t.mutation(ref("generation:saveEditorialApproval"), { backendToken, jobId, approval });
    assert.equal((await rows(t)).length, 1);
    assert.equal((await rows(t))[0].state, "failed");
  }
});

test("automatic generation stays closed to unpaid, mismatched and non-test jobs", async () => {
  for (const [paid, mutate] of [[false, () => {}], [true, (job) => { job.environment = "production"; }],
    [true, (job) => { job.payment.providerPaymentId = "other"; }], [true, (job) => { job.paymentCorrelation.intakeDigest = "other"; }]]) {
    const t = fixture(); await seedGeneration(t, paid, mutate);
    await t.mutation(ref("generation:saveEditorialApproval"), { backendToken, jobId, approval: editorialApproval() });
    assert.deepEqual(await rows(t), []);
  }
});

test("live conversation approval grammar retains digest validation and immutability", async () => {
  const t = fixture(); await seedGeneration(t);
  const approval = editorialApproval(true);
  await t.mutation(ref("generation:saveEditorialApproval"), { backendToken, jobId, approval });
  const invalid = structuredClone(approval); invalid.recordDigest = "0".repeat(64);
  await assert.rejects(t.mutation(ref("generation:saveEditorialApproval"), { backendToken, jobId, approval: invalid }), /invalid/u);
  const changed = structuredClone(approval); changed.record.sourceEvidence.reference = changed.record.sourceEvidence.reference.replace("abcdef", "123456");
  changed.record.sourceDigest = hash(JSON.stringify(changed.record.sourceEvidence));
  changed.recordDigest = hash(`${JSON.stringify(changed.record, null, 2)}\n`);
  await assert.rejects(t.mutation(ref("generation:saveEditorialApproval"), { backendToken, jobId, approval: changed }), /immutable/u);
});

test("canonical publication remains explicit, exact-release scoped, deduplicated and pinned at claim", async () => {
  const t = fixture(); await seedRelease(t);
  assert.deepEqual(await rows(t), [], "a ready release alone must not enqueue publication");
  const args = { workerToken: canonicalToken, jobId };
  await assert.rejects(t.mutation(ref("operations:queueCanonicalPublication"), { ...args, workerToken: ttsToken }));
  await assert.rejects(t.mutation(ref("operations:queueCanonicalPublication"), { ...args, jobId: "job_wrong_synthetic" }));
  assert.equal(await t.mutation(ref("operations:queueCanonicalPublication"), args), true);
  assert.equal(await t.mutation(ref("operations:queueCanonicalPublication"), args), false);
  assert.equal((await rows(t))[0].requestedBy, "automatic_canonical_completion");
  const claim = { ...args, workerId: "canonical-test-completion-worker", actions: ["publish", "queue_delivery", "deliver"], limit: 1, leaseMs: 300000 };
  assert.equal((await t.mutation(ref("operations:claimCommands"), claim)).length, 1);
  assert.equal((await t.run((ctx) => ctx.db.query("canonicalCompletionScopes").collect())).length, 1);
  assert.equal((await t.query(ref("fulfillment:getCompletionJob"), { completionToken: canonicalToken, jobId })).jobId, jobId);
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT = "changed@example.invalid";
  await assert.rejects(t.query(ref("operations:workerHealth"), { workerToken: canonicalToken }), /binding changed/u);
});

test("canonical scope rejects token aliasing, invalid signed approvals and changed manifests", async () => {
  const t = fixture(); await seedRelease(t);
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN = ttsToken;
  await assert.rejects(t.query(ref("operations:workerHealth"), { workerToken: ttsToken }), /distinct/u);
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN = canonicalToken;
  await t.run(async (ctx) => { const row = await ctx.db.query("fulfillmentReviewApprovals").unique();
    await ctx.db.patch(row._id, { approval: { ...row.approval, signature: "0".repeat(64) } }); });
  await assert.rejects(t.mutation(ref("operations:queueCanonicalPublication"), { workerToken: canonicalToken, jobId }), /signature/u);
  assert.deepEqual(await rows(t), []);
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_MANIFEST_DIGEST = "e".repeat(64);
  await assert.rejects(t.mutation(ref("operations:queueCanonicalPublication"), { workerToken: canonicalToken, jobId }), /manifest/u);
});

test("paid narration progression is transactional, correlated, deduplicated and stops at human review", async () => {
  const t = fixture();
  const prior = aggregate("content_review_required", true);
  const artifactDigests = { pageDigest: "b".repeat(64), transcriptDigest: "c".repeat(64), assetManifestDigest: digest };
  prior.artifactSets = [{ kind: "private_review", revisionId, ...artifactDigests }];
  const source = { commandId: "command_synthetic_narration_001", jobId, action: "approve_content", expectedState: prior.state, expectedVersion: prior.version,
    payload: { revisionId, artifactManifestDigest: digest, artifactDigests }, requestedAt: at, requestedBy: "primary_operator", state: "running", attempts: 1,
    claim: { workerId: "hosted-narration-worker", leaseToken: "synthetic_lease_token", claimedAtMs: Date.now(), leaseExpiresAtMs: Date.now() + 300000 },
    lastFailureReason: null, outcome: null, updatedAt: at };
  const next = { ...prior, state: "render_queued", version: 3, reviewDecisions: [{ decisionType: "content", outcome: "approved", revisionId, artifactDigests, operationsCommandId: source.commandId }] };
  await t.run(async (ctx) => {
    await ctx.db.insert("customerFlowJobs", { jobId, job: customer() });
    await ctx.db.insert("fulfillmentJobs", { jobId, aggregate: prior });
    await ctx.db.insert("customerFlowOperationsCommands", source);
  });
  await t.mutation(ref("narration:commitTransition"), { workerToken: controlToken, workerId: "hosted-narration-worker", commandId: source.commandId,
    leaseToken: source.claim.leaseToken, jobId, expectedVersion: prior.version, aggregate: next });
  assert.equal((await rows(t)).find((row) => row.action === "render")?.requestedBy, "automatic_narration_progression");
  const { enqueuePaidNarrationProgression } = await import("../../convex/operations.js");
  await t.run((ctx) => enqueuePaidNarrationProgression(ctx, source, prior, next));
  assert.equal((await rows(t)).length, 2);
  const render = (await rows(t)).find((row) => row.action === "render");
  const rendering = { ...next, state: "rendering", version: 4 };
  const rendered = { ...rendering, state: "tts_queued", version: 5, artifactSets: [...prior.artifactSets,
    { kind: "prepared_bundle", revisionId, ...artifactDigests, operationsCommandId: render.commandId }],
    stageAttempts: [{ attemptId: "attempt_synthetic", stage: "render_approved", status: "completed", operationsCommandId: render.commandId }],
    events: [{ commandId: "complete:attempt_synthetic", type: "stage_completed" }] };
  const unpaid = structuredClone(rendered); unpaid.payment.providerEventId = "mismatch";
  await t.run((ctx) => enqueuePaidNarrationProgression(ctx, render, rendering, unpaid));
  assert.equal((await rows(t)).length, 2);
  await t.run((ctx) => enqueuePaidNarrationProgression(ctx, render, rendering, rendered));
  assert.equal((await rows(t)).find((row) => row.action === "generate_narration")?.requestedBy, "automatic_narration_progression");
  await t.run((ctx) => enqueuePaidNarrationProgression(ctx, { ...render, action: "generate_narration" }, rendered,
    { ...rendered, state: "narration_review_required", version: 6 }));
  assert.equal((await rows(t)).length, 3, "no automatic approval or publication after TTS");
});
