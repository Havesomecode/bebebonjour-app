import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  EDITORIAL_POLICY_VERSION,
  createFulfillmentOrchestrator,
} from "../../src/fulfillment/job-orchestrator.mjs";
import { createExternalEffectStageHandlers } from "../../src/fulfillment/external-effect-stage-handlers.mjs";
import { claimStageTransition } from "../../src/fulfillment/job-machine.mjs";
import { createLocalTestFulfillmentStore } from "../../src/persistence/local-test-fulfillment-store.mjs";

const DIGESTS = Object.freeze({
  pageDigest: "1".repeat(64),
  transcriptDigest: "2".repeat(64),
  assetManifestDigest: "3".repeat(64),
});

const NARRATION_DIGESTS = Object.freeze({
  pageDigest: "5".repeat(64),
  transcriptDigest: "6".repeat(64),
  assetManifestDigest: "7".repeat(64),
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-job-orchestration-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const storePath = path.join(root, "fulfillment.json");
  const calls = [];
  const handlers = {
    async prepare_review(context) {
      calls.push({ stage: context.stage, idempotencyKey: context.idempotencyKey });
      return {
        revision: { revisionId: "r1", ordinal: 1, inputDigest: "a".repeat(64) },
        artifactSet: { kind: "private_review", revisionId: "r1", ...DIGESTS },
      };
    },
    async render_approved(context) {
      calls.push({ stage: context.stage, idempotencyKey: context.idempotencyKey });
      return { artifactSet: { kind: "prepared_bundle", revisionId: "r1", ...DIGESTS } };
    },
    async generate_tts(context) {
      calls.push({ stage: context.stage, idempotencyKey: context.idempotencyKey });
      return { artifactSet: { kind: "narration_review", revisionId: "r1", ...DIGESTS } };
    },
    async publish(context) {
      calls.push({ stage: context.stage, idempotencyKey: context.idempotencyKey });
      return {
        publication: {
          provider: "local-verification",
          revisionId: "r1",
          stableUrl: "https://example.invalid/announcements/job_synthetic_001",
          artifactManifestDigest: DIGESTS.assetManifestDigest,
          providerReceiptId: "local-publication-receipt",
        },
      };
    },
    async prepare_delivery() {
      return {
        targetRef: "synthetic-recipient-001",
        targetDigest: "d".repeat(64),
      };
    },
    async deliver(context) {
      calls.push({ stage: context.stage, idempotencyKey: context.idempotencyKey });
      return {
        delivery: {
          provider: "local-verification",
          providerMessageId: "local-delivery-receipt",
          revisionId: "r1",
        },
      };
    },
    async verify_delivery_confirmation({ confirmation }) {
      return confirmation;
    },
    async verify_review_decision({ decision }) {
      return decision;
    },
    ...options.handlers,
  };
  const clock = options.clock || (() => "2026-08-11T00:00:00.000Z");
  const store = createLocalTestFulfillmentStore({ filePath: storePath });
  const orchestrator = createFulfillmentOrchestrator({
    store,
    handlers,
    clock,
    tokenFactory: options.tokenFactory || ((label) => `${label}-token`),
    retryPolicy: options.retryPolicy || {
      leaseMsByStage: {
        prepare_review: 300_000,
        generate_tts: 300_000,
        render_approved: 300_000,
        publish: 300_000,
        deliver: 300_000,
      },
      maxAttemptsByStage: {
        prepare_review: 2,
        generate_tts: 2,
        render_approved: 2,
        publish: 2,
        deliver: 2,
      },
      backoffMsByStage: {
        prepare_review: [1_000],
        generate_tts: [1_000],
        render_approved: [1_000],
        publish: [1_000],
        deliver: [1_000],
      },
    },
  });
  return { calls, orchestrator, store, storePath };
}

function syntheticJob() {
  return {
    jobId: "job_synthetic_001",
    environment: "test",
    product: "announcement-page",
    intakeDigest: "a".repeat(64),
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId: "job_synthetic_001",
      intakeDigest: "a".repeat(64),
    },
    narrationRequired: false,
  };
}

function syntheticNarrationJob() {
  return { ...syntheticJob(), narrationRequired: true };
}

function approvedContentDecision() {
  return {
    commandId: "review-content-r1-approved",
    decisionType: "content",
    revisionId: "r1",
    outcome: "approved",
    policyVersion: EDITORIAL_POLICY_VERSION,
    rubricVersion: "bebebonjour-content-rubric-v1",
    reviewer: {
      id: "reviewer_synthetic_001",
      role: "qualified-human-reviewer",
      competencies: ["arabic", "religious-content", "editorial"],
    },
    decidedAt: "2026-08-11T00:03:00.000Z",
    artifactDigests: DIGESTS,
    reasons: ["synthetic fixture approved for local verification"],
  };
}

function approvedNarrationDecision() {
  return {
    ...approvedContentDecision(),
    commandId: "review-narration-r1-approved",
    decisionType: "narration",
    rubricVersion: "bebebonjour-narration-rubric-v1",
    decidedAt: "2026-08-11T00:04:00.000Z",
    reasons: ["synthetic narration bytes approved for local verification"],
  };
}

async function reachContentReview(orchestrator) {
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  await orchestrator.runNext("job_synthetic_001");
}

async function reachPublishReady(orchestrator) {
  await reachContentReview(orchestrator);
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());
  await orchestrator.runNext("job_synthetic_001");
}

test("review decisions require a trusted verifier before the state transition", async (t) => {
  const { orchestrator } = await fixture(t, {
    handlers: { verify_review_decision: undefined },
  });
  await reachContentReview(orchestrator);

  await assert.rejects(
    () => orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision()),
    /trusted review decision verifier is required/i,
  );
  assert.equal((await orchestrator.status("job_synthetic_001")).state, "content_review_required");
});

