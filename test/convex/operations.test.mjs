import assert from "node:assert/strict";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";

const listJobs = makeFunctionReference("operations:listJobs");
const getJob = makeFunctionReference("operations:getJob");
const listJobCommands = makeFunctionReference("operations:listJobCommands");
const requestCommand = makeFunctionReference("operations:requestCommand");
const claimCommands = makeFunctionReference("operations:claimCommands");
const fenceCommand = makeFunctionReference("operations:fenceCommand");
const completeCommand = makeFunctionReference("operations:completeCommand");
const failCommand = makeFunctionReference("operations:failCommand");
const consumeLoginAttempt = makeFunctionReference("operations:consumeLoginAttempt");
const resetLoginThrottle = makeFunctionReference("operations:resetLoginThrottle");

const operatorToken = "operator-token-at-least-32-characters";
const workerToken = "worker-token-at-least-32-characters__";
const rateLimitToken = "rate-limit-token-at-least-32-characters";

function fixture() {
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  process.env.BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN = rateLimitToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./operations.js": () => import("../../convex/operations.js"),
  });
}

function customerJob(overrides = {}) {
  return {
    schemaVersion: "1.0",
    jobId: "job_ops_001",
    version: 2,
    createdAt: "2026-09-02T20:00:00.000Z",
    updatedAt: "2026-09-02T20:05:00.000Z",
    intake: {
      schemaVersion: "1.0",
      requestId: "job_ops_001",
      submittedAt: "2026-09-02T20:00:00.000Z",
      customer: { email: "parent@example.test", consent: true },
      baby: { firstName: "Nour", nameArabic: "نور", gender: "girl" },
      languages: ["fr", "ar"],
      voicePreference: { enabled: true, gender: "male" },
      context: { religion: "islam" },
      request: "Une annonce douce.",
    },
    intakeDigest: "a".repeat(64),
    intakeTokenDigest: "b".repeat(64),
    payment: {
      status: "paid",
      checkout: { sessionId: "cs_test_ops", checkoutUrl: "https://checkout.example.test/session", mode: "test" },
      acceptedEventId: "evt_ops_001",
      paymentIntentId: "pi_ops_001",
      paidAt: "2026-09-02T20:05:00.000Z",
    },
    ...overrides,
  };
}

function fulfillmentAggregate(overrides = {}) {
  return {
    schemaVersion: "1.0",
    authority: "convex-target/local-test-projection",
    jobId: "job_ops_001",
    environment: "test",
    product: "announcement-page",
    intakeDigest: "a".repeat(64),
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId: "job_ops_001",
      intakeDigest: "a".repeat(64),
    },
    narrationRequired: true,
    state: "generation_queued",
    version: 3,
    createdAt: "2026-09-02T20:00:00.000Z",
    updatedAt: "2026-09-02T20:05:00.000Z",
    currentRevisionId: null,
    publishedRevisionId: null,
    retry: null,
    payment: { providerPaymentId: "pi_ops_001" },
    revisions: [],
    artifactSets: [],
    reviewDecisions: [],
    stageAttempts: [],
    publication: null,
    deliveryAttempts: [],
    events: [],
    ...overrides,
  };
}

async function seed(convex, { customer = customerJob(), fulfillment = fulfillmentAggregate() } = {}) {
  await convex.run(async (context) => {
    await context.db.insert("customerFlowJobs", { jobId: customer.jobId, job: customer });
    await context.db.insert("fulfillmentJobs", { jobId: fulfillment.jobId, aggregate: fulfillment });
  });
}

async function replaceFulfillment(convex, aggregate) {
  await convex.run(async (context) => {
    const document = await context.db.query("fulfillmentJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", aggregate.jobId))
      .unique();
    await context.db.patch(document._id, { aggregate });
  });
}

test("login throttle is durable, source-scoped, resettable, and server-clocked", async (t) => {
  const convex = fixture();
  const originalNow = Date.now;
  let nowMs = Date.parse("2026-09-03T04:00:00.000Z");
  Date.now = () => nowMs;
  t.after(() => { Date.now = originalNow; });
  const sourceHash = "a".repeat(64);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await convex.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash });
    assert.deepEqual(result, { allowed: true, retryAfterSeconds: 0 });
  }
  const blocked = await convex.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 900);
  assert.deepEqual(
    await convex.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash: "b".repeat(64) }),
    { allowed: true, retryAfterSeconds: 0 },
  );
  for (let attempt = 0; attempt < 310; attempt += 1) {
    await convex.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash });
  }
  assert.deepEqual(
    await convex.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash: "c".repeat(64) }),
    { allowed: true, retryAfterSeconds: 0 },
  );
  await assert.rejects(
    convex.mutation(resetLoginThrottle, { rateLimitToken: operatorToken, sourceHash }),
    /unauthorized/i,
  );
  await convex.mutation(resetLoginThrottle, { rateLimitToken, sourceHash });
  assert.equal((await convex.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash })).allowed, true);
  nowMs += 16 * 60 * 1_000;
  assert.equal((await convex.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash })).allowed, true);
});

test("operator list returns a bounded joined projection without secret token material", async () => {
  const convex = fixture();
  await seed(convex);

  const result = await convex.query(listJobs, {
    operatorToken,
    paginationOpts: { cursor: null, numItems: 20 },
  });

  assert.equal(result.page.length, 1);
  assert.deepEqual(result.page[0], {
    jobId: "job_ops_001",
    createdAt: "2026-09-02T20:00:00.000Z",
    updatedAt: "2026-09-02T20:05:00.000Z",
    state: "generation_queued",
    paymentStatus: "paid",
    customerEmail: "parent@example.test",
    babyName: "Nour",
    languages: ["fr", "ar"],
    narrationRequired: true,
  });
  assert.equal(JSON.stringify(result).includes("intakeTokenDigest"), false);
  assert.equal(JSON.stringify(result).includes("bbbbbbbb"), false);
});

