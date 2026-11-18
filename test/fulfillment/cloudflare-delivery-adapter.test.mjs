import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCloudflareDeliveryAdapter } from "../../src/fulfillment/cloudflare-delivery-adapter.mjs";
import { createExternalEffectStageHandlers } from "../../src/fulfillment/external-effect-stage-handlers.mjs";
import { createFulfillmentOrchestrator, EDITORIAL_POLICY_VERSION } from "../../src/fulfillment/job-orchestrator.mjs";
import { createLocalTestFulfillmentStore } from "../../src/persistence/local-test-fulfillment-store.mjs";

const config = { provider: "cloudflare", enabled: true, accountId: "a".repeat(32), zoneId: "b".repeat(32),
  from: "Bébé Bonjour <bonjour@mail.havesomecode.io>", replyTo: "contact@bebebonjour.com" };
const environment = { BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: "synthetic-send-token",
  BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN: "synthetic-read-token" };
const policy = { jobId: "job_synthetic_001", revisionId: "r1", artifactManifestDigest: "3".repeat(64),
  targetRef: "synthetic-recipient-001", recipient: "recipient@example.invalid",
  stableUrl: "https://example.invalid/announcements/job_synthetic_001?x=1&y=2" };
const target = { email: policy.recipient, targetRef: policy.targetRef };
const targetDigest = createHash("sha256").update(JSON.stringify(target)).digest("hex");
const now = "2026-11-08T11:00:00.000Z";
const messageId = "<synthetic-001@updates.bebebonjour.com>";
const request = { jobId: policy.jobId, environment: "test", product: "announcement-page",
  revisionId: policy.revisionId, artifactManifestDigest: policy.artifactManifestDigest,
  publication: { stableUrl: policy.stableUrl }, target, targetDigest,
  idempotencyKey: `bb_${"c".repeat(64)}`, attemptStartedAt: now,
  fenceExternalEffect: async (_options, mutation) => mutation() };
const accepted = () => Response.json({ success: true, errors: [], result: { message_id: messageId,
  delivered: [], queued: [policy.recipient], permanent_bounces: [], suppressed_recipients: [] } });
const create = (fetchImpl, extra = {}) => createCloudflareDeliveryAdapter({ config, environment, policy,
  fetch: fetchImpl, clock: () => now, ...extra });

test("Cloudflare fulfillment adapter preserves exact bindings, escaped announcement and support reply-to", async () => {
  const mutablePolicy = { ...policy };
  const adapter = create(async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.to, policy.recipient);
    assert.equal(payload.reply_to, "contact@bebebonjour.com");
    assert.equal(payload.subject, "Votre annonce Bébé Bonjour est prête");
    assert(payload.text.includes(policy.stableUrl));
    assert(payload.html.includes("?x=1&amp;y=2"));
    return accepted();
  }, { policy: mutablePolicy });
  mutablePolicy.recipient = "other@example.invalid";
  assert.deepEqual(await adapter.send(request), { provider: "cloudflare", providerMessageId: messageId,
    idempotencyKey: request.idempotencyKey, revisionId: request.revisionId,
    artifactManifestDigest: request.artifactManifestDigest, targetDigest });
  assert.equal(await adapter.reconcile(request), null);
});

test("exact synthetic policy, revision, target and provider guards reject before network effects", async () => {
  let calls = 0;
  const adapter = create(async () => { calls++; return accepted(); });
  for (const change of [{ environment: "production" }, { jobId: "job_other" }, { revisionId: "r2" },
    { artifactManifestDigest: "f".repeat(64) }, { targetDigest: "f".repeat(64) },
    { target: { ...target, email: "other@example.invalid" } }, { target: { ...target, extra: "x" } },
    { publication: { stableUrl: "http://example.invalid" } }, { reconciliationOnly: true },
    { attemptStartedAt: "2026-11-09T00:00:00Z" }]) {
    await assert.rejects(adapter.send({ ...request, ...change }), /policy|input|reconciliation/i);
  }
  for (const change of [{ environment: "production" }, { provider: "resend" }, { revisionId: "r2" }]) {
    await assert.rejects(adapter.status({ jobId: policy.jobId, revisionId: "r1", environment: "test",
      provider: "cloudflare", providerMessageId: messageId, ...change }), /policy/i);
  }
  assert.equal(calls, 0);
  for (const change of [{ recipient: "bad,email@example.invalid" }, { stableUrl: "http://example.invalid" },
    { artifactManifestDigest: "x" }, { jobId: "" }, { revisionId: "r2\n" }]) {
    assert.throws(() => create(async () => accepted(), { policy: { ...policy, ...change } }), /policy/i);
  }
});