test("a synthetic job persists the guarded canonical lifecycle through completion", async (t) => {
  const { calls, orchestrator, store, storePath } = await fixture(t);
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });

  assert.equal((await orchestrator.status("job_synthetic_001")).state, "awaiting_payment");
  assert.equal(await orchestrator.runNext("job_synthetic_001"), null);
  await assert.rejects(
    () => orchestrator.queueDelivery("job_synthetic_001", { commandId: "deliver-too-early" }),
    /published exact revision/i,
  );

  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  await orchestrator.runNext("job_synthetic_001");
  assert.equal((await orchestrator.status("job_synthetic_001")).state, "content_review_required");

  await assert.rejects(
    () => orchestrator.queueDelivery("job_synthetic_001", { commandId: "deliver-without-review" }),
    /published exact revision/i,
  );
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());
  await orchestrator.runNext("job_synthetic_001");
  assert.equal((await orchestrator.status("job_synthetic_001")).state, "publish_ready");

  await orchestrator.runNext("job_synthetic_001");
  assert.equal((await orchestrator.status("job_synthetic_001")).state, "published");
  await orchestrator.queueDelivery("job_synthetic_001", { commandId: "queue-delivery" });
  await orchestrator.runNext("job_synthetic_001");
  assert.equal((await orchestrator.status("job_synthetic_001")).state, "sent");
  const confirmation = {
    commandId: "delivery-confirmed",
    providerMessageId: "local-delivery-receipt",
    outcome: "delivered",
    recordedAt: "2026-08-11T00:06:00.000Z",
  };
  await orchestrator.confirmDelivery("job_synthetic_001", confirmation);

  const completed = await orchestrator.status("job_synthetic_001");
  assert.equal(completed.state, "complete");
  assert.equal(completed.currentRevisionId, "r1");
  assert.equal(completed.publishedRevisionId, "r1");
  assert.equal(completed.contentDecision.policyVersion, EDITORIAL_POLICY_VERSION);
  assert.equal(completed.contentDecision.reviewer.id, "reviewer_synthetic_001");
  assert.equal(completed.contentDecision.decidedAt, "2026-08-11T00:03:00.000Z");
  assert.equal(completed.contentDecision.outcome, "approved");
  assert.deepEqual(calls.map(({ stage }) => stage), [
    "prepare_review",
    "render_approved",
    "publish",
    "deliver",
  ]);

  const replayed = await orchestrator.confirmDelivery("job_synthetic_001", confirmation);
  assert.deepEqual(replayed, completed);

  const persisted = await store.getJob("job_synthetic_001");
  assert.equal(persisted.reviewDecisions.length, 1);
  assert.deepEqual(persisted.reviewDecisions[0].reviewer, approvedContentDecision().reviewer);
  assert.equal(persisted.reviewDecisions[0].policyVersion, EDITORIAL_POLICY_VERSION);
  assert.equal(persisted.reviewDecisions[0].decidedAt, "2026-08-11T00:03:00.000Z");
  assert.equal(persisted.reviewDecisions[0].outcome, "approved");
  assert.equal(persisted.stageAttempts.every((attempt) => attempt.startedAt && attempt.completedAt), true);

  const reopened = createFulfillmentOrchestrator({
    store: createLocalTestFulfillmentStore({ filePath: storePath }),
    handlers: {},
    clock: () => "2026-08-11T00:10:00.000Z",
    tokenFactory: (label) => `${label}-reopened-token`,
    retryPolicy: {
      leaseMsByStage: {},
      maxAttemptsByStage: {},
      backoffMsByStage: {},
    },
  });
  assert.deepEqual(await reopened.status("job_synthetic_001"), completed);
});

test("payment, review, publication, and delivery bindings fail closed", async (t) => {
  const { orchestrator } = await fixture(t);
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  const wrongCorrelation = structuredClone(syntheticJob().paymentCorrelation);
  wrongCorrelation.jobId = "job_other";
  await assert.rejects(
    () => orchestrator.recordPayment("job_synthetic_001", {
      commandId: "wrong-payment",
      providerEventId: "evt_wrong",
      providerPaymentId: "pi_wrong",
      correlation: wrongCorrelation,
      recordedAt: "2026-08-11T00:01:00.000Z",
    }),
    /correlation does not match/i,
  );

  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  await orchestrator.runNext("job_synthetic_001");

  const wrongPolicy = { ...approvedContentDecision(), commandId: "wrong-policy", policyVersion: "draft-policy" };
  await assert.rejects(
    () => orchestrator.recordReviewDecision("job_synthetic_001", wrongPolicy),
    /policy version bebebonjour-editorial-v1/i,
  );
  const wrongDigest = structuredClone(approvedContentDecision());
  wrongDigest.commandId = "wrong-digest";
  wrongDigest.artifactDigests.pageDigest = "f".repeat(64);
  const beforeForbiddenReview = await orchestrator.status("job_synthetic_001");
  await assert.rejects(
    () => orchestrator.recordReviewDecision("job_synthetic_001", wrongDigest),
    /digests do not match/i,
  );
  assert.deepEqual(await orchestrator.status("job_synthetic_001"), beforeForbiddenReview);

  const unboundedReasons = structuredClone(approvedContentDecision());
  unboundedReasons.commandId = "unbounded-review-reasons";
  unboundedReasons.reasons = Array.from({ length: 33 }, (_, index) => `reason_${index}`);
  await assert.rejects(
    () => orchestrator.recordReviewDecision("job_synthetic_001", unboundedReasons),
    /bounded review evidence/i,
  );
  assert.deepEqual(await orchestrator.status("job_synthetic_001"), beforeForbiddenReview);

  const rejected = { ...approvedContentDecision(), commandId: "content-rejected", outcome: "rejected" };
  await orchestrator.recordReviewDecision("job_synthetic_001", rejected);
  assert.equal((await orchestrator.status("job_synthetic_001")).state, "rejected");
  await assert.rejects(
    () => orchestrator.queueDelivery("job_synthetic_001", { commandId: "delivery-after-rejection" }),
    /published exact revision/i,
  );
});

