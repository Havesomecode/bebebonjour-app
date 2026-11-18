import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";
import { signPersistedReviewApproval } from "../../src/fulfillment/persisted-review-decision.mjs";

const readPreparedBundle = makeFunctionReference("narration:readPreparedBundle");
const createNarrationReviewUploadUrl = makeFunctionReference("narration:createNarrationReviewUploadUrl");
const cleanupExpiredNarrationReviewUploadGrants = makeFunctionReference("narration:cleanupExpiredNarrationReviewUploadGrants");
const commitNarrationReviewArtifactSet = makeFunctionReference("narration:commitNarrationReviewArtifactSet");
const readNarrationReviewArtifactSet = makeFunctionReference("narration:readNarrationReviewArtifactSet");
const authorizePreparedBundleRead = makeFunctionReference("narration:authorizePreparedBundleRead");
const generateNarrationReview = makeFunctionReference("narration:generateNarrationReview");

const JOB_ID = "job_03c25b08-8476-4fe1-923b-43d73feab3ff";
const WORKER_TOKEN = "narration-worker-token-at-least-thirty-two-bytes";
const REVIEW_HMAC_KEY = "review-hmac-key-at-least-thirty-two-bytes";
const authority = Object.freeze({
  workerToken: WORKER_TOKEN,
  workerId: "test-a-narration-worker",
  commandId: "command_narration_authority_000001",
  leaseToken: "narration-authority-lease",
});

function fixture() {
  process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN = WORKER_TOKEN;
  process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = REVIEW_HMAC_KEY;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./narration.js": () => import("../../convex/narration.js"),
  });
}

