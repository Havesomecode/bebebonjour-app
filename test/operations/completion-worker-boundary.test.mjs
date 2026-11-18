import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOperationsCommandWorker } from "../../src/operations/operations-command-worker.mjs";
import {
  TEST_A_COMPLETION_ACTIONS,
  TEST_A_COMPLETION_JOB_ID,
  requireTestACompletionEnvironment,
  runTestACompletionWorkerCommand,
} from "../../src/operations/production-completion-worker.mjs";
import {
  createTestACompletionCapabilities,
  createHostedCompletionArtifactResolver,
  promoteReviewedArtifactSet,
} from "../../src/fulfillment/test-a-completion-capabilities.mjs";
import { EDITORIAL_POLICY_VERSION } from "../../src/forward-coexistence/live/src/fulfillment/job-machine.mjs";
import { signPersistedReviewApproval } from "../../src/fulfillment/persisted-review-decision.mjs";
import { createLocalTestFulfillmentStore } from "../../src/persistence/local-test-fulfillment-store.mjs";

const buildInspection = Object.freeze({
  schemaVersion: "1.0",
  source: "vercel inspect --format=json",
  deploymentId: "dpl_test",
  buildId: "build_test",
  teamId: "team_test",
  projectId: "project_test",
  projectName: "bebebonjour-test-a-private",
  revisionId: "revision_synthetic_001",
});

const baseEnvironment = Object.freeze({
  CONVEX_URL: "https://example.convex.cloud",
  BEBEBONJOUR_COMPLETION_WORKER_TOKEN: "w".repeat(32),
  BEBEBONJOUR_OPERATIONS_WORKER_ID: "test-a-completion-worker",
  BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "approve_content,render,publish,retry",
  BEBEBONJOUR_OPERATIONS_WORKER_LIMIT: "1",
  BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS: "300000",
  BEBEBONJOUR_TEST_A_COMPLETION_JOB_ID: TEST_A_COMPLETION_JOB_ID,
  BEBEBONJOUR_APPROVAL_HMAC_KEY: "h".repeat(32),
  BEBEBONJOUR_TEST_A_APPROVAL_ID: `approval_${"a".repeat(24)}`,

  VERCEL_TOKEN: "vercel-test-token",
  VERCEL_DEPLOYMENT_ID: "dpl_completion_worker_runtime",
  VERCEL_PROTECTION_BYPASS_SECRET: "protection-bypass-secret-at-least-32-bytes",
  VERCEL_BUILD_INSPECTION_B64: Buffer.from(JSON.stringify(buildInspection)).toString("base64"),
  TEST_A_PUBLICATION_ORIGIN: "https://private.example.test",
  TEST_A_PUBLICATION_VERCEL_TEAM_ID: "team_test",
  TEST_A_PUBLICATION_VERCEL_PROJECT_ID: "project_test",
  TEST_A_PUBLICATION_VERCEL_PROJECT_NAME: "bebebonjour-test-a-private",
  CRON_SECRET: "c".repeat(32),
});

test("completion worker policy is pinned to one job, one action sequence, and a 300s lease", () => {
  const policy = requireTestACompletionEnvironment({ ...baseEnvironment });
  assert.equal(policy.jobId, TEST_A_COMPLETION_JOB_ID);
  assert.deepEqual(policy.actions, TEST_A_COMPLETION_ACTIONS);
  assert.equal(policy.limit, 1);
  assert.equal(policy.leaseMs, 300_000);
});

test("completion policy refuses broadened jobs, actions, customer/provider authority, and lease drift", () => {
  const rejected = [
    { BEBEBONJOUR_TEST_A_COMPLETION_JOB_ID: "job_other" },
    { BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "approve_content,render,publish,queue_delivery,deliver,retry,reconcile" },
    { BEBEBONJOUR_OPERATIONS_WORKER_LIMIT: "2" },
    { BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS: "299999" },

    { STRIPE_SECRET_KEY: "sk_test_forbidden" },
    { OPENAI_API_KEY: "forbidden-model-authority" },
    { BEBEBONJOUR_OPERATIONS_TOKEN: "forbidden-operator-authority-with-at-least-thirty-two-bytes" },
    { BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN: "forbidden-rate-limit-authority-with-at-least-thirty-two-bytes" },
    { BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: "broad-worker-token-with-at-least-thirty-two-bytes" },
    { CUSTOMER_FLOW_BACKEND_TOKEN: "broad-backend-token-with-at-least-thirty-two-bytes" },
    { CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: "forbidden-customer-data-authority" },
    { CUSTOMER_FLOW_TEST_ACCESS_TOKEN: "forbidden-customer-access-authority" },
    { TALLY_SIGNING_SECRET: "forbidden" },
  ];
  for (const override of rejected) {
    assert.throws(
      () => requireTestACompletionEnvironment({ ...baseEnvironment, ...override }),
      /completion|forbidden|exact|restricted/i,
    );
  }
});

