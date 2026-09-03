import assert from "node:assert/strict";
import test from "node:test";

import { createOperationsActionHandlers } from "../../src/operations/operations-action-handlers.mjs";

const DIGESTS = Object.freeze({
  pageDigest: "1".repeat(64),
  transcriptDigest: "2".repeat(64),
  assetManifestDigest: "3".repeat(64),
});

function command(commandId, action, payload = {}) {
  return {
    commandId,
    jobId: "job_ops_bridge_001",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload,
    async fenceExternalEffect(providerMutation) {
      return providerMutation(Object.freeze({
        idempotencyKey: commandId,
        fencingToken: "lease_ops_bridge_001",
        leaseExpiresAtMs: Date.parse("2026-09-03T05:05:00.000Z"),
      }));
    },
  };
}

function fixture() {
  let customer = {
    jobId: "job_ops_bridge_001",
    version: 2,
    payment: { checkout: null },
  };
  let aggregate = {
    jobId: "job_ops_bridge_001",
    state: "generation_queued",
    version: 3,
    currentRevisionId: null,
    artifactSets: [],
    reviewDecisions: [],
    deliveryAttempts: [],
    events: [],
  };
  const calls = [];
  const operationsCheckout = {
    async createCheckout(jobId, operationsCommandId) {
      calls.push(["checkout", jobId, operationsCommandId]);
      customer = {
        ...customer,
        version: 3,
        payment: {
          checkout: {
            sessionId: "checkout_ops_bridge_001",
            checkoutUrl: "https://checkout.example.test/ops-bridge",
            operationsCommandId,
          },
        },
      };
    },
  };
  const fulfillmentOrchestrator = {
    async runExpectedStage(jobId, stage, options) {
      calls.push(["stage", jobId, stage, options.operationsCommandId]);
      const invokeStage = async () => {
        if (stage === "prepare_review") {
          aggregate = {
            ...aggregate,
            state: "content_review_required",
            version: 5,
            currentRevisionId: "revision_ops_bridge_001",
            artifactSets: [{
              artifactSetId: "artifact_ops_bridge_001",
              kind: "private_review",
              revisionId: "revision_ops_bridge_001",
              operationsCommandId: options.operationsCommandId,
              ...DIGESTS,
            }],
          };
        }
      };
      if (options.operationsEffectBoundary) {
        await options.operationsEffectBoundary({
          stage,
          operationsCommandId: options.operationsCommandId,
        }, invokeStage);
      } else {
        await invokeStage();
      }
    },
    async recordReviewDecision(jobId, decision) {
      calls.push(["review", jobId, decision.operationsCommandId]);
      aggregate = {
        ...aggregate,
        state: "render_queued",
        version: 6,
        reviewDecisions: [{
          ...decision,
          decisionId: "decision_ops_bridge_001",
        }],
      };
    },
    async queueDelivery(jobId, input) {
      calls.push(["queue", jobId, input.commandId]);
      aggregate = {
        ...aggregate,
        state: "delivery_queued",
        version: aggregate.version + 1,
        events: [...aggregate.events, { commandId: input.commandId, type: "delivery_queued" }],
      };
    },
    async resumeRetry(jobId, input) {
      calls.push(["retry", jobId, input.commandId]);
      aggregate = {
        ...aggregate,
        state: "generation_queued",
        version: aggregate.version + 1,
        retry: null,
        events: [...aggregate.events, { commandId: input.commandId, type: "retry_resumed" }],
      };
    },
  };
  const handlers = createOperationsActionHandlers({
    operationsCheckout,
    customerStore: { async readJob() { return structuredClone(customer); } },
    fulfillmentOrchestrator,
    fulfillmentStore: { async getJob() { return structuredClone(aggregate); } },
    async authorizeReviewDecision(input) {
      return {
        commandId: input.commandId,
        operationsCommandId: input.commandId,
        decisionType: input.decisionType,
        outcome: input.outcome,
        revisionId: input.payload.revisionId,
        artifactDigests: input.payload.artifactDigests,
      };
    },
    async reconcileExternalEffect() {},
  });
  return { calls, handlers, setAggregate(value) { aggregate = structuredClone(value); } };
}

