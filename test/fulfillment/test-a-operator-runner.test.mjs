import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFulfillmentOrchestrator } from "../../src/fulfillment/job-orchestrator.mjs";
import { signPersistedReviewApproval } from "../../src/fulfillment/persisted-review-decision.mjs";
import {
  createTestAOperatorReviewRunner,
  createTestAOperatorRunner,
  createTestAOperatorStatusRunner,
} from "../../src/fulfillment/operator-runner-test-a.mjs";
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

test("status-only runner supplies safe local clock and token defaults", () => {
  const runner = createTestAOperatorStatusRunner({
    store: {
      async getJob() {
        return null;
      },
    },
  });

  assert.equal(typeof runner.status, "function");
});


test("review-only runner rejects malformed approval bytes before store I/O", async () => {
  let storeIo = 0;
  const runner = createTestAOperatorReviewRunner({
    environment: {
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
    },
    store: {
      async getJob() { storeIo += 1; },
      async getReviewApproval() { storeIo += 1; },
      async saveReviewApproval() { storeIo += 1; },
    },
  });

  await assert.rejects(
    runner.persistAndRecordReview("job_test_001", Buffer.from("not-json\n", "utf8")),
    /approval input is not valid JSON/i,
  );
  assert.equal(storeIo, 0);
});

async function createReviewFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-test-a-review-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createLocalTestFulfillmentStore({ filePath: path.join(root, "store.json") });
  const approvals = new Map();
  let saves = 0;
  store.getReviewApproval = async (approvalId) => structuredClone(approvals.get(approvalId) || null);
  store.saveReviewApproval = async (approval) => {
    saves += 1;
    if (!approvals.has(approval.approvalId)) approvals.set(approval.approvalId, structuredClone(approval));
    return structuredClone(approvals.get(approval.approvalId));
  };
  const now = "2026-08-25T08:03:00.000Z";
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
    clock: () => "2026-08-25T08:00:00.000Z",
    tokenFactory: (label) => `seed:${label}`,
    retryPolicy,
  });
  await seed.createJob(jobInput(), { commandId: "create:test-a" });
  await seed.recordPayment(jobInput().jobId, {
    commandId: "payment:evt_test_001",
    providerEventId: "evt_test_001",
    providerPaymentId: "pi_test_001",
    correlation: jobInput().paymentCorrelation,
    recordedAt: "2026-08-25T08:00:00.000Z",
  });
  await seed.runNext(jobInput().jobId);
  const runner = createTestAOperatorReviewRunner({
    store,
    environment: {
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
    },
    clock: () => now,
    tokenFactory: (label) => `review:${label}`,
    retryPolicy,
  });
  return { approvals, runner, saves: () => saves, store };
}

test("review-only runner rejects an unsigned approval without persistence or provider I/O", async (t) => {
  const fixture = await createReviewFixture(t);

  await assert.rejects(
    fixture.runner.persistAndRecordReview(jobInput().jobId, Buffer.from(JSON.stringify(decision()))),
    /signed persisted review approval/i,
  );
  assert.equal(fixture.saves(), 0);
  assert.equal(fixture.approvals.size, 0);
});

test("review-only runner rejects a forged approval without persistence or provider I/O", async (t) => {
  const fixture = await createReviewFixture(t);
  const job = await fixture.store.getJob(jobInput().jobId);
  const approval = signPersistedReviewApproval({
    hmacKey: "operator-review-key-with-at-least-thirty-two-bytes",
    job,
    decision: decision(),
  });
  approval.signature = "0".repeat(64);

  await assert.rejects(
    fixture.runner.persistAndRecordReview(jobInput().jobId, Buffer.from(JSON.stringify(approval))),
    /signature verification failed/i,
  );
  assert.equal(fixture.saves(), 0);
  assert.equal(fixture.approvals.size, 0);
});

test("review-only runner rejects a signed approval bound to a different job", async (t) => {
  const fixture = await createReviewFixture(t);
  const currentJob = await fixture.store.getJob(jobInput().jobId);
  const approval = signPersistedReviewApproval({
    hmacKey: "operator-review-key-with-at-least-thirty-two-bytes",
    job: { ...currentJob, jobId: "job_other_001" },
    decision: decision(),
  });

  await assert.rejects(
    fixture.runner.persistAndRecordReview(jobInput().jobId, Buffer.from(`${JSON.stringify(approval)}\n`)),
    /does not bind the current job run and manifest/i,
  );
  assert.equal(fixture.saves(), 0);
  assert.equal(fixture.approvals.size, 0);
});

test("review-only runner rejects a stale signed artifact manifest before persistence", async (t) => {
  const fixture = await createReviewFixture(t);
  const currentJob = await fixture.store.getJob(jobInput().jobId);
  const staleDecision = decision();
  staleDecision.artifactDigests.assetManifestDigest = "f".repeat(64);
  const approval = signPersistedReviewApproval({
    hmacKey: "operator-review-key-with-at-least-thirty-two-bytes",
    job: currentJob,
    decision: staleDecision,
  });

  await assert.rejects(
    fixture.runner.persistAndRecordReview(jobInput().jobId, Buffer.from(`${JSON.stringify(approval)}\n`)),
    /does not match the exact persisted artifact manifest/i,
  );
  assert.equal(fixture.saves(), 0);
  assert.equal(fixture.approvals.size, 0);
});

test("review-only runner rejects non-canonical approval transport bytes before persistence", async (t) => {
  const fixture = await createReviewFixture(t);
  const currentJob = await fixture.store.getJob(jobInput().jobId);
  const approval = signPersistedReviewApproval({
    hmacKey: "operator-review-key-with-at-least-thirty-two-bytes",
    job: currentJob,
    decision: decision(),
  });

  await assert.rejects(
    fixture.runner.persistAndRecordReview(
      jobInput().jobId,
      Buffer.from(`${JSON.stringify(approval, null, 2)}\n`, "utf8"),
    ),
    /canonical exact approval bytes/i,
  );
  assert.equal(fixture.saves(), 0);
  assert.equal(fixture.approvals.size, 0);
});

test("review-only runner persists the exact authenticated approval and records review", async (t) => {
  const fixture = await createReviewFixture(t);
  const currentJob = await fixture.store.getJob(jobInput().jobId);
  const approval = signPersistedReviewApproval({
    hmacKey: "operator-review-key-with-at-least-thirty-two-bytes",
    job: currentJob,
    decision: decision(),
  });
  const exactInput = Buffer.from(`${JSON.stringify(approval)}\n`, "utf8");

  const reviewed = await fixture.runner.persistAndRecordReview(jobInput().jobId, exactInput);

  assert.equal(reviewed.state, "render_queued");
  assert.deepEqual(fixture.approvals.get(approval.approvalId), approval);
  assert.deepEqual(Buffer.from(`${JSON.stringify(fixture.approvals.get(approval.approvalId))}\n`), exactInput);
  assert.equal(fixture.saves(), 1);
});

test("legacy provider-capable runner fails closed before provider construction", () => {
  let providerConstructions = 0;
  assert.throws(
    () => createTestAOperatorRunner({
      publicationProvider: () => { providerConstructions += 1; },
      resend: () => { providerConstructions += 1; },
    }),
    /status\/review-only.*publication and delivery are disabled/i,
  );
  assert.equal(providerConstructions, 0);
});