test("narration uses internal authority capabilities and a claim-only server action", async () => {
  const source = await readFile(new URL("../../convex/narration.js", import.meta.url), "utf8");

  assert.match(source, /\bactionGeneric\b/u);
  assert.match(source, /\binternalMutationGeneric\b/u);
  assert.match(source, /\binternalQueryGeneric\b/u);
  assert.doesNotMatch(source, /\bmutationGeneric\b/u);
  for (const [name, factory] of [
    ["readPreparedBundle", "internalQueryGeneric"],
    ["createNarrationReviewUploadUrl", "internalMutationGeneric"],
    ["commitNarrationReviewArtifactSet", "internalMutationGeneric"],
    ["readNarrationReviewArtifactSet", "internalQueryGeneric"],
  ]) {
    assert.match(source, new RegExp(`export const ${name} = ${factory}\\(`, "u"));
  }
  assert.match(source, /export const generateNarrationReview = actionGeneric\(\{\s*args: CLAIMED_NARRATION_ARGS,/u);
});

async function seed(convex, { revisionId = "r1" } = {}) {
  const sourceBytes = Buffer.from("<main>approved private content</main>\n");
  const storageId = await convex.run((context) => context.storage.store(new Blob([sourceBytes])));
  const sourceFile = {
    path: "private-preview/canary/index.html",
    storageId,
    bytes: sourceBytes.byteLength,
    sha256: sha256(sourceBytes),
  };
  const narrationInput = canonicalNarrationInput(revisionId);
  const narrationInputBytes = Buffer.from(`${JSON.stringify(narrationInput, null, 2)}\n`);
  const narrationInputStorageId = await convex.run((context) => context.storage.store(
    new Blob([narrationInputBytes]),
  ));
  const privateNarrationInputFile = {
    path: "private-preview/canary/narration-input.json",
    storageId: narrationInputStorageId,
    bytes: narrationInputBytes.byteLength,
    sha256: sha256(narrationInputBytes),
  };
  const privateReviewFiles = [sourceFile, privateNarrationInputFile];
  const privateReview = {
    artifactSetId: "artifacts_private_review_001",
    kind: "private_review",
    revisionId,
    pageDigest: "1".repeat(64),
    transcriptDigest: "2".repeat(64),
    assetManifestDigest: manifestDigest("private_review", revisionId, privateReviewFiles),
    manifestRef: `jobs/${JOB_ID}/revisions/${revisionId}/manifests/private_review.json`,
    files: privateReviewFiles,
    sourceRunId: "attempt_prepare_review_001",
    operationsCommandId: "command_generate_000001",
  };
  const preparedFile = { ...sourceFile, path: "deploy/index.html" };
  const preparedNarrationInputFile = { ...privateNarrationInputFile, path: "deploy/narration-input.json" };
  const preparedFiles = [preparedFile, preparedNarrationInputFile];
  const preparedBundle = {
    artifactSetId: "artifacts_prepared_bundle_001",
    kind: "prepared_bundle",
    revisionId,
    pageDigest: privateReview.pageDigest,
    transcriptDigest: privateReview.transcriptDigest,
    assetManifestDigest: manifestDigest("prepared_bundle", revisionId, preparedFiles),
    manifestRef: `jobs/${JOB_ID}/revisions/${revisionId}/manifests/prepared_bundle.json`,
    files: preparedFiles,
    sourcePrivateReviewManifestDigest: privateReview.assetManifestDigest,
    operationsCommandId: "command_render_approved_000001",
  };
  const aggregate = {
    schemaVersion: "1.1",
    authority: "convex-target/local-test-projection",
    jobId: JOB_ID,
    environment: "test",
    product: "announcement-page",
    intakeDigest: "a".repeat(64),
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId: JOB_ID,
      intakeDigest: "a".repeat(64),
    },
    narrationRequired: true,
    state: "tts_generating",
    version: 9,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:05:00.000Z",
    currentRevisionId: revisionId,
    publishedRevisionId: null,
    retry: null,
    payment: { providerPaymentId: "pi_narration_authority" },
    revisions: [{ revisionId, ordinal: 1 }],
    artifactSets: [privateReview, preparedBundle],
    reviewDecisions: [{
      decisionId: "review_content_approved_001",
      approvalId: null,
      operationsCommandId: "command_content_approval_000001",
      decisionType: "content",
      revisionId,
      outcome: "approved",
      policyVersion: "bebebonjour-editorial-v1",
      rubricVersion: "test-a-rubric-v1",
      reviewer: { id: "human-reviewer", role: "human_reviewer", competencies: ["content_review"] },
      decidedAt: "2026-09-20T10:02:00.000Z",
      artifactDigests: {
        pageDigest: privateReview.pageDigest,
        transcriptDigest: privateReview.transcriptDigest,
        assetManifestDigest: privateReview.assetManifestDigest,
      },
      reasons: [],
    }],
    stageAttempts: [{
      attemptId: "attempt_prepare_review_001",
      stage: "prepare_review",
      revisionId,
      attemptNumber: 1,
      operationNumber: 1,
      idempotencyKey: "bb_prepare_review_001",
      operationBinding: null,
      operationsCommandId: "command_generate_000001",
      status: "completed",
      leaseToken: null,
      leaseExpiresAt: null,
      startedAt: "2026-09-20T10:00:00.000Z",
      effectStartedAt: null,
      completedAt: "2026-09-20T10:01:00.000Z",
      failure: null,
    }, {
      attemptId: "attempt_generate_tts_001",
      stage: "generate_tts",
      revisionId,
      attemptNumber: 1,
      operationNumber: 1,
      idempotencyKey: "bb_generate_tts_001",
      operationBinding: null,
      operationsCommandId: authority.commandId,
      status: "running",
      leaseToken: authority.leaseToken,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      startedAt: "2026-09-20T10:05:00.000Z",
      effectStartedAt: "2026-09-20T10:05:01.000Z",
      completedAt: null,
      failure: null,
    }],
    publication: null,
    deliveryAttempts: [],
    events: [],
  };
  const approval = signPersistedReviewApproval({
    hmacKey: REVIEW_HMAC_KEY,
    job: aggregate,
    decision: {
      commandId: "ignored-by-signing",
      decisionType: "content",
      revisionId,
      outcome: "approved",
      policyVersion: "bebebonjour-editorial-v1",
      rubricVersion: "test-a-rubric-v1",
      reviewer: { id: "human-reviewer", role: "human_reviewer", competencies: ["content_review"] },
      decidedAt: "2026-09-20T10:02:00.000Z",
      artifactDigests: aggregate.reviewDecisions[0].artifactDigests,
      reasons: [],
    },
  });
  aggregate.reviewDecisions[0].approvalId = approval.approvalId;

  await convex.run(async (context) => {
    await context.db.insert("fulfillmentJobs", { jobId: JOB_ID, aggregate });
    await context.db.insert("fulfillmentReviewApprovals", { approvalId: approval.approvalId, approval });
    await context.db.insert("customerFlowOperationsCommands", {
      commandId: authority.commandId,
      jobId: JOB_ID,
      action: "generate_narration",
      expectedState: "tts_queued",
      expectedVersion: 8,
      payload: {
        revisionId,
        artifactManifestDigest: preparedBundle.assetManifestDigest,
      },
      requestedAt: "2026-09-20T10:04:00.000Z",
      requestedBy: "primary_operator",
      state: "running",
      attempts: 1,
      claim: {
        workerId: authority.workerId,
        leaseToken: authority.leaseToken,
        claimedAtMs: Date.now(),
        leaseExpiresAtMs: Date.now() + 600_000,
        effectStartedAtMs: Date.now(),
      },
      lastFailureReason: null,
      outcome: null,
      updatedAt: "2026-09-20T10:05:00.000Z",
    });
  });
  return { aggregate, preparedBundle, sourceFile };
}

test("narration authority reads only the exact approved immutable prepared bundle", async () => {
  const convex = fixture();
  const { preparedBundle, sourceFile } = await seed(convex);
  const externallyReadableBundle = {
    ...preparedBundle,
    files: preparedBundle.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };

  assert.deepEqual(await convex.query(readPreparedBundle, { ...authority, jobId: JOB_ID }), {
    artifactSet: externallyReadableBundle,
    files: externallyReadableBundle.files,
  });
  assert.deepEqual(await convex.query(authorizePreparedBundleRead, {
    ...authority,
    jobId: JOB_ID,
    revisionId: "r1",
    path: "deploy/index.html",
  }), { ...sourceFile, path: "deploy/index.html" });

  await assert.rejects(
    convex.query(readPreparedBundle, { ...authority, jobId: "job_03c25b08-8476-4fe1-923b-43d73feab3fe" }),
    /authorization|fixed/u,
  );
  await assert.rejects(
    convex.query(authorizePreparedBundleRead, {
      ...authority,
      jobId: JOB_ID,
      revisionId: "r1",
      path: "private-preview/canary/index.html",
    }),
    /file is missing|prepared bundle/u,
  );
});

test("narration authority rejects wrong and expired exact command claims", async () => {
  const convex = fixture();
  await seed(convex);

  await assert.rejects(
    convex.query(readPreparedBundle, {
      ...authority,
      jobId: JOB_ID,
      workerId: "forged-narration-worker",
    }),
    /authorization|fixed/u,
  );
  await assert.rejects(
    convex.mutation(createNarrationReviewUploadUrl, {
      ...authority,
      jobId: JOB_ID,
      leaseToken: "forged-narration-lease",
      expectedFile: { path: "narration/rejected.json", bytes: 1, sha256: "a".repeat(64) },
    }),
    /claim authorization/u,
  );
  await convex.run(async (context) => {
    const command = await context.db.query("customerFlowOperationsCommands")
      .withIndex("by_command_id", (query) => query.eq("commandId", authority.commandId))
      .unique();
    await context.db.patch(command._id, {
      claim: { ...command.claim, leaseExpiresAtMs: Date.now() - 1 },
    });
  });
  await assert.rejects(
    convex.query(readPreparedBundle, { ...authority, jobId: JOB_ID }),
    /claim authorization/u,
  );
});

test("narration authority rejects a legacy aggregate before prepared-bundle access", async () => {
  const convex = fixture();
  await seed(convex);
  await convex.run(async (context) => {
    const job = await context.db.query("fulfillmentJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", JOB_ID))
      .unique();
    await context.db.patch(job._id, {
      aggregate: { ...job.aggregate, schemaVersion: "1.0" },
    });
  });

  await assert.rejects(
    convex.query(readPreparedBundle, { ...authority, jobId: JOB_ID }),
    /schema version|exact TEST-A tts transition/u,
  );
});