test("narration jobs require exact content and audio approvals before publication or delivery", async (t) => {
  const { calls, orchestrator } = await fixture(t);
  await orchestrator.createJob(syntheticNarrationJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.runNext("job_synthetic_001");

  assert.equal((await orchestrator.status("job_synthetic_001")).state, "narration_review_required");
  await assert.rejects(
    () => orchestrator.queueDelivery("job_synthetic_001", { commandId: "delivery-without-audio-review" }),
    /published exact revision/i,
  );
  await assert.rejects(
    () => orchestrator.recordReviewDecision("job_synthetic_001", {
      ...approvedNarrationDecision(),
      commandId: "invalid-review-type",
      decisionType: "voice",
    }),
    /decision type/i,
  );

  await orchestrator.recordReviewDecision("job_synthetic_001", approvedNarrationDecision());
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.queueDelivery("job_synthetic_001", { commandId: "queue-delivery" });
  await orchestrator.runNext("job_synthetic_001");
  const sent = await orchestrator.status("job_synthetic_001");

  assert.equal(sent.state, "sent");
  assert.equal(sent.narrationDecision.policyVersion, EDITORIAL_POLICY_VERSION);
  assert.equal(sent.narrationDecision.outcome, "approved");
  assert.deepEqual(calls.map(({ stage }) => stage), [
    "prepare_review",
    "render_approved",
    "generate_tts",
    "publish",
    "deliver",
  ]);
});

test("narration publication binds the exact approved narrated artifact manifest", async (t) => {
  const { orchestrator } = await fixture(t, {
    handlers: {
      async generate_tts() {
        return { artifactSet: { kind: "narration_review", revisionId: "r1", ...NARRATION_DIGESTS } };
      },
      async publish(context) {
        return {
          publication: {
            provider: "local-verification",
            revisionId: "r1",
            stableUrl: "https://example.invalid/announcements/job_synthetic_001",
            artifactManifestDigest: DIGESTS.assetManifestDigest,
            providerReceiptId: context.idempotencyKey,
          },
        };
      },
    },
  });
  await orchestrator.createJob(syntheticNarrationJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.recordReviewDecision("job_synthetic_001", {
    ...approvedNarrationDecision(),
    artifactDigests: NARRATION_DIGESTS,
  });

  const result = await orchestrator.runNext("job_synthetic_001");
  assert.equal(result.state, "failed");
  assert.equal(result.publication, null);
  assert.deepEqual(result.stageAttempts.at(-1).failure, {
    retryable: false,
    reasonCode: "stage_error",
  });
});

test("non-narrated release cannot substitute an unreviewed prepared artifact set", async (t) => {
  const { orchestrator } = await fixture(t, {
    handlers: {
      render_approved: async ({ job }) => ({
        artifactSet: {
          kind: "prepared_bundle",
          revisionId: job.currentRevisionId,
          ...NARRATION_DIGESTS,
        },
      }),
    },
  });
  await reachContentReview(orchestrator);
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());

  const failed = await orchestrator.runNext("job_synthetic_001");
  assert.equal(failed.state, "failed");
  assert.equal(failed.publication, null);
  assert.equal(failed.stageAttempts.at(-1).failure.reasonCode, "stage_error");
});

test("publish claims revalidate persisted non-narrated prepared digests", async (t) => {
  const { orchestrator, store } = await fixture(t);
  await reachPublishReady(orchestrator);
  const corrupted = await store.getJob("job_synthetic_001");
  corrupted.artifactSets.at(-1).assetManifestDigest = "f".repeat(64);

  assert.throws(
    () => claimStageTransition(corrupted, {
      commandId: "claim-corrupted-publish",
      stage: "publish",
      leaseToken: "corrupted-publish-lease",
      leaseMs: 300_000,
      maxAttempts: 2,
    }, "2026-08-11T00:05:00.000Z"),
    /content-approved artifact digests/i,
  );
});

test("a stale narration approval cannot claim publication or advance state", async (t) => {
  const { orchestrator, store } = await fixture(t);
  await orchestrator.createJob(syntheticNarrationJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedNarrationDecision());

  const stale = await store.getJob("job_synthetic_001");
  stale.artifactSets.push({
    artifactSetId: "artifacts_newer_narration_bytes",
    kind: "narration_review",
    revisionId: "r1",
    ...NARRATION_DIGESTS,
  });

  assert.throws(
    () => claimStageTransition(stale, {
      commandId: "claim-publish-with-stale-review",
      stage: "publish",
      leaseToken: "stale-review-lease",
      leaseMs: 300_000,
      maxAttempts: 2,
    }, "2026-08-11T00:05:00.000Z"),
    /narration approval/i,
  );
  assert.equal((await store.getJob("job_synthetic_001")).state, "publish_ready");
});

test("concurrent runNext calls execute one claimed handler only", async (t) => {
  let handlerCalls = 0;
  let tokenNumber = 0;
  const { orchestrator } = await fixture(t, {
    tokenFactory() {
      tokenNumber += 1;
      return `random-lease-token-${tokenNumber}`;
    },
    handlers: {
      async prepare_review() {
        handlerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          revision: { revisionId: "r1", ordinal: 1, inputDigest: "a".repeat(64) },
          artifactSet: { kind: "private_review", revisionId: "r1", ...DIGESTS },
        };
      },
    },
  });
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });

  const results = await Promise.all([
    orchestrator.runNext("job_synthetic_001"),
    orchestrator.runNext("job_synthetic_001"),
  ]);
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.equal(handlerCalls, 1);
  assert.equal((await orchestrator.status("job_synthetic_001")).stageAttempts.length, 1);
});

