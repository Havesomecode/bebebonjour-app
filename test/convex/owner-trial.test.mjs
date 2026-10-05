import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";
import { spawnSync } from "node:child_process";
import { runProductionNarrationWorkerCommand } from "../../src/operations/production-narration-worker.mjs";
import { generateNarration } from "../../src/narration/narration-media.mjs";
import { createHash } from "node:crypto";
import { runOperationsWorkerCommand } from "../../src/operations/operations-worker-startup.mjs";
import { createTestAGenerationRunner } from "../../src/fulfillment/test-a-generation-runner.mjs";
import { commandPrepareReview } from "../../scripts/lib/commands.mjs";
import { createLocalPrepareReviewStageHandler } from "../../src/fulfillment/local-prepare-review-stage-handler.mjs";
import {
  assertValidCodexCompositionReceipt,
  buildCodexCompositionRequest,
} from "../../scripts/lib/codex-subscription-composition.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");

const operatorToken = "owner-trial-operator-token-at-least-32-bytes";
const workerToken = "owner-trial-generation-token-at-least-32-bytes";
const completionToken = "owner-trial-completion-token-at-least-32-bytes";
const controlToken = "owner-trial-narration-control-token-32-bytes";
const ttsToken = "owner-trial-tts-token-at-least-32-bytes";
const backendToken = "owner-trial-backend-token-at-least-32-bytes";
const hmacKey = "owner-trial-approval-hmac-key-at-least-32-bytes";
const origin = "https://owner-trial.example.invalid";
function fixture() {
  Object.assign(process.env, { BEBEBONJOUR_OWNER_TRIAL_ENABLED: "true",
    BEBEBONJOUR_OPERATIONS_TOKEN: operatorToken, BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: workerToken,
    BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: completionToken,
    BEBEBONJOUR_NARRATION_WORKER_TOKEN: controlToken, BEBEBONJOUR_TTS_WORKER_TOKEN: ttsToken,
    CUSTOMER_FLOW_BACKEND_TOKEN: backendToken, BEBEBONJOUR_APPROVAL_HMAC_KEY: hmacKey });
  return convexTest(schema, Object.fromEntries(["ownerTrial", "ownerTrialRuntime", "ownerTrialCompletion", "ownerTrialPublicationSupersession", "ownerTrialCompletionContinuation", "ownerTrialPublicationRecovery", "operations", "generation",
    "automaticGeneration", "narration", "narrationRuntime", "fulfillment", "http"].map(name =>
    [`./${name}.js`, () => import(`../../convex/${name}.js`)]).concat([
      ["./_generated/server.js", () => import("convex/server")]])));
}
async function issue(t, overrides = {}) {
  return t.action(ref("ownerTrialRuntime:issueTicket"), { operatorToken,
    idempotencyKey: "trial-offline-001", ownerSourceReference: "kanban:t_4b1eb28f",
    recipient: "z@havesomecode.io", origin, expiresAt: new Date(Date.now() + 3600000).toISOString(), ...overrides });
}
async function redeem(t, ticket, overrides = {}) {
  return t.action(ref("ownerTrialRuntime:redeemTicket"), { operatorToken, ticketSecret: ticket.ticketSecret,
    jobId: ticket.jobId, recipient: "z@havesomecode.io", ...overrides });
}
async function snapshot(t) {
  return t.run(async ctx => Object.fromEntries(await Promise.all(Object.keys(schema.tables)
    .map(async name => [name, await ctx.db.query(name).collect()]))));
}

test("one-use owner-bound ticket atomically admits immutable waived-payment trial; exact replay has no effects", async () => {
  const t = fixture(); const ticket = await issue(t);
  assert.match(ticket.ticketSecret, /^[a-f0-9]{64}$/u);
  assert.match(ticket.jobId, /^job_owner_trial_[a-f0-9]{32}$/u);
  assert.equal(JSON.stringify(await snapshot(t)).includes(ticket.ticketSecret), false);
  const result = await redeem(t, ticket);
  assert.equal(result.created, true);
  const state = await snapshot(t);
  assert.equal(state.customerFlowJobs.length, 1);
  const customer = state.customerFlowJobs[0].job, job = state.fulfillmentJobs[0].aggregate;
  assert.equal(customer.payment.status, "waived");
  assert.equal(job.payment, null); assert.equal(job.paymentCorrelation, null);
  assert.equal(job.state, "generation_queued");
  assert.equal(customer.intake.customer.email, "z@havesomecode.io");
  assert.deepEqual(customer.intake.baby, { firstName: "Aélio-Z", nameArabic: "أيليو", gender: "girl" });
  assert.equal(customer.ownerTrialAuthority.ownerSourceReference, "kanban:t_4b1eb28f");
  assert.deepEqual(job.ownerTrialAuthority, customer.ownerTrialAuthority);
  assert.equal(state.fulfillmentGenerationEditorialApprovals.length, 1);
  assert.equal(state.customerFlowOperationsCommands.length, 0);
  assert.deepEqual(await redeem(t, ticket), { ...result, created: false });
  assert.deepEqual(await snapshot(t), state);
  const again = await issue(t, { expiresAt: ticket.expiresAt });
  assert.equal(again.issued, false); assert.equal(again.ticketSecret, undefined);
  assert.deepEqual(await snapshot(t), state);
  const projected = await t.query(ref("operations:getJob"), { operatorToken, jobId: ticket.jobId });
  assert.deepEqual(projected.availableActions, ["generate"]);
});

