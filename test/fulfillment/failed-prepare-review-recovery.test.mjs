import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID,
  claimStageTransition,
  completeStageTransition,
  createJobAggregate,
  failStageTransition,
  recordPaymentTransition,
  recoverFailedPrepareReviewTransition,
  resumeRetryTransition,
} from "../../src/fulfillment/job-machine.mjs";
import { createTestAGenerationRunner } from "../../src/fulfillment/test-a-generation-runner.mjs";

const JOB_ID = "job_c633aa4c-0039-4257-8913-eaa6f6197d0c";
const INTAKE_DIGEST = "a".repeat(64);
const EDITORIAL_POLICY = Object.freeze({
  id: "unknown_name_general_wishes",
  preserveSubmittedName: true,
  meaningAllowed: false,
  scripturalNameAssociationAllowed: false,
  genericBlessingsAllowed: true,
  maxStage: "content_review_required",
});
const PAYMENT_CORRELATION = Object.freeze({
  project: "bebebonjour",
  product: "announcement-page",
  environment: "test",
  jobId: JOB_ID,
  intakeDigest: INTAKE_DIGEST,
});
const FAILURE_POLICY = Object.freeze({
  maxAttemptsByStage: Object.freeze({ prepare_review: 1 }),
  backoffMsByStage: Object.freeze({ prepare_review: Object.freeze([]) }),
});

function editorialApproval() {
  const sourceEvidence = {
    kind: "kanban_human_decision",
    reference: "kanban:t_synthetic_recovery_authority",
  };
  const record = {
    schemaVersion: "1.0",
    approvalType: "job_scoped_editorial_policy",
    jobId: JOB_ID,
    policy: EDITORIAL_POLICY,
    sourceEvidence,
    sourceDigest: sha256(JSON.stringify(sourceEvidence)),
  };
  return {
    record,
    recordDigest: sha256(`${JSON.stringify(record, null, 2)}\n`),
  };
}

function failedAggregate() {
  const input = {
    jobId: JOB_ID,
    environment: "test",
    product: "announcement-page",
    intakeDigest: INTAKE_DIGEST,
    paymentCorrelation: PAYMENT_CORRELATION,
    narrationRequired: false,
  };
  let aggregate = createJobAggregate(input, {
    commandId: "create-exact-recovery-fixture",
    at: "2026-09-01T12:00:00.000Z",
  });
  aggregate = recordPaymentTransition(aggregate, {
    commandId: "pay-exact-recovery-fixture",
    providerEventId: "evt_exact_recovery_fixture",
    providerPaymentId: "pi_exact_recovery_fixture",
    correlation: PAYMENT_CORRELATION,
    recordedAt: "2026-09-01T12:01:00.000Z",
  }, "2026-09-01T12:01:00.000Z");
  aggregate = claimStageTransition(aggregate, {
    commandId: "claim-failed-prepare-review-fixture",
    stage: "prepare_review",
    leaseToken: "failed-prepare-review-lease",
    leaseMs: 300_000,
    maxAttempts: 1,
    operationBinding: null,
  }, "2026-09-01T12:02:00.000Z");
  return failStageTransition(aggregate, {
    commandId: "fail-prepare-review-fixture",
    stage: "prepare_review",
    leaseToken: "failed-prepare-review-lease",
    reasonCode: "stage_error",
    retryable: false,
  }, FAILURE_POLICY, "2026-09-01T12:03:00.000Z");
}