test("operator detail returns the private intake, canonical aggregate, commands, and state-aware actions", async () => {
  const convex = fixture();
  await seed(convex);

  const result = await convex.query(getJob, { operatorToken, jobId: "job_ops_001" });

  assert.equal(result.customer.intake.customer.email, "parent@example.test");
  assert.equal(result.customer.intakeTokenDigest, undefined);
  assert.equal(result.fulfillment.state, "generation_queued");
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.availableActions, ["generate"]);
});

test("operator functions reject an invalid scoped token before returning private data", async () => {
  const convex = fixture();
  await seed(convex);

  await assert.rejects(
    convex.query(getJob, { operatorToken: "not-authorized", jobId: "job_ops_001" }),
    /unauthorized/i,
  );
});

test("command requests are idempotent and bound to the exact aggregate state and version", async () => {
  const convex = fixture();
  await seed(convex);
  const input = {
    operatorToken,
    commandId: "command_000000000000000000000001",
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  };

  const created = await convex.mutation(requestCommand, input);
  const replay = await convex.mutation(requestCommand, input);

  assert.equal(created.created, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.command, created.command);
  assert.equal(created.command.state, "pending");
  assert.equal(JSON.stringify(created).includes("parent@example.test"), false);

  const queuedDetail = await convex.query(getJob, { operatorToken, jobId: "job_ops_001" });
  assert.deepEqual(queuedDetail.availableActions, []);
  assert.equal(queuedDetail.commands[0].state, "pending");

  await assert.rejects(
    convex.mutation(requestCommand, { ...input, action: "publish" }),
    /command id conflict/i,
  );
  await assert.rejects(
    convex.mutation(requestCommand, {
      ...input,
      commandId: "command_000000000000000000000002",
      expectedVersion: 2,
    }),
    /job changed/i,
  );
});

test("checkout commands stop without provider I/O when the canonical checkout appears before claim", async () => {
  const convex = fixture();
  await seed(convex, {
    customer: customerJob({
      payment: {
        status: "pending",
        checkout: null,
        acceptedEventId: null,
        paymentIntentId: null,
        paidAt: null,
      },
    }),
    fulfillment: fulfillmentAggregate({ state: "awaiting_payment", version: 3 }),
  });
  const commandId = "command_checkout_race_000001";
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId,
    jobId: "job_ops_001",
    action: "create_checkout",
    expectedState: "awaiting_payment",
    expectedVersion: 3,
    payload: {},
  });
  await convex.run(async (context) => {
    const customer = await context.db
      .query("customerFlowJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", "job_ops_001"))
      .unique();
    await context.db.patch(customer._id, {
      job: {
        ...customer.job,
        version: customer.job.version + 1,
        payment: {
          ...customer.job.payment,
          checkout: {
            sessionId: "checkout_existing",
            checkoutUrl: "https://checkout.example.test/existing",
            mode: "test",
            metadata: {},
            createdAt: "2026-09-03T04:00:00.000Z",
          },
        },
      },
    });
  });
  const claimed = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-1",
    limit: 1,
    leaseMs: 120_000,
  });
  assert.equal(claimed.length, 0);
  const detail = await convex.query(getJob, { operatorToken, jobId: "job_ops_001" });
  const command = detail.commands.find((entry) => entry.commandId === commandId);
  assert.equal(command.state, "failed");
  assert.equal(command.outcome, null);
  assert.equal(command.lastFailureReason, "checkout_target_already_exists");
});

test("command requests reject actions that are unavailable for the current state", async () => {
  const convex = fixture();
  await seed(convex);

  await assert.rejects(
    convex.mutation(requestCommand, {
      operatorToken,
      commandId: "command_000000000000000000000003",
      jobId: "job_ops_001",
      action: "publish",
      expectedState: "generation_queued",
      expectedVersion: 3,
      payload: {},
    }),
    /not available/i,
  );
});

test("expired commands are discovered by lease expiry rather than request-order scan", async () => {
  const convex = fixture();
  await seed(convex);
  const nowMs = Date.now();
  const expiredCommandId = "command_expiry_index_target_000001";
  await convex.run(async (context) => {
    for (let index = 0; index < 20; index += 1) {
      const requestedAt = new Date(nowMs - 60_000 + index).toISOString();
      await context.db.insert("customerFlowOperationsCommands", {
        commandId: `command_expiry_index_live_${String(index).padStart(2, "0")}`,
        jobId: "job_ops_001",
        action: "generate",
        expectedState: "generation_queued",
        expectedVersion: 3,
        payload: {},
        requestedAt,
        requestedBy: "primary_operator",
        state: "running",
        attempts: 1,
        claim: {
          workerId: "live-worker",
          leaseToken: `lease-live-${String(index).padStart(2, "0")}`,
          claimedAtMs: nowMs - 60_000,
          leaseExpiresAtMs: nowMs + 60_000,
        },
        lastFailureReason: null,
        outcome: null,
        updatedAt: requestedAt,
      });
    }
    const requestedAt = new Date(nowMs - 1_000).toISOString();
    await context.db.insert("customerFlowOperationsCommands", {
      commandId: expiredCommandId,
      jobId: "job_ops_001",
      action: "generate",
      expectedState: "generation_queued",
      expectedVersion: 3,
      payload: {},
      requestedAt,
      requestedBy: "primary_operator",
      state: "running",
      attempts: 1,
      claim: {
        workerId: "expired-worker",
        leaseToken: "lease-expired-target",
        claimedAtMs: nowMs - 60_000,
        leaseExpiresAtMs: nowMs - 1,
      },
      lastFailureReason: null,
      outcome: null,
      updatedAt: requestedAt,
    });
  });

  const claimed = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "recovery-worker",
    limit: 1,
    leaseMs: 120_000,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].commandId, expiredCommandId);
});

