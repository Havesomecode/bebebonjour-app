import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";
import { createHash } from "node:crypto";
import { runOperationsWorkerCommand } from "../../src/operations/operations-worker-startup.mjs";
import { createTestAGenerationRunner } from "../../src/fulfillment/test-a-generation-runner.mjs";
import { commandPrepareReview } from "../../scripts/lib/commands.mjs";
import { createLocalPrepareReviewStageHandler } from "../../src/fulfillment/local-prepare-review-stage-handler.mjs";
import {
  assertValidCodexCompositionReceipt,
  buildCodexCompositionRequest,
} from "../../scripts/lib/codex-subscription-composition.mjs";
import { isPrivateGenerationJob } from "../../src/fulfillment/private-generation-authority.mjs";
import { retryPreEffectFailure } from "../../convex/privateGeneration.js";

const operatorToken = "private-generation-operator-token-32-characters";
const workerToken = "private-generation-worker-token-32-characters";
const backendToken = "private-generation-backend-token-32-characters";
const creation = {
  operatorToken,
  acknowledgement: "fictional-unpaid-codex-private-review-only",
  ownerSourceReference: "kanban:t_4b1eb28f",
  idempotencyKey: "private-codex-test-001",
};
function fixture() {
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  process.env.BEBEBONJOUR_PRIVATE_GENERATION_TESTS_ENABLED = "true";
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./privateGeneration.js": () => import("../../convex/privateGeneration.js"),
    "./privateGenerationRuntime.js": () => import("../../convex/privateGenerationRuntime.js"),
    "./generation.js": () => import("../../convex/generation.js"),
    "./operations.js": () => import("../../convex/operations.js"),
    "./automaticGeneration.js": () => import("../../convex/automaticGeneration.js"),
    "./http.js": () => import("../../convex/http.js"),
  });
}
async function create(t, overrides = {}) {
  return t.action(ref("privateGenerationRuntime:createFictionalTest"), { ...creation, ...overrides });
}
async function canonical(t, jobId) {
  return t.run(async (ctx) => ({
    customer: (await ctx.db.query("customerFlowJobs").withIndex("by_job_id", q => q.eq("jobId", jobId)).unique())?.job,
    fulfillment: (await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", jobId)).unique())?.aggregate,
    commands: await ctx.db.query("customerFlowOperationsCommands").collect(),
  }));
}

test("creation persists one fixed unpaid fictional job and exact authority without commands or approvals", async () => {
  const t = fixture();
  const result = await create(t);
  assert.equal(result.created, true);
  const job = await canonical(t, result.jobId);
  assert.equal(job.customer.payment.status, "not_applicable");
  assert.equal(job.fulfillment.payment, null);
  assert.equal(job.fulfillment.paymentCorrelation, null);
  assert.equal(job.fulfillment.state, "generation_queued");
  assert.equal(job.fulfillment.product, "operator_private_codex_test");
  assert.equal(job.fulfillment.narrationRequired, true);
  assert.equal(job.customer.intake.customer.email, "fictional-codex@example.invalid");
  assert.equal(job.customer.intake.baby.firstName, "Aélio-Z");
  assert.deepEqual(job.customer.privateTestAuthority, job.fulfillment.privateTestAuthority);
  assert.equal(job.customer.privateTestAuthority.ownerSourceReference, creation.ownerSourceReference);
  assert.equal(job.customer.privateTestAuthority.jobId, result.jobId);
  assert.equal(job.customer.privateTestAuthority.intakeDigest, job.customer.intakeDigest);
  assert.equal(job.commands.length, 0);
  assert.deepEqual(await t.run(ctx => ctx.db.query("fulfillmentGenerationEditorialApprovals").collect()), []);
  assert.deepEqual(await create(t), { ...result, created: false });
  await assert.rejects(create(t, { ownerSourceReference: "kanban:t_different_owner" }), /idempotency/u);
  assert.equal((await t.run(ctx => ctx.db.query("customerFlowJobs").collect())).length, 1);
  const projected = await t.query(ref("operations:getJob"), { operatorToken, jobId: result.jobId });
  assert.deepEqual(projected.availableActions, ["generate"]);
});

test("creation rejects disabled, worker/backend tokens, invalid acknowledgement and owner evidence", async () => {
  const t = fixture();
  process.env.BEBEBONJOUR_PRIVATE_GENERATION_TESTS_ENABLED = "false";
  await assert.rejects(create(t), /disabled or unauthorized/u);
  process.env.BEBEBONJOUR_PRIVATE_GENERATION_TESTS_ENABLED = "true";
  for (const token of ["wrong", workerToken, backendToken]) {
    await assert.rejects(create(t, { operatorToken: token }), /disabled or unauthorized/u);
  }
  for (const bad of [{ acknowledgement: "yes" }, { ownerSourceReference: "owner said yes" }, { idempotencyKey: "bad key" }]) {
    await assert.rejects(create(t, bad), /Invalid private fictional/u);
  }
  assert.equal((await t.run(ctx => ctx.db.query("customerFlowJobs").collect())).length, 0);
});

const hash = value => createHash("sha256").update(value).digest("hex");
function offlineCompositionReceipt(intake) {
  // Labelled offline prose fixture: no subscription/provider request is made.
  const composition = { schemaVersion: "1.0", languages: {
    ar: {
      description: "إعلان ولادة خاص للتجربة.",
      introLines: ["وصلت صغيرتنا بفرح هادئ."],
      introNarration: "وصلت صغيرتنا بفرح هادئ.",
      blessingLines: ["نسأل الله أن يبارك أيامها."],
      blessingNarration: "نسأل الله أن يبارك أيامها.",
      closingLines: ["أهلاً بك بيننا."], closingNarration: "أهلاً بك بيننا.",
    },
    fr: {
      description: "Annonce fictive de la fixture hors ligne.",
      introLines: ["Notre petite fille est arrivée."],
      introNarration: "Notre petite fille est arrivée.",
      blessingLines: ["Que ses jours soient doux."],
      blessingNarration: "Que ses jours soient doux.",
      closingLines: ["Bienvenue parmi nous."], closingNarration: "Bienvenue parmi nous.",
    },
  } };
  const requestBinding = { adapterVersion: "1.0.0", provider: "openai-codex-subscription",
    model: "offline-labelled-stub", request: buildCodexCompositionRequest(intake) };
  const { request: _request, ...metadata } = requestBinding;
  const receipt = { composition, metadata: { ...metadata,
    requestDigest: hash(JSON.stringify(requestBinding)), outputDigest: hash(JSON.stringify(composition)) } };
  assertValidCodexCompositionReceipt(receipt);
  return receipt;
}
async function offlineEditorialFixture(t, jobId) {
  // Synthetic policy fixture, NOT a real owner/content approval.
  const sourceEvidence = { kind: "kanban_human_decision", reference: "kanban:t_offline_fixture_only" };
  const record = { schemaVersion: "1.0", approvalType: "job_scoped_editorial_policy", jobId,
    policy: { id: "unknown_name_general_wishes", preserveSubmittedName: true, meaningAllowed: false,
      scripturalNameAssociationAllowed: false, genericBlessingsAllowed: true, maxStage: "content_review_required" },
    sourceEvidence, sourceDigest: hash(JSON.stringify(sourceEvidence)) };
  await t.mutation(ref("generation:saveEditorialApproval"), { backendToken, jobId,
    approval: { record, recordDigest: hash(`${JSON.stringify(record, null, 2)}\n`) } });
}
async function requestGenerate(t, jobId) {
  const { fulfillment } = await canonical(t, jobId);
  return t.mutation(ref("operations:requestCommand"), { operatorToken, jobId,
    commandId: "command_private_codex_offline_001", action: "generate", payload: {},
    expectedState: fulfillment.state, expectedVersion: fulfillment.version });
}
function offlineRuntime(t, options = {}) {
  let compositions = 0;
  const errors = [];
  const trace = [];
  const client = {
    query: async (name, args) => {
      if (options.rejectCustomerRead && name === "generation:readClaimedCustomerJob") {
        trace.push("customer_read_failed_before_effect");
        throw new Error("Offline customer read failure before Operations effect fence.");
      }
      try { return await t.query(ref(name), args); }
      catch (error) { errors.push(`${name}: ${error.message}`); throw error; }
    },
    mutation: async (name, args) => {
      try {
        if (name === "operations:failCommand" && options.rejectCustomerRead) {
          const source = await t.run(ctx => ctx.db.query("customerFlowOperationsCommands").first());
          assert.equal(source.claim.effectStartedAtMs, undefined);
          trace.push("command_failure_without_effect_fence");
        }
        const result = await t.mutation(ref(name), args);
        if (name === "operations:fenceCommand" && args.effectMayBeIssued && result.active) trace.push("effect_fenced");
        if (name === "generation:commitArtifactSet") {
          trace.push("artifact_committed");
          options.changeCommitReadback?.(result);
        }
        return result;
      }
      catch (error) { errors.push(`${name}: ${error.message}`); throw error; }
    },
  };
  const run = () => runOperationsWorkerCommand({
    environment: { CONVEX_URL: "https://offline.convex.cloud",
      BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: workerToken,
      BEBEBONJOUR_OPERATIONS_WORKER_ID: "private-offline-worker",
      BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate", BEBEBONJOUR_OPERATIONS_WORKER_LIMIT: "1",
      BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS: "300000", BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED: "true",
      BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64url"),
      BEBEBONJOUR_CODEX_MODEL: "offline-labelled-stub", BEBEBONJOUR_CODEX_TIMEOUT_MS: "240000",
      BEBEBONJOUR_CODEX_AUTH_LEASE_MS: "290000", CRON_SECRET: "offline-cron-secret-32-characters-long" },
    client,
    fetchImpl: async (url, options = {}) => {
      if (options.method === "POST") {
        const storageId = await t.run(ctx => ctx.storage.store(new Blob([options.body])));
        return new Response(JSON.stringify({ storageId }), { headers: { "content-type": "application/json" } });
      }
      const parsed = new URL(url);
      assert.equal(parsed.hostname, "offline.convex.site");
      return t.fetch(`${parsed.pathname}${parsed.search}`, options);
    },
    createCodexAuthStateStore: () => ({ kind: "offline-labelled-auth-stub" }),
    createCodexRuntime: async () => "/offline-labelled-codex-stub",
    createCodexComposer: () => ({ compose: async intake => {
      assert.ok(trace.includes("effect_fenced"), "composition must follow the real effect fence");
      trace.push("offline_composed");
      compositions++;
      return offlineCompositionReceipt(intake);
    } }),
    createGenerationRunner: runnerOptions => {
      const prepareReview = createLocalPrepareReviewStageHandler({
        resolveJobPaths: runnerOptions.workspace.resolveJobPaths,
        collectArtifactSet: runnerOptions.workspace.collectArtifactSet,
        cleanupStageOutput: async input => {
          await runnerOptions.workspace.cleanupStageOutput(input);
          if (options.failPrepareReview) trace.push("stage_output_cleaned");
        },
        compose: runnerOptions.compose,
        prepareReview: options.failPrepareReview ? async (_args, dependencies) => {
          assertValidCodexCompositionReceipt(dependencies.composition);
          trace.push("prepare_review_failed_after_composition");
          throw new Error("Offline deterministic prepareReview failure after successful composer.");
        } : commandPrepareReview,
      });
      return createTestAGenerationRunner({
        ...runnerOptions,
        prepareReview: async context => {
          try { return await prepareReview(context); }
          catch (error) { errors.push(`prepare-review: ${error.name}: ${error.message}`); throw error; }
        },
      });
    },
    clock: () => new Date().toISOString(), tokenFactory: () => "private-offline-stage-lease",
  });
  return { run, errors, trace, get compositions() { return compositions; } };
}

test("production failed generate command follows pre-fence rejection without composer or stage writes", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  await offlineEditorialFixture(t, jobId);
  await requestGenerate(t, jobId);
  const before = await canonical(t, jobId);
  const runtime = offlineRuntime(t, { rejectCustomerRead: true });
  const result = await runtime.run();
  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.equal(runtime.compositions, 0);
  assert.deepEqual(runtime.trace, ["customer_read_failed_before_effect", "command_failure_without_effect_fence"]);
  const after = await canonical(t, jobId);
  assert.deepEqual(after.customer, before.customer);
  assert.deepEqual(after.fulfillment, before.fulfillment);
  assert.equal(after.commands.length, 1);
  const source = await t.run(ctx => ctx.db.query("customerFlowOperationsCommands").first());
  assert.equal(source.state, "failed");
  assert.equal(source.claim, null);
  assert.equal(source.lastFailureReason, "generation_backend_failed");
  assert.equal(source.attempts, 1);
  assert.deepEqual(before.fulfillment.stageAttempts, []);
  assert.deepEqual(before.fulfillment.artifactSets, []);
});