// This fixture exercises the existing durable job engine, not a fake lease or
// an in-memory dedupe map. No HTTP provider request leaves this process.
async function fulfillment(t, fetchImpl) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebe-cloudflare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "jobs.json");
  let time = now;
  const clock = () => time;
  const adapter = create(fetchImpl, { clock });
  const handlers = { ...createExternalEffectStageHandlers({ deliveryAdapter: adapter,
    publicationAdapter: { reconcile: async () => null, async publish(input) {
      return { provider: "synthetic-publication", revisionId: input.revisionId, artifactManifestDigest: input.artifactManifestDigest,
        stableUrl: policy.stableUrl, providerReceiptId: "synthetic-publication", idempotencyKey: input.idempotencyKey };
    } }, resolveDeliveryTarget: async () => target }),
  async prepare_review() { return { revision: { revisionId: "r1", ordinal: 1, inputDigest: "a".repeat(64) },
    artifactSet: { kind: "private_review", revisionId: "r1", ...digests } }; },
  async render_approved() { return { artifactSet: { kind: "prepared_bundle", revisionId: "r1", ...digests } }; },
  async verify_review_decision({ decision }) { return decision; } };
  const retryPolicy = { leaseMsByStage: { prepare_review: 300_000, render_approved: 300_000, publish: 300_000, deliver: 300_000 },
    maxAttemptsByStage: { prepare_review: 2, render_approved: 2, publish: 2, deliver: 2 }, backoffMsByStage: { deliver: [1_000] } };
  const open = () => createFulfillmentOrchestrator({ store: createLocalTestFulfillmentStore({ filePath }), handlers,
    clock, retryPolicy, tokenFactory: label => `${label}-${randomUUID()}` });
  const orchestrator = open();
  const correlation = { project: "bebebonjour", product: "announcement-page", environment: "test",
    jobId: policy.jobId, intakeDigest: "a".repeat(64) };
  await orchestrator.createJob({ jobId: policy.jobId, environment: "test", product: "announcement-page",
    intakeDigest: correlation.intakeDigest, paymentCorrelation: correlation, narrationRequired: false }, { commandId: "create" });
  await orchestrator.recordPayment(policy.jobId, { commandId: "payment", providerEventId: "evt_synthetic", providerPaymentId: "pi_synthetic",
    correlation, recordedAt: now });
  await orchestrator.runNext(policy.jobId);
  await orchestrator.recordReviewDecision(policy.jobId, { commandId: "review", decisionType: "content", revisionId: "r1",
    outcome: "approved", policyVersion: EDITORIAL_POLICY_VERSION, rubricVersion: "bebebonjour-content-rubric-v1",
    reviewer: { id: "synthetic-reviewer", role: "qualified-human-reviewer", competencies: ["arabic", "religious-content", "editorial"] },
    decidedAt: now, artifactDigests: digests, reasons: ["synthetic-only approval"] });
  await orchestrator.runNext(policy.jobId);
  await orchestrator.runNext(policy.jobId);
  await orchestrator.queueDelivery(policy.jobId, { commandId: "queue" });
  return { orchestrator, open, filePath, setTime: value => { time = value; } };
}
const digests = { pageDigest: "1".repeat(64), transcriptDigest: "2".repeat(64), assetManifestDigest: "3".repeat(64) };

test("parallel durable workers issue at most one Cloudflare send for the same queued operation", async t => {
  let sends = 0;
  const fixture = await fulfillment(t, async () => { sends++; return accepted(); });
  await Promise.allSettled([fixture.orchestrator.runNext(policy.jobId), fixture.open().runNext(policy.jobId)]);
  assert.equal((await fixture.open().status(policy.jobId)).state, "sent");
  assert.equal(sends, 1);
});

test("a lost Cloudflare response persists a started effect; reopened orchestrator never resends", async t => {
  let calls = 0;
  const fixture = await fulfillment(t, async () => { calls++; throw new Error("synthetic connection reset after POST"); });
  const status = await fixture.orchestrator.runNext(policy.jobId);
  assert.equal(status.state, "reconciliation_required");
  const store = createLocalTestFulfillmentStore({ filePath: fixture.filePath });
  const saved = await store.getJob(policy.jobId);
  assert.equal(saved.stageAttempts.at(-1).effectStartedAt, now);
  const reopened = fixture.open();
  fixture.setTime("2026-11-08T11:10:00.000Z");
  assert.equal((await reopened.status(policy.jobId)).state, "reconciliation_required");
  assert.equal(await reopened.runNext(policy.jobId), null);
  assert.equal(calls, 1);
});

test("sampled delivered event cannot finalize an effect when a later failure is omitted", async t => {
  let sends = 0;
  const fixture = await fulfillment(t, async url => {
    if (url.endsWith("/send")) { sends++; return accepted(); }
    // The real history may include a newer failure omitted from this sampled response.
    return Response.json({ data: { viewer: { zones: [{ emailSendingAdaptive: [{ messageId, status: "delivered", datetime: now }] }] } } });
  });
  await fixture.orchestrator.runNext(policy.jobId);
  await assert.rejects(fixture.open().reconcileDelivery(policy.jobId, { commandId: "sampled-status" }), /cloudflare_status_unavailable/);
  const persisted = await fixture.open().status(policy.jobId);
  assert.notEqual(persisted.state, "complete");
  assert.notEqual(persisted.delivery.lastOutcome?.outcome, "delivered");
  assert.equal(sends, 1);
});