test("human-requested narration rework starts a new logical idempotent operation", async (t) => {
  const narrationKeys = [];
  let generation = 0;
  const { orchestrator } = await fixture(t, {
    handlers: {
      async generate_tts(context) {
        narrationKeys.push(context.idempotencyKey);
        generation += 1;
        return {
          artifactSet: {
            kind: "narration_review",
            revisionId: "r1",
            ...(generation === 1 ? DIGESTS : NARRATION_DIGESTS),
          },
        };
      },
    },
  });
  await orchestrator.createJob(syntheticNarrationJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.recordReviewDecision("job_synthetic_001", {
    ...approvedNarrationDecision(),
    commandId: "review-narration-r1-changes",
    outcome: "request_changes",
  });
  await orchestrator.runNext("job_synthetic_001");

  assert.equal((await orchestrator.status("job_synthetic_001")).state, "narration_review_required");
  assert.equal(narrationKeys.length, 2);
  assert.notEqual(narrationKeys[0], narrationKeys[1]);
});

test("human-requested content rework cannot overwrite the reviewed revision", async (t) => {
  const { orchestrator } = await fixture(t);
  await reachContentReview(orchestrator);
  await orchestrator.recordReviewDecision("job_synthetic_001", {
    ...approvedContentDecision(),
    commandId: "review-content-r1-changes",
    outcome: "request_changes",
  });

  const failed = await orchestrator.runNext("job_synthetic_001");
  assert.equal(failed.state, "failed");
  assert.equal(failed.currentRevisionId, "r1");
  assert.equal(failed.stageAttempts.at(-1).failure.reasonCode, "stage_error");
});

test("human-requested content rework advances to the next canonical revision", async (t) => {
  let generation = 0;
  const { orchestrator, store } = await fixture(t, {
    handlers: {
      async prepare_review() {
        generation += 1;
        const revisionId = `r${generation}`;
        return {
          revision: {
            revisionId,
            ordinal: generation,
            inputDigest: "a".repeat(64),
          },
          artifactSet: { kind: "private_review", revisionId, ...DIGESTS },
        };
      },
    },
  });
  await reachContentReview(orchestrator);
  await orchestrator.recordReviewDecision("job_synthetic_001", {
    ...approvedContentDecision(),
    commandId: "review-content-r1-rework",
    outcome: "request_changes",
  });

  const reworked = await orchestrator.runNext("job_synthetic_001");
  assert.equal(reworked.state, "content_review_required");
  assert.equal(reworked.currentRevisionId, "r2");
  const persisted = await store.getJob("job_synthetic_001");
  assert.deepEqual(persisted.revisions.map(({ revisionId, ordinal }) => ({ revisionId, ordinal })), [
    { revisionId: "r1", ordinal: 1 },
    { revisionId: "r2", ordinal: 2 },
  ]);
});

test("retryable external work reuses one stable idempotency key", async (t) => {
  let now = "2026-08-11T00:00:00.000Z";
  let publishCalls = 0;
  const publishKeys = [];
  const { orchestrator } = await fixture(t, {
    clock: () => now,
    handlers: {
      async publish(context) {
        publishCalls += 1;
        publishKeys.push(context.idempotencyKey);
        if (publishCalls === 1) {
          const error = new Error("simulated ambiguous provider response");
          error.retryable = true;
          error.reasonCode = "provider_outcome_unknown";
          throw error;
        }
        return {
          publication: {
            provider: "local-verification",
            revisionId: "r1",
            stableUrl: "https://example.invalid/announcements/job_synthetic_001",
            artifactManifestDigest: DIGESTS.assetManifestDigest,
            providerReceiptId: "reconciled-publication-receipt",
          },
        };
      },
    },
  });
  await reachPublishReady(orchestrator);

  let status = await orchestrator.runNext("job_synthetic_001");
  assert.equal(status.state, "retry_wait");
  assert.equal(status.stageAttempts.at(-1).failure.reasonCode, "provider_outcome_unknown");
  assert.equal(await orchestrator.runNext("job_synthetic_001"), null);

  now = "2026-08-11T00:00:01.000Z";
  status = await orchestrator.runNext("job_synthetic_001");
  assert.equal(status.state, "published");
  assert.equal(publishCalls, 2);
  assert.equal(new Set(publishKeys).size, 1);
  assert.deepEqual(
    status.stageAttempts.filter(({ stage }) => stage === "publish").map(({ attemptNumber }) => attemptNumber),
    [1, 2],
  );
});

test("an expired stage lease is fenced, persisted, and retried with the same side-effect key", async (t) => {
  let now = "2026-08-11T00:00:00.000Z";
  const publishKeys = [];
  const { orchestrator, store } = await fixture(t, {
    clock: () => now,
    handlers: {
      async publish(context) {
        publishKeys.push(context.idempotencyKey);
        return {
          publication: {
            provider: "local-verification",
            revisionId: "r1",
            stableUrl: "https://example.invalid/announcements/job_synthetic_001",
            artifactManifestDigest: DIGESTS.assetManifestDigest,
            providerReceiptId: "reconciled-publication-receipt",
          },
        };
      },
    },
  });
  await reachPublishReady(orchestrator);
  const claimed = await store.claimStage("job_synthetic_001", {
    commandId: "simulate-crashed-publish-claim",
    stage: "publish",
    leaseToken: "abandoned-publish-lease",
    leaseMs: 1_000,
    maxAttempts: 2,
  }, now);
  const abandonedKey = claimed.aggregate.stageAttempts.at(-1).idempotencyKey;

  now = "2026-08-11T00:00:01.000Z";
  const waiting = await orchestrator.runNext("job_synthetic_001");
  assert.equal(waiting.state, "retry_wait");
  assert.deepEqual(waiting.stageAttempts.at(-1).failure, {
    retryable: true,
    reasonCode: "lease_expired",
  });

  now = "2026-08-11T00:00:02.000Z";
  const published = await orchestrator.runNext("job_synthetic_001");
  assert.equal(published.state, "published");
  assert.deepEqual(publishKeys, [abandonedKey]);
});

test("a completion at or after lease expiry cannot commit stage output", async (t) => {
  const { orchestrator, store } = await fixture(t);
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  const claimed = await store.claimStage("job_synthetic_001", {
    commandId: "claim-generation",
    stage: "prepare_review",
    leaseToken: "short-generation-lease",
    leaseMs: 1_000,
    maxAttempts: 2,
  }, "2026-08-11T00:00:00.000Z");
  const attempt = claimed.aggregate.stageAttempts.at(-1);

  await assert.rejects(
    () => store.completeStage("job_synthetic_001", {
      commandId: `complete:${attempt.attemptId}`,
      stage: "prepare_review",
      leaseToken: "short-generation-lease",
      result: {
        revision: { revisionId: "r1", ordinal: 1, inputDigest: "a".repeat(64) },
        artifactSet: { kind: "private_review", revisionId: "r1", ...DIGESTS },
      },
    }, "2026-08-11T00:00:01.000Z"),
    /lease expired/i,
  );
});

test("an expired lease owner cannot record a stale terminal failure", async (t) => {
  const { orchestrator, store } = await fixture(t);
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });
  await store.claimStage("job_synthetic_001", {
    commandId: "claim-generation",
    stage: "prepare_review",
    leaseToken: "expired-generation-lease",
    leaseMs: 1_000,
    maxAttempts: 2,
  }, "2026-08-11T00:00:00.000Z");

  await assert.rejects(
    () => store.failStage("job_synthetic_001", {
      commandId: "stale-terminal-failure",
      stage: "prepare_review",
      leaseToken: "expired-generation-lease",
      retryable: false,
      reasonCode: "invalid_generation_input",
    }, {
      maxAttemptsByStage: { prepare_review: 2 },
      backoffMsByStage: { prepare_review: [1_000] },
    }, "2026-08-11T00:00:01.000Z"),
    /expired lease/i,
  );
  const persisted = await store.getJob("job_synthetic_001");
  assert.equal(persisted.state, "generating");
  assert.equal(persisted.stageAttempts.at(-1).status, "running");
});

