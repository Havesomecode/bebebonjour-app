import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";
import { createFulfillmentOrchestrator } from "../../src/fulfillment/job-orchestrator.mjs";
import { createConvexFulfillmentStore } from "../../src/persistence/convex-fulfillment-store.mjs";

const completionToken = "completion-store-seam-token-at-least-32-bytes";
const jobId = "job_03c25b08-8476-4fe1-923b-43d73feab3ff";
const workerId = "test-a-completion-worker";
const revisionId = "r1";
const sourceDigests = Object.freeze({
  pageDigest: "1".repeat(64),
  transcriptDigest: "2".repeat(64),
  assetManifestDigest: "3".repeat(64),
});
const preparedDigests = Object.freeze({
  pageDigest: sourceDigests.pageDigest,
  transcriptDigest: sourceDigests.transcriptDigest,
  assetManifestDigest: "4".repeat(64),
});
const sourceFile = Object.freeze({
  path: "private-preview/canary/fr/index.html",
  storageId: "storage_completion_store_seam_index",
  sha256: "5".repeat(64),
  bytes: 42,
});
const preparedFile = Object.freeze({ ...sourceFile, path: "deploy/fr/index.html" });
const retryPolicy = Object.freeze({
  leaseMsByStage: Object.freeze({ render_approved: 300_000, publish: 300_000, deliver: 300_000 }),
  maxAttemptsByStage: Object.freeze({ render_approved: 2, publish: 2, deliver: 2 }),
  backoffMsByStage: Object.freeze({
    render_approved: Object.freeze([60_000]),
    publish: Object.freeze([60_000]),
    deliver: Object.freeze([60_000]),
  }),
});

function fixture() {
  process.env.BEBEBONJOUR_COMPLETION_WORKER_TOKEN = completionToken;
  process.env.TEST_A_PUBLICATION_ORIGIN = "https://private.example.test";
  const convex = convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./fulfillment.js": () => import("../../convex/fulfillment.js"),
  });
  const client = {
    query(name, args) {
      return convex.query(makeFunctionReference(name), args);
    },
    mutation(name, args) {
      return convex.mutation(makeFunctionReference(name), args);
    },
  };
  const store = createConvexFulfillmentStore({
    client,
    authorization: { completionToken, jobId },
    functions: {
      getJob: "fulfillment:getCompletionJob",
      replaceJob: "fulfillment:replaceCompletionJob",
    },
  });
  return { convex, client, store };
}

function aggregate(state, overrides = {}) {
  const sourceArtifact = {
    artifactSetId: "artifacts_completion_store_source",
    kind: "private_review",
    revisionId,
    ...sourceDigests,
    manifestRef: `jobs/${jobId}/revisions/${revisionId}/manifests/private_review.json`,
    files: [sourceFile],
  };
  const preparedArtifact = {
    artifactSetId: "artifacts_completion_store_prepared",
    kind: "prepared_bundle",
    revisionId,
    ...preparedDigests,
    manifestRef: `jobs/${jobId}/revisions/${revisionId}/manifests/prepared_bundle.json`,
    files: [preparedFile],
    operationsCommandId: "command_completion_store_render",
  };
  const includePrepared = !["render_queued", "rendering"].includes(state);
  const includePublication = ["published", "delivery_queued", "sending", "sent"].includes(state);
  return {
    schemaVersion: "1.0",
    authority: "convex-target/local-test-projection",
    jobId,
    environment: "test",
    product: "announcement-page",
    intakeDigest: "a".repeat(64),
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId,
      intakeDigest: "a".repeat(64),
    },
    narrationRequired: false,
    state,
    version: 8,
    createdAt: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:00:00.000Z",
    currentRevisionId: revisionId,
    publishedRevisionId: includePublication ? revisionId : null,
    retry: null,
    payment: { providerPaymentId: "pi_completion_store_seam" },
    revisions: [{ revisionId, ordinal: 1, inputDigest: "a".repeat(64) }],
    artifactSets: includePrepared ? [sourceArtifact, preparedArtifact] : [sourceArtifact],
    reviewDecisions: [{
      decisionId: "review_completion_store_seam",
      decisionType: "content",
      revisionId,
      outcome: "approved",
      policyVersion: "bebebonjour-editorial-v1",
      rubricVersion: "test-a-rubric-v1",
      reviewer: { id: "human-reviewer", role: "editorial_reviewer", competencies: ["content_review"] },
      decidedAt: "2026-09-08T09:59:00.000Z",
      artifactDigests: sourceDigests,
      reasons: [],
    }],
    stageAttempts: [],
    publication: includePublication ? {
      provider: "vercel",
      revisionId,
      stableUrl: `${process.env.TEST_A_PUBLICATION_ORIGIN}/announcements/${jobId}`,
      artifactManifestDigest: preparedDigests.assetManifestDigest,
      providerReceiptId: "dpl_completion_store_seam",
      idempotencyKey: "bb_" + "6".repeat(64),
      operationsCommandId: "command_completion_store_publish",
      status: "published",
    } : null,
    deliveryAttempts: [],
    events: [],
    ...overrides,
  };
}