test("command worker forwards the exact job claim boundary to Convex", async () => {
  let claim;
  const worker = createOperationsCommandWorker({
    queue: {
      async claimCommands(input) { claim = input; return []; },
      async fenceCommand() {},
      async completeCommand() {},
      async failCommand() {},
    },
    handlers: { render: async () => ({ status: "ok" }) },
  });
  const result = await worker.runOnce({
    workerId: "test-a-completion-worker",
    jobId: TEST_A_COMPLETION_JOB_ID,
    limit: 1,
    leaseMs: 300_000,
  });
  assert.deepEqual(result, { claimed: 0, completed: 0, failed: 0 });
  assert.equal(claim.jobId, TEST_A_COMPLETION_JOB_ID);
});

test("production completion startup uses only completion-scoped Convex authority", async () => {
  let claim;
  const client = {
    async query(name, input) {
      assert.equal(name, "operations:workerHealth");
      assert.equal(input.workerToken, baseEnvironment.BEBEBONJOUR_COMPLETION_WORKER_TOKEN);
      return { protocolVersion: "1.0", scope: "completion" };
    },
    async mutation(name, input) {
      if (name === "operations:claimCommands") {
        claim = input;
        return [];
      }
      throw new Error(`unexpected mutation: ${name}`);
    },
  };
  let capabilityEnvironment;
  const result = await runTestACompletionWorkerCommand({
    environment: { ...baseEnvironment, UNRELATED_PLATFORM_VALUE: "not-forwarded" },
    client,
    async createCapabilities(options) {
      capabilityEnvironment = options.environment;
      return {
        fulfillmentOrchestrator: {
          runExpectedStage() {}, recordReviewDecision() {}, queueDelivery() {}, resumeRetry() {},
        },
        fulfillmentStore: { getJob() {} },
        authorizeReviewDecision() {},
      };
    },
  });
  assert.equal(result.claimed, 0);
  assert.equal(claim.jobId, TEST_A_COMPLETION_JOB_ID);
  assert.equal(claim.workerToken, baseEnvironment.BEBEBONJOUR_COMPLETION_WORKER_TOKEN);
  assert.deepEqual(claim.actions, [...TEST_A_COMPLETION_ACTIONS].sort());
  assert.equal(Object.hasOwn(capabilityEnvironment, "UNRELATED_PLATFORM_VALUE"), false);
  assert.equal(Object.hasOwn(capabilityEnvironment, "VERCEL_DEPLOYMENT_ID"), false);
});

test("production completion capabilities construct with inspected identity and expose retry", async () => {
  const client = {
    async query(name, input) {
      assert.equal(name, "fulfillment:getCompletionJob");
      assert.equal(input.jobId, TEST_A_COMPLETION_JOB_ID);
      return {
        jobId: TEST_A_COMPLETION_JOB_ID,
        environment: "test",
        product: "announcement-page",
        currentRevisionId: buildInspection.revisionId,
      };
    },
    async mutation() { throw new Error("unexpected mutation"); },
  };
  const capabilities = await createTestACompletionCapabilities({
    environment: { ...baseEnvironment },
    client,
    policy: requireTestACompletionEnvironment({ ...baseEnvironment }),
    publicationProvider: { async reconcile() { return null; }, async publish() {} },
  });
  assert.equal(typeof capabilities.fulfillmentOrchestrator.resumeRetry, "function");
  assert.equal(capabilities.fulfillmentOrchestrator.queueDelivery, undefined);
});

