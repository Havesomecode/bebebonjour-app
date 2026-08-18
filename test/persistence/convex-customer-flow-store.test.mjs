import assert from "node:assert/strict";
import test from "node:test";

import { createConvexCustomerFlowStore } from "../../src/persistence/convex-customer-flow-store.mjs";

const job = {
  schemaVersion: "1.0",
  jobId: "job_test_001",
  version: 1,
  createdAt: "2026-08-18T10:00:00.000Z",
  updatedAt: "2026-08-18T10:00:00.000Z",
  intake: { customer: { email: "customer@example.test" } },
  intakeDigest: "a".repeat(64),
  intakeTokenDigest: "b".repeat(64),
  payment: { status: "pending", checkout: null, acceptedEventId: null },
};

test("Convex customer-flow store creates intake and idempotency record in one mutation", async () => {
  const calls = [];
  const client = {
    async mutation(reference, args) {
      calls.push({ reference, args });
      return { conflict: false, created: true, response: args.response };
    },
  };
  const store = createConvexCustomerFlowStore({
    client,
    backendToken: "backend-token-at-least-32-characters",
    tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    functions: { createJob: "customerFlow:createJob" },
  });
  const response = { jobId: job.jobId, intakeToken: "private-token", status: "payment_pending" };

  const result = await store.createJob(job, "intake_test_001", response, job.intakeDigest);

  assert.deepEqual(result, { conflict: false, created: true, response });
  assert.equal(calls[0].reference, "customerFlow:createJob");
  assert.equal(calls[0].args.response.jobId, job.jobId);
  assert.equal(calls[0].args.response.status, "payment_pending");
  assert.equal(calls[0].args.response.intakeToken, undefined);
  assert.match(calls[0].args.response.intakeTokenCiphertext, /^v1\./);
  assert.equal(JSON.stringify(calls).includes("private-token"), false);
});

test("Convex customer-flow store binds encrypted replay tokens to the canonical job", async () => {
  const store = createConvexCustomerFlowStore({
    client: {
      async mutation(_reference, args) {
        return {
          conflict: false,
          created: false,
          response: { ...args.response, jobId: "job_test_other" },
        };
      },
    },
    backendToken: "backend-token-at-least-32-characters",
    tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });

  await assert.rejects(
    store.createJob(
      job,
      "intake_test_001",
      { jobId: job.jobId, intakeToken: "private-token", status: "payment_pending" },
      job.intakeDigest,
    ),
    /authenticated/i,
  );
});

test("Convex customer-flow store retries compare-and-set updates against the latest job", async () => {
  const replacements = [];
  let current = structuredClone(job);
  const client = {
    async query() {
      return structuredClone(current);
    },
    async mutation(_reference, args) {
      replacements.push(structuredClone(args));
      if (replacements.length === 1) {
        current = { ...current, version: 2, updatedAt: "2026-08-18T10:01:00.000Z" };
        return { updated: false, current: structuredClone(current) };
      }
      current = structuredClone(args.job);
      return { updated: true, job: structuredClone(current) };
    },
  };
  const store = createConvexCustomerFlowStore({
    client,
    backendToken: "backend-token-at-least-32-characters",
    functions: {
      readJob: "customerFlow:readJob",
      replaceJob: "customerFlow:replaceJob",
    },
  });

  const updated = await store.updateJob(job.jobId, (value) => ({
    ...value,
    payment: { ...value.payment, status: "paid" },
  }));

  assert.equal(replacements.length, 2);
  assert.equal(replacements[0].expectedVersion, 1);
  assert.equal(replacements[1].expectedVersion, 2);
  assert.equal(updated.version, 3);
  assert.equal(updated.payment.status, "paid");
});

test("Convex customer-flow store records provider events with create-once semantics", async () => {
  const calls = [];
  const event = { fingerprint: "c".repeat(64), result: { jobId: job.jobId } };
  const client = {
    async query(reference, args) {
      calls.push({ kind: "query", reference, args });
      return null;
    },
    async mutation(reference, args) {
      calls.push({ kind: "mutation", reference, args });
      return { created: true, event: args.event };
    },
  };
  const store = createConvexCustomerFlowStore({
    client,
    backendToken: "backend-token-at-least-32-characters",
    functions: {
      readProviderEvent: "customerFlow:readProviderEvent",
      recordProviderEvent: "customerFlow:recordProviderEvent",
    },
  });

  assert.equal(await store.readProviderEvent("evt_test_001"), null);
  assert.deepEqual(await store.recordProviderEvent("evt_test_001", event), {
    created: true,
    event,
  });
  assert.deepEqual(calls, [
    {
      kind: "query",
      reference: "customerFlow:readProviderEvent",
      args: {
        backendToken: "backend-token-at-least-32-characters",
        providerEventId: "evt_test_001",
      },
    },
    {
      kind: "mutation",
      reference: "customerFlow:recordProviderEvent",
      args: {
        backendToken: "backend-token-at-least-32-characters",
        providerEventId: "evt_test_001",
        event,
      },
    },
  ]);
});

test("Convex customer-flow store claims event identity before completing its result", async () => {
  const calls = [];
  const client = {
    async mutation(reference, args) {
      calls.push({ reference, args });
      if (reference === "customerFlow:claimProviderEvent") {
        return { created: true, event: { fingerprint: args.fingerprint, result: null } };
      }
      return { completed: true, event: { fingerprint: args.fingerprint, result: args.result } };
    },
  };
  const store = createConvexCustomerFlowStore({
    client,
    backendToken: "backend-token-at-least-32-characters",
    functions: {
      claimProviderEvent: "customerFlow:claimProviderEvent",
      completeProviderEvent: "customerFlow:completeProviderEvent",
    },
  });

  const claim = await store.claimProviderEvent("evt_test_claim", "d".repeat(64));
  const completed = await store.completeProviderEvent(
    "evt_test_claim",
    "d".repeat(64),
    { jobId: job.jobId },
  );

  assert.equal(claim.event.result, null);
  assert.deepEqual(completed.event.result, { jobId: job.jobId });
  assert.equal(calls.length, 2);
});