async function seedAggregate(convex, value) {
  await convex.run((context) => context.db.insert("fulfillmentJobs", { jobId, aggregate: value }));
}

async function seedCommand(convex, {
  action,
  commandId = `command_completion_store_${action}`,
  expectedState,
  expectedVersion,
  leaseToken = `operations_lease_completion_store_${action}`,
  effectStarted = action === "publish" || action === "deliver",
  payload = {},
}) {
  await convex.run((context) => context.db.insert("customerFlowOperationsCommands", {
    commandId,
    jobId,
    action,
    expectedState,
    expectedVersion,
    payload,
    requestedAt: "2026-09-08T10:00:00.000Z",
    requestedBy: "primary_operator",
    state: "running",
    attempts: 1,
    claim: {
      workerId,
      leaseToken,
      claimedAtMs: Date.now(),
      leaseExpiresAtMs: Date.now() + 300_000,
      ...(effectStarted ? { effectStartedAtMs: Date.now() } : {}),
    },
    lastFailureReason: null,
    outcome: null,
    updatedAt: "2026-09-08T10:00:00.000Z",
  }));
  return Object.freeze({ commandId, workerId, leaseToken });
}

function createOrchestrator(store, handlers, label) {
  let nowMs = Date.parse("2026-09-08T10:10:00.000Z");
  let token = 0;
  return createFulfillmentOrchestrator({
    store,
    handlers,
    clock: () => new Date(nowMs += 1_000).toISOString(),
    tokenFactory: () => `stage_lease_${label}_${token += 1}`,
    retryPolicy,
  });
}

function preparedArtifact() {
  return {
    artifactSetId: `artifacts_${createHash("sha256").update([
      jobId,
      revisionId,
      "prepared_bundle",
      preparedDigests.pageDigest,
      preparedDigests.transcriptDigest,
      preparedDigests.assetManifestDigest,
    ].join("\0")).digest("hex").slice(0, 24)}`,
    kind: "prepared_bundle",
    revisionId,
    ...preparedDigests,
    manifestRef: `jobs/${jobId}/revisions/${revisionId}/manifests/prepared_bundle.json`,
    files: [preparedFile],
  };
}

