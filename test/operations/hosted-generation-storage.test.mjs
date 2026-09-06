import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createJobAggregate, recordPaymentTransition } from "../../src/fulfillment/job-machine.mjs";
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

function hostedFixture() {
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
  const command = {
    commandId: COMMAND_ID,
    jobId: JOB_ID,
    action: "generate",
    expectedState: aggregate.state,
    expectedVersion: aggregate.version,
    payload: {},
    claim: {
      workerId: "production-worker-1",
      leaseToken: "hosted-generation-lease",
      leaseExpiresAtMs: Date.now() + 120_000,
    },
  };

  const client = {
    async query(name, input) {
      if (name === "operations:workerHealth") return { protocolVersion: "1.0", scope: "worker" };
      if (name === "generation:readClaimedCustomerJob") {
        assert.equal(input.workerToken, WORKER_TOKEN);
        return {
          schemaVersion: "1.0",
          jobId: JOB_ID,
          intakeDigest: INTAKE_DIGEST,
          intake,
          payment: { status: "paid" },
        };
      }
      if (name === "generation:getClaimedFulfillmentJob") return structuredClone(aggregate);
      if (name === "generation:readEditorialApproval") {
        assert.equal(input.workerToken, WORKER_TOKEN);
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
        return { active: true, command: structuredClone(command) };
      }
      if (name === "operations:completeCommand") return { ok: true };
      if (name === "operations:failCommand") {
        workerFailure = input.reasonCode;
        return { ok: true };
      }
      if (name === "generation:replaceClaimedFulfillmentJob") {
        assert.equal(input.expectedVersion, aggregate.version);
        aggregate = structuredClone(input.aggregate);
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
    get aggregate() { return structuredClone(aggregate); },
    get artifactRecord() { return structuredClone(artifactRecord); },
    get blobCount() { return blobs.size; },
    get downloadCount() { return downloadCount; },
    get workerFailure() { return workerFailure; },
  };
}

test("Vercel-safe production worker generates into Convex storage and a cold invocation reads it back", async () => {
  const fixture = hostedFixture();
  const environment = {
    CONVEX_URL: "https://test-a.convex.cloud",
    BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: WORKER_TOKEN,
    BEBEBONJOUR_OPERATIONS_WORKER_ID: "production-worker-1",
    BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
    BEBEBONJOUR_OPERATIONS_WORKER_LIMIT: "5",
    BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS: "120000",
    BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED: "true",
    BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64url"),
    BEBEBONJOUR_CODEX_MODEL: "gpt-5.6-sol",
    BEBEBONJOUR_CODEX_TIMEOUT_MS: "90000",
    BEBEBONJOUR_CODEX_AUTH_LEASE_MS: "110000",
    CRON_SECRET: "cron-secret-with-at-least-thirty-two-bytes",
  };

  const generated = await runOperationsWorkerCommand({
    environment,
    client: fixture.client,
    fetchImpl: fixture.fetchImpl,
    createCodexAuthStateStore: () => ({ kind: "synthetic-auth-store" }),
    createCodexRuntime: async () => "/synthetic/codex",
    createCodexComposer: () => ({ compose: async () => null }),
    clock: () => "2026-09-06T10:00:01.000Z",
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