test("successful composer followed by prepareReview failure cannot authorize pre-effect retry", async () => {
  const t = fixture();
  const { jobId, intakeDigest } = await create(t);
  await offlineEditorialFixture(t, jobId);
  await requestGenerate(t, jobId);
  const runtime = offlineRuntime(t, { failPrepareReview: true });
  const result = await runtime.run();
  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.equal(runtime.compositions, 1);
  assert.deepEqual(runtime.trace, ["effect_fenced", "offline_composed",
    "prepare_review_failed_after_composition", "stage_output_cleaned"]);
  assert.deepEqual(runtime.errors, ["prepare-review: Error: Offline deterministic prepareReview failure after successful composer."]);
  const snapshot = () => t.run(async ctx => Object.fromEntries(await Promise.all([
    ...Object.keys(schema.tables),
  ].map(async table => [table, await ctx.db.query(table).collect()]))));
  const before = await snapshot();
  const aggregate = before.fulfillmentJobs[0].aggregate;
  const command = before.customerFlowOperationsCommands[0];
  const attempt = aggregate.stageAttempts[0];
  assert.equal(command.state, "reconciliation_required");
  assert.equal(command.lastFailureReason, "generation_stage_failed");
  assert.equal(command.claim, null);
  assert.equal(aggregate.state, "failed");
  assert.equal(aggregate.version, 3);
  assert.equal(attempt.status, "failed");
  // These fields fence only publish/deliver, NOT the prepare_review composer.
  assert.equal(attempt.effectStartedAt, null);
  assert.equal(attempt.operationBinding, null);
  assert.deepEqual(aggregate.artifactSets, []);
  assert.deepEqual(aggregate.revisions, []);
  assert.deepEqual(before.fulfillmentGenerationArtifactSets, []);
  const args = { operatorToken, jobId, intakeDigest, sourceCommandId: command.commandId,
    failedAttemptId: attempt.attemptId, expectedVersion: aggregate.version,
    editorialApprovalDigest: before.fulfillmentGenerationEditorialApprovals[0].approval.recordDigest,
    recoveryId: "private_retry_post_composer_001" };
  // Observe attempted DB writes directly: transaction rollback alone is not proof.
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
    await assert.rejects(retryPreEffectFailure._handler({ ...ctx, db }, args), /provider absence unproven/u);
  });
  assert.deepEqual(writes, []);
  await assert.rejects(t.mutation(ref("privateGeneration:retryPreEffectFailure"), args), /provider absence unproven/u);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await t.query(ref("operations:getJob"), { operatorToken, jobId })).availableActions, ["reconcile"]);
  assert.equal((await runtime.run()).claimed, 0);
  assert.equal(runtime.compositions, 1);
  assert.deepEqual(await snapshot(), before);
});

