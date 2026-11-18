import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandApproveReview,
  commandPrepareReview,
  commandRender,
} from "../../scripts/lib/commands.mjs";
import { createLocalCommandStageHandlers } from "../../src/fulfillment/local-command-stage-handlers.mjs";
import { createLocalGenerationWorkspace } from "../../src/fulfillment/local-generation-workspace.mjs";
import {
  EDITORIAL_POLICY_VERSION,
  createFulfillmentOrchestrator,
} from "../../src/fulfillment/job-orchestrator.mjs";
import { createLocalTestFulfillmentStore } from "../../src/persistence/local-test-fulfillment-store.mjs";

const INTAKE_DIGEST = "a".repeat(64);
const JOB = Object.freeze({
  jobId: "job_workspace_001",
  state: "generating",
  currentRevisionId: null,
  intakeDigest: INTAKE_DIGEST,
});

async function fixture(t) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-workspace-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const workspace = createLocalGenerationWorkspace({ rootPath });
  await workspace.persistJobInput({
    jobId: JOB.jobId,
    intakeDigest: INTAKE_DIGEST,
    intake: {
      schemaVersion: "1.0",
      requestId: "req_workspace_001",
      submittedAt: "2026-08-11T00:00:00Z",
      customer: { email: "synthetic@example.invalid" },
      baby: { firstName: "Amal Test", nameArabic: "أمل", gender: "girl" },
      languages: ["ar"],
      voicePreference: { gender: "female" },
      notes: { specificDemands: "", religiousReferencesHint: [] },
    },
  });
  return { rootPath, workspace };
}