test("action bridge fences checkout and generation and returns only canonical provenance", async () => {
  const { calls, handlers } = fixture();
  const checkoutId = "command_bridge_checkout_000001";
  assert.deepEqual(await handlers.create_checkout(command(checkoutId, "create_checkout")), {
    code: "checkout_available",
    checkoutSessionId: "checkout_ops_bridge_001",
    checkoutUrl: "https://checkout.example.test/ops-bridge",
    jobVersion: 3,
  });

  const generateId = "command_bridge_generate_000001";
  assert.deepEqual(await handlers.generate(command(generateId, "generate")), {
    code: "review_prepared",
    revisionId: "revision_ops_bridge_001",
    artifactSetId: "artifact_ops_bridge_001",
    jobVersion: 5,
  });
  assert.deepEqual(calls.slice(0, 2), [
    ["checkout", "job_ops_bridge_001", checkoutId],
    ["stage", "job_ops_bridge_001", "prepare_review", generateId],
  ]);
});

test("action bridge binds review, queue, retry, and reconciliation to command ids", async () => {
  const { handlers, setAggregate } = fixture();
  const reviewId = "command_bridge_review_000001";
  const reviewPayload = {
    revisionId: "revision_ops_bridge_001",
    artifactManifestDigest: DIGESTS.assetManifestDigest,
    artifactDigests: DIGESTS,
  };
  assert.deepEqual(await handlers.approve_content(command(reviewId, "approve_content", reviewPayload)), {
    code: "review_recorded",
    decisionId: "decision_ops_bridge_001",
    jobVersion: 6,
  });

  setAggregate({
    jobId: "job_ops_bridge_001",
    state: "published",
    version: 8,
    currentRevisionId: "revision_ops_bridge_001",
    events: [],
    artifactSets: [],
    reviewDecisions: [],
    deliveryAttempts: [],
    retry: null,
  });
  const queueId = "command_bridge_queue_000001";
  assert.deepEqual(await handlers.queue_delivery(command(queueId, "queue_delivery", {
    revisionId: "revision_ops_bridge_001",
    publicationId: "publication_ops_bridge_001",
  })), { code: "delivery_queued", jobVersion: 9 });

  setAggregate({
    jobId: "job_ops_bridge_001",
    state: "retry_wait",
    version: 10,
    currentRevisionId: "revision_ops_bridge_001",
    events: [],
    artifactSets: [],
    reviewDecisions: [],
    deliveryAttempts: [],
    retry: { stage: "prepare_review" },
  });
  const retryId = "command_bridge_retry_000001";
  assert.deepEqual(await handlers.retry(command(retryId, "retry")), {
    code: "retry_scheduled",
    jobVersion: 11,
  });

  const reconcileId = "command_bridge_reconcile_000001";
  assert.deepEqual(await handlers.reconcile(command(reconcileId, "reconcile", {
    sourceCommandId: "command_bridge_source_000001",
    providerStatus: "confirmed_absent",
  })), {
    code: "reconciled",
    jobVersion: 11,
    reconciledState: "generation_queued",
    sourceCommandId: "command_bridge_source_000001",
    providerStatus: "confirmed_absent",
  });
});

test("action bridge rejects missing review and reconciliation trust capabilities", () => {
  const base = {
    operationsCheckout: { createCheckout() {} },
    customerStore: { readJob() {} },
    fulfillmentOrchestrator: {
      runExpectedStage() {}, recordReviewDecision() {}, queueDelivery() {}, resumeRetry() {},
    },
    fulfillmentStore: { getJob() {} },
  };
  assert.throws(
    () => createOperationsActionHandlers({ ...base, reconcileExternalEffect() {} }),
    /review authorization/i,
  );
  assert.throws(
    () => createOperationsActionHandlers({ ...base, authorizeReviewDecision() {} }),
    /provider reconciliation/i,
  );
});
