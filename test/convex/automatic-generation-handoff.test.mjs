import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../support/legacy-schema.mjs";
import { createJobAggregate, recordPaymentTransition } from "../../src/forward-coexistence/live/src/fulfillment/job-machine.mjs";

const saveEditorialApproval = makeFunctionReference("generation:saveEditorialApproval");
const replaceJob = makeFunctionReference("customerFlow:replaceJob");
const replaceFulfillmentJob = makeFunctionReference("fulfillment:replaceJob");
const backendToken = "backend-token-at-least-thirty-two-characters";
const jobId = "job_automatic_generation_test_001";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function fixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./customerFlow.js": () => import("../../convex/customerFlow.js"),
    "./generation.js": () => import("../../convex/generation.js"),
    "./fulfillment.js": () => import("../../convex/fulfillment.js"),
  });
}

function approval() {
  const sourceEvidence = { kind: "kanban_human_decision", reference: "kanban:t_fictional_test_generation" };
  const record = {
    schemaVersion: "1.0",
    approvalType: "job_scoped_editorial_policy",
    jobId,
    policy: {
      id: "unknown_name_general_wishes",
      preserveSubmittedName: true,
      meaningAllowed: false,
      scripturalNameAssociationAllowed: false,
      genericBlessingsAllowed: true,
      maxStage: "content_review_required",
    },
    sourceEvidence,
    sourceDigest: sha256(JSON.stringify(sourceEvidence)),
  };
  return { record, recordDigest: sha256(`${JSON.stringify(record, null, 2)}\n`) };
}

async function seed(convex, { paid = false, product = "announcement-page" } = {}) {
  const intakeDigest = "a".repeat(64);
  const correlation = { project: "bebebonjour", product, environment: "test", jobId, intakeDigest };
  const aggregate = createJobAggregate({
    jobId, environment: "test", product, intakeDigest,
    paymentCorrelation: correlation, narrationRequired: true,
  }, { commandId: `customer-intake:${jobId}`, at: "2026-09-26T10:00:00.000Z" });
  const next = paid ? recordPaymentTransition(aggregate, {
    commandId: "stripe-payment:fictional_test_001",
    providerEventId: "evt_fictional_test_001",
    providerPaymentId: "pi_fictional_test_001",
    correlation,
    recordedAt: "2026-09-26T10:01:00.000Z",
  }, "2026-09-26T10:01:00.000Z") : aggregate;
  const customer = {
    jobId, version: 1, status: "payment_pending",
    intakeDigest,
    payment: { status: "pending" },
  };
  await convex.run(async (context) => {
    await context.db.insert("customerFlowJobs", { jobId, job: customer });
    await context.db.insert("fulfillmentJobs", { jobId, aggregate: next });
  });
  return customer;
}

async function commands(convex) {
  return convex.run((context) => context.db.query("customerFlowOperationsCommands").collect());
}

test("payment followed by editorial approval queues one generation command for the paid canonical version", async () => {
  const convex = fixture();
  const customer = await seed(convex, { paid: true });
  assert.equal((await commands(convex)).length, 0);
  const paid = { ...customer, version: 2, payment: { status: "paid", paymentIntentId: "pi_fictional_test_001" } };
  await convex.mutation(replaceJob, { backendToken, expectedVersion: 1, job: paid });
  assert.equal((await commands(convex)).length, 0);
  await convex.mutation(saveEditorialApproval, { backendToken, jobId, approval: approval() });
  const [command] = await commands(convex);
  assert.deepEqual({
    jobId: command.jobId, action: command.action, expectedState: command.expectedState,
    expectedVersion: command.expectedVersion, payload: command.payload,
    requestedBy: command.requestedBy, state: command.state,
  }, {
    jobId, action: "generate", expectedState: "generation_queued",
    expectedVersion: 2, payload: {}, requestedBy: "automatic_generation", state: "pending",
  });
  await convex.mutation(saveEditorialApproval, { backendToken, jobId, approval: approval() });
  assert.equal((await commands(convex)).length, 1);
});

test("editorial approval before payment waits until both canonical paid records exist", async () => {
  const convex = fixture();
  const customer = await seed(convex);
  await convex.mutation(saveEditorialApproval, { backendToken, jobId, approval: approval() });
  assert.equal((await commands(convex)).length, 0);
  const fulfillment = await convex.run((context) => context.db.query("fulfillmentJobs").unique());
  const next = recordPaymentTransition(fulfillment.aggregate, {
    commandId: "stripe-payment:fictional_test_001", providerEventId: "evt_fictional_test_001",
    providerPaymentId: "pi_fictional_test_001", correlation: fulfillment.aggregate.paymentCorrelation,
    recordedAt: "2026-09-26T10:01:00.000Z",
  }, "2026-09-26T10:01:00.000Z");
  await convex.mutation(replaceFulfillmentJob, {
    backendToken, jobId, expectedVersion: fulfillment.aggregate.version, aggregate: next,
  });
  assert.equal((await commands(convex)).length, 0);
  const paid = { ...customer, version: 2, payment: { status: "paid", paymentIntentId: "pi_fictional_test_001" } };
  await convex.mutation(replaceJob, { backendToken, expectedVersion: 1, job: paid });
  assert.equal((await commands(convex)).length, 1);
});

test("existing operator generation command wins over automatic enqueue", async () => {
  const convex = fixture();
  const customer = await seed(convex, { paid: true });
  await convex.run((context) => context.db.insert("customerFlowOperationsCommands", {
    commandId: "command_existing_generation_001", jobId, action: "generate",
    expectedState: "generation_queued", expectedVersion: 2, payload: {},
    requestedAt: "2026-09-26T10:02:00.000Z", requestedBy: "primary_operator",
    state: "pending", attempts: 0, claim: null, lastFailureReason: null,
    outcome: null, updatedAt: "2026-09-26T10:02:00.000Z",
  }));
  await convex.mutation(replaceJob, { backendToken, expectedVersion: 1, job: {
    ...customer, version: 2, payment: { status: "paid", paymentIntentId: "pi_fictional_test_001" },
  } });
  await convex.mutation(saveEditorialApproval, { backendToken, jobId, approval: approval() });
  assert.equal((await commands(convex)).length, 1);
});