test("protected trial feedback reports actual stages without secrets or invented approvals", async () => {
  const t = fixture(), ticket = await issue(t); await redeem(t, ticket);
  const args = { operatorToken, jobId: ticket.jobId };
  await assert.rejects(t.action(ref("ownerTrialRuntime:feedback"), { ...args, operatorToken: "wrong" }));
  const progress = await t.action(ref("ownerTrialRuntime:feedback"), args);
  assert.equal(progress.state, "generation_queued");
  assert.equal(progress.paymentDisposition, "complimentary_waiver");
  assert.equal(progress.reviewMode, "delegated_owner_trial");
  assert.deepEqual(progress.reviewDecisions, []);
  assert.deepEqual(progress.commands, []);
  assert.equal(progress.events.at(-1).type, "owner_trial_payment_waived");
  assert.equal(JSON.stringify(progress).includes(ticket.ticketSecret), false);
  assert.equal(JSON.stringify(progress).includes(operatorToken), false);
});

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
async function aggregate(t, jobId) {
  return t.run(async ctx => (await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", jobId)).unique()).aggregate);
}
async function request(t, jobId, action, payload = {}) {
  const job = await aggregate(t, jobId);
  return t.mutation(ref("operations:requestCommand"), { operatorToken, jobId,
    commandId: `command_owner_trial_${action}_${job.version}`, action, payload,
    expectedState: job.state, expectedVersion: job.version });
}
test("complimentary trial reaches real generation seam then truthful signed delegated content review", async () => {
  const t = fixture(), ticket = await issue(t); await redeem(t, ticket);
  await request(t, ticket.jobId, "generate");
  const runtime = offlineRuntime(t), output = await runtime.run();
  assert.deepEqual(runtime.errors, []);
  assert.equal(output.completed, 1); assert.equal(runtime.compositions, 1);
  const job = await aggregate(t, ticket.jobId);
  assert.equal(job.state, "content_review_required");
  const artifact = job.artifactSets.at(-1);
  const reviewed = await t.action(ref("ownerTrialRuntime:review"), { operatorToken, jobId: ticket.jobId,
    decisionType: "content", expectedVersion: job.version, artifactManifestDigest: artifact.assetManifestDigest,
    evidenceDigest: hash("offline-labelled-delegated-inspection-fixture-not-real-review"),
    acknowledgement: "delegated-owner-trial-content-inspected-not-owner-acceptance" });
  assert.equal(reviewed.state, "render_queued");
  const next = await aggregate(t, ticket.jobId), decision = next.reviewDecisions.at(-1);
  assert.equal(decision.reviewer.role, "delegated_owner_trial");
  assert.equal(decision.rubricVersion, "delegated-owner-trial-content-v1");
  assert.equal(next.events.at(-1).type, "review_decision_recorded");
  assert.equal((await snapshot(t)).fulfillmentReviewApprovals.length, 1);
});
async function delegatedReview(t, jobId, type) {
  const job = await aggregate(t, jobId), artifact = job.artifactSets.at(-1);
  return t.action(ref("ownerTrialRuntime:review"), { operatorToken, jobId, decisionType: type,
    expectedVersion: job.version, artifactManifestDigest: artifact.assetManifestDigest,
    evidenceDigest: hash(`offline-labelled-${type}-inspection-not-real-review`),
    acknowledgement: `delegated-owner-trial-${type}-inspected-not-owner-acceptance` });
}
function clientFor(t) {
  return Object.fromEntries(["query", "mutation", "action"].map(k => [k, (name, args) => t[k](ref(name), args)]));
}
async function renderTrial(t, jobId) {
  const requested = await request(t, jobId, "render");
  const [c] = await t.mutation(ref("operations:claimCommands"), { workerToken: controlToken,
    workerId: "hosted-narration-worker", jobId, actions: ["render"], limit: 1, leaseMs: 300000 });
  assert.equal(c.commandId, requested.command.commandId);
  const auth = { workerToken: controlToken, workerId: "hosted-narration-worker", jobId,
    commandId: c.commandId, leaseToken: c.claim.leaseToken };
  const outcome = await t.action(ref("narrationRuntime:advance"), { ...auth, operation: "render" });
  const { jobId: _id, ...completionAuth } = auth;
  await t.mutation(ref("operations:completeCommand"), { ...completionAuth, outcome });
}
async function narratedTrial() {
  const t = fixture(), ticket = await issue(t); await redeem(t, ticket);
  await request(t, ticket.jobId, "generate"); const generation = offlineRuntime(t);
  assert.equal((await generation.run()).completed, 1); assert.deepEqual(generation.errors, []);
  await delegatedReview(t, ticket.jobId, "content"); await renderTrial(t, ticket.jobId);
  await request(t, ticket.jobId, "generate_narration");
  const tone = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=660:sample_rate=24000", "-t", "0.65", "-ac", "1", "-codec:a", "libmp3lame", "-f", "mp3", "pipe:1"]);
  assert.equal(tone.status, 0); const speechInputs = []; let approvedPage;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.openai.com") {
      const body = JSON.parse(init.body); assert.equal(body.voice, "cedar");
      assert.equal(body.model, "gpt-4o-mini-tts"); speechInputs.push(body.input);
      return new Response(tone.stdout, { headers: { "content-type": "audio/mpeg" } });
    }
    if (init.method === "POST") {
      const storageId = await t.run(ctx => ctx.storage.store(new Blob([init.body])));
      return new Response(JSON.stringify({ storageId }));
    }
    assert.equal(parsed.hostname, "offline.convex.site");
    const response = await t.fetch(parsed.pathname + parsed.search, init);
    if (parsed.searchParams.get("path") === "artifacts/current/page.json") approvedPage = await response.clone().json();
    return response;
  };
  const narrationErrors = [];
  const diagnosticClient = Object.fromEntries(Object.entries(clientFor(t)).map(([method, invoke]) => [method,
    async (name, args) => {
      try {
        const result = await invoke(name, args);
        // convex-test issues a fake storage origin. Preserve the real dual-fence
        // authorization mutation, then map only the offline transport endpoint.
        return name === "narration:createUploadUrl"
          ? "https://offline.convex.cloud/api/storage/upload" : result;
      }
      catch (error) { narrationErrors.push(`${name}: ${error.message}`); throw error; }
    }]));
  const output = await runProductionNarrationWorkerCommand({ jobId: ticket.jobId, client: diagnosticClient, fetch,
    generateNarration: async args => {
      try { return await generateNarration(args); }
      catch (error) { narrationErrors.push(`media: ${error.message}`); throw error; }
    },
    environment: { CONVEX_URL: "https://offline.convex.cloud", CONVEX_SITE_URL: "https://offline.convex.site",
      BEBEBONJOUR_TTS_WORKER_TOKEN: ttsToken, OPENAI_API_KEY: "offline-labelled-provider-token-32-bytes",
      CRON_SECRET: "offline-labelled-cron-token-32-bytes" } });
  assert.equal(output.completed, 1, JSON.stringify({ output, narrationErrors }));
  assert.deepEqual(speechInputs, approvedPage.languages.flatMap(language =>
    approvedPage.sectionOrder.map(section => approvedPage.sections[section][language].narrationText)));
  assert.equal((await aggregate(t, ticket.jobId)).state, "narration_review_required");
  await delegatedReview(t, ticket.jobId, "narration");
  return { t, ticket, fetch };
}

