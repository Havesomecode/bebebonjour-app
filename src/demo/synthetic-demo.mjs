import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commandApproveReview } from "../../scripts/lib/commands.mjs";
import { createCustomerFlowService } from "../customer-flow/service.mjs";
import { createLocalPaymentGateway } from "../customer-flow/local-adapters.mjs";
import { createInMemoryCustomerFlowStore } from "../customer-flow/memory-store.mjs";
import { createLocalCommandStageHandlers } from "../fulfillment/local-command-stage-handlers.mjs";
import { createLocalGenerationWorkspace } from "../fulfillment/local-generation-workspace.mjs";
import {
  EDITORIAL_POLICY_VERSION,
  createFulfillmentOrchestrator,
} from "../fulfillment/job-orchestrator.mjs";
import { createLocalTestFulfillmentStore } from "../persistence/local-test-fulfillment-store.mjs";

const DEMO_APPROVAL_KEY = "bebebonjour-public-synthetic-demo-key-v1-000000000000000000000000";
const REVIEWED_AT = "2026-08-18T08:03:00.000Z";
const TIMELINE_COPY = Object.freeze({
  intake: {
    label: "Intake reçu",
    description: "Profil fictif validé par le contrat first-party TEST-A.",
  },
  checkout: {
    label: "Checkout simulé",
    description: "Session locale de 39 € créée, sans Stripe ni transaction.",
  },
  payment: {
    label: "Paiement confirmé",
    description: "Événement test corrélé au job canonique; aucun débit réel.",
  },
  generation: {
    label: "Brouillon généré",
    description: "Artefacts reproductibles produits par le générateur canonique.",
  },
  review: {
    label: "Révision éditoriale",
    description: "Contenu et artefacts locaux approuvés pour la révision exacte r1.",
  },
  publication: {
    label: "Publication simulée",
    description: "Slug statique conservé dans cet artefact; aucun déploiement externe.",
  },
  delivery: {
    label: "Livraison confirmée",
    description: "Accusé local déterministe; aucun e-mail ni appel Resend.",
  },
});
const PERSONAS = Object.freeze([
  Object.freeze({
    key: "amal",
    selectionId: "general-amal",
    email: "famille.amal@demo.test",
    firstName: "Amal",
    nameArabic: "أمل",
    gender: "girl",
    languages: Object.freeze(["fr", "ar"]),
  }),
  Object.freeze({
    key: "bayane",
    selectionId: "general-bayane",
    email: "famille.bayane@demo.test",
    firstName: "Bayane",
    nameArabic: "بَيَان",
    gender: "girl",
    languages: Object.freeze(["fr", "ar"]),
  }),
]);

