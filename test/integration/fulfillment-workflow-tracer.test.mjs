import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandApproveNarration,
  commandApproveReview,
  commandDeploy,
  commandPrepareReview,
  commandRender,
  commandSend,
  commandStatus,
  commandTts,
} from "../../scripts/lib/commands.mjs";
import {
  EDITORIAL_POLICY_VERSION,
  createFulfillmentOrchestrator,
} from "../../src/fulfillment/job-orchestrator.mjs";
import { createLocalCommandStageHandlers } from "../../src/fulfillment/local-command-stage-handlers.mjs";
import { createLocalGenerationWorkspace } from "../../src/fulfillment/local-generation-workspace.mjs";
import { createLocalTestFulfillmentStore } from "../../src/persistence/local-test-fulfillment-store.mjs";

const APPROVAL_KEY = "synthetic-fixture-approval-key-material-not-for-production";
const DELIVERY_CONFIRMATION_KEY = "synthetic-delivery-verifier-key-not-for-production";
const SYNTHETIC_MP3 = Buffer.from(
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMAAAAAAAAAAAAAAA/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAACQAAA2AAVVVVVVVVVVVVVVVqampqampqampqaoCAgICAgICAgICAlZWVlZWVlZWVlZWqqqqqqqqqqqqqqsDAwMDAwMDAwMDA1dXV1dXV1dXV1dXq6urq6urq6urq6v//////////////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQCYAAAAAAAAANgUN+kLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxLEAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
  "base64",
);

const STAGES = ["prepare_review", "render_approved", "generate_tts", "publish", "deliver"];

function retryPolicy() {
  return {
    leaseMsByStage: Object.fromEntries(STAGES.map((stage) => [stage, 300_000])),
    maxAttemptsByStage: Object.fromEntries(STAGES.map((stage) => [stage, 3])),
    backoffMsByStage: Object.fromEntries(STAGES.map((stage) => [stage, [1_000, 1_000, 1_000]])),
  };
}

function retryableError(reasonCode) {
  const error = new Error(reasonCode);
  error.retryable = true;
  error.reasonCode = reasonCode;
  return error;
}

function pickDigests(artifactSet) {
  return {
    pageDigest: artifactSet.pageDigest,
    transcriptDigest: artifactSet.transcriptDigest,
    assetManifestDigest: artifactSet.assetManifestDigest,
  };
}

async function captureConsole(action) {
  const original = console.log;
  console.log = () => {};
  try {
    return await action();
  } finally {
    console.log = original;
  }
}

