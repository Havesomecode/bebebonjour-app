import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const workerToken = "narration-worker-test-token-32-characters";
const generationToken = "tts-worker-lifecycle-token-32-characters";
const operatorToken = "operator-narration-test-32-characters";
const operationsWorkerToken = "operations-worker-narration-test-32-characters";
const jobId = "job_narration_lifecycle";
const workerId = "hosted-narration-worker";
async function fixture() {
  process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN = workerToken;
  process.env.BEBEBONJOUR_TTS_WORKER_TOKEN = generationToken;
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = operationsWorkerToken;
  const t = convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./operations.js": () => import("../../convex/operations.js"),
    "./narration.js": () => import("../../convex/narration.js"),
    "./narrationRuntime.js": () => import("../../convex/narrationRuntime.js"),
    "./http.js": () => import("../../convex/http.js"),
  });
  const page = JSON.stringify({
    languages: ["fr"],
    sectionOrder: ["welcome"],
    sections: {
      welcome: { fr: { narrationText: "Bienvenue dans notre famille." } },
    },
  });
  const transcript = JSON.stringify({
    languages: {
      fr: [{ sectionId: "welcome", text: "Bienvenue dans notre famille." }],
    },
  });
  const files = [];
  for (const [path, raw] of [
    ["artifacts/current/page.json", page],
    ["artifacts/current/transcript.json", transcript],
    ["private-preview/fiction/fr/index.html", "<html>Bienvenue</html>"],
  ]) {
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([raw])));
    files.push({
      path,
      storageId,
      bytes: Buffer.byteLength(raw),
      sha256: hash(raw),
    });
  }
  const source = {
    kind: "private_review",
    revisionId: "r1",
    pageDigest: hash(page),
    transcriptDigest: hash(transcript),
    assetManifestDigest: hash("source-manifest"),
    manifestRef: `jobs/${jobId}/revisions/r1/manifests/private_review.json`,
    files,
  };
  const now = new Date().toISOString();
  const aggregate = {
    schemaVersion: "1.0",
    jobId,
    environment: "test",
    product: "announcement-page",
    intakeDigest: hash("fictional"),
    narrationRequired: true,
    state: "content_review_required",
    version: 4,
    createdAt: now,
    updatedAt: now,
    currentRevisionId: "r1",
    publishedRevisionId: null,
    retry: null,
    payment: null,
    revisions: [
      { revisionId: "r1", ordinal: 1, inputDigest: hash("fictional") },
    ],
    artifactSets: [source],
    reviewDecisions: [],
    stageAttempts: [],
    publication: null,
    deliveryAttempts: [],
    events: [],
  };
  await t.run(async (ctx) => {
    await ctx.db.insert("fulfillmentJobs", { jobId, aggregate });
    await ctx.db.insert("customerFlowJobs", {
      jobId,
      job: { jobId, intake: {}, payment: { status: "paid" } },
    });
  });
  return { t, source };
}
async function read(t) {
  return t.run(
    async (ctx) => (await ctx.db.query("fulfillmentJobs").first()).aggregate,
  );
}
async function command(t, action) {
  const job = await read(t);
  const kind = action.includes("narration")
    ? "narration_review"
    : "private_review";
  const a = job.artifactSets.filter((a) => a.kind === kind).at(-1);
  const payload =
    action.includes("approve") ||
    action.includes("changes") ||
    action.includes("reject")
      ? {
          revisionId: "r1",
          artifactManifestDigest: a.assetManifestDigest,
          artifactDigests: Object.fromEntries(
            ["pageDigest", "transcriptDigest", "assetManifestDigest"].map(
              (k) => [k, a[k]],
            ),
          ),
          ...(action.includes("changes")
            ? { reasonCodes: ["pronunciation"] }
            : {}),
        }
      : {};
  const commandId = `command_narration_${job.version}_${action}`;
  await t.mutation(ref("operations:requestCommand"), {
    operatorToken,
    commandId,
    jobId,
    action,
    expectedState: job.state,
    expectedVersion: job.version,
    payload,
  });
  const commandWorkerToken =
    action === "generate_narration" ? generationToken : workerToken;
  const [claimed] = await t.mutation(ref("operations:claimCommands"), {
    workerToken: commandWorkerToken,
    workerId,
    jobId,
    actions: [action],
    limit: 1,
    leaseMs: 300000,
  });
  assert.ok(claimed);
  const auth = {
    workerToken: commandWorkerToken,
    workerId,
    jobId,
    commandId,
    leaseToken: claimed.claim.leaseToken,
  };
  await t.mutation(ref("operations:fenceCommand"), {
    workerToken: commandWorkerToken,
    workerId,
    commandId,
    leaseToken: auth.leaseToken,
    leaseMs: 300000,
    effectMayBeIssued: false,
  });
  return auth;
}
async function finish(t, auth, outcome) {
  const { jobId: _jobId, ...rest } = auth;
  await t.mutation(ref("operations:completeCommand"), { ...rest, outcome });
}
async function beginNarrationGeneration(t) {
  let auth = await command(t, "approve_content");
  await finish(
    t,
    auth,
    await t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "review",
    }),
  );
  auth = await command(t, "render");
  await finish(
    t,
    auth,
    await t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "render",
    }),
  );
  auth = await command(t, "generate_narration");
  await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "begin",
  });
  return auth;
}
async function expireNarrationClaim(t, auth) {
  await t.run(async (ctx) => {
    const sourceCommand = await ctx.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_command_id", (query) => query.eq("commandId", auth.commandId))
      .unique();
    const fulfillment = await ctx.db
      .query("fulfillmentJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
      .unique();
    const aggregate = structuredClone(fulfillment.aggregate);
    aggregate.stageAttempts.at(-1).leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    await ctx.db.patch(fulfillment._id, { aggregate });
    await ctx.db.patch(sourceCommand._id, {
      claim: { ...sourceCommand.claim, leaseExpiresAtMs: Date.now() - 1 },
    });
  });
}
test("supported fictional bootstrap creates an unpaid operator-authored narrated job without rewriting a job", async () => {
  const { t } = await fixture();
  const input = {
    operatorToken,
    language: "fr",
    text: "Bienvenue, petit soleil. Cette famille est fictive.",
    acknowledgement: "fictional-operator-authored-not-codex",
  };
  delete process.env.BEBEBONJOUR_NARRATION_TESTS_ENABLED;
  await assert.rejects(
    t.action(ref("narrationRuntime:createFictionalTest"), input),
  );
  process.env.BEBEBONJOUR_NARRATION_TESTS_ENABLED = "true";
  await assert.rejects(
    t.action(ref("narrationRuntime:createFictionalTest"), {
      ...input,
      operatorToken: workerToken,
    }),
  );
  const created = await t.action(
    ref("narrationRuntime:createFictionalTest"),
    input,
  );
  const view = await t.query(ref("operations:getJob"), {
    operatorToken,
    jobId: created.jobId,
  });
  assert.equal(view.fulfillment.narrationRequired, true);
  assert.equal(view.fulfillment.state, "content_review_required");
  assert.equal(view.fulfillment.payment, null);
  assert.equal(view.customer.payment.status, "not_applicable");
  assert.equal(view.fulfillment.reviewDecisions.length, 0);
  assert.equal(view.fulfillment.artifactSets.length, 1);
  for (const file of view.fulfillment.artifactSets[0].files) {
    const contentType = await t.run(async (ctx) => (await ctx.storage.get(file.storageId)).type);
    assert.equal(
      contentType,
      file.path.endsWith(".json") ? "application/json" : "text/html; charset=utf-8",
      "Production Convex storage requires an explicit non-empty Content-Type",
    );
  }
  assert.equal((await read(t)).version, 4);
  assert.ok(
    view.fulfillment.events.some(
      (e) => e.type === "operator_test_content_authored",
    ),
  );
  delete process.env.BEBEBONJOUR_NARRATION_TESTS_ENABLED;
});
test("durable narration commits before review and private playback survives approval", async () => {
  const { t } = await fixture();
  let auth = await command(t, "approve_content");
  await finish(
    t,
    auth,
    await t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "review",
    }),
  );
  auth = await command(t, "render");
  await finish(
    t,
    auth,
    await t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "render",
    }),
  );
  auth = await command(t, "generate_narration");
  await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "begin",
  });
  const { jobId: _, ...fence } = auth;
  await t.mutation(ref("operations:fenceCommand"), {
    ...fence,
    leaseMs: 300000,
    effectMayBeIssued: true,
  });
  await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "fence",
  });
  const job = await read(t);
  const prepared = job.artifactSets.at(-1);
  const files = [...prepared.files];
  const review = {
    schemaVersion: "1.0",
    jobId,
    revisionId: "r1",
    preparedManifestDigest: prepared.assetManifestDigest,
    sourcePrivateReviewManifestDigest:
      prepared.sourcePrivateReviewManifestDigest,
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    aiGenerated: true,
    clips: [
      {
        language: "fr",
        section: "welcome",
        path: "artifacts/audio/fr/welcome.mp3",
        durationSeconds: 1,
      },
    ],
  };
  let transcriptDigest;
  for (const [path, raw] of [
    ["artifacts/audio/fr/welcome.mp3", "fixture-audio-not-provider-proof"],
    [
      "artifacts/transcript.json",
      JSON.stringify({
        version: 1,
        tracks: {
          fr: [
            {
              section: "welcome",
              text: "Bienvenue dans notre famille.",
              seconds: 0,
              time: "00:00",
            },
          ],
        },
      }),
    ],
    ["artifacts/narration-review.json", JSON.stringify(review)],
  ]) {
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([raw])));
    files.push({
      path,
      storageId,
      bytes: Buffer.byteLength(raw),
      sha256: hash(raw),
    });
    if (path === "artifacts/transcript.json") transcriptDigest = hash(raw);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const artifactSet = {
    kind: "narration_review",
    revisionId: "r1",
    pageDigest: prepared.pageDigest,
    transcriptDigest,
    sourcePreparedBundleManifestDigest: prepared.assetManifestDigest,
    assetManifestDigest: hash(
      `${JSON.stringify({ schemaVersion: "1.0", kind: "narration_review", revisionId: "r1", files: files.map(({ path, storageId, bytes, sha256 }) => ({ path, storageId, bytes, sha256 })) }, null, 2)}\n`,
    ),
    manifestRef: `jobs/${jobId}/revisions/r1/manifests/narration_review.json`,
    files,
  };
  await assert.rejects(
    t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "complete",
      artifactSet: { ...artifactSet, pageDigest: "0".repeat(64) },
    }),
    /binding/,
  );
  const changed = structuredClone(artifactSet);
  const transcriptFile = changed.files.find(
    (file) => file.path === "artifacts/transcript.json",
  );
  const changedRaw = JSON.stringify({
    version: 1,
    tracks: {
      fr: [
        {
          section: "welcome",
          text: "Unapproved replacement",
          seconds: 0,
          time: "00:00",
        },
      ],
    },
  });
  transcriptFile.storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([changedRaw])),
  );
  transcriptFile.sha256 = hash(changedRaw);
  transcriptFile.bytes = Buffer.byteLength(changedRaw);
  changed.transcriptDigest = transcriptFile.sha256;
  changed.assetManifestDigest = hash(
    `${JSON.stringify({ schemaVersion: "1.0", kind: "narration_review", revisionId: "r1", files: changed.files.map(({ path, storageId, bytes, sha256 }) => ({ path, storageId, bytes, sha256 })) }, null, 2)}\n`,
  );
  await assert.rejects(
    t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "complete",
      artifactSet: changed,
    }),
    /text or timing changed/,
  );
  assert.equal((await read(t)).state, "tts_generating");
  await finish(
    t,
    auth,
    await t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "complete",
      artifactSet,
    }),
  );
  assert.equal((await read(t)).state, "narration_review_required");
  auth = await command(t, "approve_narration");
  await finish(
    t,
    auth,
    await t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "review",
    }),
  );
  assert.equal((await read(t)).state, "publish_ready");
  const url = `/narration/artifact?${new URLSearchParams({ mode: "operator", jobId, revisionId: "r1", path: "artifacts/audio/fr/welcome.mp3" })}`;
  const response = await t.fetch(url, {
    headers: { authorization: `Bearer ${operatorToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(await response.text(), "fixture-audio-not-provider-proof");
  assert.equal((await t.fetch(url)).status, 403);
  assert.equal(
    (
      await t.fetch(url.replace("revisionId=r1", "revisionId=r2"), {
        headers: { authorization: `Bearer ${operatorToken}` },
      })
    ).status,
    403,
  );
});
test("queued human content decision and render produce durable approved prepared bundle; no publication", async () => {
  const { t, source } = await fixture();
  let auth = await command(t, "approve_content");
  const outcome = await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "review",
  });
  await finish(t, auth, outcome);
  assert.equal((await read(t)).state, "render_queued");
  auth = await command(t, "render");
  await finish(
    t,
    auth,
    await t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "render",
    }),
  );
  const job = await read(t);
  const prepared = job.artifactSets.at(-1);
  assert.equal(job.state, "tts_queued");
  assert.equal(prepared.kind, "prepared_bundle");
  assert.equal(prepared.pageDigest, source.pageDigest);
  assert.ok(prepared.files.some((f) => f.path === "deploy/fr/index.html"));
  assert.equal(job.narrationRequired, true);
  assert.equal(job.publication, null);
  auth = await command(t, "generate_narration");
  await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "begin",
  });
  await assert.rejects(t.mutation(ref("narration:createUploadUrl"), auth)); // must fence spend first
  const { jobId: _, ...fence } = auth;
  await t.mutation(ref("operations:fenceCommand"), {
    ...fence,
    leaseMs: 300000,
    effectMayBeIssued: true,
  });
  await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "fence",
  });
  assert.equal((await read(t)).state, "tts_generating");
  await assert.rejects(
    t.action(ref("narrationRuntime:advance"), {
      ...auth,
      operation: "complete",
      artifactSet: { ...prepared, kind: "narration_review" },
    }),
  );
  await assert.rejects(
    t.action(ref("narrationRuntime:advance"), {
      ...auth,
      jobId: "job_other",
      operation: "begin",
    }),
  );
  await t.run(async (ctx) => {
    const sourceCommand = await ctx.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_command_id", (q) => q.eq("commandId", auth.commandId))
      .unique();
    const fulfillment = await ctx.db
      .query("fulfillmentJobs")
      .withIndex("by_job_id", (q) => q.eq("jobId", jobId))
      .unique();
    const aggregate = structuredClone(fulfillment.aggregate);
    aggregate.stageAttempts.at(-1).leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    await ctx.db.patch(fulfillment._id, { aggregate });
    await ctx.db.patch(sourceCommand._id, {
      claim: { ...sourceCommand.claim, leaseExpiresAtMs: Date.now() - 1 },
    });
  });
  assert.deepEqual(await t.mutation(ref("operations:claimCommands"), {
    workerToken: generationToken,
    workerId,
    jobId,
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  }), []);
  const uncertain = await read(t);
  assert.equal(uncertain.state, "reconciliation_required");
  assert.equal(uncertain.stageAttempts.at(-1).status, "reconciliation_required");

  const sourceCommand = await t.run(async (ctx) => ctx.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (q) => q.eq("commandId", auth.commandId))
    .unique());
  assert.equal(sourceCommand.state, "reconciliation_required");
  assert.equal(sourceCommand.lastFailureReason, "external_effect_lease_expired");

  const reconciliationCommandId = "command_narration_reconcile_absent_001";
  await t.mutation(ref("operations:requestCommand"), {
    operatorToken,
    commandId: reconciliationCommandId,
    jobId,
    action: "reconcile",
    expectedState: uncertain.state,
    expectedVersion: uncertain.version,
    payload: {
      sourceCommandId: auth.commandId,
      providerStatus: "confirmed_absent",
    },
  });
  const reconciliationWorkerId = "operations-reconciliation-worker";
  const [reconciliation] = await t.mutation(ref("operations:claimCommands"), {
    workerToken: operationsWorkerToken,
    workerId: reconciliationWorkerId,
    jobId,
    actions: ["reconcile"],
    limit: 1,
    leaseMs: 300000,
  });
  // Preserve the currently deployed ordinary-job reconciliation contract:
  // an operator's claimed absence does not itself advance canonical state.
  const beforeReconciliation = await read(t);
  await assert.rejects(t.mutation(ref("operations:completeCommand"), {
    workerToken: operationsWorkerToken,
    workerId: reconciliationWorkerId,
    commandId: reconciliation.commandId,
    leaseToken: reconciliation.claim.leaseToken,
    outcome: {
      code: "reconciled",
      jobVersion: uncertain.version + 1,
      reconciledState: "tts_queued",
      sourceCommandId: auth.commandId,
      providerStatus: "confirmed_absent",
    },
  }), /Operator reconciliation does not match authoritative provider and fulfillment state/u);
  assert.deepEqual(await read(t), beforeReconciliation);
  const unresolvedSource = await t.run(async (ctx) => ctx.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (q) => q.eq("commandId", auth.commandId))
    .unique());
  assert.deepEqual(unresolvedSource, sourceCommand);
  assert.deepEqual(await t.mutation(ref("operations:claimCommands"), {
    workerToken: generationToken,
    workerId,
    jobId,
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  }), []);
});

test("a crash after the queue fence but before the aggregate fence is recovered without invoking the provider", async () => {
  const { t } = await fixture();
  const auth = await beginNarrationGeneration(t);
  const provider = { invocationCount: 0 };
  const { jobId: _jobId, ...queueFence } = auth;
  await t.mutation(ref("operations:fenceCommand"), {
    ...queueFence,
    leaseMs: 300000,
    effectMayBeIssued: true,
  });
  const [splitCommand, splitAggregate] = await Promise.all([
    t.run(async (ctx) => ctx.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_command_id", (query) => query.eq("commandId", auth.commandId))
      .unique()),
    read(t),
  ]);
  assert.equal(Number.isFinite(splitCommand.claim.effectStartedAtMs), true);
  assert.equal(splitAggregate.stageAttempts.at(-1).effectStartedAt, null);
  const originalIdempotencyKey = splitAggregate.stageAttempts.at(-1).idempotencyKey;
  // Simulate a hard process exit here: neither the aggregate fence nor the provider runs.
  await expireNarrationClaim(t, auth);

  assert.deepEqual(await t.mutation(ref("operations:claimCommands"), {
    workerToken: generationToken,
    workerId,
    jobId,
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  }), []);
  assert.equal(provider.invocationCount, 0);

  const [recovered, sourceCommand] = await Promise.all([
    read(t),
    t.run(async (ctx) => ctx.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_command_id", (query) => query.eq("commandId", auth.commandId))
      .unique()),
  ]);
  assert.equal(recovered.state, "tts_queued");
  assert.equal(recovered.stageAttempts.at(-1).status, "reconciled_absent");
  assert.equal(recovered.stageAttempts.at(-1).effectStartedAt, null);
  assert.deepEqual(recovered.stageAttempts.at(-1).failure, {
    retryable: true,
    reasonCode: "aggregate_effect_fence_missing",
  });
  assert.equal(sourceCommand.state, "pending");
  assert.equal(sourceCommand.claim, null);
  assert.equal(sourceCommand.expectedState, recovered.state);
  assert.equal(sourceCommand.expectedVersion, recovered.version);
  assert.equal(sourceCommand.lastFailureReason, "aggregate_effect_fence_missing");

  const [reclaimed] = await t.mutation(ref("operations:claimCommands"), {
    workerToken: generationToken,
    workerId,
    jobId,
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  });
  assert.equal(reclaimed.commandId, auth.commandId);
  await t.action(ref("narrationRuntime:advance"), {
    workerToken: generationToken,
    workerId,
    jobId,
    commandId: reclaimed.commandId,
    leaseToken: reclaimed.claim.leaseToken,
    operation: "begin",
  });
  const retried = await read(t);
  assert.equal(retried.stageAttempts.at(-1).effectStartedAt, null);
  assert.equal(retried.stageAttempts.at(-1).idempotencyKey, originalIdempotencyKey);
  assert.equal(provider.invocationCount, 0);
});

test("claim polling recovers a crash after narration begin but before the queue fence", async () => {
  const { t } = await fixture();
  const auth = await beginNarrationGeneration(t);
  await expireNarrationClaim(t, auth);

  assert.deepEqual(await t.mutation(ref("operations:claimCommands"), {
    workerToken: generationToken,
    workerId,
    jobId,
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  }), []);
  const recovered = await read(t);
  assert.equal(recovered.state, "tts_queued");
  assert.equal(recovered.stageAttempts.at(-1).status, "reconciled_absent");
  assert.equal(recovered.stageAttempts.at(-1).effectStartedAt, null);
});

test("an expired first queue-fence call recovers the pre-provider narration attempt", async () => {
  const { t } = await fixture();
  const auth = await beginNarrationGeneration(t);
  await expireNarrationClaim(t, auth);
  const { jobId: _jobId, ...queueFence } = auth;

  const fenced = await t.mutation(ref("operations:fenceCommand"), {
    ...queueFence,
    leaseMs: 300000,
    effectMayBeIssued: true,
  });
  assert.equal(fenced.active, false);
  assert.equal(fenced.command.state, "pending");
  assert.equal(fenced.command.lastFailureReason, "aggregate_effect_fence_missing");
  const recovered = await read(t);
  assert.equal(recovered.state, "tts_queued");
  assert.equal(recovered.stageAttempts.at(-1).status, "reconciled_absent");
  assert.equal(recovered.stageAttempts.at(-1).effectStartedAt, null);
});

test("a deterministic narration failure before the queue fence remains terminal and unclaimable", async () => {
  const { t } = await fixture();
  const auth = await beginNarrationGeneration(t);
  const beforeFailure = await read(t);
  const originalIdempotencyKey = beforeFailure.stageAttempts.at(-1).idempotencyKey;

  const aggregateFailure = await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "fail",
  });
  assert.equal(aggregateFailure.state, "failed");

  const failed = await t.mutation(ref("operations:failCommand"), {
    workerToken: generationToken,
    workerId,
    commandId: auth.commandId,
    leaseToken: auth.leaseToken,
    reasonCode: "narration_failed",
    retryable: false,
  });
  assert.equal(failed.command.state, "failed");
  assert.equal(failed.command.claim, null);
  assert.equal(failed.command.lastFailureReason, "narration_failed");

  const terminal = await read(t);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.stageAttempts.at(-1).status, "failed");
  assert.equal(terminal.stageAttempts.at(-1).effectStartedAt, null);
  assert.equal(terminal.stageAttempts.at(-1).idempotencyKey, originalIdempotencyKey);
  assert.deepEqual(terminal.stageAttempts.at(-1).failure, {
    retryable: false,
    reasonCode: "narration_failed",
  });
  assert.deepEqual(await t.mutation(ref("operations:claimCommands"), {
    workerToken: generationToken,
    workerId,
    jobId,
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  }), []);
});

test("a handled failure after the queue fence requeues with the original provider idempotency identity", async () => {
  const { t } = await fixture();
  const auth = await beginNarrationGeneration(t);
  const provider = { invocationCount: 0 };
  const originalIdempotencyKey = (await read(t)).stageAttempts.at(-1).idempotencyKey;
  const { jobId: _jobId, ...queueFence } = auth;
  await t.mutation(ref("operations:fenceCommand"), {
    ...queueFence,
    leaseMs: 300000,
    effectMayBeIssued: true,
  });

  const aggregateFailure = await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "fail",
  });
  assert.equal(aggregateFailure.state, "failed");

  const failed = await t.mutation(ref("operations:failCommand"), {
    workerToken: generationToken,
    workerId,
    commandId: auth.commandId,
    leaseToken: auth.leaseToken,
    reasonCode: "narration_failed",
    retryable: false,
  });
  assert.equal(failed.command.state, "pending");
  assert.equal(failed.command.lastFailureReason, "aggregate_effect_fence_missing");
  assert.equal(provider.invocationCount, 0);

  const [recovered, sourceCommand] = await Promise.all([
    read(t),
    t.run(async (ctx) => ctx.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_command_id", (query) => query.eq("commandId", auth.commandId))
      .unique()),
  ]);
  assert.equal(recovered.state, "tts_queued");
  assert.equal(recovered.stageAttempts.at(-1).status, "reconciled_absent");
  assert.equal(recovered.stageAttempts.at(-1).effectStartedAt, null);
  assert.equal(sourceCommand.state, "pending");
  assert.equal(sourceCommand.expectedVersion, recovered.version);
  assert.equal(provider.invocationCount, 0);

  const [reclaimed] = await t.mutation(ref("operations:claimCommands"), {
    workerToken: generationToken,
    workerId,
    jobId,
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  });
  await t.action(ref("narrationRuntime:advance"), {
    workerToken: generationToken,
    workerId,
    jobId,
    commandId: reclaimed.commandId,
    leaseToken: reclaimed.claim.leaseToken,
    operation: "begin",
  });
  const retried = await read(t);
  assert.equal(retried.state, "tts_generating");
  assert.equal(retried.stageAttempts.at(-1).idempotencyKey, originalIdempotencyKey);
});