async function writePrivateReview(paths, suffix = "") {
  const artifactRoot = path.join(paths.reviewRoot, "artifacts", "current");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, "page.json"), `{"page":"stable${suffix}"}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "transcript.json"), "{\"tracks\":{}}\n", "utf8");
  await writeFile(path.join(paths.reviewRoot, "review.json"), "{\"state\":\"review_required\"}\n", "utf8");
}

test("local generation workspace derives revision paths from persisted inputs and emits stable manifests", async (t) => {
  const { workspace } = await fixture(t);
  const paths = await workspace.resolveJobPaths(JOB);
  assert.deepEqual(paths.revision, {
    revisionId: "r1",
    ordinal: 1,
    inputDigest: INTAKE_DIGEST,
  });
  assert.deepEqual(JSON.parse(await readFile(paths.intakePath, "utf8")).baby, {
    firstName: "Amal Test",
    nameArabic: "أمل",
    gender: "girl",
  });

  await writePrivateReview(paths);
  const first = await workspace.collectArtifactSet({ kind: "private_review", paths });
  const replay = await workspace.collectArtifactSet({ kind: "private_review", paths });

  assert.deepEqual(replay, first);
  assert.equal(first.kind, "private_review");
  assert.equal(first.revisionId, "r1");
  assert.match(first.pageDigest, /^[a-f0-9]{64}$/);
  assert.match(first.transcriptDigest, /^[a-f0-9]{64}$/);
  assert.match(first.assetManifestDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.files.map((file) => file.path), [
    "artifacts/current/page.json",
    "artifacts/current/transcript.json",
    "review.json",
  ]);

  await writeFile(path.join(paths.reviewRoot, "review.json"), "{\"state\":\"changed\"}\n", "utf8");
  await assert.rejects(
    workspace.collectArtifactSet({ kind: "private_review", paths }),
    /diverge from the persisted manifest/i,
  );
});

test("artifact collection rejects an escaped manifest root before writing", async (t) => {
  const { rootPath, workspace } = await fixture(t);
  const paths = await workspace.resolveJobPaths(JOB);
  await writePrivateReview(paths);
  const escapedRoot = `${rootPath}-escaped-manifests`;
  t.after(() => rm(escapedRoot, { recursive: true, force: true }));

  await assert.rejects(
    workspace.collectArtifactSet({
      kind: "private_review",
      paths: { ...paths, manifestRoot: escapedRoot },
    }),
    /must be a child of the local workspace root/i,
  );
  await assert.rejects(
    readFile(path.join(escapedRoot, "private_review.json")),
    { code: "ENOENT" },
  );
});

test("generation handlers reuse complete artifacts and clean retryable partial output", async (t) => {
  const { workspace } = await fixture(t);
  let calls = 0;
  let failOnce = true;
  const prepareReview = async ({ output }) => {
    calls += 1;
    const paths = await workspace.resolveJobPaths(JOB);
    assert.equal(output, paths.reviewRoot);
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "partial.txt"), "partial\n", "utf8");
    if (failOnce) {
      failOnce = false;
      const error = new Error("synthetic transient compose failure");
      error.retryable = true;
      error.reasonCode = "synthetic_compose_failure";
      throw error;
    }
    await rm(path.join(output, "partial.txt"));
    await writePrivateReview(paths);
  };
  const handlers = createLocalCommandStageHandlers({
    commands: {
      prepareReview,
      render: async () => {},
      tts: async () => {},
      deploy: async () => {},
      send: async () => {},
      status: async () => {},
    },
    resolveJobPaths: workspace.resolveJobPaths,
    collectArtifactSet: workspace.collectArtifactSet,
    cleanupStageOutput: workspace.cleanupStageOutput,
  });
  const context = { job: JOB, idempotencyKey: "bb_workspace_key" };

  await assert.rejects(handlers.prepare_review(context), /synthetic transient compose failure/);
  const paths = await workspace.resolveJobPaths(JOB);
  await assert.rejects(readFile(path.join(paths.reviewRoot, "partial.txt")), { code: "ENOENT" });

  const completed = await handlers.prepare_review(context);
  const replay = await handlers.prepare_review(context);
  assert.deepEqual(replay, completed);
  assert.equal(calls, 2);
});

test("persisted orchestration drives compose, render, and retryable test-mode TTS", async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-orchestration-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const workspace = createLocalGenerationWorkspace({ rootPath: path.join(rootPath, "generation") });
  const intake = JSON.parse(await readFile(
    new URL("../../data/examples/amal/intake.json", import.meta.url),
    "utf8",
  ));
  intake.customer.email = "synthetic-amal@example.invalid";
  intake.notes.specificDemands = "";
  const intakeDigest = createHash("sha256").update(JSON.stringify(intake)).digest("hex");
  const jobId = "job_generation_integration_001";
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
  let ttsCalls = 0;
  let failPrepare = true;
  let failTts = true;
  const commands = {
    async prepareReview(args) {
      prepareCalls += 1;
      if (failPrepare) {
        failPrepare = false;
        throw retryableError("synthetic_prepare_failure");
      }
      return captureConsole(() => commandPrepareReview(args));
    },
    async render(args) {
      return captureConsole(() => commandRender(args));
    },
    async tts(args) {
      ttsCalls += 1;
      await mkdir(args.output, { recursive: true });
      await writeFile(path.join(args.output, "partial.txt"), "partial\n", "utf8");
      if (failTts) {
        failTts = false;
        throw retryableError("synthetic_tts_failure");
      }
      await rm(path.join(args.output, "partial.txt"));
      await writeDeterministicTestNarration(args);
    },
    deploy: async () => {},
    send: async () => {},
    status: async () => {},
  };
  const handlers = createLocalCommandStageHandlers({
    commands,
    resolveJobPaths: workspace.resolveJobPaths,
    collectArtifactSet: workspace.collectArtifactSet,
    cleanupStageOutput: workspace.cleanupStageOutput,
  });
  const storePath = path.join(rootPath, "fulfillment.json");
  let now = "2026-08-11T00:00:00.000Z";
  const makeOrchestrator = () => createFulfillmentOrchestrator({
    store: createLocalTestFulfillmentStore({ filePath: storePath }),
    handlers: {
      ...handlers,
      verify_review_decision: async ({ decision }) => decision,
    },
    clock: () => now,
    tokenFactory: (label) => `${label}:lease`,
    retryPolicy: retryPolicy(),
  });

  let orchestrator = makeOrchestrator();
  await orchestrator.createJob(jobInput, { commandId: "create-generation-job" });
  await orchestrator.recordPayment(jobId, {
    commandId: "record-generation-payment",
    providerEventId: "evt_test_generation_001",
    providerPaymentId: "pi_test_generation_001",
    correlation: jobInput.paymentCorrelation,
    recordedAt: now,
  });
  let status = await orchestrator.runNext(jobId);
  assert.equal(status.state, "retry_wait");
  assert.equal(status.stageAttempts.at(-1).failure.reasonCode, "synthetic_prepare_failure");

  now = "2026-08-11T00:00:02.000Z";
  orchestrator = makeOrchestrator();
  status = await orchestrator.runNext(jobId);
  assert.equal(status.state, "content_review_required");
  assert.equal(status.currentRevisionId, "r1");
  assert.equal(prepareCalls, 2);

  const aggregateAfterCompose = await createLocalTestFulfillmentStore({ filePath: storePath }).getJob(jobId);
  const privateArtifacts = aggregateAfterCompose.artifactSets.at(-1);
  assert.equal(privateArtifacts.kind, "private_review");
  assert.equal(privateArtifacts.files.length > 3, true);
  assert.equal(aggregateAfterCompose.stageAttempts.at(-1).status, "completed");
  const paths = await workspace.resolveJobPaths(status);
  const review = JSON.parse(await readFile(path.join(paths.reviewRoot, "review.json"), "utf8"));
  await withApprovalKey(() => captureConsole(() => commandApproveReview({
    review: path.join(paths.reviewRoot, "review.json"),
    output: paths.approvedRoot,
    reviewer: "synthetic-qualified-reviewer",
    ...(review.review.requiredReasons.length > 0
      ? { acknowledge: review.review.requiredReasons.join(",") }
      : {}),
  })));

  now = "2026-08-11T00:00:03.000Z";
  await orchestrator.recordReviewDecision(jobId, {
    commandId: "approve-generation-content",
    decisionType: "content",
    revisionId: "r1",
    outcome: "approved",
    policyVersion: EDITORIAL_POLICY_VERSION,
    rubricVersion: "synthetic-content-rubric-v1",
    reviewer: {
      id: "synthetic-qualified-reviewer",
      role: "qualified-human-reviewer",
      competencies: ["arabic", "editorial"],
    },
    decidedAt: now,
    artifactDigests: pickDigests(privateArtifacts),
    reasons: ["synthetic Amal-like content approved for local verification"],
  });

  now = "2026-08-11T00:00:04.000Z";
  await withApprovalKey(async () => {
    status = await orchestrator.runNext(jobId);
  });
  assert.equal(status.state, "tts_queued");
  const aggregateAfterRender = await createLocalTestFulfillmentStore({ filePath: storePath }).getJob(jobId);
  const preparedArtifacts = aggregateAfterRender.artifactSets.at(-1);
  assert.equal(preparedArtifacts.kind, "prepared_bundle");
  assert.equal(preparedArtifacts.pageDigest, createHash("sha256").update(
    await readFile(paths.approvedPagePath),
  ).digest("hex"));

  now = "2026-08-11T00:00:05.000Z";
  status = await orchestrator.runNext(jobId);
  assert.equal(status.state, "retry_wait");
  assert.equal(status.stageAttempts.at(-1).failure.reasonCode, "synthetic_tts_failure");

  now = "2026-08-11T00:00:07.000Z";
  orchestrator = makeOrchestrator();
  status = await orchestrator.runNext(jobId);
  assert.equal(status.state, "narration_review_required");
  assert.equal(ttsCalls, 2);
  const ttsAttempts = status.stageAttempts.filter((attempt) => attempt.stage === "generate_tts");
  assert.equal(ttsAttempts.length, 2);
  assert.equal(ttsAttempts[0].idempotencyKey, ttsAttempts[1].idempotencyKey);

  const finalAggregate = await createLocalTestFulfillmentStore({ filePath: storePath }).getJob(jobId);
  const narrationArtifacts = finalAggregate.artifactSets.at(-1);
  assert.equal(narrationArtifacts.kind, "narration_review");
  assert.equal(narrationArtifacts.pageDigest, preparedArtifacts.pageDigest);
  assert.match(narrationArtifacts.transcriptDigest, /^[a-f0-9]{64}$/);
  assert.match(narrationArtifacts.assetManifestDigest, /^[a-f0-9]{64}$/);
  const replay = await handlers.generate_tts({
    job: status,
    idempotencyKey: ttsAttempts.at(-1).idempotencyKey,
  });
  assert.deepEqual(replay.artifactSet, {
    kind: narrationArtifacts.kind,
    revisionId: narrationArtifacts.revisionId,
    pageDigest: narrationArtifacts.pageDigest,
    transcriptDigest: narrationArtifacts.transcriptDigest,
    assetManifestDigest: narrationArtifacts.assetManifestDigest,
    manifestRef: narrationArtifacts.manifestRef,
    files: narrationArtifacts.files,
  });
  assert.equal(ttsCalls, 2);
});

function retryableError(reasonCode) {
  const error = new Error(reasonCode);
  error.retryable = true;
  error.reasonCode = reasonCode;
  return error;
}

function retryPolicy() {
  const stages = ["prepare_review", "render_approved", "generate_tts", "publish", "deliver"];
  return {
    leaseMsByStage: Object.fromEntries(stages.map((stage) => [stage, 300_000])),
    maxAttemptsByStage: Object.fromEntries(stages.map((stage) => [stage, 3])),
    backoffMsByStage: Object.fromEntries(stages.map((stage) => [stage, [1_000, 1_000, 1_000]])),
  };
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

async function withApprovalKey(action) {
  const prior = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY =
    "synthetic-fixture-approval-key-material-not-for-production";
  try {
    return await action();
  } finally {
    if (prior === undefined) delete process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
    else process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = prior;
  }
}

async function writeDeterministicTestNarration(args) {
  const page = JSON.parse(await readFile(args.input, "utf8"));
  const transcriptSource = path.join(args.prepared, "deploy", page.slug, "transcript.json");
  const artifactsRoot = path.join(args.output, "artifacts");
  const audioRoot = path.join(artifactsRoot, "audio", "narration");
  const languages = args.lang === "all" ? page.languages : args.lang.split(",");
  for (const language of languages) {
    const languageRoot = path.join(audioRoot, language);
    await mkdir(languageRoot, { recursive: true });
    const files = [];
    for (const [index, section] of page.sectionOrder.entries()) {
      const filename = `${String(index + 1).padStart(2, "0")}-${section}.mp3`;
      await writeFile(
        path.join(languageRoot, filename),
        `synthetic-test-audio:${page.buildId}:${language}:${section}\n`,
        "utf8",
      );
      files.push({ index: index + 1, section, file: filename });
    }
    await writeFile(
      path.join(languageRoot, "manifest.json"),
      `${JSON.stringify({ schemaVersion: "1.0", language, files }, null, 2)}\n`,
      "utf8",
    );
  }
  await writeFile(
    path.join(artifactsRoot, "transcript.json"),
    await readFile(transcriptSource),
  );
  await writeFile(
    path.join(args.output, "review.json"),
    `${JSON.stringify({
      schemaVersion: "1.0",
      state: "narration_review_required",
      pageId: page.pageId,
      revision: page.pageRevision,
      generatedAt: "2026-08-11T00:00:00.000Z",
      languages,
    }, null, 2)}\n`,
    "utf8",
  );
}
