import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";
import {
  claimStageTransition,
  commandReplayDigest,
  completeStageTransition,
  failStageTransition,
  fenceExternalEffectTransition,
  queueDeliveryTransition,
  resumeRetryTransition,
} from "../../src/fulfillment/job-machine.mjs";
import { createFulfillmentOrchestrator } from "../../src/fulfillment/job-orchestrator.mjs";
import { createConvexFulfillmentStore } from "../../src/persistence/convex-fulfillment-store.mjs";

const completionToken = "completion-store-seam-token-at-least-32-bytes";
const jobId = "job_03c25b08-8476-4fe1-923b-43d73feab3ff";
const workerId = "test-a-completion-worker";
const revisionId = "r1";
const publicationOrigin = "https://private.example.test";
const deliveryTargetDigest = createHash("sha256")
  .update('{"email":"delivered@resend.dev","targetRef":"resend:test-a-sink"}')
  .digest("hex");
const sourceDigests = Object.freeze({
  pageDigest: "1".repeat(64),
  transcriptDigest: "2".repeat(64),
  assetManifestDigest: "3".repeat(64),
});
const sourceFile = Object.freeze({
  bytes: 42,
  path: "private-preview/canary/fr/index.html",
  sha256: "5".repeat(64),
  storageId: "storage_completion_store_seam_index",
});
const preparedFile = Object.freeze({ ...sourceFile, path: "deploy/fr/index.html" });
const preparedAssetManifestDigest = createHash("sha256").update(`${JSON.stringify({
  schemaVersion: "1.0",
  kind: "prepared_bundle",
  revisionId,
  files: [preparedFile],
}, null, 2)}\n`).digest("hex");
const preparedDigests = Object.freeze({
  pageDigest: sourceDigests.pageDigest,
  transcriptDigest: sourceDigests.transcriptDigest,
  assetManifestDigest: preparedAssetManifestDigest,
});
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
  process.env.TEST_A_PUBLICATION_ORIGIN = publicationOrigin;
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

async function assertForgedReplacementRejected(scenario, forge, label, pattern) {
  const { convex, client } = fixture();
  await seedAggregate(convex, scenario.current);
  const authority = await seedCommand(convex, scenario.authority);
  const forged = structuredClone(scenario.next);
  forge(forged);
  await assert.rejects(
    client.mutation("fulfillment:replaceCompletionJob", {
      completionToken,
      ...authority,
      jobId,
      expectedVersion: scenario.current.version,
      aggregate: forged,
    }),
    pattern,
    label,
  );
  assert.deepEqual(
    await client.query("fulfillment:getCompletionJob", { completionToken, jobId }),
    scenario.current,
    `${label}: canonical aggregate changed after rejection`,
  );
}

function rebindStageCompletionDigest(current, next, stage, result) {
  const event = next.events.at(-1);
  event.commandDigest = commandReplayDigest("stage_completed", {
    commandId: event.commandId,
    stage,
    leaseToken: current.stageAttempts.at(-1).leaseToken,
    result,
  });
}

function renderCompletionScenario() {
  const commandId = "command_completion_store_render_boundary";
  const origin = aggregate("render_queued");
  const claimed = claimStageTransition(origin, {
    commandId: `claim:${jobId}:${revisionId}:render_approved:1`,
    stage: "render_approved",
    leaseToken: "stage_lease_render_boundary",
    leaseMs: 300_000,
    maxAttempts: 2,
    operationBinding: null,
    operationsCommandId: commandId,
  }, "2026-09-08T10:01:00.000Z");
  const next = completeStageTransition(claimed, {
    commandId: `complete:${claimed.stageAttempts.at(-1).attemptId}`,
    stage: "render_approved",
    leaseToken: claimed.stageAttempts.at(-1).leaseToken,
    result: { artifactSet: preparedArtifact() },
  }, "2026-09-08T10:02:00.000Z");
  return {
    current: claimed,
    next,
    authority: {
      action: "render",
      commandId,
      expectedState: origin.state,
      expectedVersion: origin.version,
    },
  };
}