test("worker claims, completes, and safely retries commands with leases", async () => {
  const convex = fixture();
  await seed(convex);
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_000000000000000000000004",
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });

  const first = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-1",
    limit: 1,
    leaseMs: 120_000,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].attempts, 1);
  assert.equal(first[0].claim.workerId, "ops-worker-1");

  await assert.rejects(
    convex.mutation(completeCommand, {
      workerToken,
      commandId: first[0].commandId,
      workerId: "ops-worker-1",
      leaseToken: first[0].claim.leaseToken,
      outcome: { code: "generated", customerEmail: "parent@example.test" },
    }),
    /outcome fields/i,
  );

  await assert.rejects(
    convex.mutation(completeCommand, {
      workerToken,
      commandId: first[0].commandId,
      workerId: "other-worker",
      leaseToken: first[0].claim.leaseToken,
      outcome: { code: "review_prepared", revisionId: "revision_001", artifactSetId: "artifact_001", jobVersion: 4 },
    }),
    /active claim/i,
  );

  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generating",
    version: 4,
    currentRevisionId: null,
    stageAttempts: [{
      attemptId: "attempt_ops_worker_001",
      stage: "prepare_review",
      revisionId: null,
      status: "running",
      operationsCommandId: first[0].commandId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    }],
  }));
  const fenced = await convex.mutation(fenceCommand, {
    workerToken,
    commandId: first[0].commandId,
    workerId: "ops-worker-1",
    leaseToken: first[0].claim.leaseToken,
    leaseMs: 120_000,
    effectMayBeIssued: true,
  });
  assert.equal(fenced.active, true);
  assert.equal(fenced.command.claim.effectStartedAtMs > 0, true);

  await assert.rejects(
    convex.mutation(completeCommand, {
      workerToken,
      commandId: first[0].commandId,
      workerId: "ops-worker-1",
      leaseToken: first[0].claim.leaseToken,
      outcome: { code: "review_prepared", revisionId: "revision_001", artifactSetId: "artifact_001", jobVersion: 5 },
    }),
    /authoritative fulfillment outcome/i,
  );

  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "content_review_required",
    version: 5,
    currentRevisionId: "revision_001",
    revisions: [{ revisionId: "revision_001", ordinal: 1, inputDigest: "a".repeat(64) }],
    artifactSets: [{
      artifactSetId: "artifact_001",
      kind: "private_review",
      revisionId: "revision_001",
      operationsCommandId: first[0].commandId,
      pageDigest: "c".repeat(64),
      transcriptDigest: "d".repeat(64),
      assetManifestDigest: "e".repeat(64),
    }],
  }));

  const completed = await convex.mutation(completeCommand, {
    workerToken,
    commandId: first[0].commandId,
    workerId: "ops-worker-1",
    leaseToken: first[0].claim.leaseToken,
    outcome: { code: "review_prepared", revisionId: "revision_001", artifactSetId: "artifact_001", jobVersion: 5 },
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.command.state, "completed");

  const noMore = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-2",
    limit: 1,
    leaseMs: 120_000,
  });
  assert.deepEqual(noMore, []);
});

test("effect fence rejects an expired canonical stage lease", async () => {
  const convex = fixture();
  await seed(convex);
  const commandId = "command_expired_stage_lease_000001";
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId,
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-stage-lease",
    limit: 1,
    leaseMs: 120_000,
  });
  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generating",
    version: 4,
    stageAttempts: [{
      attemptId: "attempt_expired_stage_lease_001",
      stage: "prepare_review",
      revisionId: null,
      status: "running",
      operationsCommandId: commandId,
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    }],
  }));

  const fenced = await convex.mutation(fenceCommand, {
    workerToken,
    commandId,
    workerId: "ops-worker-stage-lease",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 120_000,
    effectMayBeIssued: true,
  });
  assert.equal(fenced.active, false);
  assert.equal(fenced.command.state, "failed");
  assert.equal(fenced.command.lastFailureReason, "stale_job_state");
  assert.equal(fenced.command.claim, null);
});

test("effect fence rejects a future stage lease outside canonical timestamp form", async () => {
  const convex = fixture();
  await seed(convex);
  const commandId = "command_malformed_stage_lease_0001";
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId,
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-stage-lease",
    limit: 1,
    leaseMs: 120_000,
  });
  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generating",
    version: 4,
    stageAttempts: [{
      attemptId: "attempt_malformed_stage_lease_001",
      stage: "prepare_review",
      revisionId: null,
      status: "running",
      operationsCommandId: commandId,
      leaseExpiresAt: "2099-01-01",
    }],
  }));

  const fenced = await convex.mutation(fenceCommand, {
    workerToken,
    commandId,
    workerId: "ops-worker-stage-lease",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 120_000,
    effectMayBeIssued: true,
  });
  assert.equal(fenced.active, false);
  assert.equal(fenced.command.state, "failed");
  assert.equal(fenced.command.lastFailureReason, "stale_job_state");
});

test("failed commands retain bounded failure codes and become retryable without PII", async () => {
  const convex = fixture();
  await seed(convex);
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_000000000000000000000005",
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });
  const claimed = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-1",
    limit: 1,
    leaseMs: 120_000,
  });

  const failed = await convex.mutation(failCommand, {
    workerToken,
    commandId: "command_000000000000000000000005",
    workerId: "ops-worker-1",
    leaseToken: claimed[0].claim.leaseToken,
    reasonCode: "generation_provider_unavailable",
    retryable: true,
  });

  assert.equal(failed.command.state, "pending");
  assert.equal(failed.command.lastFailureReason, "generation_provider_unavailable");
  assert.equal(JSON.stringify(failed).includes("parent@example.test"), false);
});

test("commands without operator input reject every payload field", async () => {
  const convex = fixture();
  await seed(convex);

  await assert.rejects(
    convex.mutation(requestCommand, {
      operatorToken,
      commandId: "command_000000000000000000000006",
      jobId: "job_ops_001",
      action: "generate",
      expectedState: "generation_queued",
      expectedVersion: 3,
      payload: { note: "unexpected" },
    }),
    /unexpected fields/i,
  );
});

