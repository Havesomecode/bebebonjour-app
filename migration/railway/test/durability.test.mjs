import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCustomerFlowService } from "../../../src/customer-flow/service.mjs";
import { createFulfillmentOrchestrator } from "../../../src/fulfillment/job-orchestrator.mjs";
import { createPostgresCustomerStore } from "../customer-store.mjs";
import { createPostgresFulfillmentStore } from "../fulfillment-store.mjs";
import { openTestDatabase } from "./database.mjs";

const intake = {
  schemaVersion: "1.0", customer: { email: "store@example.test", consent: true },
  baby: { firstName: "Test", gender: "neutral" }, languages: ["fr"],
  voicePreference: { enabled: false, gender: "neutral" },
};
function application(pool) {
  const customer = createPostgresCustomerStore({ pool, tokenEncryptionKey: Buffer.alloc(32, 11).toString("base64") });
  const fulfillment = createPostgresFulfillmentStore({ pool });
  const orchestrator = createFulfillmentOrchestrator({ store: fulfillment, handlers: {},
    clock: () => "2026-11-08T00:00:00.000Z", tokenFactory: () => `token_${randomUUID()}`,
    retryPolicy: { leaseMsByStage: {}, maxAttemptsByStage: {}, backoffMsByStage: {} } });
  const service = createCustomerFlowService({ store: customer, fulfillmentOrchestrator: orchestrator,
    atomicFulfillment: true, now: () => "2026-11-08T00:00:00.000Z", paymentGateway: { createCheckoutSession: async ({ jobId }) => ({
      id: `cs_${jobId}`, url: "https://checkout.stripe.com/synthetic", mode: "test",
    }) } });
  return { service, customer, fulfillment };
}

test("SQL rejects missing document identities instead of accepting null CHECK results", async (t) => {
  const db = await openTestDatabase(t);
  for (const table of ["customer_jobs", "fulfillment_jobs", "review_approvals"]) {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const id = `invalid_${randomUUID().replaceAll("-", "")}`;
      const [column, document] = table === "review_approvals" ? ["approval_id", "approval"]
        : ["job_id", table === "customer_jobs" ? "job" : "aggregate"];
      // Table/column names are the fixed test allowlist above; only values are external.
      await assert.rejects(() => client.query(`INSERT INTO bb_candidate.${table}(${column},${document}) VALUES ($1,$2)`, [id, {}]), /check constraint/);
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
});

test("unfinished payment result resumes after a fresh PostgreSQL connection without double advancement", async (t) => {
  const db = await openTestDatabase(t);
  let app = application(db.pool);
  const submitted = await app.service.submitIntake(intake, { idempotencyKey: `resume:${randomUUID()}` });
  const checkout = await app.service.createCheckout(submitted.jobId, submitted.intakeToken);
  const payment = { providerEventId: `evt_${randomUUID().replaceAll("-", "")}`,
    sessionId: checkout.sessionId, paymentIntentId: `pi_${submitted.jobId}`,
    amountMinor: 3900, currency: "eur", livemode: false, metadata: checkout.metadata };
  app.customer.completeProviderEvent = async () => { throw new Error("synthetic process interrupted before event completion"); };
  await assert.rejects(() => app.service.recordPaymentSucceeded(payment), /synthetic process interrupted/);
  assert.equal((await app.customer.readProviderEvent(payment.providerEventId)).result, null);
  assert.equal((await app.customer.readJob(submitted.jobId)).payment.status, "paid");
  app = application(db.newPool());
  const resumed = await app.service.recordPaymentSucceeded(payment);
  assert.equal(resumed.status, "generation_pending");
  assert.deepEqual(await app.service.recordPaymentSucceeded(payment), resumed);
  const aggregate = await app.fulfillment.getJob(submitted.jobId);
  assert.equal(aggregate.events.filter((e) => e.type === "payment_recorded").length, 1);
  await assert.rejects(() => app.service.recordPaymentSucceeded({ ...payment, paymentIntentId: "pi_different" }), { code: "payment_event_conflict" });
});

test("row locks prevent lost updates across independent pools and a thrown update leaves no changes", async (t) => {
  const db = await openTestDatabase(t);
  const left = application(db.pool);
  const right = application(db.newPool());
  const submission = await left.service.submitIntake(intake);
  const initial = await left.customer.readJob(submission.jobId);
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? left : right).customer.updateJob(submission.jobId, (job) => {
    job.syntheticCount = (job.syntheticCount || 0) + 1;
    return job;
  })));
  const final = await right.customer.readJob(submission.jobId);
  assert.equal(final.syntheticCount, 20);
  assert.equal(final.version, initial.version + 20);
  await assert.rejects(() => left.customer.updateJob(submission.jobId, (job) => {
    job.syntheticCount = 100;
    throw new Error("synthetic rejection");
  }), /synthetic rejection/);
  assert.deepEqual(await right.customer.readJob(submission.jobId), final);
  await assert.rejects(() => left.customer.updateJob(submission.jobId, (job) => ({ ...job, jobId: "changed_identity" })), /preserve job identity/);
});