function publishCompletionScenario() {
  const commandId = "command_completion_store_publish_boundary";
  const origin = aggregate("publish_ready");
  const claimed = claimStageTransition(origin, {
    commandId: `claim:${jobId}:${revisionId}:publish:1`,
    stage: "publish",
    leaseToken: "stage_lease_publish_boundary",
    leaseMs: 300_000,
    maxAttempts: 2,
    operationBinding: null,
    operationsCommandId: commandId,
  }, "2026-09-08T10:01:00.000Z");
  const fenced = fenceExternalEffectTransition(claimed, {
    commandId: `effect-fence:${claimed.stageAttempts.at(-1).attemptId}:1`,
    stage: "publish",
    attemptId: claimed.stageAttempts.at(-1).attemptId,
    leaseToken: claimed.stageAttempts.at(-1).leaseToken,
    leaseMs: 300_000,
    effectMayBeIssued: true,
  }, "2026-09-08T10:02:00.000Z");
  const next = completeStageTransition(fenced, {
    commandId: `complete:${fenced.stageAttempts.at(-1).attemptId}`,
    stage: "publish",
    leaseToken: fenced.stageAttempts.at(-1).leaseToken,
    result: {
      publication: {
        provider: "vercel",
        revisionId,
        stableUrl: `${publicationOrigin}/announcements/${jobId}`,
        artifactManifestDigest: preparedDigests.assetManifestDigest,
        providerReceiptId: "dpl_completion_store_boundary",
      },
    },
  }, "2026-09-08T10:03:00.000Z");
  return {
    current: fenced,
    next,
    authority: {
      action: "publish",
      commandId,
      expectedState: origin.state,
      expectedVersion: origin.version,
    },
  };
}

function deliveryCompletionScenario() {
  const commandId = "command_completion_store_deliver_boundary";
  const origin = aggregate("delivery_queued");
  const claimed = claimStageTransition(origin, {
    commandId: `claim:${jobId}:${revisionId}:deliver:1`,
    stage: "deliver",
    leaseToken: "stage_lease_deliver_boundary",
    leaseMs: 300_000,
    maxAttempts: 2,
    operationBinding: {
      targetRef: "resend:test-a-sink",
      targetDigest: deliveryTargetDigest,
    },
    operationsCommandId: commandId,
  }, "2026-09-08T10:01:00.000Z");
  const fenced = fenceExternalEffectTransition(claimed, {
    commandId: `effect-fence:${claimed.stageAttempts.at(-1).attemptId}:1`,
    stage: "deliver",
    attemptId: claimed.stageAttempts.at(-1).attemptId,
    leaseToken: claimed.stageAttempts.at(-1).leaseToken,
    leaseMs: 300_000,
    effectMayBeIssued: true,
  }, "2026-09-08T10:02:00.000Z");
  const next = completeStageTransition(fenced, {
    commandId: `complete:${fenced.stageAttempts.at(-1).attemptId}`,
    stage: "deliver",
    leaseToken: fenced.stageAttempts.at(-1).leaseToken,
    result: {
      delivery: {
        provider: "resend",
        revisionId,
        providerMessageId: "email_completion_store_boundary",
      },
    },
  }, "2026-09-08T10:03:00.000Z");
  return {
    current: fenced,
    next,
    authority: {
      action: "deliver",
      commandId,
      expectedState: origin.state,
      expectedVersion: origin.version,
    },
  };
}