test("the TEST-A tracer persists one guarded synthetic order through confirmed delivery", async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-fulfillment-tracer-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalApprovalKey = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  const ttsRequests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.openai.com/v1/audio/speech");
    ttsRequests.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      arrayBuffer: async () => Uint8Array.from(SYNTHETIC_MP3).buffer,
    };
  };
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = APPROVAL_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalApprovalKey === undefined) delete process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
    else process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = originalApprovalKey;
  });

  const workspace = createLocalGenerationWorkspace({ rootPath: path.join(rootPath, "generation") });
  const intake = JSON.parse(await readFile(
    new URL("../../data/examples/amal/intake.json", import.meta.url),
    "utf8",
  ));
  intake.customer.email = "synthetic-fulfillment@example.test";
  intake.notes.specificDemands = "";
  const intakeDigest = createHash("sha256").update(JSON.stringify(intake)).digest("hex");
  const jobId = "job_fulfillment_tracer_001";
  const jobInput = {
    jobId,
    environment: "test",
    product: "announcement-page",
    intakeDigest,
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId,
      intakeDigest,
    },
    narrationRequired: true,
  };
  await workspace.persistJobInput({ jobId, intakeDigest, intake });

  let prepareCalls = 0;
  let deliveryVerifierCalls = 0;
  const commands = {
    async prepareReview(args) {
      prepareCalls += 1;
      if (prepareCalls === 1) throw retryableError("synthetic_prepare_interruption");
      return captureConsole(() => commandPrepareReview(args));
    },
    render: (args) => captureConsole(() => commandRender(args)),
    tts: (args) => captureConsole(() => commandTts(args)),
    deploy: (args) => captureConsole(() => commandDeploy(args)),
    send: (args) => captureConsole(() => commandSend(args)),
    status: (args) => captureConsole(() => commandStatus(args)),
  };
  const handlers = {
    ...createLocalCommandStageHandlers({
      commands,
      resolveJobPaths: workspace.resolveJobPaths,
      collectArtifactSet: workspace.collectArtifactSet,
      cleanupStageOutput: workspace.cleanupStageOutput,
    }),
    async verify_delivery_confirmation({ job, confirmation }) {
      deliveryVerifierCalls += 1;
      const { verificationToken, ...verified } = confirmation;
      const expectedToken = createHmac("sha256", DELIVERY_CONFIRMATION_KEY)
        .update([
          job.jobId,
          confirmation.providerMessageId,
          confirmation.outcome,
          confirmation.recordedAt,
        ].join(":"))
        .digest();
      const suppliedToken = Buffer.from(verificationToken ?? "", "hex");
      if (
        confirmation.providerMessageId !== job.delivery?.providerMessageId
        || suppliedToken.length !== expectedToken.length
        || !timingSafeEqual(suppliedToken, expectedToken)
      ) {
        throw new Error("Trusted confirmation lacks valid independent provider evidence.");
      }
      return verified;
    },
  };

  const storePath = path.join(rootPath, "fulfillment.json");
  let now = "2026-08-11T00:00:00.000Z";
  const makeOrchestrator = () => createFulfillmentOrchestrator({
    store: createLocalTestFulfillmentStore({ filePath: storePath }),
    handlers,
    clock: () => now,
    tokenFactory: (label) => `${label}:synthetic-lease`,
    retryPolicy: retryPolicy(),
  });
  let orchestrator = makeOrchestrator();
  const observedStates = [];

  let status = await orchestrator.createJob(jobInput, { commandId: "create-synthetic-order" });
  observedStates.push(status.state);
  assert.equal(status.state, "awaiting_payment");
  assert.equal(await orchestrator.runNext(jobId), null);
  await assert.rejects(
    () => orchestrator.queueDelivery(jobId, { commandId: "forbidden-delivery-before-payment" }),
    /published exact revision/i,
  );

  status = await orchestrator.recordPayment(jobId, {
    commandId: "record-synthetic-payment",
    providerEventId: "evt_test_fulfillment_tracer_001",
    providerPaymentId: "pi_test_fulfillment_tracer_001",
    correlation: jobInput.paymentCorrelation,
    recordedAt: now,
  });
  observedStates.push(status.state);
  assert.equal(status.state, "generation_queued");

  status = await orchestrator.runNext(jobId);
  observedStates.push(status.state);
  assert.equal(status.state, "retry_wait");
  assert.deepEqual(status.stageAttempts.at(-1).failure, {
    retryable: true,
    reasonCode: "synthetic_prepare_interruption",
  });
  assert.equal(await orchestrator.runNext(jobId), null);

  now = "2026-08-11T00:00:02.000Z";
  orchestrator = makeOrchestrator();
  status = await orchestrator.runNext(jobId);
  observedStates.push(status.state);
  assert.equal(status.state, "content_review_required");
  assert.equal(status.currentRevisionId, "r1");
  assert.equal(prepareCalls, 2);
  assert.equal(await orchestrator.runNext(jobId), null);
  await assert.rejects(
    () => orchestrator.queueDelivery(jobId, { commandId: "forbidden-delivery-before-content-review" }),
    /published exact revision/i,
  );

  const storeAfterGeneration = createLocalTestFulfillmentStore({ filePath: storePath });
  const generated = await storeAfterGeneration.getJob(jobId);
  const privateArtifacts = generated.artifactSets.at(-1);
  assert.equal(privateArtifacts.kind, "private_review");
  assert.equal(privateArtifacts.files.length > 3, true);
  const paths = await workspace.resolveJobPaths(status);
  assert.deepEqual(
    await workspace.collectArtifactSet({ kind: "private_review", paths }),
    {
      kind: privateArtifacts.kind,
      revisionId: privateArtifacts.revisionId,
      ...pickDigests(privateArtifacts),
      manifestRef: privateArtifacts.manifestRef,
      files: privateArtifacts.files,
    },
  );

  const contentReview = JSON.parse(await readFile(path.join(paths.reviewRoot, "review.json"), "utf8"));
  await captureConsole(() => commandApproveReview({
    review: path.join(paths.reviewRoot, "review.json"),
    output: paths.approvedRoot,
    reviewer: "synthetic-qualified-reviewer",
    ...(contentReview.review.requiredReasons.length > 0
      ? { acknowledge: contentReview.review.requiredReasons.join(",") }
      : {}),
  }));

  now = "2026-08-11T00:00:03.000Z";
  status = await orchestrator.recordReviewDecision(jobId, {
    commandId: "approve-synthetic-content",
    decisionType: "content",
    revisionId: "r1",
    outcome: "approved",
    policyVersion: EDITORIAL_POLICY_VERSION,
    rubricVersion: "bebebonjour-content-rubric-v1",
    reviewer: {
      id: "synthetic-qualified-reviewer",
      role: "qualified-human-reviewer",
      competencies: ["arabic", "religious-content", "editorial"],
    },
    decidedAt: now,
    artifactDigests: pickDigests(privateArtifacts),
    reasons: ["synthetic content approved after local browser review"],
  });
  observedStates.push(status.state);
  assert.equal(status.state, "render_queued");

  now = "2026-08-11T00:00:04.000Z";
  status = await orchestrator.runNext(jobId);
  observedStates.push(status.state);
  assert.equal(status.state, "tts_queued");
  status = await orchestrator.runNext(jobId);
  observedStates.push(status.state);
  assert.equal(status.state, "narration_review_required");
  await assert.rejects(
    () => orchestrator.queueDelivery(jobId, { commandId: "forbidden-delivery-before-narration-review" }),
    /published exact revision/i,
  );

  const generatedNarration = await createLocalTestFulfillmentStore({ filePath: storePath }).getJob(jobId);
  const narrationArtifacts = generatedNarration.artifactSets.at(-1);
  assert.equal(narrationArtifacts.kind, "narration_review");
  assert.equal(ttsRequests.length > 0, true);
  assert.equal(ttsRequests.every(({ url }) => url === "https://api.openai.com/v1/audio/speech"), true);

  await captureConsole(() => commandApproveNarration({
    review: path.join(paths.narrationReviewRoot, "review.json"),
    prepared: paths.preparedRoot,
    output: paths.finalRoot,
    reviewer: "synthetic-qualified-reviewer",
    acknowledge: intake.languages.join(","),
  }));

  now = "2026-08-11T00:00:05.000Z";
  status = await orchestrator.recordReviewDecision(jobId, {
    commandId: "approve-synthetic-narration",
    decisionType: "narration",
    revisionId: "r1",
    outcome: "approved",
    policyVersion: EDITORIAL_POLICY_VERSION,
    rubricVersion: "bebebonjour-narration-rubric-v1",
    reviewer: {
      id: "synthetic-qualified-reviewer",
      role: "qualified-human-reviewer",
      competencies: ["arabic", "french", "narration", "editorial"],
    },
    decidedAt: now,
    artifactDigests: pickDigests(narrationArtifacts),
    reasons: ["synthetic narration bytes approved after local listening review"],
  });
  observedStates.push(status.state);
  assert.equal(status.state, "publish_ready");

  now = "2026-08-11T00:00:06.000Z";
  status = await orchestrator.runNext(jobId);
  observedStates.push(status.state);
  assert.equal(status.state, "published");
  assert.equal(status.publication.provider, "vercel-dry-run");
  assert.equal(status.publication.revisionId, "r1");
  assert.equal(status.publication.stableUrl, `https://example.invalid/announcements/${jobId}`);

  status = await orchestrator.queueDelivery(jobId, { commandId: "queue-synthetic-delivery" });
  observedStates.push(status.state);
  assert.equal(status.state, "delivery_queued");
  now = "2026-08-11T00:00:07.000Z";
  status = await orchestrator.runNext(jobId);
  observedStates.push(status.state);
  assert.equal(status.state, "sent");
  assert.equal(status.delivery.provider, "console-dry-run");
  await assert.rejects(
    () => orchestrator.confirmDelivery(jobId, {
      commandId: "forbidden-unauthenticated-confirmation",
      providerMessageId: status.delivery.providerMessageId,
      outcome: "delivered",
      recordedAt: now,
      verificationToken: "00".repeat(32),
    }),
    /trusted confirmation lacks valid independent provider evidence/i,
  );
  assert.equal(deliveryVerifierCalls, 1);
  assert.equal((await orchestrator.status(jobId)).state, "sent");

  now = "2026-08-11T00:00:08.000Z";
  const verificationToken = createHmac("sha256", DELIVERY_CONFIRMATION_KEY)
    .update([jobId, status.delivery.providerMessageId, "delivered", now].join(":"))
    .digest("hex");
  status = await orchestrator.confirmDelivery(jobId, {
    commandId: "confirm-synthetic-delivery",
    providerMessageId: status.delivery.providerMessageId,
    outcome: "delivered",
    recordedAt: now,
    verificationToken,
  });
  observedStates.push(status.state);
  assert.equal(status.state, "complete");
  assert.equal(status.delivery.status, "delivered");
  assert.equal(deliveryVerifierCalls, 2);
  assert.doesNotMatch(JSON.stringify(status), /verificationToken|synthetic-delivery-verifier-key/);

  const reopened = createFulfillmentOrchestrator({
    store: createLocalTestFulfillmentStore({ filePath: storePath }),
    handlers: {},
    clock: () => "2026-08-11T00:00:09.000Z",
    tokenFactory: (label) => `${label}:reopened-lease`,
    retryPolicy: {
      leaseMsByStage: {},
      maxAttemptsByStage: {},
      backoffMsByStage: {},
    },
  });
  assert.deepEqual(await reopened.status(jobId), status);
  assert.deepEqual(observedStates, [
    "awaiting_payment",
    "generation_queued",
    "retry_wait",
    "content_review_required",
    "render_queued",
    "tts_queued",
    "narration_review_required",
    "publish_ready",
    "published",
    "delivery_queued",
    "sent",
    "complete",
  ]);
  assert.deepEqual(status.stageAttempts.map(({ stage }) => stage), [
    "prepare_review",
    "prepare_review",
    "render_approved",
    "generate_tts",
    "publish",
    "deliver",
  ]);
  assert.equal(new Set(status.stageAttempts
    .filter(({ stage }) => stage === "prepare_review")
    .map(({ idempotencyKey }) => idempotencyKey)).size, 1);

  const persistedText = await readFile(storePath, "utf8");
  assert.doesNotMatch(persistedText, /synthetic-fulfillment@example\.test|Amal/);
  assert.doesNotMatch(persistedText, /verificationToken|synthetic-delivery-verifier-key/);
  assert.match(persistedText, /"state": "complete"/);
});