test("pending unfenced private command runs actual worker into immutable review artifacts; replay is inert", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  await offlineEditorialFixture(t, jobId);
  assert.equal((await canonical(t, jobId)).commands.length, 0, "policy persistence must not autoqueue unpaid jobs");
  await requestGenerate(t, jobId);
  const pending = (await canonical(t, jobId)).commands[0];
  assert.equal(pending.state, "pending");
  assert.equal(pending.claim, null);
  const runtime = offlineRuntime(t);
  const result = await runtime.run();
  assert.equal(result.completed, 1, runtime.errors.join("; "));
  assert.equal(result.failed, 0);
  assert.equal(runtime.compositions, 1);
  assert.deepEqual(runtime.trace, ["effect_fenced", "offline_composed", "artifact_committed"]);
  const generated = await canonical(t, jobId);
  assert.equal(generated.fulfillment.state, "content_review_required");
  assert.equal(generated.fulfillment.reviewDecisions.length, 0);
  assert.equal(generated.fulfillment.payment, null);
  assert.equal(generated.fulfillment.artifactSets.length, 1);
  assert.equal(generated.commands[0].state, "completed");
  const artifacts = await t.run(ctx => ctx.db.query("fulfillmentGenerationArtifactSets").collect());
  assert.equal(artifacts.length, 1);
  for (const file of artifacts[0].artifactSet.files) {
    const bytes = Buffer.from(await t.run(async ctx => (await ctx.storage.get(file.storageId)).arrayBuffer()));
    assert.equal(hash(bytes), file.sha256);
  }
  const dossierFile = artifacts[0].artifactSet.files.find(file => file.path === "review.json");
  assert.ok(dossierFile);
  const dossier = JSON.parse(Buffer.from(await t.run(async ctx => (await ctx.storage.get(dossierFile.storageId)).arrayBuffer())).toString("utf8"));
  assert.equal(dossier.generationMaterials.composition.model, "offline-labelled-stub");
  assert.equal(dossier.review.status, "draft");
  const again = await runtime.run();
  assert.equal(again.claimed, 0);
  assert.equal(runtime.compositions, 1);
  assert.deepEqual(await canonical(t, jobId), generated);
  assert.deepEqual(await create(t), { jobId, intakeDigest: generated.customer.intakeDigest, created: false });
});