test("narration upload grants use canonical SHA-256 scope identities and bounded live capacity", async () => {
  const convex = fixture();
  await seed(convex);
  const grantIds = [];
  const firstExpectedFile = uploadIntentFor("narration/grant-0.json");
  const firstGrant = await convex.mutation(createNarrationReviewUploadUrl, {
    ...authority,
    jobId: JOB_ID,
    expectedFile: firstExpectedFile,
  });
  grantIds.push(firstGrant.grantId);

  const firstDocument = await convex.run((context) => context.db
    .query("fulfillmentNarrationUploadGrants")
    .withIndex("by_grant_id", (query) => query.eq("grantId", firstGrant.grantId))
    .unique());
  const canonicalScope = canonicalJson({
    commandId: authority.commandId,
    expectedFile: firstExpectedFile,
    jobId: JOB_ID,
    leaseToken: authority.leaseToken,
    revisionId: "r1",
  });
  assert.equal(firstDocument.scopeKey, createHash("sha256").update(canonicalScope).digest("hex"));
  assert.match(firstDocument.scopeKey, /^[a-f0-9]{64}$/u);
  await assert.rejects(
    convex.mutation(createNarrationReviewUploadUrl, {
      ...authority,
      jobId: JOB_ID,
      expectedFile: { ...firstExpectedFile, storageId: "forbidden-upload-intent-storage-id" },
    }),
    /upload intent is invalid/u,
  );
  await assert.rejects(
    convex.mutation(createNarrationReviewUploadUrl, {
      ...authority,
      jobId: JOB_ID,
      expectedFile: firstExpectedFile,
    }),
    /already active|duplicate/u,
  );

  for (let index = 1; index < 256; index += 1) {
    const grant = await convex.mutation(createNarrationReviewUploadUrl, {
      ...authority,
      jobId: JOB_ID,
      expectedFile: uploadIntentFor(`narration/grant-${index}.json`),
    });
    grantIds.push(grant.grantId);
  }
  await assert.rejects(
    convex.mutation(createNarrationReviewUploadUrl, {
      ...authority,
      jobId: JOB_ID,
      expectedFile: uploadIntentFor("narration/over-count-cap.json"),
    }),
    /budget/u,
  );

  await convex.run(async (context) => {
    const expired = await context.db.query("fulfillmentNarrationUploadGrants")
      .withIndex("by_grant_id", (query) => query.eq("grantId", grantIds[0]))
      .unique();
    await context.db.patch(expired._id, { expiresAtMs: Date.now() - 1 });
  });
  const recovered = await convex.mutation(createNarrationReviewUploadUrl, {
    ...authority,
    jobId: JOB_ID,
    expectedFile: uploadIntentFor("narration/recovered-capacity.json"),
  });
  assert.match(recovered.grantId, /^narration_upload_[a-f0-9]{24}$/u);
});