function recoveryCommand(aggregate = failedAggregate()) {
  const approval = editorialApproval();
  return {
    commandId: `recover-failed-prepare-review:${JOB_ID}:${aggregate.stageAttempts.at(-1).attemptId}`,
    jobId: JOB_ID,
    failedAttemptId: aggregate.stageAttempts.at(-1).attemptId,
    intakeDigest: INTAKE_DIGEST,
    paymentCorrelation: PAYMENT_CORRELATION,
    editorialApproval: {
      approvalType: approval.record.approvalType,
      jobId: approval.record.jobId,
      policy: approval.record.policy,
      record: approval.record,
      recordDigest: approval.recordDigest,
      sourceDigest: approval.record.sourceDigest,
      intakeDigest: INTAKE_DIGEST,
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("the exact failed prepare_review transition is audited, terminal-evidence preserving, and idempotent", () => {
  assert.equal(RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID, JOB_ID);
  const failed = failedAggregate();
  const failedAttempt = clone(failed.stageAttempts[0]);
  const command = recoveryCommand(failed);

  const recovered = recoverFailedPrepareReviewTransition(
    failed,
    command,
    "2026-09-01T12:04:00.000Z",
  );

  assert.equal(recovered.state, "generation_queued");
  assert.equal(recovered.retry, null);
  assert.deepEqual(recovered.stageAttempts, [failedAttempt]);
  assert.equal(recovered.events.at(-1).type, "failed_prepare_review_recovered");
  assert.equal(recovered.events.at(-1).state, "generation_queued");
  assert.match(recovered.events.at(-1).commandDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    recoverFailedPrepareReviewTransition(recovered, command, "2026-09-01T12:05:00.000Z"),
    recovered,
  );
  assert.throws(
    () => recoverFailedPrepareReviewTransition(recovered, {
      ...command,
      intakeDigest: "b".repeat(64),
    }, "2026-09-01T12:05:00.000Z"),
    /command replay/i,
  );
});

test("recovery rejects every non-exact or ambiguous failed-state predicate without mutation", async (t) => {
  const cases = [
    ["wrong opaque job identifier", (job, command) => { command.jobId = `${JOB_ID}x`; }],
    ["fulfillment intake mismatch", (job) => { job.intakeDigest = "b".repeat(64); }],
    ["payment correlation mismatch", (job) => { job.payment.correlation.intakeDigest = "b".repeat(64); }],
    ["payment absent", (job) => { job.payment = null; }],
    ["external effect present", (job) => { job.stageAttempts[0].effectStartedAt = job.updatedAt; }],
    ["revision present", (job) => { job.currentRevisionId = "r1"; }],
    ["wrong latest stage", (job) => { job.stageAttempts[0].stage = "publish"; }],
    ["wrong latest attempt status", (job) => { job.stageAttempts[0].status = "reconciliation_required"; }],
    ["retry state present", (job) => { job.retry = { stage: "prepare_review", availableAt: job.updatedAt }; }],
    ["wrong aggregate state", (job) => { job.state = "reconciliation_required"; }],
    ["more than the exact failed attempt", (job) => { job.stageAttempts.push(clone(job.stageAttempts[0])); }],
    ["artifact evidence present", (job) => { job.artifactSets.push({ kind: "private_review" }); }],
    ["publication evidence present", (job) => { job.publication = { provider: "unexpected" }; }],
    ["delivery evidence present", (job) => { job.deliveryAttempts.push({ provider: "unexpected" }); }],
    ["wrong approval record digest", (_job, command) => {
      command.editorialApproval.recordDigest = "b".repeat(64);
    }],
    ["wrong approval source digest", (_job, command) => {
      command.editorialApproval.sourceDigest = "b".repeat(64);
    }],
    ["broadened approval policy", (_job, command) => {
      command.editorialApproval.policy = {
        ...command.editorialApproval.policy,
        meaningAllowed: true,
      };
    }],
    ["approval intake mismatch", (_job, command) => {
      command.editorialApproval.intakeDigest = "b".repeat(64);
    }],
    ["unexpected command field", (_job, command) => { command.resetAllFailures = true; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const aggregate = failedAggregate();
      const command = recoveryCommand(aggregate);
      mutate(aggregate, command);
      const before = clone(aggregate);
      assert.throws(
        () => recoverFailedPrepareReviewTransition(
          aggregate,
          command,
          "2026-09-01T12:04:00.000Z",
        ),
        /failed prepare-review recovery rejected/i,
      );
      assert.deepEqual(aggregate, before);
    });
  }
});

test("the isolated runner recovers only the exact job and advances only prepare_review", async () => {
  let aggregate = failedAggregate();
  const calls = [];
  const store = {
    async getJob(jobId) {
      calls.push({ kind: "get", jobId });
      return jobId === aggregate.jobId ? clone(aggregate) : null;
    },
    async recoverFailedPrepareReview(jobId, command, at) {
      calls.push({ kind: "recover", jobId, command: clone(command) });
      aggregate = recoverFailedPrepareReviewTransition(aggregate, command, at);
      return clone(aggregate);
    },
    async claimStage(jobId, command, at) {
      calls.push({ kind: "claim", jobId });
      aggregate = claimStageTransition(aggregate, command, at);
      return { aggregate: clone(aggregate), acquired: true };
    },
    async completeStage(jobId, command, at) {
      calls.push({ kind: "complete", jobId });
      aggregate = completeStageTransition(aggregate, command, at);
      return clone(aggregate);
    },
    async failStage() {
      throw new Error("unexpected fixture stage failure");
    },
    async resumeRetry(jobId, command, at) {
      aggregate = resumeRetryTransition(aggregate, command, at);
      return clone(aggregate);
    },
  };
  const customer = {
    schemaVersion: "1.0",
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: {
      schemaVersion: "1.0",
      requestId: JOB_ID,
      customer: { email: "recovery-fixture@example.test", consent: true },
      baby: { firstName: "Recovery Fixture", gender: "neutral" },
      languages: ["fr"],
      voicePreference: { enabled: false, gender: "neutral" },
    },
    payment: { status: "paid" },
  };
  const runner = createTestAGenerationRunner({
    editorialApproval: editorialApproval(),
    customerReader: { readJob: async () => clone(customer) },
    store,
    workspace: {
      async persistJobInput(value) {
        calls.push({ kind: "persist", jobId: value.jobId });
      },
    },
    async prepareReview() {
      calls.push({ kind: "prepare_review" });
      return {
        revision: { revisionId: "r1", ordinal: 1, inputDigest: INTAKE_DIGEST },
        artifactSet: {
          kind: "private_review",
          revisionId: "r1",
          pageDigest: "b".repeat(64),
          transcriptDigest: "c".repeat(64),
          assetManifestDigest: "d".repeat(64),
        },
      };
    },
    clock: () => "2026-09-01T12:04:00.000Z",
    tokenFactory: () => "recovery-generation-lease",
  });

  const result = await runner.generate(JOB_ID);

  assert.deepEqual(result, {
    jobId: JOB_ID,
    outcome: "generated",
    state: "content_review_required",
    revisionId: "r1",
    intakeDigest: INTAKE_DIGEST,
  });
  assert.deepEqual(calls.map(({ kind }) => kind), [
    "get",
    "recover",
    "persist",
    "get",
    "claim",
    "prepare_review",
    "complete",
  ]);
  assert.equal(aggregate.stageAttempts[0].status, "failed");
  assert.equal(aggregate.stageAttempts[1].stage, "prepare_review");
  assert.equal(aggregate.stageAttempts[1].status, "completed");
  assert.equal(aggregate.state, "content_review_required");
  assert.equal(aggregate.reviewDecisions.length, 0);
  assert.equal(aggregate.publication, null);
  assert.deepEqual(aggregate.deliveryAttempts, []);
  assert.doesNotMatch(JSON.stringify(result), /Recovery Fixture|recovery-fixture@example\.test/u);
});

test("runner rejects wrong identity and malformed or missing approval before recovery mutation", async () => {
  const malformed = editorialApproval();
  malformed.recordDigest = "b".repeat(64);
  for (const approval of [undefined, malformed]) {
    assert.throws(
      () => createTestAGenerationRunner({ editorialApproval: approval }),
      (error) => error.code === "generation_approval_rejected",
    );
  }

  let recoveries = 0;
  const aggregate = failedAggregate();
  const store = {
    getJob: async () => clone(aggregate),
    recoverFailedPrepareReview: async () => { recoveries += 1; },
    claimStage: async () => { throw new Error("must not claim"); },
    completeStage: async () => { throw new Error("must not complete"); },
    failStage: async () => { throw new Error("must not fail"); },
    resumeRetry: async () => { throw new Error("must not resume"); },
  };
  const customer = {
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: { requestId: `${JOB_ID}x` },
    payment: { status: "paid" },
  };
  const runner = createTestAGenerationRunner({
    editorialApproval: editorialApproval(),
    customerReader: { readJob: async () => clone(customer) },
    store,
    workspace: { persistJobInput: async () => { throw new Error("must not persist"); } },
    prepareReview: async () => { throw new Error("must not generate"); },
  });

  await assert.rejects(runner.generate(JOB_ID), (error) => {
    assert.equal(error.code, "generation_authority_rejected");
    assert.doesNotMatch(error.message, /Recovery Fixture|recovery-fixture@example\.test/u);
    return true;
  });
  await assert.rejects(runner.generate(`${JOB_ID}x`), (error) => {
    assert.equal(error.code, "generation_approval_rejected");
    return true;
  });
  assert.equal(recoveries, 0);
});
