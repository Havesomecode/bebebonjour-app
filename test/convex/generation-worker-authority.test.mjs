import assert from "node:assert/strict";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";
import {
  claimStageTransition,
  createJobAggregate,
  recordPaymentTransition,
} from "../../src/fulfillment/job-machine.mjs";

const readClaimedCustomerJob = makeFunctionReference("generation:readClaimedCustomerJob");
const getClaimedFulfillmentJob = makeFunctionReference("generation:getClaimedFulfillmentJob");
const replaceClaimedFulfillmentJob = makeFunctionReference("generation:replaceClaimedFulfillmentJob");

const workerToken = "worker-token-at-least-thirty-two-characters_";
const workerId = "generation-worker-1";
const commandId = "command_generation_authority_000001";
const leaseToken = "generation-authority-lease-token";
const jobId = "job_generation_authority_001";
const intakeDigest = "a".repeat(64);
const now = "2026-09-06T10:00:00.000Z";

function fixture() {
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./generation.js": () => import("../../convex/generation.js"),
  });
}

function authority(overrides = {}) {
  return { workerToken, workerId, commandId, leaseToken, ...overrides };
}

function aggregateFixture() {
  const correlation = {
    project: "bebebonjour",
    product: "announcement-page",
    environment: "test",
    jobId,
    intakeDigest,
  };
  const created = createJobAggregate({
    jobId,
    environment: "test",
    product: "announcement-page",
    intakeDigest,
    paymentCorrelation: correlation,
    narrationRequired: false,
  }, { commandId: "create-generation-authority-fixture", at: now });
  return recordPaymentTransition(created, {
    commandId: "pay-generation-authority-fixture",
    providerEventId: "evt_generation_authority_fixture",
    providerPaymentId: "pi_generation_authority_fixture",
    correlation,
    recordedAt: now,
  }, now);
}

async function seed(convex, { action = "generate" } = {}) {
  const aggregate = aggregateFixture();
  const customer = {
    schemaVersion: "1.0",
    jobId,
    intakeDigest,
    intake: { requestId: jobId },
    payment: { status: "paid" },
  };
  await convex.run(async (context) => {
    await context.db.insert("customerFlowJobs", { jobId, job: customer });
    await context.db.insert("fulfillmentJobs", { jobId, aggregate });
    await context.db.insert("customerFlowOperationsCommands", {
      commandId,
      jobId,
      action,
      expectedState: "generation_queued",
      expectedVersion: aggregate.version,
      payload: {},
      requestedAt: now,
      requestedBy: "primary_operator",
      state: "running",
      attempts: 1,
      claim: {
        workerId,
        leaseToken,
        claimedAtMs: Date.now(),
        leaseExpiresAtMs: Date.now() + 600_000,
        effectStartedAtMs: Date.now(),
      },
      lastFailureReason: null,
      outcome: null,
      updatedAt: now,
    });
  });
  return { aggregate, customer };
}

test("claim-scoped generation authority reads and advances only its claimed prepare_review job", async () => {
  const convex = fixture();
  const { aggregate, customer } = await seed(convex);
  assert.deepEqual(await convex.query(readClaimedCustomerJob, {
    ...authority(), jobId,
  }), customer);
  assert.deepEqual(await convex.query(getClaimedFulfillmentJob, {
    ...authority(), jobId,
  }), aggregate);

  const next = claimStageTransition(aggregate, {
    commandId: "claim-generation-authority-stage",
    stage: "prepare_review",
    leaseToken: "prepare-review-stage-lease",
    leaseMs: 300_000,
    maxAttempts: 2,
    operationsCommandId: commandId,
  }, now);
  const forgedHistory = structuredClone(next);
  forgedHistory.events[0].type = "forged_history";
  await assert.rejects(
    convex.mutation(replaceClaimedFulfillmentJob, {
      ...authority(),
      jobId,
      expectedVersion: aggregate.version,
      aggregate: forgedHistory,
    }),
    /prepare_review/u,
  );
  assert.deepEqual(await convex.mutation(replaceClaimedFulfillmentJob, {
    ...authority(),
    jobId,
    expectedVersion: aggregate.version,
    aggregate: next,
  }), { updated: true, aggregate: next });
});

test("generation authority rejects wrong, replayed, cross-job, and non-generate claims", async () => {
  const convex = fixture();
  await seed(convex);
  for (const invalid of [
    authority({ workerToken: "wrong-worker-token-with-at-least-thirty-two" }),
    authority({ leaseToken: "replayed-lease-token" }),
    authority({ commandId: "command_generation_authority_999999" }),
  ]) {
    await assert.rejects(
      convex.query(getClaimedFulfillmentJob, { ...invalid, jobId }),
      /claim|authorization/u,
    );
  }
  await assert.rejects(
    convex.query(getClaimedFulfillmentJob, {
      ...authority(),
      jobId: "job_generation_authority_other",
    }),
    /claim|authorization/u,
  );

  const wrongAction = fixture();
  await seed(wrongAction, { action: "publish" });
  await assert.rejects(
    wrongAction.query(getClaimedFulfillmentJob, { ...authority(), jobId }),
    /prepare_review|claim/u,
  );
});