test("narration upload cleanup derives the exact authorized non-r1 revision", async () => {
  const convex = fixture();
  await seed(convex, { revisionId: "r2" });
  const grant = await convex.mutation(createNarrationReviewUploadUrl, {
    ...authority,
    jobId: JOB_ID,
    expectedFile: uploadIntentFor("narration/revision-r2.json"),
  });
  await convex.run(async (context) => {
    const document = await context.db.query("fulfillmentNarrationUploadGrants")
      .withIndex("by_grant_id", (query) => query.eq("grantId", grant.grantId))
      .unique();
    await context.db.patch(document._id, { expiresAtMs: Date.now() - 1 });
  });

  assert.deepEqual(await convex.mutation(cleanupExpiredNarrationReviewUploadGrants, {
    ...authority,
    jobId: JOB_ID,
  }), { deleted: 1 });
  assert.equal(await convex.run((context) => context.db
    .query("fulfillmentNarrationUploadGrants")
    .withIndex("by_grant_id", (query) => query.eq("grantId", grant.grantId))
    .unique()), null);
});

test("narration upload grants reject aggregate expected bytes beyond the live scope budget", async () => {
  const convex = fixture();
  await seed(convex);
  const maxFileBytes = 20 * 1024 * 1024;
  for (let index = 0; index < 12; index += 1) {
    await convex.mutation(createNarrationReviewUploadUrl, {
      ...authority,
      jobId: JOB_ID,
      expectedFile: uploadIntentFor(`narration/byte-cap-${index}.bin`, maxFileBytes),
    });
  }
  await assert.rejects(
    convex.mutation(createNarrationReviewUploadUrl, {
      ...authority,
      jobId: JOB_ID,
      expectedFile: uploadIntentFor("narration/over-byte-cap.bin", maxFileBytes),
    }),
    /budget/u,
  );
});

