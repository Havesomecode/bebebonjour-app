import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFulfillmentOrchestrator } from "../../src/fulfillment/job-orchestrator.mjs";
import { signPersistedReviewApproval } from "../../src/fulfillment/persisted-review-decision.mjs";
import { createTestAOperatorRunner } from "../../src/fulfillment/operator-runner-test-a.mjs";
import { createLocalTestFulfillmentStore } from "../../src/persistence/local-test-fulfillment-store.mjs";

const digests = Object.freeze({
  pageDigest: "1".repeat(64),
  transcriptDigest: "2".repeat(64),
  assetManifestDigest: "3".repeat(64),
  manifestRef: "jobs/job_test_001/revisions/r1/manifests/prepared_bundle.json",
  files: [{
    path: "deploy/index.html",
    sha256: "4".repeat(64),
    bytes: 100,
    storageId: `local-test:sha256:${"4".repeat(64)}`,
  }],
});
const retryPolicy = Object.freeze({
  leaseMsByStage: Object.fromEntries(["prepare_review", "render_approved", "publish", "deliver"].map(
    (stage) => [stage, 300_000],
  )),
  maxAttemptsByStage: Object.fromEntries(["prepare_review", "render_approved", "publish", "deliver"].map(
    (stage) => [stage, 2],
  )),
  backoffMsByStage: Object.fromEntries(["prepare_review", "render_approved", "publish", "deliver"].map(
    (stage) => [stage, [1_000]],
  )),
});

function jobInput() {
  return {
    jobId: "job_test_001",
    environment: "test",
    product: "announcement-page",
    intakeDigest: "a".repeat(64),
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId: "job_test_001",
      intakeDigest: "a".repeat(64),
    },
    narrationRequired: false,
  };
}

function decision() {
  return {
    decisionType: "content",
    revisionId: "r1",
    outcome: "approved",
    policyVersion: "bebebonjour-editorial-v1",
    rubricVersion: "bebebonjour-content-rubric-v1",
    reviewer: {
      id: "reviewer_test_001",
      role: "qualified-human-reviewer",
      competencies: ["arabic", "religious-content", "editorial"],
    },
    decidedAt: "2026-08-25T08:03:00.000Z",
    artifactDigests: {
      pageDigest: digests.pageDigest,
      transcriptDigest: digests.transcriptDigest,
      assetManifestDigest: digests.assetManifestDigest,
    },
    reasons: ["Synthetic TEST-A revision reviewed."],
  };
}

