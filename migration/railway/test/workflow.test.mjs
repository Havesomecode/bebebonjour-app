import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commandApproveNarration, commandApproveReview, commandDeploy, commandPrepareReview, commandRender,
  commandSend, commandStatus, commandTts } from "../../../scripts/lib/commands.mjs";
import { createFulfillmentOrchestrator, EDITORIAL_POLICY_VERSION } from "../../../src/fulfillment/job-orchestrator.mjs";
import { createLocalCommandStageHandlers } from "../../../src/fulfillment/local-command-stage-handlers.mjs";
import { createLocalGenerationWorkspace } from "../../../src/fulfillment/local-generation-workspace.mjs";
import { createCustomerFlowService } from "../../../src/customer-flow/service.mjs";
import { createPostgresCustomerStore } from "../customer-store.mjs";
import { createPostgresFulfillmentStore } from "../fulfillment-store.mjs";
import { openTestDatabase } from "./database.mjs";

const stages = ["prepare_review", "render_approved", "generate_tts", "publish", "deliver"];
const policy = {
  leaseMsByStage: Object.fromEntries(stages.map((s) => [s, 300_000])),
  maxAttemptsByStage: Object.fromEntries(stages.map((s) => [s, 3])),
  backoffMsByStage: Object.fromEntries(stages.map((s) => [s, [1_000, 1_000, 1_000]])),
};
const digestsOf = (a) => ({ pageDigest: a.pageDigest, transcriptDigest: a.transcriptDigest, assetManifestDigest: a.assetManifestDigest });
async function silent(action) {
  const previous = console.log;
  console.log = () => {};
  try { return await action(); } finally { console.log = previous; }
}