test("a handler that finishes after lease expiry enters retry with the stable side-effect key", async (t) => {
  let now = "2026-08-11T00:00:00.000Z";
  const keys = [];
  const shortPolicy = {
    leaseMsByStage: Object.fromEntries([
      "prepare_review",
      "generate_tts",
      "render_approved",
      "publish",
      "deliver",
    ].map((stage) => [stage, 1_000])),
    maxAttemptsByStage: Object.fromEntries([
      "prepare_review",
      "generate_tts",
      "render_approved",
      "publish",
      "deliver",
    ].map((stage) => [stage, 2])),
    backoffMsByStage: Object.fromEntries([
      "prepare_review",
      "generate_tts",
      "render_approved",
      "publish",
      "deliver",
    ].map((stage) => [stage, [1_000]])),
  };
  const { orchestrator } = await fixture(t, {
    clock: () => now,
    retryPolicy: shortPolicy,
    handlers: {
      async prepare_review(context) {
        keys.push(context.idempotencyKey);
        if (keys.length === 1) now = "2026-08-11T00:00:01.000Z";
        return {
          revision: { revisionId: "r1", ordinal: 1, inputDigest: "a".repeat(64) },
          artifactSet: { kind: "private_review", revisionId: "r1", ...DIGESTS },
        };
      },
    },
  });
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:00:00.000Z",
  });

  const waiting = await orchestrator.runNext("job_synthetic_001");
  assert.equal(waiting.state, "retry_wait");
  assert.deepEqual(waiting.stageAttempts.at(-1).failure, {
    retryable: true,
    reasonCode: "lease_expired",
  });

  now = "2026-08-11T00:00:02.000Z";
  const completed = await orchestrator.runNext("job_synthetic_001");
  assert.equal(completed.state, "content_review_required");
  assert.equal(new Set(keys).size, 1);
});

test("command ids cannot be replayed across operations or rebound to different payloads", async (t) => {
  const { orchestrator } = await fixture(t);
  await orchestrator.createJob(syntheticJob(), { commandId: "shared-command" });
  const payment = {
    commandId: "shared-command",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  };
  await assert.rejects(
    () => orchestrator.recordPayment("job_synthetic_001", payment),
    /command replay/i,
  );

  await orchestrator.recordPayment("job_synthetic_001", { ...payment, commandId: "payment-command" });
  await assert.rejects(
    () => orchestrator.recordPayment("job_synthetic_001", {
      ...payment,
      commandId: "payment-command",
      providerPaymentId: "pi_test_rebound",
    }),
    /command replay/i,
  );
});

test("audit timestamps are canonical ISO values and cannot move backward", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    () => store.createJob(syntheticJob(), { commandId: "invalid-time", at: "1" }),
    /ISO timestamp/i,
  );
  await store.createJob(syntheticJob(), {
    commandId: "create-job",
    at: "2026-08-11T00:00:01.000Z",
  });
  await assert.rejects(
    () => store.recordPayment("job_synthetic_001", {
      commandId: "payment-succeeded",
      providerEventId: "evt_test_synthetic_001",
      providerPaymentId: "pi_test_synthetic_001",
      correlation: syntheticJob().paymentCorrelation,
      recordedAt: "2026-08-11T00:00:01.000Z",
    }, "2026-08-11T00:00:00.000Z"),
    /cannot precede/i,
  );
});