test("revoked trial authority cannot queue or claim narration effects", async () => {
  const t = fixture(), ticket = await issue(t); await redeem(t, ticket);
  await request(t, ticket.jobId, "generate");
  assert.equal((await offlineRuntime(t).run()).completed, 1);
  await delegatedReview(t, ticket.jobId, "content");
  await renderTrial(t, ticket.jobId);
  assert.equal((await aggregate(t, ticket.jobId)).state, "tts_queued");
  const pending = await request(t, ticket.jobId, "generate_narration");
  await t.run(async ctx => {
    const authority = await ctx.db.query("ownerTrialTickets")
      .withIndex("by_ticket_id", q => q.eq("ticketId", ticket.ticketId)).unique();
    await ctx.db.patch(authority._id, { redeemed: false });
  });
  const before = await snapshot(t);
  await assert.rejects(t.mutation(ref("operations:claimCommands"), {
    workerToken: ttsToken, workerId: "hosted-narration-worker", actions: ["generate_narration"],
    limit: 1, leaseMs: 300_000, jobId: ticket.jobId,
  }), /Owner trial/);
  assert.deepEqual(await snapshot(t), before);
  await assert.rejects(t.mutation(ref("operations:requestCommand"), {
    operatorToken, jobId: ticket.jobId, action: "generate_narration",
    commandId: `${pending.command.commandId}_revoked`, expectedState: "tts_queued",
    expectedVersion: (await aggregate(t, ticket.jobId)).version, payload: {},
  }), /Owner trial/);
  assert.deepEqual(await snapshot(t), before);
});
test("canonical waived trial runs production narration and completion seams with sanitized publication and owner-only delivery", async () => {
  const { t, ticket, fetch } = await narratedTrial();
  const { runOwnerTrialCompletionWorkerCommand } = await import("../../src/operations/owner-trial-completion-worker.mjs");
  const policy = await t.query(ref("ownerTrial:completionPolicy"), { completionToken, jobId: ticket.jobId });
  assert.equal(policy.recipient, "z@havesomecode.io"); assert.equal(policy.origin, origin);
  const calls = { publish: 0, sends: [] };
  const publicationProvider = { reconcile: async () => null, publish: async req => {
    calls.publish++;
    assert.equal(req.artifactSet.kind, "narration_review");
    return req.fenceExternalEffect({ effectMayBeIssued: true }, async () => ({ provider: "vercel",
      providerReceiptId: "offline-labelled-vercel-receipt", revisionId: policy.revisionId,
      stableUrl: `${origin}/announcements/${ticket.jobId}`, artifactManifestDigest: policy.manifestDigest,
      idempotencyKey: req.idempotencyKey }));
  } };
  const resend = { emails: { send: async (args, opts) => {
    calls.sends.push({ args, opts }); return { data: { id: "offline-labelled-resend-id" } };
  } } };
  const inspection = { schemaVersion: "1.0", revisionId: policy.revisionId, teamId: "team_offline",
    projectId: "prj_offline", projectName: "owner-trial-offline", framework: null, buildCommand: null,
    devCommand: null, installCommand: null, outputDirectory: null };
  const options = { client: clientFor(t), jobId: ticket.jobId, fetch, publicationProvider, resend,
    environment: { CONVEX_URL: "https://offline.convex.cloud", BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: completionToken,
      BEBEBONJOUR_APPROVAL_HMAC_KEY: hmacKey, OWNER_TRIAL_VERCEL_BUILD_INSPECTION_B64: Buffer.from(JSON.stringify(inspection)).toString("base64"),
      OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID: inspection.teamId, OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID: inspection.projectId,
      OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME: inspection.projectName, VERCEL_TOKEN: "offline-labelled-vercel-token",
      RESEND_API_KEY: "re_offline-labelled", OWNER_TRIAL_RESEND_FROM: "Bebe <offline@example.invalid>" } };
  for (const action of ["publish", "queue_delivery", "deliver"]) {
    const job = await aggregate(t, ticket.jobId);
    const payload = { revisionId: policy.revisionId, artifactManifestDigest: policy.manifestDigest,
      ...(action !== "publish" ? { publicationId: job.publication.providerReceiptId } : {}) };
    await request(t, ticket.jobId, action, payload);
    const outcome = await runOwnerTrialCompletionWorkerCommand(options);
    assert.equal(outcome.completed, 1, JSON.stringify(outcome));
  }
  assert.equal((await aggregate(t, ticket.jobId)).state, "sent");
  assert.equal(calls.publish, 1); assert.equal(calls.sends.length, 1);
  assert.deepEqual(calls.sends[0].args.to, ["z@havesomecode.io"]);
  assert.equal(calls.sends[0].args.cc, undefined); assert.equal(calls.sends[0].args.bcc, undefined);
  assert.ok(calls.sends[0].args.html.includes(`${origin}/announcements/${ticket.jobId}`));
  const beforeReplay = await snapshot(t);
  assert.equal((await runOwnerTrialCompletionWorkerCommand(options)).claimed, 0);
  assert.deepEqual(await snapshot(t), beforeReplay);
  assert.equal(calls.publish, 1); assert.equal(calls.sends.length, 1);
});
