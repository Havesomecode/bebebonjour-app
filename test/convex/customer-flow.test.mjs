import assert from "node:assert/strict";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";
import { createJobAggregate } from "../../src/fulfillment/job-machine.mjs";

const createJob = makeFunctionReference("customerFlow:createJob");
const readJob = makeFunctionReference("customerFlow:readJob");
const replaceJob = makeFunctionReference("customerFlow:replaceJob");
const readProviderEvent = makeFunctionReference("customerFlow:readProviderEvent");
const recordProviderEvent = makeFunctionReference("customerFlow:recordProviderEvent");
const claimProviderEvent = makeFunctionReference("customerFlow:claimProviderEvent");
const completeProviderEvent = makeFunctionReference("customerFlow:completeProviderEvent");
const claimWorkItems = makeFunctionReference("customerFlow:claimWorkItems");
const completeWorkItem = makeFunctionReference("customerFlow:completeWorkItem");
const releaseWorkItem = makeFunctionReference("customerFlow:releaseWorkItem");
const createFulfillmentJob = makeFunctionReference("fulfillment:createJob");
const getFulfillmentJob = makeFunctionReference("fulfillment:getJob");
const replaceFulfillmentJob = makeFunctionReference("fulfillment:replaceJob");
const saveReviewApproval = makeFunctionReference("fulfillment:saveReviewApproval");
const getReviewApproval = makeFunctionReference("fulfillment:getReviewApproval");
const backendToken = "backend-token-at-least-32-characters";
const job = {
  jobId: "job_test_001",
  version: 1,
  status: "payment_pending",
  createdAt: "2026-08-27T10:29:59.000Z",
  intakeDigest: "a".repeat(64),
  intake: { customer: { email: "convex@example.test" } },
};
const response = {
  jobId: job.jobId,
  intakeTokenCiphertext: "v1.dGVzdGl2.dGVzdHRhZw.dGVzdGNpcGhlcnRleHQ",
  status: job.status,
};
const fulfillmentAggregate = createJobAggregate({
  jobId: job.jobId,
  environment: "test",
  product: "announcement-page",
  intakeDigest: job.intakeDigest,
  paymentCorrelation: {
    project: "bebebonjour",
    product: "announcement-page",
    environment: "test",
    jobId: job.jobId,
    intakeDigest: job.intakeDigest,
  },
  narrationRequired: false,
}, {
  commandId: `customer-intake:${job.jobId}`,
  at: job.createdAt,
});

function fixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./customerFlow.js": () => import("../../convex/customerFlow.js"),
    "./fulfillment.js": () => import("../../convex/fulfillment.js"),
  });
}

