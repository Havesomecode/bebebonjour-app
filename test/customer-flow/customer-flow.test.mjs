import assert from "node:assert/strict";
import test from "node:test";

import {
  CustomerFlowError,
  createCustomerFlowService,
} from "../../src/customer-flow/service.mjs";
import { createInMemoryCustomerFlowStore } from "../../src/customer-flow/memory-store.mjs";

const syntheticIntake = {
  schemaVersion: "1.0",
  customer: {
    email: "synthetic.parent@example.test",
    consent: true,
  },
  baby: {
    firstName: "Amal Test",
    nameArabic: "أمل",
    gender: "girl",
    birthDate: "2026-07-18",
  },
  languages: ["fr", "ar"],
  voicePreference: { enabled: true, gender: "male" },
  context: { religion: "islam" },
  request: "Synthetic local-only request.",
};

function harness(options = {}) {
  const checkoutCalls = [];
  const ids = {
    job: ["job_test_001", "job_test_002", "job_test_003", "job_test_004"],
    token: [
      "tok_test_001_private",
      "tok_test_002_private",
      "tok_test_003_private",
      "tok_test_004_private",
    ],
    event: ["event_test_001", "event_test_002"],
  };
  const store = createInMemoryCustomerFlowStore();
  const service = createCustomerFlowService({
    store,
    now: () => "2026-08-11T00:00:00.000Z",
    createId(kind) {
      const value = ids[kind]?.shift();
      if (!value) throw new Error(`No deterministic ${kind} id left.`);
      return value;
    },
    paymentGateway: {
      async createCheckoutSession(request) {
        checkoutCalls.push(structuredClone(request));
        return {
          id: `cs_test_${request.jobId}`,
          url: `http://127.0.0.1:4173/test-checkout/${request.jobId}`,
          mode: "test",
        };
      },
    },

    fulfillmentOrchestrator: options.fulfillmentOrchestrator,
  });
  return { checkoutCalls, service, store };
}

async function createJob(service, intake = syntheticIntake, options = {}) {
  return service.submitIntake(structuredClone(intake), options);
}

async function payJob(service, submission, overrides = {}) {
  const checkout = await service.createCheckout(submission.jobId, submission.intakeToken);
  return service.recordPaymentSucceeded({
    providerEventId: "evt_stripe_test_001",
    sessionId: checkout.sessionId,
    paymentIntentId: "pi_test_001",
    amountMinor: 3900,
    currency: "EUR",
    livemode: false,
    metadata: checkout.metadata,
    ...overrides,
  });
}

test("synthetic intake creates a canonical private job and reusable test checkout", async () => {
  const { checkoutCalls, service, store } = harness();

  const submission = await createJob(service);
  const separateSubmission = await createJob(service);
  assert.deepEqual(submission, {
    jobId: "job_test_001",
    intakeToken: "tok_test_001_private",
    status: "payment_pending",
  });
  assert.notEqual(separateSubmission.jobId, submission.jobId);
  assert.notEqual(separateSubmission.intakeToken, submission.intakeToken);

  const publicStatus = await service.getStatus(submission.jobId, submission.intakeToken);
  assert.deepEqual(publicStatus, {
    jobId: submission.jobId,
    status: "payment_pending",
    payment: "pending",
    review: "not_ready",
    delivery: "not_ready",
  });
  assert.equal(JSON.stringify(publicStatus).includes("synthetic.parent@example.test"), false);
  assert.equal(JSON.stringify(publicStatus).includes("Amal Test"), false);

  const stored = await store.readJob(submission.jobId);
  assert.equal(stored.intake.customer.email, syntheticIntake.customer.email);
  assert.notEqual(stored.intakeTokenDigest, submission.intakeToken);
  assert.equal(JSON.stringify(stored).includes(submission.intakeToken), false);

  const first = await service.createCheckout(submission.jobId, submission.intakeToken);
  const replay = await service.createCheckout(submission.jobId, submission.intakeToken);
  assert.deepEqual(replay, first);
  assert.equal(checkoutCalls.length, 1);
  assert.deepEqual(checkoutCalls[0].metadata, {
    project: "bebebonjour",
    product: "announcement-page",
    environment: "test",
    job_id: submission.jobId,
    intake_digest: stored.intakeDigest,
  });
  assert.deepEqual(checkoutCalls[0].paymentIntentMetadata, checkoutCalls[0].metadata);
  assert.equal(first.checkoutUrl.includes(syntheticIntake.customer.email), false);
});