test("narration commit atomically completes generate_tts with derived aggregate provenance and is idempotent", async () => {
  const convex = fixture();
  const { aggregate, preparedBundle } = await seed(convex);
  const bytes = Buffer.from("private narration review\n");
  const storageId = await convex.run((context) => context.storage.store(new Blob([bytes])));
  const artifactSet = {
    kind: "narration_review",
    revisionId: "r1",
    pageDigest: preparedBundle.pageDigest,
    transcriptDigest: preparedBundle.transcriptDigest,
    assetManifestDigest: manifestDigest("narration_review", "r1", [{
      path: "narration/review.json", storageId, bytes: bytes.byteLength, sha256: sha256(bytes),
    }]),
    sourcePreparedBundleManifestDigest: preparedBundle.assetManifestDigest,
    manifestRef: `jobs/${JOB_ID}/revisions/r1/manifests/narration_review.json`,
    files: [{ path: "narration/review.json", storageId, bytes: bytes.byteLength, sha256: sha256(bytes) }],
  };

  const grant = await convex.mutation(createNarrationReviewUploadUrl, {
    ...authority,
    jobId: JOB_ID,
    expectedFile: {
      path: artifactSet.files[0].path,
      bytes: artifactSet.files[0].bytes,
      sha256: artifactSet.files[0].sha256,
    },
  });
  assert.match(grant.uploadUrl, /^https?:\/\//u);
  assert.match(grant.grantId, /^narration_upload_[a-f0-9]{24}$/u);
  assert.deepEqual(await convex.mutation(commitNarrationReviewArtifactSet, {
    ...authority, jobId: JOB_ID, artifactSet, uploadGrantIds: [grant.grantId],
  }), { created: true, artifactSet });
  const committed = await convex.run(async (context) => {
    const [job, command] = await Promise.all([
      context.db.query("fulfillmentJobs")
        .withIndex("by_job_id", (query) => query.eq("jobId", JOB_ID)).unique(),
      context.db.query("customerFlowOperationsCommands")
        .withIndex("by_command_id", (query) => query.eq("commandId", authority.commandId)).unique(),
    ]);
    const narration = job.aggregate.artifactSets.at(-1);
    await context.db.patch(command._id, {
      state: "completed",
      claim: null,
      outcome: {
        code: "narration_prepared",
        jobVersion: job.aggregate.version,
        revisionId: "r1",
        artifactSetId: narration.artifactSetId,
      },
    });
    return job.aggregate;
  });
  assert.deepEqual(await convex.query(readNarrationReviewArtifactSet, {
    ...authority, jobId: JOB_ID, revisionId: "r1",
  }), { artifactSet, files: artifactSet.files });
  const reordered = {
    files: artifactSet.files,
    manifestRef: artifactSet.manifestRef,
    transcriptDigest: artifactSet.transcriptDigest,
    sourcePreparedBundleManifestDigest: artifactSet.sourcePreparedBundleManifestDigest,
    kind: artifactSet.kind,
    revisionId: artifactSet.revisionId,
    assetManifestDigest: artifactSet.assetManifestDigest,
    pageDigest: artifactSet.pageDigest,
  };
  assert.deepEqual(await convex.mutation(commitNarrationReviewArtifactSet, {
    ...authority, jobId: JOB_ID, artifactSet: reordered, uploadGrantIds: [grant.grantId],
  }), { created: false, artifactSet });
  await assert.rejects(
    convex.mutation(commitNarrationReviewArtifactSet, {
      ...authority,
      jobId: JOB_ID,
      artifactSet: { ...artifactSet, sourcePreparedBundleManifestDigest: "0".repeat(64) },
      uploadGrantIds: [grant.grantId],
    }),
    /immutable|prepared bundle/u,
  );

  const current = committed;
  assert.equal(current.version, aggregate.version + 1);
  assert.equal(current.state, "narration_review_required");
  const narration = current.artifactSets.at(-1);
  assert.equal(narration.kind, "narration_review");
  assert.equal(narration.sourceRunId, "attempt_generate_tts_001");
  assert.equal(narration.operationsCommandId, authority.commandId);
  assert.equal(narration.sourcePreparedBundleManifestDigest, preparedBundle.assetManifestDigest);
  assert.deepEqual(narration.files, artifactSet.files);
  const attempt = current.stageAttempts.at(-1);
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.completedAt, current.updatedAt);
  assert.equal(attempt.leaseToken, null);
  assert.equal(attempt.leaseExpiresAt, null);
  assert.equal(current.events.at(-1).type, "stage_completed");
  assert.equal(current.events.at(-1).commandId, "complete:attempt_generate_tts_001");
  assert.equal(current.events.at(-1).state, "narration_review_required");
  assert.equal(await convex.run((context) => context.db
    .query("fulfillmentNarrationReviewArtifactSets")
    .withIndex("by_job_revision", (query) => query.eq("jobId", JOB_ID).eq("revisionId", "r1"))
    .unique()), null);
});