test("creation token cannot alias completion or rate-limit service roles", async () => {
  const t = fixture();
  for (const role of ["BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN"]) {
    const previous = process.env[role];
    process.env[role] = operatorToken;
    try { await assert.rejects(create(t), /disabled or unauthorized/u, role); }
    finally {
      if (previous === undefined) delete process.env[role];
      else process.env[role] = previous;
    }
  }
  assert.equal((await t.run(ctx => ctx.db.query("customerFlowJobs").collect())).length, 0);
});

test("private job IDs remain contained when product and authority markers are stripped", async () => {
  assert.equal(isPrivateGenerationJob({ jobId: "job_private_codex_customer" }, {}), true);
  assert.equal(isPrivateGenerationJob({}, { jobId: "job_private_codex_fulfillment" }), true);
  assert.equal(isPrivateGenerationJob({ jobId: "job_normal_paid_customer" }, { jobId: "job_normal_paid_customer", product: "announcement-page" }), false);
  const t = fixture();
  const { jobId } = await create(t);
  await t.run(async ctx => {
    const customer = await ctx.db.query("customerFlowJobs").first();
    const fulfillment = await ctx.db.query("fulfillmentJobs").first();
    delete customer.job.privateTestAuthority;
    delete fulfillment.aggregate.privateTestAuthority;
    fulfillment.aggregate.product = "announcement-page";
    fulfillment.aggregate.state = "awaiting_payment";
    await ctx.db.patch(customer._id, { job: customer.job });
    await ctx.db.patch(fulfillment._id, { aggregate: fulfillment.aggregate });
  });
  const projected = await t.query(ref("operations:getJob"), { operatorToken, jobId });
  assert.deepEqual(projected.availableActions, []);
  await assert.rejects(t.mutation(ref("operations:requestCommand"), {
    operatorToken, jobId, commandId: "command_private_stripped_checkout", action: "create_checkout",
    payload: {}, expectedState: "awaiting_payment", expectedVersion: 1,
  }), /not available/u);
});