test("reviewed private bytes are promoted without mutation and remain exact-revision bound", async () => {
  const bytes = Buffer.from("<h1>synthetic</h1>");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const privateSet = {
    artifactSetId: "artifact_set_private_001",
    kind: "private_review",
    revisionId: "revision_synthetic_001",
    pageDigest: "1".repeat(64),
    transcriptDigest: "2".repeat(64),
    assetManifestDigest: "3".repeat(64),
    files: [{
      path: "private-preview/canary/fr/index.html",
      storageId: "storage_synthetic_001",
      bytes: bytes.length,
      sha256: digest,
    }],
  };
  const job = {
    jobId: TEST_A_COMPLETION_JOB_ID,
    environment: "test",
    product: "announcement-page",
    currentRevisionId: privateSet.revisionId,
    reviewDecisions: [{
      decisionType: "content",
      outcome: "approved",
      revisionId: privateSet.revisionId,
      artifactDigests: {
        pageDigest: privateSet.pageDigest,
        transcriptDigest: privateSet.transcriptDigest,
        assetManifestDigest: privateSet.assetManifestDigest,
      },
    }],
    artifactSets: [privateSet],
  };

  const promoted = await promoteReviewedArtifactSet({ job });
  assert.equal(promoted.artifactSet.kind, "prepared_bundle");
  assert.equal(promoted.artifactSet.files[0].path, "deploy/fr/index.html");
  assert.equal(promoted.artifactSet.files[0].storageId, "storage_synthetic_001");
  assert.equal(promoted.artifactSet.files[0].sha256, digest);
  assert.throws(
    () => promoteReviewedArtifactSet({ job: { ...job, jobId: "job_real_customer_001" } }),
    /non-synthetic/u,
  );
});

test("hosted resolver rejects non-synthetic and non-private artifact reads before publication", async () => {
  const bytes = Buffer.from("<h1>synthetic</h1>");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = {
    artifactSetId: "artifact_set_private_001",
    kind: "private_review",
    revisionId: "revision_synthetic_001",
    pageDigest: "1".repeat(64),
    transcriptDigest: "2".repeat(64),
    assetManifestDigest: "3".repeat(64),
    files: [{
      path: "private-preview/canary/fr/index.html",
      storageId: "storage_synthetic_001",
      bytes: bytes.length,
      sha256: digest,
    }],
  };
  const { artifactSet } = await promoteReviewedArtifactSet({
    job: {
      jobId: TEST_A_COMPLETION_JOB_ID,
      environment: "test",
      product: "announcement-page",
      currentRevisionId: source.revisionId,
      reviewDecisions: [{
        decisionType: "content",
        outcome: "approved",
        revisionId: source.revisionId,
        artifactDigests: {
          pageDigest: source.pageDigest,
          transcriptDigest: source.transcriptDigest,
          assetManifestDigest: source.assetManifestDigest,
        },
      }],
      artifactSets: [source],
    },
  });
  let reads = 0;
  const resolver = createHostedCompletionArtifactResolver({
    siteOrigin: "https://synthetic.convex.site",
    backendToken: "backend-token-with-at-least-thirty-two-bytes",
    jobId: TEST_A_COMPLETION_JOB_ID,
    async fetch(url, options) {
      reads += 1;
      assert.equal(url.searchParams.get("storageId"), source.files[0].storageId);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["x-bebebonjour-worker-id"], "test-a-completion-worker");
      assert.equal(options.headers["x-bebebonjour-command-id"], "cmd_publish_001");
      assert.equal(options.headers["x-bebebonjour-lease-token"], "lease_publish_001");
      return new Response(bytes, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": "application/octet-stream",
        },
      });
    },
  });
  const request = {
    jobId: TEST_A_COMPLETION_JOB_ID,
    environment: "test",
    product: "announcement-page",
    revisionId: source.revisionId,
    artifactManifestDigest: artifactSet.assetManifestDigest,
    artifactSet,
    artifactReadAuthority: {
      workerId: "test-a-completion-worker",
      commandId: "cmd_publish_001",
      leaseToken: "lease_publish_001",
    },
  };
  const resolved = await resolver.resolve(request);
  assert.equal(resolved.entrypointPath, "fr/index.html");
  assert.equal(reads, 1);

  await assert.rejects(
    resolver.resolve({ ...request, jobId: "job_real_customer_001" }),
    /not the exact synthetic/u,
  );
  assert.equal(reads, 1);

  await assert.rejects(
    resolver.resolve({ ...request, artifactReadAuthority: undefined }),
    /active completion command claim/u,
  );
  assert.equal(reads, 1);

  const nonPrivateResolver = createHostedCompletionArtifactResolver({
    siteOrigin: "https://synthetic.convex.site",
    backendToken: "backend-token-with-at-least-thirty-two-bytes",
    jobId: TEST_A_COMPLETION_JOB_ID,
    async fetch() { return new Response(bytes); },
  });
  await assert.rejects(nonPrivateResolver.resolve(request), /not private/u);
});
