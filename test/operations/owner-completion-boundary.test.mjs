import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  OWNER_COMPLETION_ACTIONS,
  OWNER_COMPLETION_JOB_ID,
  OWNER_COMPLETION_MANIFEST_DIGEST,
  OWNER_COMPLETION_NARRATION_DECISION_ID,
  OWNER_COMPLETION_REVISION_ID,
  OWNER_DELIVERY_EMAIL,
  requireOwnerCompletionEnvironment,
} from "../../src/operations/owner-completion-policy.mjs";
import { createResendOwnerDeliveryAdapter } from "../../src/fulfillment/resend-owner-delivery-adapter.mjs";
import {
  assertOwnerCompletionJob,
  createOwnerCompletionArtifactResolver,
  createOwnerCompletionCapabilities,
} from "../../src/fulfillment/owner-completion-capabilities.mjs";

const baseEnvironment = {
  BEBEBONJOUR_OWNER_COMPLETION_JOB_ID: OWNER_COMPLETION_JOB_ID,
  BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN: "o".repeat(32),
  BEBEBONJOUR_OWNER_COMPLETION_WORKER_ID: "owner-completion-worker",
  BEBEBONJOUR_OWNER_COMPLETION_WORKER_ACTIONS: "publish,queue_delivery,deliver",
  BEBEBONJOUR_OWNER_COMPLETION_WORKER_LIMIT: "1",
  BEBEBONJOUR_OWNER_COMPLETION_WORKER_LEASE_MS: "300000",
  CONVEX_URL: "https://example.convex.cloud",
  OWNER_PUBLICATION_ORIGIN: "https://announcements.example.test",
  OWNER_PUBLICATION_VERCEL_TEAM_ID: "team_owner",
  OWNER_PUBLICATION_VERCEL_PROJECT_ID: "prj_owner",
  OWNER_PUBLICATION_VERCEL_PROJECT_NAME: "bebebonjour-test-a-announcements",
  OWNER_VERCEL_BUILD_INSPECTION_B64: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
  OWNER_APPROVED_AUDIO_SHA256: `48387158${"a".repeat(53)}58c`,
  OWNER_APPROVED_AUDIO_BYTES: "173568",
  RESEND_API_KEY: "re_owner",
  OWNER_RESEND_FROM: "Bebe Bonjour <announcements@example.test>",
  VERCEL_TOKEN: "vercel-token",
  CRON_SECRET: "c".repeat(32),
};

function ownerJob() {
  return {
    jobId: OWNER_COMPLETION_JOB_ID,
    environment: "test",
    product: "announcement-page",
    narrationRequired: true,
    currentRevisionId: OWNER_COMPLETION_REVISION_ID,
    state: "publish_ready",
    version: 8,
    artifactSets: [{
      artifactSetId: "artifacts_owner",
      kind: "narration_review",
      revisionId: OWNER_COMPLETION_REVISION_ID,
      assetManifestDigest: OWNER_COMPLETION_MANIFEST_DIGEST,
      files: [
        { path: "deploy/index.html", storageId: "storage_page", bytes: 4, sha256: "a".repeat(64) },
        {
          path: "artifacts/audio/fr/welcome.mp3",
          storageId: "storage_audio",
          bytes: 173568,
          sha256: `48387158${"a".repeat(53)}58c`,
        },
      ],
    }],
    reviewDecisions: [{
      decisionId: OWNER_COMPLETION_NARRATION_DECISION_ID,
      decisionType: "narration",
      revisionId: OWNER_COMPLETION_REVISION_ID,
      outcome: "approved",
      artifactDigests: { assetManifestDigest: OWNER_COMPLETION_MANIFEST_DIGEST },
    }],
    stageAttempts: [],
    publication: null,
    deliveryAttempts: [],
    events: [],
  };
}

