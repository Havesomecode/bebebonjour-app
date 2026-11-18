import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { signPersistedReviewApproval } from "../../src/fulfillment/persisted-review-decision.mjs";
import { createResendConfiguredTestDeliveryAdapter } from "../../src/fulfillment/resend-delivery-adapter.mjs";
import {
  requireCanonicalTestCompletionEnvironment,
  runCanonicalTestCompletionWorkerCommand,
} from "../../src/operations/canonical-test-completion-worker.mjs";
import {
  assertCanonicalTestRelease,
  createCanonicalTestCompletionCapabilities,
  createCanonicalTestArtifactResolver,
} from "../../src/fulfillment/canonical-test-completion-capabilities.mjs";

const hmacKey = "h".repeat(32);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const page = Buffer.from("<h1>Fictional announcement</h1>");
const file = { path: "deploy/fr/index.html", storageId: "storage_fictional_page", bytes: page.length, sha256: digest(page) };
const manifest = { schemaVersion: "1.0", kind: "prepared_bundle", revisionId: "r2", files: [file] };
const manifestDigest = digest(`${JSON.stringify(manifest, null, 2)}\n`);
const sourceDigests = { pageDigest: "1".repeat(64), transcriptDigest: "2".repeat(64), assetManifestDigest: "3".repeat(64) };
const env = {
  BEBEBONJOUR_CANONICAL_COMPLETION_JOB_ID: "job_fictional_123",
  BEBEBONJOUR_CANONICAL_COMPLETION_REVISION_ID: "r2",
  BEBEBONJOUR_CANONICAL_COMPLETION_MANIFEST_DIGEST: manifestDigest,
  BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN: "w".repeat(32),
  BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_ID: "canonical-test-completion-worker",
  BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_ACTIONS: "publish,queue_delivery,deliver",
  BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_LIMIT: "1",
  BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_LEASE_MS: "300000",
  BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT: "fictional-123@inbox.example.test",
  BEBEBONJOUR_APPROVAL_HMAC_KEY: hmacKey,
  CONVEX_URL: "https://example.convex.cloud",
  VERCEL_TOKEN: "vercel-test",
  VERCEL_PROTECTION_BYPASS_SECRET: "b".repeat(32),
  VERCEL_BUILD_INSPECTION_B64: Buffer.from(JSON.stringify({
    schemaVersion: "1.0", source: "vercel inspect --format=json", deploymentId: "dpl_test", buildId: "build_test",
    teamId: "team_test", projectId: "project_test", projectName: "fictional-announcements", revisionId: "r2",
  })).toString("base64"),
  CANONICAL_PUBLICATION_ORIGIN: "https://announcements.example.test",
  CANONICAL_PUBLICATION_VERCEL_TEAM_ID: "team_test",
  CANONICAL_PUBLICATION_VERCEL_PROJECT_ID: "project_test",
  CANONICAL_PUBLICATION_VERCEL_PROJECT_NAME: "fictional-announcements",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Bebe Bonjour <sender@example.test>",
  CRON_SECRET: "c".repeat(32),
};
function fixture() {
  const job = {
    jobId: env.BEBEBONJOUR_CANONICAL_COMPLETION_JOB_ID, environment: "test", product: "announcement-page",
    narrationRequired: false, intakeDigest: "4".repeat(64), currentRevisionId: "r2", state: "publish_ready", version: 7,
    stageAttempts: [{ stage: "prepare_review", status: "completed", attemptId: "attempt_content_123" }],
    artifactSets: [
      { kind: "private_review", revisionId: "r2", ...sourceDigests },
      { artifactSetId: "artifacts_prepared_123", kind: "prepared_bundle", revisionId: "r2", ...sourceDigests,
        assetManifestDigest: manifestDigest, files: [file], manifestRef: "jobs/job_fictional_123/revisions/r2/manifests/prepared_bundle.json" },
    ],
    reviewDecisions: [], deliveryAttempts: [],
  };
  const decision = {
    decisionType: "content", revisionId: "r2", outcome: "approved", policyVersion: "editorial-v1", rubricVersion: "content-v1",
    reviewer: { id: "reviewer_123", role: "editorial_reviewer", competencies: ["content_review"] },
    decidedAt: "2026-09-25T12:00:00.000Z", artifactDigests: sourceDigests, reasons: [],
  };
  const approval = signPersistedReviewApproval({ hmacKey, job, decision });
  job.reviewDecisions.push({ ...approval.decision, decisionId: "review_recorded_123" });
  return { job, approvals: { [approval.approvalId]: approval }, approval };
}

test("policy pins one fictional test job, exact revision/manifest, explicit recipient and manual effect scope", () => {
  const { approval } = fixture();
  const policy = requireCanonicalTestCompletionEnvironment({ ...env, BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID: approval.approvalId });
  assert.equal(policy.jobId, "job_fictional_123");
  assert.equal(policy.recipient, "fictional-123@inbox.example.test");
  assert.equal(policy.manifestDigest, manifestDigest);
  for (const [name, value] of [
    ["BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_ACTIONS", "approve_content,publish,queue_delivery,deliver"],
    ["BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_LIMIT", "2"],
    ["BEBEBONJOUR_CANONICAL_COMPLETION_JOB_ID", "job_narration_test_650a15d1-39bd-4dec-bc0d-3519ace71aa7"],
    ["BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT", "delivered@resend.dev"],
    ["BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT", "z@havesomecode.io"],
    ["BEBEBONJOUR_CANONICAL_COMPLETION_MANIFEST_DIGEST", "bad"],
  ]) assert.throws(() => requireCanonicalTestCompletionEnvironment({ ...env, BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID: approval.approvalId, [name]: value }));
});

