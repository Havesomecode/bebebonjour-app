import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createJobAggregate,
  failStageTransition,
  recordPaymentTransition,
} from "../../src/fulfillment/job-machine.mjs";
import { runOperationsWorkerCommand } from "../../src/operations/operations-worker-startup.mjs";
import { createProductionGenerationWorker } from "../../src/operations/production-generation-worker.mjs";
import { createConvexGenerationArtifactStore } from "../../src/persistence/convex-generation-artifact-store.mjs";

const JOB_ID = "job_hosted_generation_001";
const WORKER_TOKEN = "worker-token-with-at-least-thirty-two-bytes";
const COMMAND_ID = "command_hosted_generate_000001";
const INTAKE_DIGEST = "a".repeat(64);
const BASE_INTAKE = JSON.parse(
  await readFile(new URL("../../data/examples/bayane/intake.json", import.meta.url), "utf8"),
);

function editorialApproval() {
  const sourceEvidence = {
    kind: "kanban_human_decision",
    reference: "kanban:t_hosted_generation_authority",
  };
  const record = {
    schemaVersion: "1.0",
    approvalType: "job_scoped_editorial_policy",
    jobId: JOB_ID,
    policy: {
      id: "unknown_name_general_wishes",
      preserveSubmittedName: true,
      meaningAllowed: false,
      scripturalNameAssociationAllowed: false,
      genericBlessingsAllowed: true,
      maxStage: "content_review_required",
    },
    sourceEvidence,
    sourceDigest: sha256(JSON.stringify(sourceEvidence)),
  };
  return {
    record,
    recordDigest: sha256(`${JSON.stringify(record, null, 2)}\n`),
  };
}

function productionEnvironment() {
  return {
    CONVEX_URL: "https://test-a.convex.cloud",
    BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: WORKER_TOKEN,
    BEBEBONJOUR_OPERATIONS_WORKER_ID: "production-worker-1",
    BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
    BEBEBONJOUR_OPERATIONS_WORKER_LIMIT: "5",
    BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS: "300000",
    BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED: "true",
    BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64url"),
    BEBEBONJOUR_CODEX_MODEL: "gpt-5.6-sol",
    BEBEBONJOUR_CODEX_TIMEOUT_MS: "240000",
    BEBEBONJOUR_CODEX_AUTH_LEASE_MS: "290000",
    CRON_SECRET: "cron-secret-with-at-least-thirty-two-bytes",
  };
}