test("review commands bind the exact current revision and artifact digests", async () => {
  const convex = fixture();
  const artifactDigests = {
    pageDigest: "1".repeat(64),
    transcriptDigest: "2".repeat(64),
    assetManifestDigest: "3".repeat(64),
  };
  await seed(convex, {
    fulfillment: fulfillmentAggregate({
      state: "content_review_required",
      version: 4,
      currentRevisionId: "revision_ops_001",
      revisions: [{ revisionId: "revision_ops_001", ordinal: 1, inputDigest: "a".repeat(64) }],
      artifactSets: [{
        artifactSetId: "artifact_private_review_001",
        kind: "private_review",
        revisionId: "revision_ops_001",
        ...artifactDigests,
      }],
    }),
  });
  const input = {
    operatorToken,
    commandId: "command_000000000000000000000007",
    jobId: "job_ops_001",
    action: "approve_content",
    expectedState: "content_review_required",
    expectedVersion: 4,
    payload: {
      revisionId: "revision_ops_001",
      artifactManifestDigest: artifactDigests.assetManifestDigest,
      artifactDigests,
    },
  };

  await assert.rejects(
    convex.mutation(requestCommand, {
      ...input,
      commandId: "command_000000000000000000000008",
      payload: { ...input.payload, artifactManifestDigest: "f".repeat(64) },
    }),
    /exact review artifacts/i,
  );

  const result = await convex.mutation(requestCommand, input);
  assert.equal(result.created, true);
  assert.deepEqual(result.command.payload.artifactDigests, artifactDigests);
});

test("review completion follows only the latest decision and its action terminal state", async () => {
  const convex = fixture();
  const artifactDigests = {
    pageDigest: "1".repeat(64),
    transcriptDigest: "2".repeat(64),
    assetManifestDigest: "3".repeat(64),
  };
  await seed(convex, {
    fulfillment: fulfillmentAggregate({
      state: "content_review_required",
      version: 4,
      currentRevisionId: "revision_ops_review",
      artifactSets: [{
        artifactSetId: "artifact_private_review",
        kind: "private_review",
        revisionId: "revision_ops_review",
        ...artifactDigests,
      }],
    }),
  });
  const commandId = "command_review_latest_000001";
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId,
    jobId: "job_ops_001",
    action: "approve_content",
    expectedState: "content_review_required",
    expectedVersion: 4,
    payload: {
      revisionId: "revision_ops_review",
      artifactManifestDigest: artifactDigests.assetManifestDigest,
      artifactDigests,
    },
  });
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-review",
    limit: 1,
    leaseMs: 120_000,
  });
  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generation_queued",
    version: 5,
    currentRevisionId: "revision_ops_review",
    artifactSets: [{
      artifactSetId: "artifact_private_review",
      kind: "private_review",
      revisionId: "revision_ops_review",
      ...artifactDigests,
    }],
    reviewDecisions: [
      {
        decisionId: "decision_old_approved",
        decisionType: "content",
        outcome: "approved",
        revisionId: "revision_ops_review",
        artifactDigests,
      },
      {
        decisionId: "decision_latest_changes",
        decisionType: "content",
        outcome: "request_changes",
        revisionId: "revision_ops_review",
        artifactDigests,
      },
    ],
  }));
  await assert.rejects(
    convex.mutation(completeCommand, {
      workerToken,
      commandId,
      workerId: "ops-worker-review",
      leaseToken: claimed.claim.leaseToken,
      outcome: {
        code: "review_recorded",
        decisionId: "decision_old_approved",
        jobVersion: 5,
      },
    }),
    /authoritative fulfillment outcome/i,
  );

  const approvedState = fulfillmentAggregate({
    state: "render_queued",
    version: 5,
    currentRevisionId: "revision_ops_review",
    artifactSets: [{
      artifactSetId: "artifact_private_review",
      kind: "private_review",
      revisionId: "revision_ops_review",
      ...artifactDigests,
    }],
    reviewDecisions: [{
      decisionId: "decision_old_approved",
      decisionType: "content",
      outcome: "approved",
      revisionId: "revision_ops_review",
      artifactDigests,
      operationsCommandId: "command_other_review_000001",
    }],
  });
  await replaceFulfillment(convex, approvedState);
  const reviewOutcome = {
    code: "review_recorded",
    decisionId: "decision_old_approved",
    jobVersion: 5,
  };
  await assert.rejects(
    convex.mutation(completeCommand, {
      workerToken,
      commandId,
      workerId: "ops-worker-review",
      leaseToken: claimed.claim.leaseToken,
      outcome: reviewOutcome,
    }),
    /authoritative fulfillment outcome/i,
  );
  approvedState.reviewDecisions[0].operationsCommandId = commandId;
  await replaceFulfillment(convex, approvedState);
  const completed = await convex.mutation(completeCommand, {
    workerToken,
    commandId,
    workerId: "ops-worker-review",
    leaseToken: claimed.claim.leaseToken,
    outcome: reviewOutcome,
  });
  assert.equal(completed.command.state, "completed");
});

test("publication commands bind the current release revision and manifest", async () => {
  const convex = fixture();
  await seed(convex, {
    fulfillment: fulfillmentAggregate({
      state: "publish_ready",
      version: 7,
      narrationRequired: false,
      currentRevisionId: "revision_ops_002",
      artifactSets: [{
        artifactSetId: "artifact_release_002",
        kind: "prepared_bundle",
        revisionId: "revision_ops_002",
        pageDigest: "4".repeat(64),
        transcriptDigest: "5".repeat(64),
        assetManifestDigest: "6".repeat(64),
      }],
    }),
  });
  const input = {
    operatorToken,
    commandId: "command_000000000000000000000009",
    jobId: "job_ops_001",
    action: "publish",
    expectedState: "publish_ready",
    expectedVersion: 7,
    payload: {
      revisionId: "revision_ops_002",
      artifactManifestDigest: "6".repeat(64),
    },
  };

  await assert.rejects(
    convex.mutation(requestCommand, {
      ...input,
      commandId: "command_000000000000000000000010",
      payload: { ...input.payload, artifactManifestDigest: "7".repeat(64) },
    }),
    /exact release artifact/i,
  );
  assert.equal((await convex.mutation(requestCommand, input)).created, true);
});