test("signed exact approvals and canonical prepared bundle guard publication, including post-start drift", async () => {
  const { job, approvals, approval } = fixture();
  const environment = { ...env, BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID: approval.approvalId };
  const policy = requireCanonicalTestCompletionEnvironment(environment);
  assert.equal(assertCanonicalTestRelease(job, policy, approvals, hmacKey), job);
  const store = { async getJob() { return structuredClone(job); }, async getReviewApproval(id) { return structuredClone(approvals[id]); } };
  const capabilities = await createCanonicalTestCompletionCapabilities({
    environment, policy, client: { query() {}, mutation() {} }, fulfillmentStore: store,
    publicationProvider: { async reconcile() { return null; }, async publish() {} },
    resend: { emails: { async send() { throw new Error("No live send in unit test"); } } },
  });
  assert.equal((await capabilities.fulfillmentOrchestrator.status(policy.jobId)).state, "publish_ready");
  assert.throws(() => capabilities.fulfillmentOrchestrator.status("job_other"), /exact configured job/i);
  job.artifactSets[1].assetManifestDigest = "a".repeat(64);
  await assert.rejects(capabilities.fulfillmentStore.getJob(policy.jobId), /manifest|release/i);
  job.artifactSets[1].assetManifestDigest = manifestDigest;
  approvals[approval.approvalId].decision.outcome = "rejected";
  await assert.rejects(capabilities.fulfillmentStore.getJob(policy.jobId), /signature|approval/i);
});

test("private artifact resolver fetches only exact manifest bytes behind a claimed lease", async () => {
  const { job, approval } = fixture();
  const policy = requireCanonicalTestCompletionEnvironment({ ...env, BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID: approval.approvalId });
  let reads = 0;
  const resolver = createCanonicalTestArtifactResolver({ policy, siteOrigin: "https://example.convex.site", completionToken: "w".repeat(32),
    async fetch(url, init) {
      reads += 1;
      assert.equal(url.searchParams.get("storageId"), file.storageId);
      assert.equal(init.headers["x-bebebonjour-worker-id"], policy.workerId);
      return new Response(page, { headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store" } });
    },
  });
  const request = { jobId: policy.jobId, environment: "test", product: "announcement-page", revisionId: policy.revisionId,
    artifactManifestDigest: policy.manifestDigest, artifactSet: job.artifactSets[1], artifactReadAuthority: {
      workerId: policy.workerId, commandId: "command_123", leaseToken: "lease_123",
    },
  };
  assert.equal((await resolver.resolve(request)).files[0].publicPath, "fr/index.html");
  assert.equal(reads, 1);
  await assert.rejects(resolver.resolve({ ...request, artifactManifestDigest: "b".repeat(64) }), /manifest|exact/i);
  await assert.rejects(resolver.resolve({ ...request, artifactReadAuthority: null }), /lease|claim/i);
  assert.equal(reads, 1);
});

test("configured disposable recipient is immutable through fenced Resend acceptance", async () => {
  const { approval } = fixture();
  const policy = requireCanonicalTestCompletionEnvironment({ ...env, BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID: approval.approvalId });
  const sends = [];
  const stableUrl = `${env.CANONICAL_PUBLICATION_ORIGIN}/announcements/${policy.jobId}`;
  const adapter = createResendConfiguredTestDeliveryAdapter({ policy, stableUrl, from: env.RESEND_FROM,
    clock: () => "2026-09-26T12:01:00.000Z",
    resend: { emails: { async send(message, options) { sends.push({ message, options }); return { data: { id: "email_fictional_1" } }; } } },
  });
  const request = { jobId: policy.jobId, environment: "test", revisionId: policy.revisionId,
    artifactManifestDigest: policy.manifestDigest, publication: { stableUrl },
    target: { targetRef: policy.targetRef, email: policy.recipient }, targetDigest: "d".repeat(64),
    attemptStartedAt: "2026-09-26T12:00:00.000Z", idempotencyKey: `bb_${"a".repeat(64)}`,
    fenceExternalEffect: async (_fence, effect) => effect() };
  const receipt = await adapter.send(request);
  assert.equal(receipt.providerMessageId, "email_fictional_1");
  assert.deepEqual(sends[0].message.to, [policy.recipient]);
  assert.equal(sends[0].options.idempotencyKey, request.idempotencyKey);
  await assert.rejects(adapter.send({ ...request, target: { ...request.target, email: "other@inbox.example.test" } }), /recipient|target/i);
  await assert.rejects(adapter.send({ ...request, publication: { stableUrl: "https://other.example.test" } }), /stable/i);
  await assert.rejects(adapter.send({ ...request, attemptStartedAt: "2026-09-25T12:00:00.000Z" }), /window/i);
  assert.equal(sends.length, 1);
});

test("worker refuses unavailable backend scope before claiming commands or issuing effects", async () => {
  const { approval } = fixture();
  const environment = { ...env, BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID: approval.approvalId };
  let claimed = 0;
  await assert.rejects(runCanonicalTestCompletionWorkerCommand({ environment,
    client: { async query() { return { protocolVersion: "1.0", scope: "owner_completion" }; }, async mutation() { claimed++; return []; } },
    capabilities: { fulfillmentOrchestrator: {}, fulfillmentStore: {} },
  }), /scope|protocol/i);
  assert.equal(claimed, 0);
});