function hostedFixture(options = {}) {
  const intake = structuredClone(BASE_INTAKE);
  intake.requestId = JOB_ID;
  intake.customer.email = "synthetic-hosted@example.test";
  intake.baby.firstName = "Aélio-Z";
  intake.baby.nameArabic = "أيليو";
  const paymentCorrelation = {
    project: "bebebonjour",
    product: "announcement-page",
    environment: "test",
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
  };
  let aggregate = createJobAggregate({
    jobId: JOB_ID,
    environment: "test",
    product: "announcement-page",
    intakeDigest: INTAKE_DIGEST,
    paymentCorrelation,
    narrationRequired: false,
  }, {
    commandId: "create-hosted-generation-fixture",
    at: "2026-09-06T10:00:00.000Z",
  });
  aggregate = recordPaymentTransition(aggregate, {
    commandId: "pay-hosted-generation-fixture",
    providerEventId: "evt_hosted_generation_fixture",
    providerPaymentId: "pi_hosted_generation_fixture",
    correlation: paymentCorrelation,
    recordedAt: "2026-09-06T10:00:00.000Z",
  }, "2026-09-06T10:00:00.000Z");

  const approval = editorialApproval();
  const blobs = new Map();
  let artifactRecord = null;
  let workerFailure = null;
  let claimAvailable = true;
  let downloadCount = 0;
  let uploadOrdinal = 0;
  const trace = [];
  const nowMs = Date.now();
  const command = {
    commandId: COMMAND_ID,
    jobId: JOB_ID,
    action: "generate",
    expectedState: aggregate.state,
    expectedVersion: aggregate.version,
    payload: {},
    state: "running",
    claim: {
      workerId: "production-worker-1",
      leaseToken: "hosted-generation-lease",
      leaseExpiresAtMs: nowMs + 120_000,
    },
  };

  const client = {
    async query(name, input) {
      if (name === "operations:workerHealth") return { protocolVersion: "1.0", scope: "worker" };
      if (name === "generation:readClaimedCustomerJob") {
        assert.equal(input.workerToken, WORKER_TOKEN);
        trace.push("customer_job_read");
        if (options.rejectCustomerRead === true) {
          throw new Error("synthetic customer payload must stay private");
        }
        return {
          schemaVersion: "1.0",
          jobId: JOB_ID,
          intakeDigest: INTAKE_DIGEST,
          intake,
          payment: { status: "paid" },
        };
      }
      if (name === "generation:getClaimedFulfillmentJob") {
        trace.push(`fulfillment_read:${aggregate.state}`);
        return structuredClone(aggregate);
      }
      if (name === "generation:readEditorialApproval") {
        assert.equal(input.workerToken, WORKER_TOKEN);
        trace.push("editorial_approval_read");
        return structuredClone(approval);
      }
      if (name === "generation:readArtifactSet") {
        assert.equal(input.workerToken, WORKER_TOKEN);
        if (!artifactRecord) return null;
        return {
          artifactSet: structuredClone(artifactRecord),
          files: structuredClone(artifactRecord.files),
        };
      }
      throw new Error(`Unexpected query ${name}`);
    },
    async mutation(name, input) {
      if (name === "operations:claimCommands") {
        if (!claimAvailable) return [];
        claimAvailable = false;
        return [structuredClone(command)];
      }
      if (name === "operations:fenceCommand") {
        if (!input.effectMayBeIssued) {
          trace.push("operations_preflight_fenced");
          const active = aggregate.state === command.expectedState
            && aggregate.version === command.expectedVersion;
          return { active, command: active ? structuredClone(command) : null };
        }
        trace.push("operations_effect_fence_checked");
        const attempt = aggregate.stageAttempts?.at(-1);
        const active = options.rejectEffectFence !== true
          && aggregate.state === "generating"
          && aggregate.version > command.expectedVersion
          && attempt?.stage === "prepare_review"
          && attempt?.status === "running"
          && attempt?.operationsCommandId === COMMAND_ID
          && Date.parse(attempt.leaseExpiresAt) > Date.now();
        if (active) {
          trace.push("operations_effect_fenced");
          return { active: true, command: structuredClone(command) };
        }
        if (options.rejectEffectFence === true) {
          aggregate = failStageTransition(aggregate, {
            commandId: `operations-fence-rejected:${COMMAND_ID}:${attempt.attemptId}`,
            stage: "prepare_review",
            leaseToken: attempt.leaseToken,
            retryable: true,
            reasonCode: "operations_effect_fence_rejected",
          }, {
            maxAttemptsByStage: { prepare_review: 2 },
            backoffMsByStage: { prepare_review: [60_000] },
          }, new Date(nowMs).toISOString());
          command.state = "failed";
          command.claim = null;
          trace.push("prepare_review_fence_recovered");
          return {
            active: false,
            command: structuredClone(command),
          };
        }
        return { active: false, command: null };
      }
      if (name === "operations:completeCommand") {
        trace.push("operations_command_completed");
        return { ok: true };
      }
      if (name === "operations:failCommand") {
        trace.push("operations_command_failed");
        workerFailure = input.reasonCode;
        return { ok: true };
      }
      if (name === "generation:replaceClaimedFulfillmentJob") {
        assert.equal(input.expectedVersion, aggregate.version);
        const entersPrepareReview = aggregate.state === "generation_queued"
          && input.aggregate.state === "generating";
        if (!entersPrepareReview && !trace.includes("operations_effect_fenced")) {
          throw new Error("Generation prepare_review claim authorization failed.");
        }
        if (
          options.rejectPrepareReviewClaim === true
          && entersPrepareReview
        ) {
          trace.push("prepare_review_claim_rejected");
          return { updated: false, current: structuredClone(aggregate) };
        }
        aggregate = structuredClone(input.aggregate);
        if (aggregate.state === "generating") trace.push("prepare_review_claimed");
        return { updated: true, aggregate: structuredClone(aggregate) };
      }
      if (name === "generation:createArtifactUploadUrl") {
        return `memory:upload:${uploadOrdinal += 1}`;
      }
      if (name === "generation:commitArtifactSet") {
        artifactRecord = structuredClone(input.artifactSet);
        return { created: true, artifactSet: structuredClone(artifactRecord) };
      }
      throw new Error(`Unexpected mutation ${name}`);
    },
  };

  async function fetchImpl(url, options = {}) {
    if (String(url).startsWith("memory:upload:")) {
      const storageId = `storage_${blobs.size + 1}`;
      blobs.set(storageId, Buffer.from(await new Response(options.body).arrayBuffer()));
      return new Response(JSON.stringify({ storageId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).startsWith("https://test-a.convex.site/generation/artifact?")) {
      const artifactUrl = new URL(url);
      assert.equal(options.headers.authorization, `Bearer ${WORKER_TOKEN}`);
      assert.equal(options.headers["x-bebebonjour-worker-id"], "production-worker-1");
      assert.equal(options.headers["x-bebebonjour-command-id"], COMMAND_ID);
      assert.equal(options.headers["x-bebebonjour-lease-token"], "hosted-generation-lease");
      assert.equal(artifactUrl.searchParams.get("jobId"), JOB_ID);
      assert.equal(artifactUrl.searchParams.get("kind"), "private_review");
      const file = artifactRecord?.files.find(
        (entry) => entry.path === artifactUrl.searchParams.get("path"),
      );
      const bytes = file ? blobs.get(file.storageId) : null;
      if (!bytes) return new Response(null, { status: 404 });
      downloadCount += 1;
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  }

  return {
    client,
    fetchImpl,
    clock: () => new Date(nowMs).toISOString(),
    recordTrace(value) { trace.push(value); },
    get aggregate() { return structuredClone(aggregate); },
    get artifactRecord() { return structuredClone(artifactRecord); },
    get blobCount() { return blobs.size; },
    get downloadCount() { return downloadCount; },
    get trace() { return [...trace]; },
    get workerFailure() { return workerFailure; },
    get command() { return structuredClone(command); },
  };
}

test("Vercel-safe production worker generates into Convex storage and a cold invocation reads it back", async () => {
  const fixture = hostedFixture();
  const environment = productionEnvironment();

  const generated = await runOperationsWorkerCommand({
    environment,
    client: fixture.client,
    fetchImpl: fixture.fetchImpl,
    createCodexAuthStateStore: () => ({ kind: "synthetic-auth-store" }),
    createCodexRuntime: async () => "/synthetic/codex",
    createCodexComposer: () => ({
      compose: async () => {
        fixture.recordTrace("provider_compose_started");
        return null;
      },
    }),
    clock: fixture.clock,
    tokenFactory: () => "hosted-generation-stage-lease",
  });
  assert.equal(fixture.workerFailure, null, JSON.stringify(fixture.aggregate.stageAttempts?.at(-1)));
  assert.deepEqual(generated, {
    status: "ok",
    protocolVersion: "1.0",
    workerId: "production-worker-1",
    enabledActionCount: 1,
    claimed: 1,
    completed: 1,
    failed: 0,
  });
  assert.deepEqual(fixture.trace.slice(0, 11), [
    "operations_preflight_fenced",
    "editorial_approval_read",
    "fulfillment_read:generation_queued",
    "customer_job_read",
    "fulfillment_read:generation_queued",
    "fulfillment_read:generation_queued",
    "prepare_review_claimed",
    "operations_effect_fence_checked",
    "operations_effect_fenced",
    "fulfillment_read:generating",
    "provider_compose_started",
  ]);
  assert.equal(fixture.aggregate.state, "content_review_required");
  assert.equal(fixture.artifactRecord.kind, "private_review");
  assert.ok(fixture.blobCount > 0);
  assert.ok(fixture.artifactRecord.files.every((file) => file.storageId.startsWith("storage_")));
  assert.equal(JSON.stringify(fixture.artifactRecord).includes("synthetic-hosted@example.test"), false);
  const {
    artifactSetId: _artifactSetId,
    operationsCommandId: _operationsCommandId,
    ...persistedArtifactBinding
  } = fixture.aggregate.artifactSets[0];
  assert.deepEqual(persistedArtifactBinding, fixture.artifactRecord);

  const coldWorker = createProductionGenerationWorker({
    environment,
    client: fixture.client,
    workerToken: WORKER_TOKEN,
    fetchImpl: fixture.fetchImpl,
    clock: () => "2026-09-06T10:05:01.000Z",
    tokenFactory: () => "cold-hosted-generation-stage-lease",
  });
  const replayed = await coldWorker.fulfillmentOrchestrator.runExpectedStage(
    JOB_ID,
    "prepare_review",
    {
      operationsCommandId: COMMAND_ID,
      workerAuthority: {
        commandId: COMMAND_ID,
        workerId: "production-worker-1",
        leaseToken: "hosted-generation-lease",
      },
      operationsEffectBoundary: async (request, operation) => {
        assert.deepEqual(request, {
          jobId: JOB_ID,
          stage: "prepare_review",
          operationsCommandId: COMMAND_ID,
        });
        return operation();
      },
    },
  );
  assert.equal(replayed.outcome, "already_generated");
  assert.equal(replayed.jobId, JOB_ID);
  assert.equal(replayed.revisionId, fixture.aggregate.currentRevisionId);
  assert.equal(fixture.downloadCount, fixture.blobCount);
});

test("production generate fails closed before composition when its stage claim or effect fence is rejected", async () => {
  for (const scenario of [
    { name: "prepare_review claim", fixtureOptions: { rejectPrepareReviewClaim: true } },
    { name: "Operations effect fence", fixtureOptions: { rejectEffectFence: true } },
  ]) {
    const fixture = hostedFixture(scenario.fixtureOptions);
    let compositionCount = 0;
    const result = await runOperationsWorkerCommand({
      environment: productionEnvironment(),
      client: fixture.client,
      fetchImpl: fixture.fetchImpl,
      createCodexAuthStateStore: () => ({ kind: "synthetic-auth-store" }),
      createCodexRuntime: async () => "/synthetic/codex",
      createCodexComposer: () => ({
        compose: async () => {
          compositionCount += 1;
          return null;
        },
      }),
      clock: fixture.clock,
      tokenFactory: () => "hosted-generation-stage-lease",
    });

    assert.deepEqual(result, {
      status: "ok",
      protocolVersion: "1.0",
      workerId: "production-worker-1",
      enabledActionCount: 1,
      claimed: 1,
      completed: 0,
      failed: scenario.fixtureOptions.rejectPrepareReviewClaim ? 1 : 0,
      ...(scenario.fixtureOptions.rejectEffectFence ? { expired: 1 } : {}),
    }, `${scenario.name}: ${fixture.workerFailure}; ${fixture.trace.join(",")}`);
    assert.equal(compositionCount, 0, scenario.name);
    assert.equal(fixture.artifactRecord, null, scenario.name);
    assert.equal(fixture.blobCount, 0, scenario.name);
    assert.equal(fixture.trace.includes("operations_command_completed"), false, scenario.name);
    assert.equal(
      fixture.aggregate.state,
      scenario.fixtureOptions.rejectPrepareReviewClaim ? "generation_queued" : "retry_wait",
      scenario.name,
    );
    if (scenario.fixtureOptions.rejectEffectFence) {
      assert.equal(fixture.command.state, "failed", scenario.name);
      assert.equal(fixture.aggregate.stageAttempts.at(-1).status, "retry_wait", scenario.name);
      assert.deepEqual(fixture.aggregate.stageAttempts.at(-1).failure, {
        retryable: true,
        reasonCode: "operations_effect_fence_rejected",
      }, scenario.name);
      assert.deepEqual(fixture.aggregate.retry, {
        stage: "prepare_review",
        availableAt: new Date(Date.parse(fixture.clock()) + 60_000).toISOString(),
      }, scenario.name);
      assert.equal(fixture.trace.includes("prepare_review_fence_recovered"), true, scenario.name);
      assert.equal(fixture.trace.includes("operations_command_failed"), false, scenario.name);
    }
  }
});

test("production pre-effect failures persist only a bounded generation reason", async () => {
  const fixture = hostedFixture({ rejectCustomerRead: true });
  const result = await runOperationsWorkerCommand({
    environment: productionEnvironment(),
    client: fixture.client,
    fetchImpl: fixture.fetchImpl,
    createCodexAuthStateStore: () => ({ kind: "synthetic-auth-store" }),
    createCodexRuntime: async () => {
      throw new Error("Codex runtime must not start after a pre-effect failure.");
    },
    clock: fixture.clock,
    tokenFactory: () => "hosted-generation-stage-lease",
  });

  assert.deepEqual(result, {
    status: "ok",
    protocolVersion: "1.0",
    workerId: "production-worker-1",
    enabledActionCount: 1,
    claimed: 1,
    completed: 0,
    failed: 1,
  });
  assert.equal(fixture.workerFailure, "generation_backend_failed");
  assert.match(fixture.workerFailure, /^[a-z0-9_]{3,64}$/u);
  assert.equal(fixture.workerFailure.includes("payload"), false);
  assert.equal(fixture.artifactRecord, null);
  assert.equal(fixture.blobCount, 0);
  assert.equal(fixture.trace.includes("operations_effect_fenced"), false);
});

test("hosted artifact uploads reject cross-job manifest references before storage mutation", async () => {
  let mutationCount = 0;
  const store = createConvexGenerationArtifactStore({
    authorization: {
      workerToken: WORKER_TOKEN,
      commandId: COMMAND_ID,
      workerId: "production-worker-1",
      leaseToken: "hosted-generation-lease",
    },
    client: {
      async query() { return null; },
      async mutation() {
        mutationCount += 1;
        throw new Error("storage mutation must not run");
      },
    },
    convexUrl: "https://test-a.convex.cloud",
    fetchImpl: async () => new Response(null, { status: 500 }),
  });
  const bytes = Buffer.from("x", "utf8");
  await assert.rejects(
    store.uploadArtifactSet({
      jobId: JOB_ID,
      artifactSet: {
        kind: "private_review",
        revisionId: "r1",
        pageDigest: "a".repeat(64),
        transcriptDigest: "b".repeat(64),
        assetManifestDigest: "c".repeat(64),
        manifestRef: "jobs/job_other_generation_001/revisions/r1/manifests/private_review.json",
        files: [{
          path: "review.json",
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
          storageId: `local-test:sha256:${sha256(bytes)}`,
        }],
      },
      readArtifact: async () => bytes,
    }),
    /artifact set is invalid/u,
  );
  assert.equal(mutationCount, 0);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