test("real worker rejects a materially divergent artifact commit readback, not just reordered keys", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  await offlineEditorialFixture(t, jobId);
  await requestGenerate(t, jobId);
  const runtime = offlineRuntime(t, { changeCommitReadback: result => {
    result.artifactSet.pageDigest = "0".repeat(64);
  } });
  const result = await runtime.run();
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(runtime.errors, ["prepare-review: Error: Convex generation artifact commit readback diverged."]);
  const job = await canonical(t, jobId);
  assert.equal(job.fulfillment.artifactSets.length, 0);
  assert.equal(job.fulfillment.state, "failed");
  assert.equal(job.commands[0].state, "reconciliation_required");
});

test("forged markers and mismatched private authority fail before the offline provider boundary", async () => {
  for (const change of [
    (c, f) => { c.privateTestAuthority = true; f.privateTestAuthority = true; },
    (c, f) => { f.privateTestAuthority.intakeDigest = "0".repeat(64); },
    (c, f) => { f.environment = "production"; },
    (c, f) => { f.product = "announcement-page"; },
    (c, f) => { c.intake.baby.firstName = "Real Name"; },
    (c, f) => { c.privateTestAuthority.jobId = "job_other_job"; },
  ]) {
    const t = fixture();
    const { jobId } = await create(t);
    await offlineEditorialFixture(t, jobId);
    await requestGenerate(t, jobId);
    await t.run(async ctx => {
      const c = await ctx.db.query("customerFlowJobs").first();
      const f = await ctx.db.query("fulfillmentJobs").first();
      change(c.job, f.aggregate);
      await ctx.db.patch(c._id, { job: c.job });
      await ctx.db.patch(f._id, { aggregate: f.aggregate });
    });
    const runtime = offlineRuntime(t);
    const result = await runtime.run();
    assert.equal(result.completed, 0);
    assert.equal(runtime.compositions, 0);
    assert.equal((await canonical(t, jobId)).fulfillment.artifactSets.length, 0);
  }
});
