import assert from "node:assert/strict";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";

const createJob = makeFunctionReference("customerFlow:createJob");
const readJob = makeFunctionReference("customerFlow:readJob");
const replaceJob = makeFunctionReference("customerFlow:replaceJob");
const readProviderEvent = makeFunctionReference("customerFlow:readProviderEvent");
const recordProviderEvent = makeFunctionReference("customerFlow:recordProviderEvent");
const claimProviderEvent = makeFunctionReference("customerFlow:claimProviderEvent");
const completeProviderEvent = makeFunctionReference("customerFlow:completeProviderEvent");
const createFulfillmentJob = makeFunctionReference("fulfillment:createJob");
const getFulfillmentJob = makeFunctionReference("fulfillment:getJob");
const replaceFulfillmentJob = makeFunctionReference("fulfillment:replaceJob");
const backendToken = "backend-token-at-least-32-characters";
const job = {
  jobId: "job_test_001",
  version: 1,
  status: "payment_pending",
  intake: { customer: { email: "convex@example.test" } },
};
const response = {
  jobId: job.jobId,
  intakeTokenCiphertext: "v1.dGVzdGl2.dGVzdHRhZw.dGVzdGNpcGhlcnRleHQ",
  status: job.status,
};

function fixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./customerFlow.js": () => import("../../convex/customerFlow.js"),
    "./fulfillment.js": () => import("../../convex/fulfillment.js"),
  });
}

test("Convex creates a job and its idempotency response atomically", async () => {
  const convex = fixture();

  const created = await convex.mutation(createJob, {
    backendToken,
    idempotencyKey: "intake:test-001",
    requestDigest: "a".repeat(64),
    job,
    response,
  });
  const replay = await convex.mutation(createJob, {
    backendToken,
    idempotencyKey: "intake:test-001",
    requestDigest: "a".repeat(64),
    job: { ...job, jobId: "job_test_replay" },
    response: { ...response, jobId: "job_test_replay" },
  });
  const conflict = await convex.mutation(createJob, {
    backendToken,
    idempotencyKey: "intake:test-001",
    requestDigest: "b".repeat(64),
    job: { ...job, jobId: "job_test_conflict" },
    response: { ...response, jobId: "job_test_conflict" },
  });

  assert.deepEqual(created, { conflict: false, created: true, response });
  assert.deepEqual(replay, { conflict: false, created: false, response });
  assert.deepEqual(conflict, { conflict: true, created: false, response: null });
  const documents = await convex.run(async (context) => context.db.query("customerFlowJobs").collect());
  assert.equal(documents.length, 1);
  assert.equal(documents[0].job.jobId, job.jobId);
});

test("Convex rejects an idempotency response bound to another customer job", async () => {
  const convex = fixture();

  await assert.rejects(
    convex.mutation(createJob, {
      backendToken,
      idempotencyKey: "intake:test-mismatch",
      requestDigest: "a".repeat(64),
      job,
      response: { ...response, jobId: "job_test_other" },
    }),
    /same canonical job/i,
  );
});

test("Convex rejects plaintext intake tokens at the persistence boundary", async () => {
  const convex = fixture();

  await assert.rejects(
    convex.mutation(createJob, {
      backendToken,
      idempotencyKey: "intake:test-plaintext-token",
      requestDigest: "a".repeat(64),
      job,
      response: { jobId: job.jobId, intakeToken: "private-token", status: job.status },
    }),
    /encrypted intake token/i,
  );
});

test("Convex replaces a customer job only at the expected version", async () => {
  const convex = fixture();
  await convex.mutation(createJob, {
    backendToken,
    idempotencyKey: null,
    requestDigest: "a".repeat(64),
    job,
    response,
  });

  const replacedJob = { ...job, version: 2, status: "generation_pending" };
  const replaced = await convex.mutation(replaceJob, {
    backendToken,
    expectedVersion: 1,
    job: replacedJob,
  });
  const stale = await convex.mutation(replaceJob, {
    backendToken,
    expectedVersion: 1,
    job: { ...replacedJob, version: 2, status: "failed" },
  });

  assert.deepEqual(replaced, { updated: true, job: replacedJob });
  assert.deepEqual(stale, { updated: false, current: replacedJob });
  assert.deepEqual(await convex.query(readJob, { backendToken, jobId: job.jobId }), replacedJob);
});

test("Convex records one immutable result per provider event id", async () => {
  const convex = fixture();
  const event = { fingerprint: "c".repeat(64), result: { jobId: job.jobId } };

  const created = await convex.mutation(recordProviderEvent, {
    backendToken,
    providerEventId: "evt_test_001",
    event,
  });
  const replay = await convex.mutation(recordProviderEvent, {
    backendToken,
    providerEventId: "evt_test_001",
    event: { fingerprint: "d".repeat(64), result: { jobId: "other" } },
  });

  assert.deepEqual(created, { created: true, event });
  assert.deepEqual(replay, { created: false, event });
  assert.deepEqual(await convex.query(readProviderEvent, {
    backendToken,
    providerEventId: "evt_test_001",
  }), event);
});

test("Convex rejects provider event records without a bounded fingerprint", async () => {
  const convex = fixture();

  await assert.rejects(
    convex.mutation(recordProviderEvent, {
      backendToken,
      providerEventId: "evt_test_invalid",
      event: { result: { rejected: true } },
    }),
    /provider event record is invalid/i,
  );
});

test("Convex claims one provider event fingerprint before completing its immutable result", async () => {
  const convex = fixture();
  const providerEventId = "evt_test_claimed";
  const fingerprint = "a".repeat(64);

  const claim = await convex.mutation(claimProviderEvent, {
    backendToken,
    providerEventId,
    fingerprint,
  });
  const conflicting = await convex.mutation(claimProviderEvent, {
    backendToken,
    providerEventId,
    fingerprint: "b".repeat(64),
  });
  const result = { jobId: job.jobId, status: "generation_pending" };
  const completed = await convex.mutation(completeProviderEvent, {
    backendToken,
    providerEventId,
    fingerprint,
    result,
  });

  assert.deepEqual(claim, { created: true, event: { fingerprint, result: null } });
  assert.equal(conflicting.event.fingerprint, fingerprint);
  assert.deepEqual(completed, { completed: true, event: { fingerprint, result } });
});

test("Convex persists fulfillment aggregates with create-once compare-and-set semantics", async () => {
  const convex = fixture();
  const aggregate = { jobId: job.jobId, version: 1, state: "awaiting_payment" };
  const created = await convex.mutation(createFulfillmentJob, {
    backendToken,
    jobId: job.jobId,
    aggregate,
  });
  const next = { ...aggregate, version: 2, state: "generation_queued" };
  const replaced = await convex.mutation(replaceFulfillmentJob, {
    backendToken,
    jobId: job.jobId,
    expectedVersion: 1,
    aggregate: next,
  });
  const stale = await convex.mutation(replaceFulfillmentJob, {
    backendToken,
    jobId: job.jobId,
    expectedVersion: 1,
    aggregate: { ...next, state: "failed" },
  });

  assert.deepEqual(created, { created: true, aggregate });
  assert.deepEqual(replaced, { updated: true, aggregate: next });
  assert.deepEqual(stale, { updated: false, current: next });
  assert.deepEqual(await convex.query(getFulfillmentJob, { backendToken, jobId: job.jobId }), next);
});