test("narration terminal recovery survives an expired completed command lease", async () => {
  const convex = fixture();
  const { preparedBundle } = await seed(convex);
  const bytes = Buffer.from("durable narration recovery\n");
  const storageId = await convex.run((context) => context.storage.store(new Blob([bytes])));
  const artifactSet = {
    kind: "narration_review",
    revisionId: "r1",
    pageDigest: preparedBundle.pageDigest,
    transcriptDigest: preparedBundle.transcriptDigest,
    assetManifestDigest: manifestDigest("narration_review", "r1", [{
      path: "narration/recovery.json", storageId, bytes: bytes.byteLength, sha256: sha256(bytes),
    }]),
    sourcePreparedBundleManifestDigest: preparedBundle.assetManifestDigest,
    manifestRef: `jobs/${JOB_ID}/revisions/r1/manifests/narration_review.json`,
    files: [{ path: "narration/recovery.json", storageId, bytes: bytes.byteLength, sha256: sha256(bytes) }],
  };
  const grant = await convex.mutation(createNarrationReviewUploadUrl, {
    ...authority,
    jobId: JOB_ID,
    expectedFile: {
      path: artifactSet.files[0].path,
      bytes: artifactSet.files[0].bytes,
      sha256: artifactSet.files[0].sha256,
    },
  });
  await convex.mutation(commitNarrationReviewArtifactSet, {
    ...authority,
    jobId: JOB_ID,
    artifactSet,
    uploadGrantIds: [grant.grantId],
  });
  await convex.run(async (context) => {
    const [job, command] = await Promise.all([
      context.db.query("fulfillmentJobs")
        .withIndex("by_job_id", (query) => query.eq("jobId", JOB_ID)).unique(),
      context.db.query("customerFlowOperationsCommands")
        .withIndex("by_command_id", (query) => query.eq("commandId", authority.commandId)).unique(),
    ]);
    const narration = job.aggregate.artifactSets.at(-1);
    await context.db.patch(command._id, {
      state: "completed",
      claim: { ...command.claim, leaseExpiresAtMs: Date.now() - 1 },
      outcome: {
        code: "narration_prepared",
        jobVersion: job.aggregate.version,
        revisionId: "r1",
        artifactSetId: narration.artifactSetId,
      },
    });
  });

  assert.deepEqual(await convex.query(readNarrationReviewArtifactSet, {
    ...authority,
    jobId: JOB_ID,
    revisionId: "r1",
  }), { artifactSet, files: artifactSet.files });
  assert.deepEqual(await convex.mutation(commitNarrationReviewArtifactSet, {
    ...authority,
    jobId: JOB_ID,
    artifactSet,
    uploadGrantIds: [],
  }), { created: false, artifactSet });
});