test("explicit intake idempotency replays only the same request and rejects conflicts", async () => {
  const { service } = harness();
  const options = { idempotencyKey: "intake:test:request-001" };
  const submission = await createJob(service, syntheticIntake, options);
  const replay = await createJob(service, syntheticIntake, options);
  assert.deepEqual(replay, submission);

  await assert.rejects(
    createJob(service, {
      ...structuredClone(syntheticIntake),
      customer: { email: "different.synthetic@example.test", consent: true },
    }, options),
    (error) => error instanceof CustomerFlowError
      && error.statusCode === 409
      && error.code === "idempotency_conflict",
  );
});

test("synthetic-only intake accepts the documented Resend delivery test sink", async () => {
  const { service } = harness();
  const submission = await createJob(service, {
    ...structuredClone(syntheticIntake),
    customer: { email: "delivered@resend.dev", consent: true },
  });

  assert.equal(submission.status, "payment_pending");
});

test("customer-flow service exposes no parallel editorial or delivery lifecycle", () => {
  const { service } = harness();
  assert.deepEqual(Object.keys(service).sort(), [
    "createCheckout",
    "getStatus",
    "recordPaymentSucceeded",
    "submitIntake",
  ]);
});

test("payment authority is idempotent and cannot satisfy another job", async () => {
  const { service } = harness();
  const first = await createJob(service);
  const second = await createJob(service, {
    ...structuredClone(syntheticIntake),
    customer: { email: "other.synthetic@example.test", consent: true },
  });
  const checkout = await service.createCheckout(first.jobId, first.intakeToken);

  await assert.rejects(
    service.recordPaymentSucceeded({
      providerEventId: "evt_wrong_job",
      sessionId: checkout.sessionId,
      paymentIntentId: "pi_wrong_job",
      amountMinor: 3900,
      currency: "EUR",
      livemode: false,
      metadata: { ...checkout.metadata, job_id: second.jobId },
    }),
    (error) => error instanceof CustomerFlowError && error.code === "payment_correlation_failed",
  );

  const payment = {
    providerEventId: "evt_stripe_test_001",
    sessionId: checkout.sessionId,
    paymentIntentId: "pi_test_001",
    amountMinor: 3900,
    currency: "EUR",
    livemode: false,
    metadata: checkout.metadata,
    payloadSha256: "e".repeat(64),
  };
  const accepted = await service.recordPaymentSucceeded(payment);
  const replay = await service.recordPaymentSucceeded(payment);
  assert.deepEqual(replay, accepted);
  await assert.rejects(
    service.recordPaymentSucceeded({ ...payment, payloadSha256: "f".repeat(64) }),
    (error) => error instanceof CustomerFlowError && error.code === "payment_event_conflict",
  );
  const duplicate = await service.recordPaymentSucceeded({
    ...payment,
    providerEventId: "evt_stripe_test_duplicate_identity",
    payloadSha256: "d".repeat(64),
  });
  assert.deepEqual(duplicate, accepted);
  await assert.rejects(
    service.recordPaymentSucceeded({
      ...payment,
      providerEventId: "evt_stripe_test_other_payment",
      paymentIntentId: "pi_test_other_payment",
      payloadSha256: "c".repeat(64),
    }),
    (error) => error instanceof CustomerFlowError && error.code === "payment_event_conflict",
  );
  assert.equal((await service.getStatus(first.jobId, first.intakeToken)).payment, "paid");
  assert.equal((await service.getStatus(second.jobId, second.intakeToken)).payment, "pending");
});