test("real Convex completion store preserves both authorities through render, publish, and deliver", async () => {
  const { convex, store } = fixture();
  await seedAggregate(convex, aggregate("render_queued"));
  const renderAuthority = await seedCommand(convex, {
    action: "render",
    expectedState: "render_queued",
    expectedVersion: 8,
  });
  let publicationEffects = 0;
  let deliveryEffects = 0;
  const orchestrator = createOrchestrator(store, {
    render_approved: async () => ({ artifactSet: preparedArtifact() }),
    publish: async (context) => context.fenceExternalEffect({ effectMayBeIssued: true }, async () => {
      publicationEffects += 1;
      return {
        publication: {
          provider: "vercel",
          revisionId,
          stableUrl: `${process.env.TEST_A_PUBLICATION_ORIGIN}/announcements/${jobId}`,
          artifactManifestDigest: preparedDigests.assetManifestDigest,
          providerReceiptId: "dpl_completion_store_seam",
        },
      };
    }),
    prepare_delivery: async () => ({
      targetRef: "resend:test-a-sink",
      targetDigest: "7".repeat(64),
    }),
    deliver: async (context) => context.fenceExternalEffect({ effectMayBeIssued: true }, async () => {
      deliveryEffects += 1;
      return {
        delivery: {
          provider: "resend",
          revisionId,
          providerMessageId: "email_completion_store_seam",
        },
      };
    }),
  }, "happy");

  const renderClaim = {
    commandId: `claim:${jobId}:${revisionId}:render_approved:1`,
    stage: "render_approved",
    leaseToken: "stage_lease_render_replay",
    leaseMs: 300_000,
    maxAttempts: 2,
    operationBinding: null,
    operationsCommandId: renderAuthority.commandId,
  };
  const claimed = await store.claimStage(jobId, renderClaim, "2026-09-08T10:01:00.000Z", renderAuthority);
  const replayed = await store.claimStage(jobId, renderClaim, "2026-09-08T10:01:00.000Z", renderAuthority);
  assert.equal(claimed.acquired, true);
  assert.equal(replayed.acquired, false);
  assert.equal(replayed.aggregate.version, claimed.aggregate.version);
  assert.notEqual(claimed.aggregate.stageAttempts.at(-1).leaseToken, renderAuthority.leaseToken);
  assert.equal(claimed.aggregate.events.at(-1).commandId, renderClaim.commandId);
  await store.completeStage(jobId, {
    commandId: `complete:${claimed.aggregate.stageAttempts.at(-1).attemptId}`,
    stage: "render_approved",
    leaseToken: renderClaim.leaseToken,
    result: { artifactSet: preparedArtifact() },
  }, "2026-09-08T10:02:00.000Z", renderAuthority);

  let current = await store.getJob(jobId, renderAuthority);
  const publishAuthority = await seedCommand(convex, {
    action: "publish",
    expectedState: "publish_ready",
    expectedVersion: current.version,
  });
  await orchestrator.runExpectedStage(jobId, "publish", {
    operationsCommandId: publishAuthority.commandId,
    workerAuthority: publishAuthority,
  });

  current = await store.getJob(jobId, publishAuthority);
  assert.deepEqual(current.events.map((event) => event.type), [
    "stage_claimed",
    "stage_completed",
    "stage_claimed",
    "external_effect_fenced",
    "stage_completed",
  ]);
  assert.equal(current.state, "published");
  const queueAuthority = await seedCommand(convex, {
    action: "queue_delivery",
    expectedState: "published",
    expectedVersion: current.version,
    payload: {
      revisionId,
      publicationId: current.publication.providerReceiptId,
    },
  });
  await orchestrator.queueDelivery(jobId, {
    commandId: queueAuthority.commandId,
    revisionId,
    publicationId: current.publication.providerReceiptId,
  }, queueAuthority);

  current = await store.getJob(jobId, queueAuthority);
  const deliverAuthority = await seedCommand(convex, {
    action: "deliver",
    expectedState: "delivery_queued",
    expectedVersion: current.version,
  });
  await orchestrator.runExpectedStage(jobId, "deliver", {
    operationsCommandId: deliverAuthority.commandId,
    workerAuthority: deliverAuthority,
  });

  current = await store.getJob(jobId, deliverAuthority);
  assert.equal(current.state, "sent");
  assert.equal(publicationEffects, 1);
  assert.equal(deliveryEffects, 1);
  assert.equal(current.publication.operationsCommandId, publishAuthority.commandId);
  assert.equal(current.deliveryAttempts.at(-1).operationsCommandId, deliverAuthority.commandId);
  for (const attempt of current.stageAttempts) {
    assert.notEqual(attempt.leaseToken, attempt.operationsCommandId);
  }
  assert.deepEqual(
    current.events.filter((event) => event.type === "external_effect_fenced").map((event) => event.commandId),
    [
      `effect-fence:${current.stageAttempts[1].attemptId}:1`,
      `effect-fence:${current.stageAttempts[2].attemptId}:1`,
    ],
  );
});