test("separate local store instances serialize one file without temporary-file races", async (t) => {
  const { orchestrator, store, storePath } = await fixture(t);
  const secondStore = createLocalTestFulfillmentStore({ filePath: storePath });
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });

  const outcomes = await Promise.allSettled([
    store.claimStage("job_synthetic_001", {
      commandId: "claim-a",
      stage: "prepare_review",
      leaseToken: "lease-a",
      leaseMs: 1_000,
      maxAttempts: 2,
    }, "2026-08-11T00:00:00.000Z"),
    secondStore.claimStage("job_synthetic_001", {
      commandId: "claim-b",
      stage: "prepare_review",
      leaseToken: "lease-b",
      leaseMs: 1_000,
      maxAttempts: 2,
    }, "2026-08-11T00:00:00.000Z"),
  ]);
  const rejection = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.doesNotMatch(String(rejection.reason?.code || rejection.reason), /ENOENT/);
  assert.equal((await store.getJob("job_synthetic_001")).stageAttempts.length, 1);
});

test("an abruptly terminated lock owner cannot wedge the local fulfillment store", async (t) => {
  const { orchestrator, storePath } = await fixture(t);
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });

  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(${JSON.stringify(`${storePath}.mutex.sqlite`)});
database.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setInterval(() => {}, 1_000);`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const [locked] = await once(child.stdout, "data");
  assert.match(locked.toString(), /locked/);
  child.kill("SIGKILL");
  await once(child, "exit");

  const reopened = createLocalTestFulfillmentStore({ filePath: storePath });
  assert.equal((await reopened.getJob("job_synthetic_001")).jobId, "job_synthetic_001");
});

test("terminal stage failures persist bounded diagnostics and cannot continue", async (t) => {
  const { orchestrator } = await fixture(t, {
    handlers: {
      async prepare_review() {
        const error = new Error("synthetic customer@example.com raw provider diagnostic");
        error.retryable = false;
        error.reasonCode = "invalid_generation_input";
        throw error;
      },
    },
  });
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  await orchestrator.recordPayment("job_synthetic_001", {
    commandId: "payment-succeeded",
    providerEventId: "evt_test_synthetic_001",
    providerPaymentId: "pi_test_synthetic_001",
    correlation: syntheticJob().paymentCorrelation,
    recordedAt: "2026-08-11T00:01:00.000Z",
  });

  const failed = await orchestrator.runNext("job_synthetic_001");
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.stageAttempts.at(-1).failure, {
    retryable: false,
    reasonCode: "invalid_generation_input",
  });
  assert.doesNotMatch(JSON.stringify(failed), /customer@example\.com|raw provider diagnostic/);
  assert.equal(await orchestrator.runNext("job_synthetic_001"), null);
});

test("the local TEST-A job artifact is byte-deterministic for fixed inputs and dependencies", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await reachContentReview(first.orchestrator);
  await reachContentReview(second.orchestrator);

  assert.equal(
    await readFile(first.storePath, "utf8"),
    await readFile(second.storePath, "utf8"),
  );
});

test("the durable TEST-A projection uses the versioned persistent field schema", async (t) => {
  const { orchestrator, storePath } = await fixture(t);
  await reachContentReview(orchestrator);
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.queueDelivery("job_synthetic_001", { commandId: "queue-delivery" });
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.confirmDelivery("job_synthetic_001", {
    commandId: "delivery-confirmed",
    providerMessageId: "local-delivery-receipt",
    outcome: "delivered",
    recordedAt: "2026-08-11T00:06:00.000Z",
  });

  const rawText = await readFile(storePath, "utf8");
  const raw = JSON.parse(rawText);
  const schema = JSON.parse(await readFile(
    new URL("../../schemas/fulfillment-job-store.schema.json", import.meta.url),
    "utf8",
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true, formats: { "date-time": true } })
    .compile(schema);

  assert.equal(validate(raw), true, JSON.stringify(validate.errors));
  assert.equal(raw.schema_version, "1.0");
  assert.equal(raw.jobs.job_synthetic_001.current_revision_id, "r1");
  assert.equal(raw.jobs.job_synthetic_001.stage_attempts[0].status, "completed");
  assert.equal(
    raw.jobs.job_synthetic_001.review_decisions[0].reviewer.id,
    approvedContentDecision().reviewer.id,
  );
  assert.equal(raw.jobs.job_synthetic_001.delivery_attempts[0].status, "delivered");
  assert.equal(
    raw.jobs.job_synthetic_001.delivery_attempts[0].target_ref,
    "synthetic-recipient-001",
  );
  const missingBinding = structuredClone(raw);
  delete missingBinding.jobs.job_synthetic_001.stage_attempts.find(
    (attempt) => attempt.stage === "deliver",
  ).operation_binding;
  assert.equal(validate(missingBinding), false);
  assert.doesNotMatch(rawText, /jobArtifactDigest|job_artifact_digest/);
});

test("a malformed durable aggregate is rejected before backend transitions inspect it", async (t) => {
  const { orchestrator, storePath } = await fixture(t);
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  const raw = JSON.parse(await readFile(storePath, "utf8"));
  raw.jobs.job_synthetic_001.review_decisions = {};
  await writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  const reopened = createLocalTestFulfillmentStore({ filePath: storePath });
  await assert.rejects(
    () => reopened.getJob("job_synthetic_001"),
    /persistence schema/i,
  );
});

test("malformed persisted audit timestamps fail schema validation", async (t) => {
  const { orchestrator, storePath } = await fixture(t);
  await orchestrator.createJob(syntheticJob(), { commandId: "create-job" });
  const raw = JSON.parse(await readFile(storePath, "utf8"));
  raw.jobs.job_synthetic_001.created_at = "not-a-timestamp";
  await writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  const reopened = createLocalTestFulfillmentStore({ filePath: storePath });
  await assert.rejects(() => reopened.getJob("job_synthetic_001"), /persistence schema/i);
});

test("review-gated external adapters recover ambiguous publication without a duplicate effect", async (t) => {
  let now = "2026-08-11T00:00:00.000Z";
  let publishCalls = 0;
  let reconcileCalls = 0;
  const receipts = new Map();
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter: {
      async reconcile(request) {
        reconcileCalls += 1;
        return receipts.get(request.idempotencyKey) || null;
      },
      async publish(request) {
        publishCalls += 1;
        assert.equal(request.environment, "test");
        assert.equal(request.revisionId, "r1");
        assert.equal(request.artifactManifestDigest, DIGESTS.assetManifestDigest);
        const receipt = {
          provider: "fake-vercel",
          revisionId: request.revisionId,
          stableUrl: "https://example.invalid/announcements/job_synthetic_001",
          artifactManifestDigest: request.artifactManifestDigest,
          providerReceiptId: "fake-deployment-001",
          idempotencyKey: request.idempotencyKey,
        };
        receipts.set(request.idempotencyKey, receipt);
        const error = new Error("synthetic timeout after provider acceptance");
        error.retryable = true;
        error.reasonCode = "provider_outcome_unknown";
        throw error;
      },
    },
    deliveryAdapter: fakeDeliveryAdapter(),
    resolveDeliveryTarget: async () => ({ targetRef: "synthetic-recipient-001" }),
  });
  const { orchestrator } = await fixture(t, {
    clock: () => now,
    handlers: externalHandlers,
  });
  await reachContentReview(orchestrator);

  assert.equal(await orchestrator.runNext("job_synthetic_001"), null);
  assert.equal(publishCalls, 0);
  await orchestrator.recordReviewDecision("job_synthetic_001", approvedContentDecision());
  await orchestrator.runNext("job_synthetic_001");

  let status = await orchestrator.runNext("job_synthetic_001");
  assert.equal(status.state, "retry_wait");
  assert.equal(status.stageAttempts.at(-1).failure.reasonCode, "provider_outcome_unknown");
  now = "2026-08-11T00:00:01.000Z";
  status = await orchestrator.runNext("job_synthetic_001");

  assert.equal(status.state, "published");
  assert.equal(status.publication.providerReceiptId, "fake-deployment-001");
  assert.equal(publishCalls, 1);
  assert.equal(reconcileCalls, 2);
  assert.equal(new Set(status.stageAttempts
    .filter(({ stage }) => stage === "publish")
    .map(({ idempotencyKey }) => idempotencyKey)).size, 1);
});

test("terminal provider failure records a bounded outcome without a publication receipt", async (t) => {
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter: {
      async reconcile() {
        return null;
      },
      async publish() {
        const error = new Error("synthetic provider body with private diagnostics");
        error.retryable = false;
        error.reasonCode = "provider_rejected";
        throw error;
      },
    },
    deliveryAdapter: fakeDeliveryAdapter(),
    resolveDeliveryTarget: async () => ({ targetRef: "synthetic-recipient-001" }),
  });
  const { orchestrator } = await fixture(t, { handlers: externalHandlers });
  await reachPublishReady(orchestrator);

  const failed = await orchestrator.runNext("job_synthetic_001");

  assert.equal(failed.state, "failed");
  assert.equal(failed.publication, null);
  assert.deepEqual(failed.stageAttempts.at(-1).failure, {
    retryable: false,
    reasonCode: "provider_rejected",
  });
  assert.doesNotMatch(JSON.stringify(failed), /private diagnostics|synthetic provider body/);
});

test("ambiguous delivery acceptance is reconciled before retrying the send effect", async (t) => {
  let now = "2026-08-11T00:00:00.000Z";
  let sendCalls = 0;
  const receipts = new Map();
  const attemptStarts = [];
  const deliveryAdapter = fakeDeliveryAdapter({
    async reconcile(request) {
      attemptStarts.push(request.attemptStartedAt);
      return receipts.get(request.idempotencyKey) || null;
    },
    async send(request) {
      sendCalls += 1;
      assert.equal(request.attemptStartedAt, "2026-08-11T00:00:00.000Z");
      const receipt = {
        provider: "fake-resend",
        revisionId: request.revisionId,
        providerMessageId: "fake-message-ambiguous-001",
        idempotencyKey: request.idempotencyKey,
        artifactManifestDigest: request.artifactManifestDigest,
        targetDigest: request.targetDigest,
      };
      receipts.set(request.idempotencyKey, receipt);
      const error = new Error("synthetic timeout after message acceptance");
      error.retryable = true;
      error.reasonCode = "provider_outcome_unknown";
      throw error;
    },
  });
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter: fakePublicationAdapter(),
    deliveryAdapter,
    resolveDeliveryTarget: async () => ({ targetRef: "synthetic-recipient-001" }),
  });
  const { orchestrator } = await fixture(t, {
    clock: () => now,
    handlers: externalHandlers,
  });
  await reachPublishReady(orchestrator);
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.queueDelivery("job_synthetic_001", { commandId: "queue-delivery" });

  let status = await orchestrator.runNext("job_synthetic_001");
  assert.equal(status.state, "retry_wait");
  now = "2026-08-11T00:00:01.000Z";
  status = await orchestrator.runNext("job_synthetic_001");

  assert.equal(status.state, "sent");
  assert.equal(status.delivery.providerMessageId, "fake-message-ambiguous-001");
  assert.equal(sendCalls, 1);
  assert.deepEqual(attemptStarts, [
    "2026-08-11T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
  ]);
});

test("delivery retries keep the persisted exact target binding and never retarget", async (t) => {
  let now = "2026-08-11T00:00:00.000Z";
  let address = "first@example.test";
  let sendCalls = 0;
  const deliveryAdapter = fakeDeliveryAdapter({
    async send() {
      sendCalls += 1;
      const error = new Error("synthetic provider unavailable before acceptance");
      error.retryable = true;
      error.reasonCode = "provider_unavailable";
      throw error;
    },
  });
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter: fakePublicationAdapter(),
    deliveryAdapter,
    resolveDeliveryTarget: async () => ({
      targetRef: "synthetic-recipient-001",
      address,
    }),
  });
  const { orchestrator } = await fixture(t, {
    clock: () => now,
    handlers: externalHandlers,
  });
  await reachPublishReady(orchestrator);
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.queueDelivery("job_synthetic_001", { commandId: "queue-delivery" });

  let status = await orchestrator.runNext("job_synthetic_001");
  assert.equal(status.state, "retry_wait");
  address = "changed@example.test";
  now = "2026-08-11T00:00:01.000Z";
  status = await orchestrator.runNext("job_synthetic_001");

  assert.equal(status.state, "failed");
  assert.equal(status.stageAttempts.at(-1).failure.reasonCode, "provider_receipt_invalid");
  assert.equal(sendCalls, 1);
});

test("caller-asserted delivery completion is rejected without a trusted verifier", async (t) => {
  const { orchestrator } = await fixture(t, {
    handlers: { verify_delivery_confirmation: undefined },
  });
  await reachPublishReady(orchestrator);
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.queueDelivery("job_synthetic_001", { commandId: "queue-delivery" });
  await orchestrator.runNext("job_synthetic_001");

  await assert.rejects(
    () => orchestrator.confirmDelivery("job_synthetic_001", {
      commandId: "untrusted-confirmation",
      providerMessageId: "local-delivery-receipt",
      outcome: "delivered",
      recordedAt: "2026-08-11T00:06:00.000Z",
    }),
    /trusted delivery confirmation verifier/i,
  );
  assert.equal((await orchestrator.status("job_synthetic_001")).state, "sent");
});

test("delivery status reconciliation completes only an exact delivered provider message", async (t) => {
  let providerOutcome = "pending";
  let providerMessageId = null;
  let providerRetryable = false;
  let providerReasonCode = null;
  const deliveryAdapter = fakeDeliveryAdapter({
    async status(request) {
      return {
        providerMessageId: providerMessageId || request.providerMessageId,
        outcome: providerOutcome,
        recordedAt: "2026-08-11T00:06:00.000Z",
        retryable: providerRetryable,
        reasonCode: providerReasonCode,
      };
    },
  });
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter: fakePublicationAdapter(),
    deliveryAdapter,
    resolveDeliveryTarget: async () => ({ targetRef: "synthetic-recipient-001" }),
  });
  const { orchestrator } = await fixture(t, { handlers: externalHandlers });
  await reachPublishReady(orchestrator);
  await orchestrator.runNext("job_synthetic_001");
  await orchestrator.queueDelivery("job_synthetic_001", { commandId: "queue-delivery" });
  await orchestrator.runNext("job_synthetic_001");

  const pending = await orchestrator.reconcileDelivery("job_synthetic_001", {
    commandId: "reconcile-delivery-pending",
  });
  assert.equal(pending.state, "sent");
  assert.equal(pending.delivery.status, "sent");
  assert.equal(pending.delivery.lastOutcome.outcome, "pending");

  providerOutcome = "failed";
  providerRetryable = true;
  providerReasonCode = "provider_delayed";
  const failed = await orchestrator.reconcileDelivery("job_synthetic_001", {
    commandId: "reconcile-delivery-failed",
  });
  assert.equal(failed.state, "sent");
  assert.deepEqual(failed.delivery.lastOutcome, {
    outcome: "failed",
    recordedAt: "2026-08-11T00:06:00.000Z",
    retryable: true,
    reasonCode: "provider_delayed",
  });

  providerOutcome = "delivered";
  providerRetryable = false;
  providerReasonCode = null;
  providerMessageId = "different-message";
  await assert.rejects(
    () => orchestrator.reconcileDelivery("job_synthetic_001", {
      commandId: "reconcile-delivery-mismatch",
    }),
    /exact provider message/i,
  );
  assert.equal((await orchestrator.status("job_synthetic_001")).state, "sent");

  providerMessageId = null;
  const completed = await orchestrator.reconcileDelivery("job_synthetic_001", {
    commandId: "reconcile-delivery-delivered",
  });
  assert.equal(completed.state, "complete");
  assert.equal(completed.delivery.status, "delivered");
  assert.equal(completed.delivery.providerMessageId, "fake-message-001");
  assert.deepEqual(
    await orchestrator.reconcileDelivery("job_synthetic_001", {
      commandId: "reconcile-delivery-delivered-retry",
    }),
    completed,
  );
});

function fakePublicationAdapter(overrides = {}) {
  const receipts = new Map();
  return {
    async reconcile(request) {
      return receipts.get(request.idempotencyKey) || null;
    },
    async publish(request) {
      const receipt = {
        provider: "fake-vercel",
        revisionId: request.revisionId,
        stableUrl: "https://example.invalid/announcements/job_synthetic_001",
        artifactManifestDigest: request.artifactManifestDigest,
        providerReceiptId: "fake-deployment-001",
        idempotencyKey: request.idempotencyKey,
      };
      receipts.set(request.idempotencyKey, receipt);
      return receipt;
    },
    ...overrides,
  };
}

function fakeDeliveryAdapter(overrides = {}) {
  const receipts = new Map();
  return {
    async reconcile(request) {
      return receipts.get(request.idempotencyKey) || null;
    },
    async send(request) {
      const receipt = {
        provider: "fake-resend",
        revisionId: request.revisionId,
        providerMessageId: "fake-message-001",
        idempotencyKey: request.idempotencyKey,
        artifactManifestDigest: request.artifactManifestDigest,
        targetDigest: request.targetDigest,
      };
      receipts.set(request.idempotencyKey, receipt);
      return receipt;
    },
    async status(request) {
      return {
        providerMessageId: request.providerMessageId,
        outcome: "pending",
        recordedAt: "2026-08-11T00:06:00.000Z",
      };
    },
    ...overrides,
  };
}
