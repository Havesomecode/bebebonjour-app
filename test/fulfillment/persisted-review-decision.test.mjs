import assert from "node:assert/strict";
import test from "node:test";

import {
  createPersistedReviewDecisionVerifier,
  signPersistedReviewApproval,
} from "../../src/fulfillment/persisted-review-decision.mjs";

const key = "operator-review-key-with-at-least-thirty-two-bytes";
const digests = Object.freeze({
  pageDigest: "1".repeat(64),
  transcriptDigest: "2".repeat(64),
  assetManifestDigest: "3".repeat(64),
});

function currentJob() {
  return {
    jobId: "job_test_001",
    environment: "test",
    product: "announcement-page",
    intakeDigest: "0".repeat(64),
    state: "content_review_required",
    currentRevisionId: "r1",
    stageAttempts: [{
      attemptId: "attempt_prepare_001",
      stage: "prepare_review",
      revisionId: "r1",
      status: "completed",
    }],
  };
}

function contentDecision() {
  return {
    commandId: "review:placeholder",
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
    decidedAt: "2026-08-25T08:00:00.000Z",
    artifactDigests: digests,
    reasons: ["Synthetic TEST-A revision reviewed."],
  };
}

test("persisted review verification returns only the signed decision bound to the current job run and manifest", async () => {
  const approval = signPersistedReviewApproval({
    hmacKey: key,
    job: currentJob(),
    decision: contentDecision(),
  });
  const verifier = createPersistedReviewDecisionVerifier({
    hmacKey: key,
    fulfillmentStore: {
      async getJob() {
        return {
          artifactSets: [{
            kind: "private_review",
            revisionId: "r1",
            ...digests,
          }],
        };
      },
    },
    approvalStore: {
      async getReviewApproval(approvalId) {
        assert.equal(approvalId, approval.approvalId);
        return structuredClone(approval);
      },
    },
  });

  const verified = await verifier({
    job: currentJob(),
    decision: { approvalId: approval.approvalId },
  });

  assert.deepEqual(verified, { ...approval.decision, approvalId: approval.approvalId });
  assert.equal(verified.commandId, `review:${approval.approvalId}`);
  assert.equal(approval.binding.runId, "attempt_prepare_001");
  assert.equal(approval.binding.intakeDigest, "0".repeat(64));
  assert.equal(approval.binding.artifactManifestDigest, digests.assetManifestDigest);
});

test("review approval signing rejects unexpected personal-data fields", () => {
  assert.throws(() => signPersistedReviewApproval({
    hmacKey: key,
    job: currentJob(),
    decision: {
      ...contentDecision(),
      customerEmail: "not-needed@example.test",
    },
  }), /unexpected fields/i);
});

test("review verification rejects unsigned extra fields on a persisted approval", async () => {
  const approval = signPersistedReviewApproval({
    hmacKey: key,
    job: currentJob(),
    decision: contentDecision(),
  });
  const verifier = createPersistedReviewDecisionVerifier({
    hmacKey: key,
    approvalStore: {
      async getReviewApproval() {
        return { ...approval, customerEmail: "not-needed@example.test" };
      },
    },
    fulfillmentStore: {
      async getJob() {
        return {
          artifactSets: [{ kind: "private_review", revisionId: "r1", ...digests }],
        };
      },
    },
  });

  await assert.rejects(verifier({
    job: currentJob(),
    decision: { approvalId: approval.approvalId },
  }), /unexpected fields/i);
});