for (const scenario of [
  { action: "render", stage: "render_approved", state: "render_queued", resumed: "render_queued" },
  { action: "publish", stage: "publish", state: "publish_ready", resumed: "publish_ready" },
  { action: "deliver", stage: "deliver", state: "delivery_queued", resumed: "delivery_queued" },
]) {
  test(`real Convex completion store fails and recovers ${scenario.action} without provider effects`, async () => {
    const { convex, store } = fixture();
    await seedAggregate(convex, aggregate(scenario.state));
    const authority = await seedCommand(convex, {
      action: scenario.action,
      expectedState: scenario.state,
      expectedVersion: 8,
    });
    let providerEffects = 0;
    const orchestrator = createOrchestrator(store, {
      [scenario.stage]: async () => {
        throw Object.assign(new Error("pre-provider failure"), {
          reasonCode: "provider_unavailable",
          retryable: true,
        });
      },
      ...(scenario.stage === "deliver" ? {
        prepare_delivery: async () => ({
          targetRef: "resend:test-a-sink",
          targetDigest: "7".repeat(64),
        }),
      } : {}),
    }, `failure_${scenario.action}`);

    const failed = await orchestrator.runExpectedStage(jobId, scenario.stage, {
      operationsCommandId: authority.commandId,
      workerAuthority: authority,
    });
    assert.equal(failed.state, "retry_wait");
    assert.equal(failed.stageAttempts.at(-1).failure.reasonCode, "provider_unavailable");
    assert.equal(providerEffects, 0);

    const retryAuthority = await seedCommand(convex, {
      action: "retry",
      commandId: `command_completion_store_retry_${scenario.action}`,
      expectedState: "retry_wait",
      expectedVersion: failed.version,
      effectStarted: false,
    });
    const recovered = await store.resumeRetry(jobId, {
      commandId: retryAuthority.commandId,
    }, failed.retry.availableAt, retryAuthority);
    assert.equal(recovered.state, scenario.resumed);
    assert.equal(providerEffects, 0);
  });
}

test("real Convex completion store rejects stale, wrong-command, wrong-job, and forged transition authority", async () => {
  const { convex, client, store } = fixture();
  const initial = aggregate("render_queued");
  await seedAggregate(convex, initial);
  const authority = await seedCommand(convex, {
    action: "render",
    expectedState: "render_queued",
    expectedVersion: initial.version,
  });
  let providerEffects = 0;
  const orchestrator = createOrchestrator(store, {
    render_approved: async () => {
      providerEffects += 1;
      return { artifactSet: preparedArtifact() };
    },
  }, "negative");

  await assert.rejects(
    orchestrator.runExpectedStage(jobId, "render_approved", {
      operationsCommandId: "command_completion_store_wrong",
      workerAuthority: { ...authority, commandId: "command_completion_store_wrong" },
    }),
    /command claim authorization/u,
  );
  await assert.rejects(
    orchestrator.runExpectedStage(jobId, "render_approved", {
      operationsCommandId: authority.commandId,
      workerAuthority: { ...authority, leaseToken: "stale_operations_lease" },
    }),
    /command claim authorization/u,
  );
  await assert.rejects(
    store.getJob("job_real_customer_forbidden", authority),
    /Completion worker authorization/u,
  );
  assert.equal(providerEffects, 0);

  const stageLeaseToken = "stage_lease_forgery_negative";
  const claimed = await store.claimStage(jobId, {
    commandId: `claim:${jobId}:${revisionId}:render_approved:1`,
    stage: "render_approved",
    leaseToken: stageLeaseToken,
    leaseMs: 300_000,
    maxAttempts: 2,
    operationBinding: null,
    operationsCommandId: authority.commandId,
  }, "2026-09-08T10:01:00.000Z", authority);
  await assert.rejects(
    store.completeStage(jobId, {
      commandId: `complete:${claimed.aggregate.stageAttempts.at(-1).attemptId}`,
      stage: "render_approved",
      leaseToken: "stale_stage_lease",
      result: { artifactSet: preparedArtifact() },
    }, "2026-09-08T10:02:00.000Z", authority),
    /current exact lease token/u,
  );

  const forgedLease = structuredClone(claimed.aggregate);
  forgedLease.stageAttempts.at(-1).leaseExpiresAt = "2099-01-01T00:00:00.000Z";
  await convex.run(async (context) => {
    const document = await context.db.query("fulfillmentJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
      .unique();
    await context.db.patch(document._id, { aggregate: initial });
  });
  await assert.rejects(
    client.mutation("fulfillment:replaceCompletionJob", {
      completionToken,
      ...authority,
      jobId,
      expectedVersion: initial.version,
      aggregate: forgedLease,
    }),
    /synthetic stage authority/u,
  );

  const forged = structuredClone(claimed.aggregate);
  forged.events.at(-1).commandId = authority.commandId;
  await convex.run(async (context) => {
    const document = await context.db.query("fulfillmentJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
      .unique();
    await context.db.patch(document._id, { aggregate: initial });
  });
  await assert.rejects(
    client.mutation("fulfillment:replaceCompletionJob", {
      completionToken,
      ...authority,
      jobId,
      expectedVersion: initial.version,
      aggregate: forged,
    }),
    /canonical transition evidence/u,
  );
  assert.equal(providerEffects, 0);
});