test("review approval is immutable, and encrypted replay cannot be opened under a different key", async (t) => {
  const db = await openTestDatabase(t);
  const left = application(db.pool);
  const right = application(db.newPool());
  const id = `approval_${randomUUID()}`;
  const approval = { approvalId: id, revisionId: "r1", artifactDigests: { pageDigest: "1".repeat(64) } };
  const attempts = await Promise.allSettled([
    left.fulfillment.saveReviewApproval(approval),
    right.fulfillment.saveReviewApproval({ ...approval, revisionId: "r2" }),
  ]);
  assert.deepEqual(attempts.map((a) => a.status).sort(), ["fulfilled", "rejected"]);
  const saved = await right.fulfillment.getReviewApproval(id);
  assert.deepEqual(await left.fulfillment.saveReviewApproval(saved), saved);
  const key = `crypto:${randomUUID()}`;
  await left.service.submitIntake(intake, { idempotencyKey: key });
  const wrongKey = createPostgresCustomerStore({ pool: db.pool, tokenEncryptionKey: Buffer.alloc(32, 12).toString("base64") });
  const persisted = (await db.pool.query("SELECT response,request_digest FROM bb_candidate.submissions WHERE idempotency_key=$1", [key])).rows[0];
  await assert.rejects(() => wrongKey.createJob({ jobId: "unpersisted_job", version: 1 }, key,
    { jobId: "unpersisted_job", status: "payment_pending", intakeToken: "synthetic-unused-token" }, persisted.request_digest));
  assert.equal(await left.customer.readJob("unpersisted_job"), null);
});

test("durable stage lease rejects competing workers, stale tokens and expired completion", async (t) => {
  const db = await openTestDatabase(t);
  const app = application(db.pool);
  const second = application(db.newPool());
  const submission = await app.service.submitIntake(intake);
  const initial = await app.fulfillment.getJob(submission.jobId);
  await app.fulfillment.recordPayment(submission.jobId, { commandId: "synthetic-lease-payment",
    providerEventId: `evt_${submission.jobId}`, providerPaymentId: `pi_${submission.jobId}`,
    correlation: initial.paymentCorrelation, recordedAt: "2026-11-08T00:00:00.000Z" }, "2026-11-08T00:00:00.000Z");
  const claim = { commandId: "synthetic-lease-claim", stage: "prepare_review", workerId: "synthetic-worker-1",
    leaseToken: "synthetic-lease-token-1", leaseMs: 1_000, maxAttempts: 3 };
  const acquired = await app.fulfillment.claimStage(submission.jobId, claim, "2026-11-08T00:00:00.000Z");
  assert.equal(acquired.acquired, true);
  assert.equal((await second.fulfillment.claimStage(submission.jobId, claim, "2026-11-08T00:00:00.000Z")).acquired, false);
  await assert.rejects(() => second.fulfillment.claimStage(submission.jobId, { ...claim, commandId: "competing-claim", leaseToken: "different" }, "2026-11-08T00:00:00.100Z"));
  const current = await second.fulfillment.getJob(submission.jobId);
  const completion = { commandId: "synthetic-completion", stage: "prepare_review",
    attemptId: current.stageAttempts.at(-1).attemptId, leaseToken: "wrong-token", workerId: claim.workerId, result: {} };
  await assert.rejects(() => app.fulfillment.completeStage(submission.jobId, completion, "2026-11-08T00:00:00.500Z"));
  await assert.rejects(() => app.fulfillment.completeStage(submission.jobId,
    { ...completion, leaseToken: claim.leaseToken }, "2026-11-08T00:00:02.000Z"));
  assert.deepEqual(await app.fulfillment.getJob(submission.jobId), current);
});