test("server-side narration action derives only canonical approved input and commits bounded output", async (t) => {
  const convex = fixture();
  const { preparedBundle } = await seed(convex);
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const requests = [];
  process.env.OPENAI_API_KEY = "synthetic-openai-api-key-at-least-thirty-two-bytes";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  const result = await convex.action(generateNarrationReview, { ...authority, jobId: JOB_ID });
  assert.equal(result.created, true);
  assert.equal(result.artifactSet.files.length, 6);
  assert.equal(requests.length, 6);
  assert.deepEqual(requests.map((request) => request.body.model), Array(6).fill("gpt-4o-mini-tts"));
  assert.deepEqual(requests.map((request) => request.body.voice), Array(6).fill("cedar"));
  assert.equal(requests.some((request) => Object.hasOwn(request.body, "storageId")), false);
  assert.equal(requests.every((request) => /^[a-f0-9]{64}$/u.test(request.headers["Idempotency-Key"])), true);
  assert.equal(new Set(requests.map((request) => request.headers["Idempotency-Key"])).size, 6);
  assert.equal(result.artifactSet.sourcePreparedBundleManifestDigest, preparedBundle.assetManifestDigest);
  const job = await convex.run((context) => context.db.query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", JOB_ID)).unique());
  assert.equal(job.aggregate.state, "narration_review_required");
  assert.equal(job.aggregate.artifactSets.at(-1).kind, "narration_review");
  const effects = await convex.run((context) => context.db
    .query("fulfillmentNarrationProviderEffects")
    .collect());
  assert.equal(effects.length, 6);
  assert.equal(effects.every((effect) => effect.state === "stored"), true);
  assert.deepEqual(await convex.action(generateNarrationReview, { ...authority, jobId: JOB_ID }), {
    created: false,
    artifactSet: result.artifactSet,
  });
  assert.equal(requests.length, 6);
});

test("narration provider effect issuance fences an ambiguous retry before a second provider call", async (t) => {
  const convex = fixture();
  await seed(convex);
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  process.env.OPENAI_API_KEY = "synthetic-openai-api-key-at-least-thirty-two-bytes";
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("synthetic ambiguous provider disconnect");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  await assert.rejects(
    convex.action(generateNarrationReview, { ...authority, jobId: JOB_ID }),
    /synthetic ambiguous provider disconnect/u,
  );
  assert.equal(calls, 1);
  const effects = await convex.run((context) => context.db
    .query("fulfillmentNarrationProviderEffects")
    .collect());
  assert.equal(effects.length, 1);
  assert.equal(effects[0].state, "issued");

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 });
  };
  await assert.rejects(
    convex.action(generateNarrationReview, { ...authority, jobId: JOB_ID }),
    /unresolved; reconciliation is required/u,
  );
  assert.equal(calls, 1);
});

test("narration provider effect claim rejects a stale lease before provider issuance", async () => {
  const convex = fixture();
  await seed(convex);
  await convex.run(async (context) => {
    const command = await context.db.query("customerFlowOperationsCommands")
      .withIndex("by_command_id", (query) => query.eq("commandId", authority.commandId)).unique();
    await context.db.patch(command._id, {
      claim: { ...command.claim, leaseExpiresAtMs: Date.now() - 1 },
    });
  });

  await assert.rejects(
    convex.action(generateNarrationReview, { ...authority, jobId: JOB_ID }),
    /claim authorization failed/u,
  );
  const effects = await convex.run((context) => context.db
    .query("fulfillmentNarrationProviderEffects")
    .collect());
  assert.equal(effects.length, 0);
});

test("narration rejects a forged prepared bundle before artifact access", async () => {
  const convex = fixture();
  await seed(convex);
  await convex.run(async (context) => {
    const job = await context.db.query("fulfillmentJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", JOB_ID)).unique();
    const aggregate = structuredClone(job.aggregate);
    aggregate.artifactSets[1].files[0].sha256 = "f".repeat(64);
    await context.db.patch(job._id, { aggregate });
  });
  await assert.rejects(
    convex.query(readPreparedBundle, { ...authority, jobId: JOB_ID }),
    /immutable approved content promotion|integrity|blob/u,
  );
});

function canonicalNarrationInput(revisionId) {
  const languages = ["ar"];
  const sectionOrder = ["intro", "dua", "meaning", "reveal", "verses", "closing"];
  return {
    schemaVersion: "1.0",
    pageId: "page_narration_authority_001",
    revisionId,
    provider: "openai",
    model: "gpt-4o-mini-tts",
    languages,
    sectionOrder,
    segments: sectionOrder.map((section, index) => ({
      language: "ar",
      section,
      ordinal: index + 1,
      voice: "cedar",
      instructions: "Warm and intimate family joy.",
      text: `Approved ${section} narration.`,
    })),
  };
}

function manifestDigest(kind, revisionId, files) {
  return sha256(`${JSON.stringify({
    schemaVersion: "1.0",
    kind,
    revisionId,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
  }, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  throw new Error("Test scope values must contain deterministic JSON only.");
}

function uploadIntentFor(path, bytes = 1) {
  return { path, bytes, sha256: sha256(Buffer.from(`expected:${path}:${bytes}`)) };
}