test("Convex atomically creates customer, fulfillment, and work-item state", async () => {
  const convex = fixture();

  const created = await convex.mutation(createJob, {
    backendToken,
    idempotencyKey: "intake:test-001",
    requestDigest: "a".repeat(64),
    job,
    response,
    enqueueWorkItem: true,
    fulfillmentAggregate,
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
  const workItems = await convex.run(async (context) => context.db.query("customerFlowWorkItems").collect());
  assert.equal(workItems.length, 1);
  assert.deepEqual({
    jobId: workItems[0].jobId,
    source: workItems[0].source,
    state: workItems[0].state,
    createdAt: workItems[0].createdAt,
    updatedAt: workItems[0].updatedAt,
    attempts: workItems[0].attempts,
    claim: workItems[0].claim,
    kanbanTaskId: workItems[0].kanbanTaskId,
    lastFailureReason: workItems[0].lastFailureReason,
  }, {
    jobId: job.jobId,
    source: "customer-intake",
    state: "pending",
    createdAt: "2026-08-27T10:29:59.000Z",
    updatedAt: "2026-08-27T10:29:59.000Z",
    attempts: 0,
    claim: null,
    kanbanTaskId: null,
    lastFailureReason: null,
  });
  const fulfillment = await convex.run(
    async (context) => context.db.query("fulfillmentJobs").collect(),
  );
  assert.deepEqual(fulfillment.map(({ jobId, aggregate }) => ({ jobId, aggregate })), [{
    jobId: job.jobId,
    aggregate: fulfillmentAggregate,
  }]);
});

test("Convex refuses to expose work before fulfillment initialization", async () => {
  const convex = fixture();
  await assert.rejects(
    convex.mutation(createJob, {
      backendToken,
      idempotencyKey: "intake:partial-001",
      requestDigest: "a".repeat(64),
      job,
      response,
      enqueueWorkItem: true,
    }),
    /fulfillment aggregate/i,
  );
  const workItems = await convex.run(
    async (context) => context.db.query("customerFlowWorkItems").collect(),
  );
  assert.equal(workItems.length, 0);
});

test("Convex rejects PII-bearing fulfillment aggregates before any work is persisted", async () => {
  const convex = fixture();
  await assert.rejects(
    convex.mutation(createJob, {
      backendToken,
      idempotencyKey: "intake:malformed-aggregate",
      requestDigest: "a".repeat(64),
      job,
      response,
      enqueueWorkItem: true,
      fulfillmentAggregate: {
        ...fulfillmentAggregate,
        customerEmail: "parent@example.com",
      },
    }),
    /canonical initial fulfillment aggregate/i,
  );
  const counts = await convex.run(async (context) => ({
    customers: (await context.db.query("customerFlowJobs").collect()).length,
    fulfillment: (await context.db.query("fulfillmentJobs").collect()).length,
    submissions: (await context.db.query("customerFlowSubmissions").collect()).length,
    work: (await context.db.query("customerFlowWorkItems").collect()).length,
  }));
  assert.deepEqual(counts, { customers: 0, fulfillment: 0, submissions: 0, work: 0 });
});

test("Convex rejects tampered initial fulfillment events before persistence", async () => {
  const convex = fixture();
  const tampered = structuredClone(fulfillmentAggregate);
  tampered.events[0].commandDigest = "f".repeat(64);
  await assert.rejects(convex.mutation(createJob, {
    backendToken,
    idempotencyKey: "intake:tampered-event",
    requestDigest: "a".repeat(64),
    job,
    response,
    enqueueWorkItem: true,
    fulfillmentAggregate: tampered,
  }), /canonical initial fulfillment aggregate/i);
});

test("Convex work queue claims, releases, and completes PII-free intake references idempotently", async () => {
  const convex = fixture();
  await convex.mutation(createJob, {
    backendToken,
    idempotencyKey: "intake:queue-001",
    requestDigest: "a".repeat(64),
    job,
    response,
    enqueueWorkItem: true,
    fulfillmentAggregate,
  });

  const firstClaim = await convex.mutation(claimWorkItems, {
    backendToken,
    workerId: "bridge_test_worker",
    limit: 10,
    nowMs: 1_788_000_000_000,
    leaseMs: 120_000,
  });
  assert.equal(firstClaim.length, 1);
  assert.deepEqual(Object.keys(firstClaim[0]).sort(), ["attempts", "createdAt", "jobId", "source"]);
  assert.equal(JSON.stringify(firstClaim).includes("convex@example.test"), false);

  assert.deepEqual(await convex.mutation(releaseWorkItem, {
    backendToken,
    jobId: job.jobId,
    workerId: "bridge_test_worker",
    reasonCode: "kanban_create_failed",
    nowMs: 1_788_000_000_100,
  }), { released: true });

  const secondClaim = await convex.mutation(claimWorkItems, {
    backendToken,
    workerId: "bridge_test_worker",
    limit: 1,
    nowMs: 1_788_000_000_200,
    leaseMs: 120_000,
  });
  assert.equal(secondClaim[0].attempts, 2);

  assert.deepEqual(await convex.mutation(completeWorkItem, {
    backendToken,
    jobId: job.jobId,
    workerId: "bridge_test_worker",
    kanbanTaskId: "t_bridge_001",
    nowMs: 1_788_000_000_300,
  }), { completed: true, kanbanTaskId: "t_bridge_001" });
  assert.deepEqual(await convex.mutation(completeWorkItem, {
    backendToken,
    jobId: job.jobId,
    workerId: "bridge_test_worker",
    kanbanTaskId: "t_bridge_001",
    nowMs: 1_788_000_000_400,
  }), { completed: false, kanbanTaskId: "t_bridge_001" });

  assert.deepEqual(await convex.mutation(claimWorkItems, {
    backendToken,
    workerId: "bridge_other_worker",
    limit: 10,
    nowMs: 1_788_000_000_500,
    leaseMs: 120_000,
  }), []);
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

test("Convex persists one immutable human review approval per approval id", async () => {
  const convex = fixture();
  const approval = {
    schemaVersion: "1.0",
    approvalId: `approval_${"a".repeat(24)}`,
    binding: { jobId: job.jobId },
    decision: { outcome: "approved" },
    signature: "b".repeat(64),
  };

  assert.deepEqual(await convex.mutation(saveReviewApproval, {
    backendToken,
    approval,
  }), { created: true, approval });
  assert.deepEqual(await convex.mutation(saveReviewApproval, {
    backendToken,
    approval: { ...approval, binding: { jobId: "job_test_other" } },
  }), { created: false, approval });
  assert.deepEqual(await convex.query(getReviewApproval, {
    backendToken,
    approvalId: approval.approvalId,
  }), approval);
});

test("Convex rejects extra review approval fields before durable storage", async () => {
  const convex = fixture();
  const approval = {
    schemaVersion: "1.0",
    approvalId: `approval_${"c".repeat(24)}`,
    binding: { jobId: job.jobId },
    decision: { outcome: "approved" },
    signature: "d".repeat(64),
    customerEmail: "not-needed@example.test",
  };

  await assert.rejects(convex.mutation(saveReviewApproval, {
    backendToken,
    approval,
  }), /unexpected fields/i);
});

test("Convex rejects extra nested review data before durable storage", async () => {
  const convex = fixture();
  const approval = {
    schemaVersion: "1.0",
    approvalId: `approval_${"e".repeat(24)}`,
    binding: { jobId: job.jobId, customerEmail: "not-needed@example.test" },
    decision: { outcome: "approved" },
    signature: "f".repeat(64),
  };

  await assert.rejects(convex.mutation(saveReviewApproval, {
    backendToken,
    approval,
  }), /unexpected fields/i);
});