test("delivery commands bind the exact published revision and publication", async () => {
  for (const [state, action, suffix] of [
    ["published", "queue_delivery", "011"],
    ["delivery_queued", "deliver", "012"],
  ]) {
    const convex = fixture();
    await seed(convex, {
      fulfillment: fulfillmentAggregate({
        state,
        version: 9,
        narrationRequired: false,
        currentRevisionId: "revision_ops_003",
        publishedRevisionId: "revision_ops_003",
        publication: {
          status: "published",
          revisionId: "revision_ops_003",
          publicationId: "publication_ops_003",
          artifactManifestDigest: "9".repeat(64),
        },
        artifactSets: [{
          artifactSetId: "artifact_release_003",
          kind: "prepared_bundle",
          revisionId: "revision_ops_003",
          pageDigest: "7".repeat(64),
          transcriptDigest: "8".repeat(64),
          assetManifestDigest: "9".repeat(64),
        }],
      }),
    });
    const input = {
      operatorToken,
      commandId: `command_000000000000000000000${suffix}`,
      jobId: "job_ops_001",
      action,
      expectedState: state,
      expectedVersion: 9,
      payload: {
        revisionId: "revision_ops_003",
        publicationId: "publication_ops_003",
        artifactManifestDigest: "9".repeat(64),
      },
    };

    await assert.rejects(
      convex.mutation(requestCommand, {
        ...input,
        commandId: `command_000000000000000000009${suffix}`,
        payload: { ...input.payload, publicationId: "publication_wrong" },
      }),
      /exact publication/i,
    );
    assert.equal((await convex.mutation(requestCommand, input)).created, true);
  }
});

test("one job version cannot hold mutually exclusive review decisions", async () => {
  const convex = fixture();
  const artifactDigests = {
    pageDigest: "a".repeat(64),
    transcriptDigest: "b".repeat(64),
    assetManifestDigest: "c".repeat(64),
  };
  await seed(convex, {
    fulfillment: fulfillmentAggregate({
      state: "content_review_required",
      version: 4,
      currentRevisionId: "revision_ops_decision",
      artifactSets: [{
        artifactSetId: "artifact_private_review_decision",
        kind: "private_review",
        revisionId: "revision_ops_decision",
        ...artifactDigests,
      }],
    }),
  });
  const shared = {
    operatorToken,
    jobId: "job_ops_001",
    expectedState: "content_review_required",
    expectedVersion: 4,
  };
  await convex.mutation(requestCommand, {
    ...shared,
    commandId: "command_000000000000000000000013",
    action: "approve_content",
    payload: {
      revisionId: "revision_ops_decision",
      artifactManifestDigest: artifactDigests.assetManifestDigest,
      artifactDigests,
    },
  });

  await assert.rejects(
    convex.mutation(requestCommand, {
      ...shared,
      commandId: "command_000000000000000000000014",
      action: "reject_content",
        payload: {
        revisionId: "revision_ops_decision",
        artifactManifestDigest: artifactDigests.assetManifestDigest,
        artifactDigests,
        reasonCodes: ["editorial_tone"],
      },
    }),
    /review decision already exists/i,
  );
});

test("operator identity and command lease timestamps are server-owned", async (t) => {
  const convex = fixture();
  await seed(convex);
  const originalNow = Date.now;
  let nowMs = Date.parse("2026-09-03T01:00:00.000Z");
  Date.now = () => nowMs;
  t.after(() => { Date.now = originalNow; });

  const requested = await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_000000000000000000000015",
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });
  assert.equal(requested.command.requestedAt, "2026-09-03T01:00:00.000Z");
  assert.equal(requested.command.requestedBy, "primary_operator");

  nowMs += 1_000;
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-1",
    limit: 1,
    leaseMs: 120_000,
  });
  assert.equal(claimed.claim.claimedAtMs, nowMs);

  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generating",
    version: 4,
    currentRevisionId: null,
    stageAttempts: [{
      attemptId: "attempt_ops_clock_001",
      stage: "prepare_review",
      revisionId: null,
      status: "running",
      operationsCommandId: claimed.commandId,
      leaseExpiresAt: new Date(nowMs + 120_000).toISOString(),
    }],
  }));
  await convex.mutation(fenceCommand, {
    workerToken,
    commandId: claimed.commandId,
    workerId: "ops-worker-1",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 120_000,
    effectMayBeIssued: true,
  });
  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "content_review_required",
    version: 5,
    currentRevisionId: "revision_001",
    revisions: [{ revisionId: "revision_001", ordinal: 1, inputDigest: "a".repeat(64) }],
    artifactSets: [{
      artifactSetId: "artifact_001",
      kind: "private_review",
      revisionId: "revision_001",
      operationsCommandId: claimed.commandId,
      pageDigest: "c".repeat(64),
      transcriptDigest: "d".repeat(64),
      assetManifestDigest: "e".repeat(64),
    }],
  }));

  nowMs += 1_000;
  const completed = await convex.mutation(completeCommand, {
    workerToken,
    commandId: claimed.commandId,
    workerId: "ops-worker-1",
    leaseToken: claimed.claim.leaseToken,
    outcome: {
      code: "review_prepared",
      revisionId: "revision_001",
      artifactSetId: "artifact_001",
      jobVersion: 5,
    },
  });
  assert.equal(completed.command.updatedAt, "2026-09-03T01:00:02.000Z");
});