test("owner completion policy is exact and separate from TEST-A", () => {
  const policy = requireOwnerCompletionEnvironment(baseEnvironment);
  assert.deepEqual(policy.actions, OWNER_COMPLETION_ACTIONS);
  assert.equal(policy.jobId, OWNER_COMPLETION_JOB_ID);
  assert.equal(policy.recipient, OWNER_DELIVERY_EMAIL);
  for (const [name, value] of [
    ["BEBEBONJOUR_OWNER_COMPLETION_JOB_ID", "job_other"],
    ["BEBEBONJOUR_OWNER_COMPLETION_WORKER_ACTIONS", "publish,deliver"],
    ["OWNER_PUBLICATION_VERCEL_PROJECT_NAME", "other-project"],
  ]) {
    assert.throws(() => requireOwnerCompletionEnvironment({ ...baseEnvironment, [name]: value }));
  }
});

test("owner completion job accepts only the approved narrated release identity", () => {
  const job = ownerJob();
  assert.equal(assertOwnerCompletionJob(job), job);
  assert.throws(() => assertOwnerCompletionJob({ ...job, currentRevisionId: "r2" }), /exact approved/u);
  assert.throws(() => assertOwnerCompletionJob({ ...job, version: 7 }), /exact approved narrated release/u);
});

test("owner capabilities construct with production defaults and no automatic retry surface", async () => {
  const inspection = {
    schemaVersion: "1.0",
    source: "vercel inspect --format=json",
    deploymentId: "dpl_owner_reviewed",
    buildId: "bld_owner_reviewed",
    teamId: "team_owner",
    projectId: "prj_owner",
    projectName: "bebebonjour-test-a-announcements",
    revisionId: "r1",
  };
  const environment = {
    ...baseEnvironment,
    OWNER_VERCEL_BUILD_INSPECTION_B64: Buffer.from(`${JSON.stringify(inspection)}\n`).toString("base64"),
  };
  const capabilities = await createOwnerCompletionCapabilities({
    environment,
    policy: requireOwnerCompletionEnvironment(environment),
    client: { query: async () => null, mutation: async () => null },
    fulfillmentStore: { getJob: async () => ownerJob() },
    publicationProvider: { reconcile: async () => null, publish: async () => null },
    resend: { emails: { send: async () => ({ data: { id: "unused" } }), get: async () => ({ data: { last_event: "queued" } }) } },
  });
  assert.equal(typeof capabilities.fulfillmentOrchestrator.runExpectedStage, "function");
  assert.equal((await capabilities.fulfillmentOrchestrator.status(OWNER_COMPLETION_JOB_ID)).state, "publish_ready");
  assert.throws(
    () => capabilities.fulfillmentOrchestrator.status("job_other"),
    /restricted to the exact job/u,
  );
});