test("intake, payment, and customer status bind to the canonical fulfillment orchestrator", async () => {
  const calls = [];
  let canonicalState = "awaiting_payment";
  const fulfillmentOrchestrator = {
    async createJob(input, context) {
      calls.push({ method: "createJob", input: structuredClone(input), context });
      return { jobId: input.jobId, state: canonicalState };
    },
    async recordPayment(jobId, payment) {
      calls.push({ method: "recordPayment", jobId, payment: structuredClone(payment) });
      canonicalState = "generation_queued";
      return { jobId, state: canonicalState };
    },
    async status(jobId) {
      calls.push({ method: "status", jobId });
      return { jobId, state: canonicalState };
    },
  };
  const { service } = harness({ fulfillmentOrchestrator });
  const submission = await createJob(service);
  const created = calls.find(({ method }) => method === "createJob");
  assert.deepEqual(created.input.paymentCorrelation, {
    project: "bebebonjour",
    product: "announcement-page",
    environment: "test",
    jobId: submission.jobId,
    intakeDigest: created.input.intakeDigest,
  });
  assert.equal(created.context.commandId, `customer-intake:${submission.jobId}`);

  const checkout = await service.createCheckout(submission.jobId, submission.intakeToken);
  assert.equal(checkout.metadata.product, "announcement-page");
  await payJob(service, submission);
  const recorded = calls.find(({ method }) => method === "recordPayment");
  assert.equal(recorded.jobId, submission.jobId);
  assert.match(recorded.payment.commandId, /^stripe-payment:[a-f0-9]{64}$/);
  assert.deepEqual(recorded.payment.correlation, created.input.paymentCorrelation);
  assert.equal((await service.getStatus(submission.jobId, submission.intakeToken)).status, "generation_pending");
});

test("concurrent same-id Stripe payload conflicts are fenced before a second effect", async () => {
  let paymentCalls = 0;
  let releaseFirst;
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const fulfillmentOrchestrator = {
    async createJob(input) { return { jobId: input.jobId, state: "awaiting_payment" }; },
    async status(jobId) { return { jobId, state: "awaiting_payment" }; },
    async recordPayment(jobId) {
      paymentCalls += 1;
      if (paymentCalls === 1) {
        markEntered();
        await holdFirst;
      }
      return { jobId, state: "generation_queued" };
    },
  };
  const { service } = harness({ fulfillmentOrchestrator });
  const submission = await createJob(service);
  const checkout = await service.createCheckout(submission.jobId, submission.intakeToken);
  const payment = {
    providerEventId: "evt_test_concurrent",
    sessionId: checkout.sessionId,
    paymentIntentId: "pi_test_concurrent",
    amountMinor: 3900,
    currency: "EUR",
    livemode: false,
    metadata: checkout.metadata,
    payloadSha256: "a".repeat(64),
  };

  const first = service.recordPaymentSucceeded(payment).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await entered;
  const second = await service.recordPaymentSucceeded({
    ...payment,
    payloadSha256: "b".repeat(64),
  }).then((value) => ({ value }), (error) => ({ error }));
  releaseFirst();
  const firstOutcome = await first;

  assert.equal(firstOutcome.error, undefined);
  assert.equal(second.error?.code, "payment_event_conflict");
  assert.equal(paymentCalls, 1);
});

test("invalid customer credentials and fields fail with stable redacted errors", async () => {
  const { service } = harness();
  const submission = await createJob(service);

  await assert.rejects(
    service.getStatus(submission.jobId, "wrong-token"),
    (error) => error instanceof CustomerFlowError
      && error.statusCode === 404
      && error.code === "job_not_found",
  );
  await assert.rejects(
    service.submitIntake({ ...structuredClone(syntheticIntake), request: "x".repeat(2001) }),
    (error) => error instanceof CustomerFlowError
      && error.statusCode === 400
      && error.code === "invalid_intake"
      && !error.message.includes("synthetic.parent@example.test"),
  );
  await assert.rejects(
    service.submitIntake({
      ...structuredClone(syntheticIntake),
      customer: { email: "real-looking@example.com", consent: true },
    }),
    (error) => error instanceof CustomerFlowError && error.code === "invalid_intake",
  );
});