test("real local render traverses PostgreSQL payment, retry, exact review and dry-run completion", async (t) => {
  const db = await openTestDatabase(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-railway-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldKey = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = "synthetic-railway-approval-only-not-production";
  const oldFetch = globalThis.fetch;
  const oldApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-no-network";
  const existingTracer = await readFile(new URL("../../../test/integration/fulfillment-workflow-tracer.test.mjs", import.meta.url), "utf8");
  const fixture = /const SYNTHETIC_MP3 = Buffer.from\(\s*"([^"]+)"/.exec(existingTracer);
  assert.ok(fixture, "Reuse the existing tracer's synthetic audio fixture, never a live provider.");
  const mp3 = Buffer.from(fixture[1], "base64");
  let ttsCalls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://api.openai.com/v1/audio/speech");
    ttsCalls++;
    return { ok: true, arrayBuffer: async () => Uint8Array.from(mp3).buffer };
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldApiKey;
    if (oldKey === undefined) delete process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
    else process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = oldKey;
  });
  const workspace = createLocalGenerationWorkspace({ rootPath: path.join(root, "generation") });
  let now = "2026-11-08T00:00:00.000Z";
  let prepareCalls = 0;
  const handlers = {
    ...createLocalCommandStageHandlers({
      commands: {
        prepareReview: async (args, options) => {
          prepareCalls++;
          if (prepareCalls === 1) throw Object.assign(new Error("synthetic interruption"), { retryable: true, reasonCode: "synthetic_interruption" });
          return silent(() => commandPrepareReview(args, options));
        },
        render: (args) => silent(() => commandRender(args)),
        tts: (args) => silent(() => commandTts(args)),
        deploy: (args) => silent(() => commandDeploy(args)),
        send: (args) => silent(() => commandSend(args)),
        status: (args) => silent(() => commandStatus(args)),
      },
      resolveJobPaths: workspace.resolveJobPaths,
      collectArtifactSet: workspace.collectArtifactSet,
      cleanupStageOutput: workspace.cleanupStageOutput,
    }),
    // Synthetic test trust boundary only; never wired by the HTTP runtime.
    verify_review_decision: async ({ decision }) => decision,
    verify_delivery_confirmation: async ({ confirmation }) => {
      if (confirmation.verificationToken !== "synthetic-independent-confirmation") throw new Error("Unverified delivery.");
      const { verificationToken: _token, ...verified } = confirmation;
      return verified;
    },
  };

  let store = createPostgresFulfillmentStore({ pool: db.pool });
  const make = () => createFulfillmentOrchestrator({ store, handlers, clock: () => now,
    tokenFactory: () => `synthetic-${randomUUID()}`, retryPolicy: policy });
  let orchestrator = make();
  const customerStore = createPostgresCustomerStore({ pool: db.pool, tokenEncryptionKey: Buffer.alloc(32, 9).toString("base64") });
  const service = createCustomerFlowService({ store: customerStore,
    paymentGateway: { createCheckoutSession: async (request) => ({ id: `cs_${request.jobId}`, url: "https://checkout.stripe.com/test", mode: "test" }) },
    fulfillmentOrchestrator: orchestrator, atomicFulfillment: true, now: () => now });
  const intake = JSON.parse(await readFile(new URL("../../../data/examples/amal/intake.json", import.meta.url), "utf8"));
  intake.customer.email = "railway-workflow@example.test";
  intake.customer.consent = true;
  intake.notes.specificDemands = "";
  intake.voicePreference.enabled = true;
  const submission = await service.submitIntake(intake, { idempotencyKey: `tracer:${randomUUID()}` });
  const id = submission.jobId;
  const job = await customerStore.readJob(id);
  await workspace.persistJobInput({ jobId: id, intakeDigest: job.intakeDigest, intake });
  assert.equal(await orchestrator.runNext(id), null);
  await assert.rejects(() => orchestrator.queueDelivery(id, { commandId: "forbidden-before-payment" }), /published exact revision/i);
  const checkout = await service.createCheckout(id, submission.intakeToken);
  await service.recordPaymentSucceeded({ providerEventId: `evt_${id}`, sessionId: checkout.sessionId,
    paymentIntentId: `pi_${id}`, amountMinor: 3900, currency: "eur", livemode: false, metadata: checkout.metadata });
  assert.equal((await orchestrator.runNext(id)).state, "retry_wait");
  assert.equal(await orchestrator.runNext(id), null);
  now = "2026-11-08T00:00:02.000Z";
  // A fresh pool represents an application restart; no process-local state is needed.
  store = createPostgresFulfillmentStore({ pool: db.newPool() });

  orchestrator = make();
  await Promise.all([orchestrator.runNext(id), orchestrator.runNext(id)]);
  assert.equal((await orchestrator.status(id)).state, "content_review_required");
  assert.equal(prepareCalls, 2);
  assert.equal(await orchestrator.runNext(id), null);
  const generated = await store.getJob(id);
  const artifacts = generated.artifactSets.at(-1);
  const decision = {
    commandId: "approve-postgres-r1", decisionType: "content", revisionId: "r1", outcome: "approved",
    policyVersion: EDITORIAL_POLICY_VERSION, rubricVersion: "bebebonjour-content-rubric-v1",
    reviewer: { id: "synthetic-qualified-reviewer", role: "qualified-human-reviewer", competencies: ["arabic", "religious-content", "editorial"] },
    decidedAt: now, artifactDigests: digestsOf(artifacts), reasons: ["Synthetic local verification"],
  };
  await assert.rejects(() => orchestrator.recordReviewDecision(id, { ...decision, revisionId: "r2" }));
  await assert.rejects(() => orchestrator.recordReviewDecision(id, { ...decision, artifactDigests: { ...decision.artifactDigests, pageDigest: "0".repeat(64) } }));
  await assert.rejects(() => orchestrator.queueDelivery(id, { commandId: "forbidden-before-review" }), /published exact revision/i);
  const paths = await workspace.resolveJobPaths(await orchestrator.status(id));
  const review = JSON.parse(await readFile(path.join(paths.reviewRoot, "review.json"), "utf8"));
  await silent(() => commandApproveReview({ review: path.join(paths.reviewRoot, "review.json"), output: paths.approvedRoot,
    reviewer: "synthetic-qualified-reviewer", ...(review.review.requiredReasons.length ? { acknowledge: review.review.requiredReasons.join(",") } : {}) }));
  assert.equal((await orchestrator.recordReviewDecision(id, decision)).state, "render_queued");
  const rendered = await orchestrator.runNext(id);
  assert.equal(rendered.state, "tts_queued", JSON.stringify(rendered));
  assert.equal((await orchestrator.runNext(id)).state, "narration_review_required");
  assert.ok(ttsCalls > 0);
  await assert.rejects(() => orchestrator.queueDelivery(id, { commandId: "forbidden-before-narration" }));
  const narration = (await store.getJob(id)).artifactSets.at(-1);
  await silent(() => commandApproveNarration({ review: path.join(paths.narrationReviewRoot, "review.json"),
    prepared: paths.preparedRoot, output: paths.finalRoot, reviewer: "synthetic-qualified-reviewer", acknowledge: intake.languages.join(",") }));
  assert.equal((await orchestrator.recordReviewDecision(id, { ...decision, commandId: "approve-postgres-narration-r1",
    decisionType: "narration", rubricVersion: "bebebonjour-narration-rubric-v1", artifactDigests: digestsOf(narration) })).state, "publish_ready");
  const published = await orchestrator.runNext(id);
  assert.equal(published.state, "published");
  assert.equal(published.publication.provider, "vercel-dry-run");
  assert.equal(published.publication.revisionId, "r1");
  assert.equal((await orchestrator.queueDelivery(id, { commandId: "queue-postgres-delivery" })).state, "delivery_queued");
  const sent = await orchestrator.runNext(id);
  assert.equal(sent.state, "sent");
  assert.equal(sent.delivery.provider, "console-dry-run");
  await assert.rejects(() => orchestrator.confirmDelivery(id, { commandId: "bad-confirmation", providerMessageId: sent.delivery.providerMessageId, outcome: "delivered", recordedAt: now }));
  const completed = await orchestrator.confirmDelivery(id, { commandId: "confirmed-synthetic-delivery", providerMessageId: sent.delivery.providerMessageId,
    outcome: "delivered", recordedAt: now, verificationToken: "synthetic-independent-confirmation" });
  assert.equal(completed.state, "complete");
  const durable = await createPostgresFulfillmentStore({ pool: db.newPool() }).getJob(id);
  assert.equal(durable.state, "complete");
  assert.doesNotMatch(JSON.stringify(durable), /railway-workflow@example\.test|synthetic-independent-confirmation/);
  const approvedPage = JSON.parse(await readFile(paths.approvedPagePath, "utf8"));
  assert.match(await readFile(path.join(paths.finalRoot, "deploy", approvedPage.slug, "ar", "index.html"), "utf8"), /أمل/);
});