export async function exportSyntheticDemo({ outputRoot }) {
  if (typeof outputRoot !== "string" || outputRoot.trim() === "") {
    throw new Error("A synthetic demo output root is required.");
  }
  const resolvedOutput = path.resolve(outputRoot);
  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(resolvedOutput, { recursive: true });

  const announcements = [];
  for (const persona of PERSONAS) {
    announcements.push(await buildAnnouncement(persona, resolvedOutput));
  }

  const manifest = {
    schemaVersion: "1.0",
    mode: "synthetic-demo",
    simulated: true,
    generatedAt: "2026-08-18T08:07:00.000Z",
    price: { amountMinor: 3900, currency: "EUR", display: "39 €" },
    safety: {
      inventedProfilesOnly: true,
      providersCalled: [],
      networkRequired: false,
      analytics: false,
      reset: "Reloads the first immutable canonical projection.",
    },
    announcements,
  };
  await writeFile(
    path.join(resolvedOutput, "workflow.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

async function buildAnnouncement(persona, outputRoot) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), `bebebonjour-demo-${persona.key}-`));
  try {
    return await buildInWorkspace(persona, outputRoot, workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function buildInWorkspace(persona, outputRoot, workspaceRoot) {
  const jobId = `job_demo_${persona.key}`;
  const intakeToken = `tok_demo_${persona.key}_private`;
  const customerStore = createInMemoryCustomerFlowStore();
  const generationStore = createLocalTestFulfillmentStore({
    filePath: path.join(workspaceRoot, "fulfillment.json"),
  });
  const workspace = createLocalGenerationWorkspace({ rootPath: workspaceRoot });
  const handlers = createLocalCommandStageHandlers({
    commands: {
      tts: writeDeterministicNarrationArtifacts,
      deploy: async () => {},
      send: async () => {},
      status: async () => {},
    },
    resolveJobPaths: workspace.resolveJobPaths,
    collectArtifactSet: workspace.collectArtifactSet,
    cleanupStageOutput: workspace.cleanupStageOutput,
  });
  let stageFailure = null;
  const observedHandlers = Object.fromEntries(Object.entries(handlers).map(([stage, handler]) => [
    stage,
    async (context) => {
      try {
        return await handler(context);
      } catch (error) {
        stageFailure = error;
        throw error;
      }
    },
  ]));
  const observedStore = {
    ...generationStore,
    async completeStage(...args) {
      try {
        return await generationStore.completeStage(...args);
      } catch (error) {
        stageFailure = error;
        throw error;
      }
    },
  };
  let now = "2026-08-18T08:00:00.000Z";
  const orchestrator = createFulfillmentOrchestrator({
    store: observedStore,
    handlers: {
      ...observedHandlers,
      verify_review_decision: async ({ decision }) => decision,
      verify_delivery_confirmation: async ({ confirmation }) => confirmation,
    },
    clock: () => now,
    tokenFactory: (label) => `${persona.key}:${label}:lease`,
    retryPolicy: retryPolicy(),
  });
  const flow = createCustomerFlowService({
    store: customerStore,
    paymentGateway: createLocalPaymentGateway(),
    fulfillmentOrchestrator: orchestrator,
    now: () => now,
    createId: (kind) => kind === "job" ? jobId : intakeToken,
  });
  const intake = {
    schemaVersion: "1.0",
    customer: { email: persona.email, consent: true },
    baby: {
      firstName: persona.firstName,
      nameArabic: persona.nameArabic,
      gender: persona.gender,
    },
    languages: [...persona.languages],
    voicePreference: { enabled: true, gender: "neutral" },
    preferences: { selfContainedFonts: true },
  };

  const submitted = await flow.submitIntake(intake, {
    idempotencyKey: `demo-intake-${persona.key}`,
  });
  const privateJob = await customerStore.readJob(jobId);
  await workspace.persistJobInput({
    jobId,
    intakeDigest: privateJob.intakeDigest,
    intake: privateJob.intake,
    selectionId: persona.selectionId,
  });
  const timeline = [await snapshot(flow, orchestrator, submitted, "intake")];

  now = "2026-08-18T08:01:00.000Z";
  const checkout = await flow.createCheckout(jobId, intakeToken);
  timeline.push(await snapshot(flow, orchestrator, submitted, "checkout"));
  await flow.recordPaymentSucceeded({
    providerEventId: `evt_demo_${persona.key}`,
    sessionId: checkout.sessionId,
    paymentIntentId: `pi_demo_${persona.key}`,
    amountMinor: 3900,
    currency: "EUR",
    livemode: false,
    metadata: checkout.metadata,
  });
  timeline.push(await snapshot(flow, orchestrator, submitted, "payment"));

  now = "2026-08-18T08:02:00.000Z";
  await silenceConsole(() => orchestrator.runNext(jobId));
  timeline.push(await snapshot(flow, orchestrator, submitted, "generation"));

  const reviewStatus = await orchestrator.status(jobId);
  const paths = await workspace.resolveJobPaths(reviewStatus);
  const review = JSON.parse(await readFile(path.join(paths.reviewRoot, "review.json"), "utf8"));
  await withDemoApprovalKey(() => silenceConsole(() => commandApproveReview({
    review: path.join(paths.reviewRoot, "review.json"),
    output: paths.approvedRoot,
    reviewer: "synthetic-demo-editor",
    "reviewed-at": REVIEWED_AT,
    ...(review.review.requiredReasons.length > 0
      ? { acknowledge: review.review.requiredReasons.join(",") }
      : {}),
  })));
  const aggregate = await generationStore.getJob(jobId);
  const reviewedArtifacts = aggregate.artifactSets.at(-1);
  now = REVIEWED_AT;
  await orchestrator.recordReviewDecision(jobId, {
    commandId: `demo-review-${persona.key}`,
    decisionType: "content",
    revisionId: "r1",
    outcome: "approved",
    policyVersion: EDITORIAL_POLICY_VERSION,
    rubricVersion: "bebebonjour-synthetic-demo-rubric-v1",
    reviewer: {
      id: "synthetic-demo-editor",
      role: "qualified-human-reviewer",
      competencies: ["arabic", "editorial"],
    },
    decidedAt: now,
    artifactDigests: pickDigests(reviewedArtifacts),
    reasons: ["Built-in fictional profile approved for the synthetic demo."],
  });

  now = "2026-08-18T08:04:00.000Z";
  const renderStatus = await withDemoApprovalKey(
    () => silenceConsole(() => orchestrator.runNext(jobId)),
  );
  if (renderStatus.state !== "tts_queued") {
    const failure = renderStatus.stageAttempts.at(-1)?.failure?.reasonCode || "unknown";
    throw new Error(
      `Synthetic rendering did not complete: ${renderStatus.state} (${failure}): ${stageFailure?.message || "unknown"}.`,
    );
  }
  now = "2026-08-18T08:04:15.000Z";
  const narrationStatus = await silenceConsole(() => orchestrator.runNext(jobId));
  if (narrationStatus.state !== "narration_review_required") {
    throw new Error(`Synthetic narration artifacts did not complete: ${narrationStatus.state}.`);
  }
  const narrationAggregate = await generationStore.getJob(jobId);
  const narrationArtifacts = narrationAggregate.artifactSets.at(-1);
  now = "2026-08-18T08:04:30.000Z";
  const publishReadyStatus = await orchestrator.recordReviewDecision(jobId, {
    commandId: `demo-narration-review-${persona.key}`,
    decisionType: "narration",
    revisionId: "r1",
    outcome: "approved",
    policyVersion: EDITORIAL_POLICY_VERSION,
    rubricVersion: "bebebonjour-synthetic-demo-narration-rubric-v1",
    reviewer: {
      id: "synthetic-demo-editor",
      role: "qualified-human-reviewer",
      competencies: ["arabic", "editorial"],
    },
    decidedAt: now,
    artifactDigests: pickDigests(narrationArtifacts),
    reasons: ["Deterministic local placeholders verified; no TTS provider was called."],
  });
  if (publishReadyStatus.state !== "publish_ready") {
    throw new Error(`Synthetic exact-revision review did not complete: ${publishReadyStatus.state}.`);
  }
  timeline.push(await snapshot(flow, orchestrator, submitted, "review"));
  const renderedPaths = await workspace.resolveJobPaths(await orchestrator.status(jobId));
  await copyAnnouncement(renderedPaths.preparedRoot, persona.key, outputRoot);

  now = "2026-08-18T08:05:00.000Z";
  const publicationStatus = await silenceConsole(() => orchestrator.runNext(jobId));
  if (publicationStatus.state !== "published") {
    throw new Error(`Synthetic publication did not complete: ${publicationStatus.state}.`);
  }
  await orchestrator.queueDelivery(jobId, { commandId: `demo-delivery-${persona.key}` });
  timeline.push(await snapshot(flow, orchestrator, submitted, "publication"));

  now = "2026-08-18T08:06:00.000Z";
  const deliveryStatus = await silenceConsole(() => orchestrator.runNext(jobId));
  if (deliveryStatus.state !== "sent") {
    throw new Error(`Synthetic delivery did not complete: ${deliveryStatus.state}.`);
  }
  const sentAggregate = await generationStore.getJob(jobId);
  now = "2026-08-18T08:07:00.000Z";
  await orchestrator.confirmDelivery(jobId, {
    commandId: `demo-confirm-${persona.key}`,
    providerMessageId: sentAggregate.deliveryAttempts.at(-1).providerMessageId,
    outcome: "delivered",
    recordedAt: now,
  });
  const finalPath = `announcements/${persona.key}/${persona.languages[0]}`;
  timeline.push(await snapshot(flow, orchestrator, submitted, "delivery", finalPath));

  return {
    key: persona.key,
    slug: persona.key,
    simulated: true,
    path: finalPath,
    intake,
    checkout: {
      amountMinor: 3900,
      currency: "EUR",
      mode: "test",
      sessionId: checkout.sessionId,
    },
    timeline,
  };
}

async function snapshot(flow, orchestrator, submitted, key, stableUrl = undefined) {
  const [projected, canonical] = await Promise.all([
    flow.getStatus(submitted.jobId, submitted.intakeToken),
    orchestrator.status(submitted.jobId),
  ]);
  return {
    key,
    ...TIMELINE_COPY[key],
    ...projected,
    canonicalState: canonical.state,
    revisionId: canonical.currentRevisionId,
    publishedRevisionId: canonical.publishedRevisionId,
    simulated: true,
    ...(stableUrl ? { canonicalStableUrl: projected.stableUrl, stableUrl } : {}),
  };
}

async function copyAnnouncement(preparedRoot, slug, outputRoot) {
  const deployRoot = path.join(preparedRoot, "deploy");
  const targetRoot = path.join(outputRoot, "announcements");
  await mkdir(targetRoot, { recursive: true });
  await cp(path.join(deployRoot, slug), path.join(targetRoot, slug), {
    recursive: true,
    force: true,
  });
}

function pickDigests(artifactSet) {
  return {
    pageDigest: artifactSet.pageDigest,
    transcriptDigest: artifactSet.transcriptDigest,
    assetManifestDigest: artifactSet.assetManifestDigest,
  };
}

function retryPolicy() {
  const stages = ["prepare_review", "generate_tts", "render_approved", "publish", "deliver"];
  return {
    leaseMsByStage: Object.fromEntries(stages.map((stage) => [stage, 300_000])),
    maxAttemptsByStage: Object.fromEntries(stages.map((stage) => [stage, 1])),
    backoffMsByStage: Object.fromEntries(stages.map((stage) => [stage, []])),
  };
}

async function writeDeterministicNarrationArtifacts(args) {
  const page = JSON.parse(await readFile(args.input, "utf8"));
  const transcriptSource = path.join(args.prepared, "deploy", page.slug, "transcript.json");
  const artifactsRoot = path.join(args.output, "artifacts");
  const languages = args.lang === "all" ? page.languages : args.lang.split(",");
  for (const language of languages) {
    const languageRoot = path.join(artifactsRoot, "audio", "narration", language);
    await mkdir(languageRoot, { recursive: true });
    const files = [];
    for (const [index, section] of page.sectionOrder.entries()) {
      const filename = `${String(index + 1).padStart(2, "0")}-${section}.placeholder`;
      await writeFile(
        path.join(languageRoot, filename),
        `synthetic-placeholder:${page.buildId}:${language}:${section}\n`,
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
      generatedAt: "2026-08-18T08:04:15.000Z",
      languages,
      provider: null,
      notice: "Synthetic placeholders only; no TTS provider call.",
    }, null, 2)}\n`,
    "utf8",
  );
}

async function withDemoApprovalKey(operation) {
  const previous = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = DEMO_APPROVAL_KEY;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
    else process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = previous;
  }
}

async function silenceConsole(operation) {
  const previous = console.log;
  console.log = () => {};
  try {
    return await operation();
  } finally {
    console.log = previous;
  }
}