test("reconciliation commands must target the latest unresolved external effect", async () => {
  const convex = fixture();
  await seed(convex);
  const insertSource = async (commandId, updatedAt) => convex.run(async (context) => {
    await context.db.insert("customerFlowOperationsCommands", {
      commandId,
      jobId: "job_ops_001",
      action: "generate",
      expectedState: "generation_queued",
      expectedVersion: 3,
      payload: {},
      requestedAt: updatedAt,
      requestedBy: "primary_operator",
      state: "reconciliation_required",
      attempts: 1,
      claim: null,
      lastFailureReason: "provider_result_unknown",
      outcome: null,
      updatedAt,
    });
  });
  const older = "command_reconcile_source_old_000001";
  const latest = "command_reconcile_source_new_000001";
  await insertSource(older, "2026-09-03T01:00:00.000Z");
  await insertSource(latest, "2026-09-03T01:01:00.000Z");

  const request = {
    operatorToken,
    jobId: "job_ops_001",
    action: "reconcile",
    expectedState: "generation_queued",
    expectedVersion: 3,
  };
  await assert.rejects(
    convex.mutation(requestCommand, {
      ...request,
      commandId: "command_reconcile_old_check_000001",
      payload: { sourceCommandId: older, providerStatus: "confirmed_absent" },
    }),
    /latest unresolved command/i,
  );
  const accepted = await convex.mutation(requestCommand, {
    ...request,
    commandId: "command_reconcile_new_check_000001",
    payload: { sourceCommandId: latest, providerStatus: "confirmed_absent" },
  });
  assert.equal(accepted.created, true);
});

test("ambiguous external effects move the command and operator projection to reconciliation", async (t) => {
  const convex = fixture();
  await seed(convex, {
    customer: customerJob({
      payment: {
        status: "pending",
        checkout: null,
        acceptedEventId: null,
        paymentIntentId: null,
        paidAt: null,
      },
    }),
    fulfillment: fulfillmentAggregate({ state: "awaiting_payment", version: 3 }),
  });
  const originalNow = Date.now;
  let nowMs = Date.parse("2026-09-03T02:00:00.000Z");
  Date.now = () => nowMs;
  t.after(() => { Date.now = originalNow; });

  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_000000000000000000000016",
    jobId: "job_ops_001",
    action: "create_checkout",
    expectedState: "awaiting_payment",
    expectedVersion: 3,
    payload: {},
  });
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-1",
    limit: 1,
    leaseMs: 120_000,
  });
  await convex.mutation(fenceCommand, {
    workerToken,
    commandId: claimed.commandId,
    workerId: "ops-worker-1",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 120_000,
    effectMayBeIssued: true,
  });
  nowMs += 1_000;
  const failed = await convex.mutation(failCommand, {
    workerToken,
    commandId: claimed.commandId,
    workerId: "ops-worker-1",
    leaseToken: claimed.claim.leaseToken,
    reasonCode: "provider_result_unknown",
    retryable: true,
  });
  assert.equal(failed.command.state, "reconciliation_required");
  const detail = await convex.query(getJob, { operatorToken, jobId: "job_ops_001" });
  assert.equal(detail.summary.state, "reconciliation_required");
  assert.equal(detail.fulfillment.state, "awaiting_payment");
  assert.deepEqual(detail.availableActions, ["reconcile"]);

  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_000000000000000000000016_reconcile",
    jobId: "job_ops_001",
    action: "reconcile",
    expectedState: "awaiting_payment",
    expectedVersion: 3,
    payload: {
      sourceCommandId: claimed.commandId,
      providerStatus: "confirmed_absent",
    },
  });
  const [failedReconciliation] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-2",
    limit: 1,
    leaseMs: 120_000,
  });
  await convex.mutation(failCommand, {
    workerToken,
    commandId: failedReconciliation.commandId,
    workerId: "ops-worker-2",
    leaseToken: failedReconciliation.claim.leaseToken,
    reasonCode: "provider_inspection_unavailable",
    retryable: false,
  });
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_000000000000000000000017_reconcile",
    jobId: "job_ops_001",
    action: "reconcile",
    expectedState: "awaiting_payment",
    expectedVersion: 3,
    payload: {
      sourceCommandId: claimed.commandId,
      providerStatus: "confirmed_absent",
    },
  });
  const [reconciliation] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-2",
    limit: 1,
    leaseMs: 120_000,
  });
  const reconciliationOutcome = {
    code: "reconciled",
    jobVersion: 3,
    reconciledState: "awaiting_payment",
    sourceCommandId: claimed.commandId,
    providerStatus: "confirmed_absent",
  };
  await convex.mutation(completeCommand, {
    workerToken,
    commandId: reconciliation.commandId,
    workerId: "ops-worker-2",
    leaseToken: reconciliation.claim.leaseToken,
    outcome: reconciliationOutcome,
  });

  const resolved = await convex.query(getJob, { operatorToken, jobId: "job_ops_001" });
  assert.equal(resolved.summary.state, "awaiting_payment");
  assert.equal(resolved.commands.find((command) => command.commandId === claimed.commandId).state, "pending");
  assert.deepEqual(resolved.availableActions, []);
  const [retriedSource] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-3",
    limit: 1,
    leaseMs: 120_000,
  });
  assert.equal(retriedSource.commandId, claimed.commandId);
});

test("command completion enforces action-specific outcomes and replays idempotently", async (t) => {
  const convex = fixture();
  await seed(convex);
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-09-03T03:00:00.000Z");
  t.after(() => { Date.now = originalNow; });

  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_000000000000000000000017",
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-1",
    limit: 1,
    leaseMs: 120_000,
  });
  const base = {
    workerToken,
    commandId: claimed.commandId,
    workerId: "ops-worker-1",
    leaseToken: claimed.claim.leaseToken,
  };
  await assert.rejects(
    convex.mutation(completeCommand, {
      ...base,
      outcome: { code: "published", publicationId: "publication_wrong", jobVersion: 4 },
    }),
    /outcome does not match action/i,
  );
  const outcome = {
    code: "review_prepared",
    revisionId: "revision_001",
    artifactSetId: "artifact_001",
    jobVersion: 5,
  };
  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generating",
    version: 4,
    currentRevisionId: null,
    stageAttempts: [{
      attemptId: "attempt_ops_generate_001",
      stage: "prepare_review",
      revisionId: null,
      status: "running",
      operationsCommandId: claimed.commandId,
      leaseExpiresAt: "2026-09-03T03:02:00.000Z",
    }],
  }));
  const fenced = await convex.mutation(fenceCommand, {
    workerToken,
    commandId: claimed.commandId,
    workerId: "ops-worker-1",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 120_000,
    effectMayBeIssued: true,
  });
  assert.equal(fenced.active, true);
  const postState = fulfillmentAggregate({
    state: "content_review_required",
    version: 5,
    currentRevisionId: "revision_001",
    revisions: [{ revisionId: "revision_001", ordinal: 1, inputDigest: "a".repeat(64) }],
    artifactSets: [{
      artifactSetId: "artifact_001",
      kind: "private_review",
      revisionId: "revision_001",
      pageDigest: "c".repeat(64),
      transcriptDigest: "d".repeat(64),
      assetManifestDigest: "e".repeat(64),
    }],
  });
  await replaceFulfillment(convex, postState);
  await assert.rejects(
    convex.mutation(completeCommand, { ...base, outcome }),
    /authoritative fulfillment outcome/i,
  );
  postState.artifactSets[0].operationsCommandId = claimed.commandId;
  await replaceFulfillment(convex, postState);
  const completed = await convex.mutation(completeCommand, { ...base, outcome });
  assert.equal(completed.command.state, "completed");
  const replay = await convex.mutation(completeCommand, { ...base, outcome });
  assert.deepEqual(replay, completed);
});