test("owner artifact resolver publishes exact page and audio behind a playable stable entrypoint", async () => {
  const page = Buffer.from("<!doctype html><html><body>Approved page</body></html>");
  const audio = Buffer.alloc(173568, 7);
  const audioDigest = (await import("node:crypto")).createHash("sha256").update(audio).digest("hex");
  const files = [
    { path: "deploy/fr/index.html", storageId: "page", bytes: page.length, sha256: (await import("node:crypto")).createHash("sha256").update(page).digest("hex") },
    { path: "artifacts/audio/fr/intro.mp3", storageId: "audio", bytes: audio.length, sha256: audioDigest },
  ];
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "1.0",
    kind: "narration_review",
    revisionId: OWNER_COMPLETION_REVISION_ID,
    files,
  }, null, 2)}\n`);
  const manifestDigest = (await import("node:crypto")).createHash("sha256").update(manifestBytes).digest("hex");
  const fetch = async (url) => {
    const bytes = new URL(url).searchParams.get("storageId") === "audio" ? audio : page;
    return new Response(bytes, { headers: { "cache-control": "private, no-store", "content-type": "application/octet-stream" } });
  };
  const resolver = createOwnerCompletionArtifactResolver({
    fetch,
    siteOrigin: "https://example.convex.site",
    completionToken: "o".repeat(32),
    expectedAudioSha256: audioDigest,
    expectedManifestDigest: manifestDigest,
  });
  const result = await resolver.resolve({
    jobId: OWNER_COMPLETION_JOB_ID,
    environment: "test",
    product: "announcement-page",
    revisionId: OWNER_COMPLETION_REVISION_ID,
    artifactManifestDigest: manifestDigest,
    artifactSet: { kind: "narration_review", revisionId: OWNER_COMPLETION_REVISION_ID, assetManifestDigest: manifestDigest, files },
    artifactReadAuthority: { workerId: "owner-completion-worker", commandId: "command_123", leaseToken: "lease_123" },
  });
  assert.equal(result.entrypointPath, "index.html");
  assert.deepEqual(result.files.map(({ publicPath }) => publicPath), [
    "fr/index.html",
    "audio/fr/intro.mp3",
    "index.html",
  ]);
  assert.equal(result.files[1].sha256, audioDigest);
  assert.deepEqual(result.files[0].bytes, page, "approved page bytes must stay exact");
  const shell = result.files[2].bytes.toString("utf8");
  assert.match(shell, /<iframe[^>]+src="\.\/fr\/index\.html"/u);
  assert.match(shell, /<audio[^>]+controls[^>]+src="\.\/audio\/fr\/intro\.mp3"/u);
  assert.equal(result.files[2].sha256, (await import("node:crypto")).createHash("sha256").update(result.files[2].bytes).digest("hex"));
  assert.deepEqual(result.manifestBytes, manifestBytes);
});

test("owner Resend adapter sends exactly one fenced idempotent owner email", async () => {
  const calls = [];
  const stableUrl = `https://announcements.example.test/announcements/${OWNER_COMPLETION_JOB_ID}`;
  const adapter = createResendOwnerDeliveryAdapter({
    from: "Bebe Bonjour <announcements@example.test>",
    stableUrl,
    clock: () => "2026-09-17T12:00:00.000Z",
    resend: { emails: {
      send: async (...args) => { calls.push(args); return { data: { id: "email_owner_1" }, error: null }; },
      get: async () => ({ data: { last_event: "delivered" }, error: null }),
    } },
  });
  const result = await adapter.send({
    jobId: OWNER_COMPLETION_JOB_ID,
    environment: "test",
    revisionId: OWNER_COMPLETION_REVISION_ID,
    artifactManifestDigest: OWNER_COMPLETION_MANIFEST_DIGEST,
    target: { targetRef: "resend:owner:z-at-havesomecode", email: OWNER_DELIVERY_EMAIL },
    targetDigest: "d".repeat(64),
    attemptStartedAt: "2026-09-17T11:59:00.000Z",
    idempotencyKey: "bb_" + "1".repeat(64),
    publication: { stableUrl },
    fenceExternalEffect: async (_fence, effect) => effect(),
  });
  assert.equal(result.providerMessageId, "email_owner_1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0].to, [OWNER_DELIVERY_EMAIL]);
  assert.equal(calls[0][1].idempotencyKey, "bb_" + "1".repeat(64));
  await assert.rejects(adapter.send({ environment: "test", target: { email: "other@example.test" } }), /exact owner/u);
});

test("owner worker is manual-only and Convex scope is exact without retry", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const configuration = JSON.parse(await readFile(path.join(root, "vercel.owner-completion-worker.json"), "utf8"));
  assert.equal(Object.hasOwn(configuration, "crons"), false);
  assert.deepEqual(configuration.routes, [{
    src: "/api/operations/owner-completion-worker",
    dest: "owner-completion-worker/api/worker.mjs",
  }]);

  const operations = await readFile(path.join(root, "convex/operations.js"), "utf8");
  const fulfillment = await readFile(path.join(root, "convex/fulfillment.js"), "utf8");
  assert.match(operations, /return "owner_completion"/u);
  assert.match(operations, /\["deliver", "publish", "queue_delivery"\]/u);
  const ownerClaimScope = operations.slice(
    operations.indexOf('if (scope === "owner_completion")'),
    operations.indexOf('if (scope !== "completion")', operations.indexOf('if (scope === "owner_completion")')),
  );
  assert.doesNotMatch(ownerClaimScope, /\bretry\b/u);
  assert.match(fulfillment, /review_c4c5a7589bf08d2f674671d0/u);
  assert.match(fulfillment, /OWNER_APPROVED_AUDIO_SHA256/u);
  assert.match(fulfillment, /audio\[0\]\.bytes !== 173568/u);
});
