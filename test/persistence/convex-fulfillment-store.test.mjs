import assert from "node:assert/strict";
import test from "node:test";

import { createConvexFulfillmentStore } from "../../src/persistence/convex-fulfillment-store.mjs";

const input = {
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

const payment = {
  commandId: "payment:evt_test_001",
  providerEventId: "evt_test_001",
  providerPaymentId: "pi_test_001",
  correlation: input.paymentCorrelation,
  recordedAt: "2026-08-18T10:01:00.000Z",
};

test("Convex fulfillment store applies payment transitions with compare-and-set persistence", async () => {
  let aggregate;
  const calls = [];
  const client = {
    async query() {
      return aggregate ? structuredClone(aggregate) : null;
    },
    async mutation(reference, args) {
      calls.push({ reference, args: structuredClone(args) });
      if (reference === "fulfillment:createJob") {
        aggregate = structuredClone(args.aggregate);
        return { created: true, aggregate: structuredClone(aggregate) };
      }
      aggregate = structuredClone(args.aggregate);
      return { updated: true, aggregate: structuredClone(aggregate) };
    },
  };
  const store = createConvexFulfillmentStore({
    client,
    backendToken: "backend-token-at-least-32-characters",
    functions: {
      createJob: "fulfillment:createJob",
      getJob: "fulfillment:getJob",
      replaceJob: "fulfillment:replaceJob",
    },
  });

  const created = await store.createJob(input, {
    commandId: "create:test-001",
    at: "2026-08-18T10:00:00.000Z",
  });
  const paid = await store.recordPayment(input.jobId, payment, payment.recordedAt);

  assert.equal(created.state, "awaiting_payment");
  assert.equal(paid.state, "generation_queued");
  assert.equal(calls[1].args.expectedVersion, created.version);
  assert.equal(calls[1].args.aggregate.version, created.version + 1);
});

test("Convex fulfillment store persists and reloads one immutable review approval", async () => {
  const approval = {
    schemaVersion: "1.0",
    approvalId: `approval_${"a".repeat(24)}`,
    binding: { jobId: input.jobId },
    decision: { outcome: "approved" },
    signature: "b".repeat(64),
  };
  let persisted = null;
  const client = {
    async query(reference, args) {
      assert.equal(reference, "fulfillment:getReviewApproval");
      assert.equal(args.approvalId, approval.approvalId);
      return structuredClone(persisted);
    },
    async mutation(reference, args) {
      assert.equal(reference, "fulfillment:saveReviewApproval");
      assert.deepEqual(args.approval, approval);
      persisted = structuredClone(args.approval);
      return { created: true, approval: structuredClone(persisted) };
    },
  };
  const store = createConvexFulfillmentStore({
    client,
    backendToken: "backend-token-at-least-32-characters",
  });

  assert.deepEqual(await store.saveReviewApproval(approval), approval);
  assert.deepEqual(await store.getReviewApproval(approval.approvalId), approval);
});