test("effect fence rejects a matching stage that belongs to another operations command", async () => {
  const convex = fixture();
  await seed(convex);
  const commandId = "command_wrong_stage_owner_000001";
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId,
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-stage-owner",
    limit: 1,
    leaseMs: 120_000,
  });
  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generating",
    version: 4,
    currentRevisionId: null,
    stageAttempts: [{
      attemptId: "attempt_other_command",
      stage: "prepare_review",
      revisionId: null,
      status: "running",
      operationsCommandId: "command_other_owner_000001",
    }],
  }));
  const fenced = await convex.mutation(fenceCommand, {
    workerToken,
    commandId,
    workerId: "ops-worker-stage-owner",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 120_000,
    effectMayBeIssued: true,
  });
  assert.equal(fenced.active, false);
  assert.equal(fenced.command.state, "failed");
  assert.equal(fenced.command.lastFailureReason, "stale_job_state");
});

test("server fence expires stale external-effect ownership before another provider mutation", async (t) => {
  const convex = fixture();
  await seed(convex);
  const originalNow = Date.now;
  let nowMs = Date.parse("2026-09-03T03:15:00.000Z");
  Date.now = () => nowMs;
  t.after(() => { Date.now = originalNow; });

  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_expiring_effect_000001",
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-expiry",
    limit: 1,
    leaseMs: 1_000,
  });
  nowMs += 500;
  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generating",
    version: 4,
    currentRevisionId: null,
    stageAttempts: [{
      attemptId: "attempt_expiring_effect_001",
      stage: "prepare_review",
      revisionId: null,
      status: "running",
      operationsCommandId: claimed.commandId,
      leaseExpiresAt: new Date(nowMs + 10_000).toISOString(),
    }],
  }));
  const started = await convex.mutation(fenceCommand, {
    workerToken,
    commandId: claimed.commandId,
    workerId: "ops-worker-expiry",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 1_000,
    effectMayBeIssued: true,
  });
  assert.equal(started.active, true);
  nowMs += 1_001;
  const expired = await convex.mutation(fenceCommand, {
    workerToken,
    commandId: claimed.commandId,
    workerId: "ops-worker-expiry",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 1_000,
    effectMayBeIssued: true,
  });
  assert.equal(expired.active, false);
  assert.equal(expired.command.state, "reconciliation_required");
});

test("expired fenced effects are moved to reconciliation after completion rejection", async (t) => {
  const convex = fixture();
  await seed(convex);
  const originalNow = Date.now;
  let nowMs = Date.parse("2026-09-03T03:20:00.000Z");
  Date.now = () => nowMs;
  t.after(() => { Date.now = originalNow; });
  const commandId = "command_expired_completion_000001";
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId,
    jobId: "job_ops_001",
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
  });
  const [claimed] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-expired-completion",
    limit: 1,
    leaseMs: 1_000,
  });
  await replaceFulfillment(convex, fulfillmentAggregate({
    state: "generating",
    version: 4,
    currentRevisionId: null,
    stageAttempts: [{
      attemptId: "attempt_expired_completion",
      stage: "prepare_review",
      revisionId: null,
      status: "running",
      operationsCommandId: commandId,
      leaseExpiresAt: new Date(nowMs + 10_000).toISOString(),
    }],
  }));
  await convex.mutation(fenceCommand, {
    workerToken,
    commandId,
    workerId: "ops-worker-expired-completion",
    leaseToken: claimed.claim.leaseToken,
    leaseMs: 1_000,
    effectMayBeIssued: true,
  });
  nowMs += 1_000;
  await assert.rejects(
    convex.mutation(completeCommand, {
      workerToken,
      commandId,
      workerId: "ops-worker-expired-completion",
      leaseToken: claimed.claim.leaseToken,
      outcome: {
        code: "review_prepared",
        revisionId: "revision_expired",
        artifactSetId: "artifact_expired",
        jobVersion: 5,
      },
    }),
    /active claim/i,
  );
  const failed = await convex.mutation(failCommand, {
    workerToken,
    commandId,
    workerId: "ops-worker-expired-completion",
    leaseToken: claimed.claim.leaseToken,
    reasonCode: "completion_rejected",
    retryable: false,
  });
  assert.equal(failed.command.state, "reconciliation_required");
});