test("private TEST-A operator runner persists review before exact publication and one sink delivery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-test-a-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createLocalTestFulfillmentStore({ filePath: path.join(root, "store.json") });
  const approvals = new Map();
  store.getReviewApproval = async (approvalId) => structuredClone(approvals.get(approvalId) || null);
  store.saveReviewApproval = async (approval) => {
    if (!approvals.has(approval.approvalId)) approvals.set(approval.approvalId, structuredClone(approval));
    return structuredClone(approvals.get(approval.approvalId));
  };
  let now = "2026-08-25T08:00:00.000Z";
  const seed = createFulfillmentOrchestrator({
    store,
    handlers: {
      async prepare_review() {
        return {
          revision: { revisionId: "r1", ordinal: 1, inputDigest: "a".repeat(64) },
          artifactSet: { kind: "private_review", revisionId: "r1", ...digests },
        };
      },
    },
    clock: () => now,
    tokenFactory: (label) => `seed:${label}`,
    retryPolicy,
  });
  await seed.createJob(jobInput(), { commandId: "create:test-a" });
  await seed.recordPayment(jobInput().jobId, {
    commandId: "payment:evt_test_001",
    providerEventId: "evt_test_001",
    providerPaymentId: "pi_test_001",
    correlation: jobInput().paymentCorrelation,
    recordedAt: now,
  });
  await seed.runNext(jobInput().jobId);

  const publicationCalls = [];
  const resendCalls = [];
  const runner = createTestAOperatorRunner({
    store,
    environment: {
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
      RESEND_API_KEY: "re_test_operator_runner",
      RESEND_FROM: "Bébé Bonjour <onboarding@resend.dev>",
      TEST_A_PUBLICATION_ORIGIN: "https://announcements.example.test",
    },
    publicationProvider: {
      async reconcile() {
        return null;
      },
      async publish(request) {
        publicationCalls.push(request);
        return {
          provider: "vercel",
          providerReceiptId: "deployment_test_001",
          stableUrl: "https://announcements.example.test/announcements/job_test_001",
          revisionId: request.revisionId,
          artifactSetId: request.artifactSetId,
          artifactManifestDigest: request.artifactManifestDigest,
          idempotencyKey: request.idempotencyKey,
        };
      },
    },
    resend: {
      emails: {
        async send(payload, options) {
          resendCalls.push({ payload, options });
          return { data: { id: "email_test_001" }, error: null };
        },
        async get() {
          return { data: { last_event: "delivered" }, error: null };
        },
      },
    },
    stageHandlers: {
      async render_approved() {
        return { artifactSet: { kind: "prepared_bundle", revisionId: "r1", ...digests } };
      },
    },
    clock: () => now,
    tokenFactory: (label) => `runner:${label}`,
    retryPolicy,
  });

  now = "2026-08-25T08:03:00.000Z";
  const reviewStatus = await runner.status(jobInput().jobId);
  await assert.rejects(
    runner.persistAndRecordReview(jobInput().jobId, decision()),
    /signed persisted review approval/i,
  );
  const wrongManifestApproval = signPersistedReviewApproval({
    hmacKey: "operator-review-key-with-at-least-thirty-two-bytes",
    job: reviewStatus,
    decision: {
      ...decision(),
      artifactDigests: {
        ...decision().artifactDigests,
        assetManifestDigest: "9".repeat(64),
      },
    },
  });
  await assert.rejects(
    runner.persistAndRecordReview(jobInput().jobId, wrongManifestApproval),
    /exact persisted artifact manifest/i,
  );
  assert.equal(approvals.size, 0);
  const invalidOutcomeApproval = signPersistedReviewApproval({
    hmacKey: "operator-review-key-with-at-least-thirty-two-bytes",
    job: reviewStatus,
    decision: { ...decision(), outcome: "forged" },
  });
  await assert.rejects(
    runner.persistAndRecordReview(jobInput().jobId, invalidOutcomeApproval),
    /outcome is invalid/i,
  );
  assert.equal(approvals.size, 0);
  const approval = signPersistedReviewApproval({
    hmacKey: "operator-review-key-with-at-least-thirty-two-bytes",
    job: reviewStatus,
    decision: decision(),
  });
  const reviewed = await runner.persistAndRecordReview(jobInput().jobId, approval);
  assert.equal(reviewed.state, "render_queued");
  assert.equal((await store.getReviewApproval(reviewed.contentDecision.approvalId)).binding.jobId, jobInput().jobId);

  now = "2026-08-25T08:04:00.000Z";
  assert.equal((await runner.runNext(jobInput().jobId)).state, "publish_ready");
  assert.equal((await runner.runNext(jobInput().jobId)).state, "published");
  await runner.queueDelivery(jobInput().jobId);
  assert.equal((await runner.runNext(jobInput().jobId)).state, "sent");

  assert.equal(publicationCalls.length, 1);
  assert.equal(publicationCalls[0].artifactManifestDigest, digests.assetManifestDigest);
  assert.equal(resendCalls.length, 1);
  assert.equal(resendCalls[0].payload.to, "delivered@resend.dev");
});

test("private TEST-A operator runner fails closed when runtime secrets or exact origin are missing", () => {
  assert.throws(() => createTestAOperatorRunner({ environment: {} }),
    /BEBEBONJOUR_APPROVAL_HMAC_KEY is required/);
  assert.throws(() => createTestAOperatorRunner({
    environment: {
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
    },
  }), /RESEND_API_KEY is required/);
  assert.throws(() => createTestAOperatorRunner({
    environment: {
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
      RESEND_API_KEY: "re_private_canary_value",
      RESEND_FROM: "Bébé Bonjour <onboarding@resend.dev>",
      TEST_A_PUBLICATION_ORIGIN: "http://announcements.example.test",
    },
  }), /exact HTTPS origin/);
});

test("private TEST-A operator runner wires production-safe provider, clock, and token defaults", () => {
  const store = {
    async getJob() {
      return null;
    },
    async getReviewApproval() {
      return null;
    },
    async saveReviewApproval() {
      return null;
    },
  };
  const runner = createTestAOperatorRunner({
    store,
    environment: {
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
      RESEND_API_KEY: "re_test_operator_runner",
      RESEND_FROM: "Bébé Bonjour <onboarding@resend.dev>",
      TEST_A_PUBLICATION_ORIGIN: "https://announcements.example.test",
      VERCEL_TOKEN: "vercel_test_token",
      TEST_A_PUBLICATION_VERCEL_TEAM_ID: "team_test_a",
      TEST_A_PUBLICATION_VERCEL_PROJECT_ID: "prj_test_a_announcements",
      TEST_A_PUBLICATION_VERCEL_PROJECT_NAME: "bebebonjour-test-a-announcements",
      TEST_A_PUBLICATION_CANARY_JOB_ID: "job_test_001",
      TEST_A_PUBLICATION_CANARY_REVISION_ID: "r1",
      TEST_A_ARTIFACT_ROOT: "/tmp/bebebonjour-test-a-artifacts",
    },
    resend: { emails: { send: async () => null, get: async () => null } },
  });

  assert.equal(typeof runner.runNext, "function");
});