function exactBoundaryScenarios() {
  const renderSuccess = renderCompletionScenario();
  const renderOrigin = aggregate("render_queued");
  const renderClaim = {
    current: renderOrigin,
    next: renderSuccess.current,
    authority: renderSuccess.authority,
    owned: new Set(["stageAttempts"]),
  };
  const renderRetryNext = failStageTransition(renderSuccess.current, {
    commandId: `fail:${renderSuccess.current.stageAttempts.at(-1).attemptId}:render_retryable`,
    stage: "render_approved",
    leaseToken: renderSuccess.current.stageAttempts.at(-1).leaseToken,
    reasonCode: "render_retryable",
    retryable: true,
  }, retryPolicy, "2026-09-08T10:02:00.000Z");
  const renderFailure = {
    current: renderSuccess.current,
    next: renderRetryNext,
    authority: renderSuccess.authority,
    owned: new Set(["retry", "stageAttempts"]),
  };
  const retryCommandId = `retry:${jobId}:${revisionId}:render_approved`;
  const retryNext = resumeRetryTransition(renderRetryNext, {
    commandId: retryCommandId,
    stage: "render_approved",
  }, "2026-09-08T10:04:00.000Z");
  const retryResume = {
    current: renderRetryNext,
    next: retryNext,
    authority: {
      action: "retry",
      commandId: retryCommandId,
      expectedState: renderRetryNext.state,
      expectedVersion: renderRetryNext.version,
    },
    owned: new Set(["retry"]),
  };

  const publishSuccess = publishCompletionScenario();
  const publishOrigin = aggregate("publish_ready");
  const publishClaimed = claimStageTransition(publishOrigin, {
    commandId: `claim:${jobId}:${revisionId}:publish:1`,
    stage: "publish",
    leaseToken: "stage_lease_publish_boundary",
    leaseMs: 300_000,
    maxAttempts: 2,
    operationBinding: null,
    operationsCommandId: publishSuccess.authority.commandId,
  }, "2026-09-08T10:01:00.000Z");
  const publishFence = {
    current: publishClaimed,
    next: publishSuccess.current,
    authority: publishSuccess.authority,
    owned: new Set(["stageAttempts"]),
  };
  const publishFailure = {
    current: publishClaimed,
    next: failStageTransition(publishClaimed, {
      commandId: `fail:${publishClaimed.stageAttempts.at(-1).attemptId}:publish_failed`,
      stage: "publish",
      leaseToken: publishClaimed.stageAttempts.at(-1).leaseToken,
      reasonCode: "publish_failed",
      retryable: false,
    }, retryPolicy, "2026-09-08T10:02:00.000Z"),
    authority: publishSuccess.authority,
    owned: new Set(["retry", "stageAttempts"]),
  };

  const queueCommandId = "command_completion_store_queue_boundary";
  const queueOrigin = aggregate("published");
  const queueCommand = {
    commandId: queueCommandId,
    revisionId,
    publicationId: queueOrigin.publication.providerReceiptId,
  };
  const queueDelivery = {
    current: queueOrigin,
    next: queueDeliveryTransition(queueOrigin, queueCommand, "2026-09-08T10:01:00.000Z"),
    authority: {
      action: "queue_delivery",
      commandId: queueCommandId,
      expectedState: queueOrigin.state,
      expectedVersion: queueOrigin.version,
      payload: { revisionId, publicationId: queueCommand.publicationId },
    },
    owned: new Set(),
  };

  const deliverySuccess = deliveryCompletionScenario();
  const deliveryOrigin = aggregate("delivery_queued");
  const deliveryClaimed = claimStageTransition(deliveryOrigin, {
    commandId: `claim:${jobId}:${revisionId}:deliver:1`,
    stage: "deliver",
    leaseToken: "stage_lease_deliver_boundary",
    leaseMs: 300_000,
    maxAttempts: 2,
    operationBinding: { targetRef: "resend:test-a-sink", targetDigest: deliveryTargetDigest },
    operationsCommandId: deliverySuccess.authority.commandId,
  }, "2026-09-08T10:01:00.000Z");
  const deliveryClaim = {
    current: deliveryOrigin,
    next: deliveryClaimed,
    authority: deliverySuccess.authority,
    owned: new Set(["stageAttempts"]),
  };
  const deliveryFailure = {
    current: deliveryClaimed,
    next: failStageTransition(deliveryClaimed, {
      commandId: `fail:${deliveryClaimed.stageAttempts.at(-1).attemptId}:delivery_failed`,
      stage: "deliver",
      leaseToken: deliveryClaimed.stageAttempts.at(-1).leaseToken,
      reasonCode: "delivery_failed",
      retryable: false,
    }, retryPolicy, "2026-09-08T10:02:00.000Z"),
    authority: deliverySuccess.authority,
    owned: new Set(["retry", "stageAttempts"]),
  };

  return [
    ["render claim", renderClaim],
    ["render success", { ...renderSuccess, owned: new Set(["artifactSets", "stageAttempts"]) }],
    ["render failure", renderFailure],
    ["retry resume", retryResume],
    ["publish fence", publishFence],
    ["publish failure", publishFailure],
    ["publish success", {
      ...publishSuccess,
      owned: new Set(["publication", "publishedRevisionId", "stageAttempts"]),
    }],
    ["queue delivery", queueDelivery],
    ["delivery claim", deliveryClaim],
    ["delivery failure", deliveryFailure],
    ["delivery success", {
      ...deliverySuccess,
      owned: new Set(["deliveryAttempts", "stageAttempts"]),
    }],
  ];
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
      targetDigest: deliveryTargetDigest,
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
          targetDigest: deliveryTargetDigest,
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

test("real Convex completion store rejects unrelated aggregate fields forged during a render claim", async () => {
  const current = aggregate("render_queued");
  const claim = {
    commandId: `claim:${jobId}:${revisionId}:render_approved:1`,
    stage: "render_approved",
    leaseToken: "stage_lease_render_boundary",
    leaseMs: 300_000,
    maxAttempts: 2,
    operationBinding: null,
    operationsCommandId: "command_completion_store_render_boundary",
  };
  const validNext = claimStageTransition(current, claim, "2026-09-08T10:01:00.000Z");
  const forgeries = {
    publication: {
      provider: "vercel",
      revisionId: "forged-revision",
      stableUrl: "https://attacker.example.test/announcement",
      artifactManifestDigest: "b".repeat(64),
      providerReceiptId: "forged-publication",
      idempotencyKey: "bb_" + "c".repeat(64),
      operationsCommandId: claim.operationsCommandId,
      status: "published",
    },
    publishedRevisionId: "forged-revision",
    retry: {
      stage: "publish",
      availableAt: "2099-01-01T00:00:00.000Z",
    },
  };

  for (const [field, value] of Object.entries(forgeries)) {
    const { convex, client } = fixture();
    await seedAggregate(convex, current);
    const authority = await seedCommand(convex, {
      action: "render",
      commandId: claim.operationsCommandId,
      expectedState: current.state,
      expectedVersion: current.version,
    });
    await assert.rejects(
      client.mutation("fulfillment:replaceCompletionJob", {
        completionToken,
        ...authority,
        jobId,
        expectedVersion: current.version,
        aggregate: { ...structuredClone(validNext), [field]: value },
      }),
      /exact transition mutation boundary/u,
      field,
    );
  }
});

test("real Convex completion store binds the promoted artifact to the active render attempt", async () => {
  const scenario = renderCompletionScenario();
  const forgeries = {
    extra: (artifact) => { artifact.extra = "forged"; },
    artifactSetId: (artifact) => { artifact.artifactSetId = "artifacts_forged"; },
    operationsCommandId: (artifact) => { artifact.operationsCommandId = "command_attacker_render"; },
    assetManifestDigest: (artifact) => { artifact.assetManifestDigest = "b".repeat(64); },
  };
  for (const [field, forgeArtifact] of Object.entries(forgeries)) {
    await assertForgedReplacementRejected(
      scenario,
      (next) => {
        const artifact = next.artifactSets.at(-1);
        forgeArtifact(artifact);
        if (field === "assetManifestDigest") {
          artifact.artifactSetId = `artifacts_${createHash("sha256").update([
            jobId,
            revisionId,
            artifact.kind,
            artifact.pageDigest,
            artifact.transcriptDigest,
            artifact.assetManifestDigest,
          ].join("\0")).digest("hex").slice(0, 24)}`;
        }
        const { operationsCommandId: ignored, ...resultArtifact } = artifact;
        rebindStageCompletionDigest(scenario.current, next, "render_approved", {
          artifactSet: resultArtifact,
        });
      },
      field,
      /exact artifact promotion/u,
    );
  }
});

test("real Convex completion store binds every publication field to the active publish attempt", async () => {
  const scenario = publishCompletionScenario();
  const forgeries = {
    extra: (next) => { next.publication.extra = "forged"; },
    provider: (next) => { next.publication.provider = "attacker"; },
    revisionId: (next) => { next.publication.revisionId = "forged-revision"; },
    stableUrl: (next) => { next.publication.stableUrl = "https://attacker.example.test"; },
    artifactManifestDigest: (next) => { next.publication.artifactManifestDigest = "b".repeat(64); },
    providerReceiptId: (next) => { next.publication.providerReceiptId = "dpl_forged_nonempty"; },
    idempotencyKey: (next) => { next.publication.idempotencyKey = "bb_" + "c".repeat(64); },
    operationsCommandId: (next) => { next.publication.operationsCommandId = "command_attacker_publish"; },
    status: (next) => { next.publication.status = "pending"; },
  };
  for (const [field, forge] of Object.entries(forgeries)) {
    await assertForgedReplacementRejected(
      scenario,
      (next) => {
        forge(next);
        const {
          provider,
          revisionId: publishedRevision,
          stableUrl,
          artifactManifestDigest,
          providerReceiptId,
        } = next.publication;
        rebindStageCompletionDigest(scenario.current, next, "publish", {
          publication: {
            provider,
            revisionId: publishedRevision,
            stableUrl,
            artifactManifestDigest,
            providerReceiptId,
          },
        });
      },
      field,
      /canonical transition evidence|exact publication result/u,
    );
  }
});

test("real Convex completion store binds every delivery field to the active delivery attempt", async () => {
  const scenario = deliveryCompletionScenario();
  const forgeries = {
    extra: (next) => { next.deliveryAttempts.at(-1).extra = "forged"; },
    provider: (next) => { next.deliveryAttempts.at(-1).provider = "attacker"; },
    revisionId: (next) => { next.deliveryAttempts.at(-1).revisionId = "forged-revision"; },
    providerMessageId: (next) => {
      next.deliveryAttempts.at(-1).providerMessageId = "email_forged_nonempty";
    },
    idempotencyKey: (next) => { next.deliveryAttempts.at(-1).idempotencyKey = "bb_" + "c".repeat(64); },
    operationsCommandId: (next) => {
      next.deliveryAttempts.at(-1).operationsCommandId = "command_attacker_deliver";
    },
    targetRef: (next) => { next.deliveryAttempts.at(-1).targetRef = "resend:attacker"; },
    status: (next) => { next.deliveryAttempts.at(-1).status = "delivered"; },
    deliveredAt: (next) => { next.deliveryAttempts.at(-1).deliveredAt = next.updatedAt; },
    lastOutcome: (next) => {
      next.deliveryAttempts.at(-1).lastOutcome = { outcome: "delivered" };
    },
  };
  for (const [field, forge] of Object.entries(forgeries)) {
    await assertForgedReplacementRejected(
      scenario,
      (next) => {
        forge(next);
        const { provider, revisionId: deliveredRevision, providerMessageId } = next.deliveryAttempts.at(-1);
        rebindStageCompletionDigest(scenario.current, next, "deliver", {
          delivery: { provider, revisionId: deliveredRevision, providerMessageId },
        });
      },
      field,
      /canonical transition evidence|exact delivery result/u,
    );
  }
});

test("real Convex completion store rejects every unrelated mutable aggregate field across transitions", async () => {
  const forgeries = {
    artifactSets: (next) => { next.artifactSets.push({ forged: true }); },
    deliveryAttempts: (next) => { next.deliveryAttempts.push({ forged: true }); },
    publication: (next) => {
      next.publication = next.publication ? null : { forged: true };
    },
    publishedRevisionId: (next) => {
      next.publishedRevisionId = next.publishedRevisionId ? null : "forged-revision";
    },
    retry: (next) => {
      next.retry = next.retry ? null : { stage: "publish", availableAt: "2099-01-01T00:00:00.000Z" };
    },
    reviewDecisions: (next) => { next.reviewDecisions.push({ forged: true }); },
    stageAttempts: (next) => { next.stageAttempts.push({ forged: true }); },
  };
  for (const [transition, scenario] of exactBoundaryScenarios()) {
    for (const [field, forge] of Object.entries(forgeries)) {
      if (scenario.owned.has(field)) continue;
      await assertForgedReplacementRejected(
        scenario,
        forge,
        `${transition}: ${field}`,
        /exact transition mutation boundary/u,
      );
    }
  }
});

test("real Convex completion store binds retry stage and timing to the failed attempt", async () => {
  const [, scenario] = exactBoundaryScenarios().find(([name]) => name === "retry resume");
  const forgeries = {
    stage: (next) => {
      next.state = "publish_ready";
      next.events.at(-1).state = "publish_ready";
    },
    timing: (next) => {
      next.updatedAt = "2026-09-08T10:02:30.000Z";
      next.events.at(-1).at = next.updatedAt;
    },
  };
  for (const [field, forge] of Object.entries(forgeries)) {
    await assertForgedReplacementRejected(
      scenario,
      forge,
      field,
      /canonical transition evidence|exact retry transition/u,
    );
  }
});

test("real Convex completion store rejects non-monotonic transition timestamps", async () => {
  const [, scenario] = exactBoundaryScenarios().find(([name]) => name === "render claim");
  await assertForgedReplacementRejected(
    scenario,
    (next) => {
      next.updatedAt = "2026-09-08T09:59:00.000Z";
      next.events.at(-1).at = next.updatedAt;
      next.stageAttempts.at(-1).startedAt = next.updatedAt;
      next.stageAttempts.at(-1).leaseExpiresAt = "2026-09-08T10:04:00.000Z";
    },
    "updatedAt",
    /monotonic timestamp/u,
  );
});

test("real Convex completion store binds the delivery target digest at claim time", async () => {
  const [, scenario] = exactBoundaryScenarios().find(([name]) => name === "delivery claim");
  await assertForgedReplacementRejected(
    scenario,
    (next) => {
      const attempt = next.stageAttempts.at(-1);
      attempt.operationBinding.targetDigest = "b".repeat(64);
      const event = next.events.at(-1);
      event.commandDigest = commandReplayDigest("stage_claimed", {
        commandId: event.commandId,
        stage: attempt.stage,
        leaseMs: 300_000,
        maxAttempts: 2,
        operationBinding: attempt.operationBinding,
        operationsCommandId: attempt.operationsCommandId,
      });
    },
    "targetDigest",
    /synthetic stage authority/u,
  );
});

test("real Convex completion store rejects every mutable field in a forged replay replacement", async () => {
  const renderSuccess = renderCompletionScenario();
  const replay = structuredClone(renderSuccess.current);
  replay.version += 1;
  replay.updatedAt = "2026-09-08T10:02:00.000Z";
  replay.events.push({ ...structuredClone(replay.events.at(-1)), at: replay.updatedAt });
  const scenario = {
    current: renderSuccess.current,
    next: replay,
    authority: renderSuccess.authority,
  };
  const forgeries = {
    artifactSets: (next) => { next.artifactSets.push({ forged: true }); },
    deliveryAttempts: (next) => { next.deliveryAttempts.push({ forged: true }); },
    publication: (next) => { next.publication = { forged: true }; },
    publishedRevisionId: (next) => { next.publishedRevisionId = "forged-revision"; },
    retry: (next) => { next.retry = { stage: "publish", availableAt: next.updatedAt }; },
    reviewDecisions: (next) => { next.reviewDecisions.push({ forged: true }); },
    stageAttempts: (next) => { next.stageAttempts.push({ forged: true }); },
    state: (next) => { next.state = "failed"; },
    updatedAt: (next) => { next.updatedAt = "2099-01-01T00:00:00.000Z"; },
    version: (next) => { next.version += 1; },
    events: (next) => { next.events.push({ forged: true }); },
  };
  for (const [field, forge] of Object.entries(forgeries)) {
    await assertForgedReplacementRejected(
      scenario,
      forge,
      field,
      /active matching command claim|canonical transition evidence|synthetic stage authority/u,
    );
  }
});

test("real Convex completion store rejects forged stage lease, effect, and failure provenance", async () => {
  const success = renderCompletionScenario();
  const failure = exactBoundaryScenarios().find(([name]) => name === "render failure")[1];
  const forgeries = [
    ["expired lease", success, (next) => {
      next.updatedAt = "2026-09-08T10:07:00.000Z";
      next.events.at(-1).at = next.updatedAt;
      next.stageAttempts.at(-1).completedAt = next.updatedAt;
    }],
    ["effectStartedAt", success, (next) => {
      next.stageAttempts.at(-1).effectStartedAt = "2026-09-08T10:01:30.000Z";
    }],
    ["attempt shape", success, (next) => {
      next.stageAttempts.at(-1).extra = "forged";
    }],
    ["failure reason", failure, (next) => {
      const attempt = next.stageAttempts.at(-1);
      attempt.failure.reasonCode = "resend_send_failed";
      const event = next.events.at(-1);
      event.commandId = `fail:${attempt.attemptId}:${attempt.failure.reasonCode}`;
      event.eventId = `event_${createHash("sha256")
        .update(`${jobId}\0${event.commandId}`)
        .digest("hex")
        .slice(0, 24)}`;
      event.commandDigest = commandReplayDigest("stage_failed", {
        commandId: event.commandId,
        stage: attempt.stage,
        leaseToken: failure.current.stageAttempts.at(-1).leaseToken,
        retryable: attempt.failure.retryable,
        reasonCode: attempt.failure.reasonCode,
      });
    }],
  ];
  for (const [label, scenario, forge] of forgeries) {
    await assertForgedReplacementRejected(scenario, forge, label, /synthetic stage authority/u);
  }
});