test("successful reconciliation resolves the source only from authoritative persisted provider state", async () => {
  const convex = fixture();
  const manifest = "9".repeat(64);
  await seed(convex, {
    fulfillment: fulfillmentAggregate({
      state: "published",
      version: 8,
      narrationRequired: false,
      currentRevisionId: "revision_reconciled",
      publishedRevisionId: "revision_reconciled",
      artifactSets: [{
        artifactSetId: "artifact_reconciled",
        kind: "prepared_bundle",
        revisionId: "revision_reconciled",
        pageDigest: "7".repeat(64),
        transcriptDigest: "8".repeat(64),
        assetManifestDigest: manifest,
      }],
      publication: {
        provider: "vercel",
        status: "published",
        revisionId: "revision_reconciled",
        stableUrl: "https://announcement.example.test/reconciled",
        artifactManifestDigest: manifest,
        providerReceiptId: "deployment_reconciled_001",
        operationsCommandId: "command_reconciled_source_000001",
      },
    }),
  });
  const sourceCommandId = "command_reconciled_source_000001";
  await convex.run(async (context) => {
    await context.db.insert("customerFlowOperationsCommands", {
      commandId: sourceCommandId,
      jobId: "job_ops_001",
      action: "publish",
      expectedState: "publish_ready",
      expectedVersion: 7,
      payload: { revisionId: "revision_reconciled", artifactManifestDigest: manifest },
      requestedAt: "2026-09-03T03:30:00.000Z",
      requestedBy: "primary_operator",
      state: "reconciliation_required",
      attempts: 1,
      claim: null,
      lastFailureReason: "provider_result_unknown",
      outcome: null,
      updatedAt: "2026-09-03T03:31:00.000Z",
    });
  });
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_reconciled_check_000001",
    jobId: "job_ops_001",
    action: "reconcile",
    expectedState: "published",
    expectedVersion: 8,
    payload: { sourceCommandId, providerStatus: "confirmed_succeeded" },
  });
  const [reconciliation] = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-2",
    limit: 1,
    leaseMs: 120_000,
  });
  const base = {
    workerToken,
    commandId: reconciliation.commandId,
    workerId: "ops-worker-2",
    leaseToken: reconciliation.claim.leaseToken,
  };
  await assert.rejects(
    convex.mutation(completeCommand, {
      ...base,
      outcome: {
        code: "reconciled",
        jobVersion: 999,
        reconciledState: "unrelated_state",
        sourceCommandId,
        providerStatus: "confirmed_succeeded",
      },
    }),
    /authoritative provider and fulfillment state/i,
  );
  await convex.mutation(completeCommand, {
    ...base,
    outcome: {
      code: "reconciled",
      jobVersion: 8,
      reconciledState: "published",
      sourceCommandId,
      providerStatus: "confirmed_succeeded",
    },
  });
  const detail = await convex.query(getJob, { operatorToken, jobId: "job_ops_001" });
  const source = detail.commands.find((command) => command.commandId === sourceCommandId);
  assert.equal(detail.summary.state, "published");
  assert.equal(source.state, "completed");
  assert.deepEqual(source.outcome, {
    code: "published",
    deploymentId: "deployment_reconciled_001",
    jobVersion: 8,
    productionUrl: "https://announcement.example.test/reconciled",
    publicationId: "deployment_reconciled_001",
  });
});

test("job detail reports truncated history and never misses older active commands", async () => {
  const convex = fixture();
  await seed(convex);
  await convex.run(async (context) => {
    const baseMs = Date.parse("2026-09-03T04:00:00.000Z");
    for (let index = 0; index < 101; index += 1) {
      const at = new Date(baseMs + index * 1_000).toISOString();
      await context.db.insert("customerFlowOperationsCommands", {
        commandId: `command_history_${String(index).padStart(3, "0")}`,
        jobId: "job_ops_001",
        action: "generate",
        expectedState: "generation_queued",
        expectedVersion: index === 0 ? 3 : index + 3,
        payload: {},
        requestedAt: at,
        requestedBy: "primary_operator",
        state: index === 0 ? "pending" : "completed",
        attempts: index === 0 ? 0 : 1,
        claim: null,
        lastFailureReason: null,
        outcome: index === 0 ? null : {
          code: "review_prepared",
          revisionId: `revision_${index}`,
          artifactSetId: `artifact_${index}`,
          jobVersion: index + 4,
        },
        updatedAt: at,
      });
    }
  });

  const detail = await convex.query(getJob, { operatorToken, jobId: "job_ops_001" });
  assert.equal(detail.commands.length, 100);
  assert.equal(detail.commandsHasMore, true);
  assert.equal(typeof detail.commandCursor, "string");
  assert.deepEqual(detail.availableActions, []);
  const firstHistoryPage = await convex.query(listJobCommands, {
    operatorToken,
    jobId: "job_ops_001",
    paginationOpts: { cursor: null, numItems: 30 },
  });
  assert.equal(firstHistoryPage.page.length, 30);
  assert.equal(firstHistoryPage.isDone, false);
  assert.equal(JSON.stringify(firstHistoryPage).includes("lease_"), false);
});

test("claiming revalidates canonical artifact bindings after a same-version drift", async () => {
  const convex = fixture();
  await seed(convex, {
    fulfillment: fulfillmentAggregate({
      state: "publish_ready",
      version: 7,
      narrationRequired: false,
      currentRevisionId: "revision_claim_binding",
      artifactSets: [{
        artifactSetId: "artifact_claim_binding",
        kind: "prepared_bundle",
        revisionId: "revision_claim_binding",
        pageDigest: "1".repeat(64),
        transcriptDigest: "2".repeat(64),
        assetManifestDigest: "3".repeat(64),
      }],
    }),
  });
  await convex.mutation(requestCommand, {
    operatorToken,
    commandId: "command_000000000000000000000018",
    jobId: "job_ops_001",
    action: "publish",
    expectedState: "publish_ready",
    expectedVersion: 7,
    payload: {
      revisionId: "revision_claim_binding",
      artifactManifestDigest: "3".repeat(64),
    },
  });
  await convex.run(async (context) => {
    const document = await context.db.query("fulfillmentJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", "job_ops_001"))
      .unique();
    const aggregate = structuredClone(document.aggregate);
    aggregate.artifactSets[0].assetManifestDigest = "4".repeat(64);
    await context.db.patch(document._id, { aggregate });
  });

  const claimed = await convex.mutation(claimCommands, {
    workerToken,
    workerId: "ops-worker-1",
    limit: 1,
    leaseMs: 120_000,
  });
  assert.deepEqual(claimed, []);
  const detail = await convex.query(getJob, { operatorToken, jobId: "job_ops_001" });
  assert.equal(detail.commands[0].state, "failed");
  assert.equal(detail.commands[0].lastFailureReason, "stale_action_binding");
});
