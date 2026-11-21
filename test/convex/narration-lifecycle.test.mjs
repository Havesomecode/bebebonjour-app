import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../support/legacy-schema.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const workerToken = "narration-worker-test-token-32-characters";
const operatorToken = "operator-narration-test-32-characters";
const jobId = "job_narration_lifecycle";
const workerId = "hosted-narration-worker";
async function fixture() {
  process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN = workerToken;
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
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
  const [claimed] = await t.mutation(ref("operations:claimCommands"), {
    workerToken,
    workerId,
    jobId,
    actions: [action],
    limit: 1,
    leaseMs: 300000,
  });
  assert.ok(claimed);
  const auth = {
    workerToken,
    workerId,
    jobId,
    commandId,
    leaseToken: claimed.claim.leaseToken,
  };
  await t.mutation(ref("operations:fenceCommand"), {
    workerToken,
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
async function markGenuinelyPaid(t) {
  await t.run(async (ctx) => {
    const customer = await ctx.db.query("customerFlowJobs").first();
    const fulfillment = await ctx.db.query("fulfillmentJobs").first();
    const correlation = {
      project: "bebebonjour", product: "announcement-page", environment: "test",
      jobId, intakeDigest: fulfillment.aggregate.intakeDigest,
    };
    await ctx.db.patch(customer._id, { job: {
      ...customer.job,
      intakeDigest: fulfillment.aggregate.intakeDigest,
      payment: { status: "paid", paymentIntentId: "pi_narration_paid", acceptedEventId: "evt_narration_paid" },
    } });
    await ctx.db.patch(fulfillment._id, { aggregate: {
      ...fulfillment.aggregate,
      paymentCorrelation: correlation,
      payment: {
        providerPaymentId: "pi_narration_paid", providerEventId: "evt_narration_paid",
        correlation, recordedAt: new Date().toISOString(),
      },
    } });
  });
}
async function queued(t) {
  return t.run((ctx) => ctx.db.query("customerFlowOperationsCommands").collect());
}
async function claimQueued(t, action) {
  const [pending] = (await queued(t)).filter((entry) => entry.action === action && entry.state === "pending");
  assert.ok(pending, `missing queued ${action}`);
  const [claimed] = await t.mutation(ref("operations:claimCommands"), {
    workerToken, workerId, jobId, actions: [action], limit: 1, leaseMs: 300000,
  });
  assert.equal(claimed.commandId, pending.commandId);
  const auth = { workerToken, workerId, jobId, commandId: claimed.commandId, leaseToken: claimed.claim.leaseToken };
  await t.mutation(ref("operations:fenceCommand"), {
    workerToken, workerId, commandId: auth.commandId, leaseToken: auth.leaseToken,
    leaseMs: 300000, effectMayBeIssued: false,
  });
  return auth;
}
test("paid approval and render atomically queue only their next narration stages", async () => {
  const { t } = await fixture();
  await markGenuinelyPaid(t);
  let auth = await command(t, "approve_content");
  const review = await t.action(ref("narrationRuntime:advance"), { ...auth, operation: "review" });
  assert.equal((await read(t)).state, "render_queued");
  await assert.rejects(
    t.action(ref("narrationRuntime:advance"), { ...auth, operation: "review" }),
    /version conflict|Stale operator decision/,
  );
  let entries = await queued(t);
  assert.equal(entries.filter((entry) => entry.action === "render").length, 1);
  assert.equal(entries.find((entry) => entry.action === "render").expectedVersion, review.jobVersion);
  assert.equal(entries.find((entry) => entry.action === "render").requestedBy, "automatic_narration_progression");
  assert.deepEqual(entries.find((entry) => entry.action === "render").payload, {});
  await finish(t, auth, review);
  assert.equal((await queued(t)).filter((entry) => entry.action === "render").length, 1);

  auth = await claimQueued(t, "render");
  const rendered = await t.action(ref("narrationRuntime:advance"), { ...auth, operation: "render" });
  entries = await queued(t);
  assert.equal((await read(t)).state, "tts_queued");
  assert.equal(entries.filter((entry) => entry.action === "generate_narration").length, 1);
  assert.equal(entries.find((entry) => entry.action === "generate_narration").expectedVersion, rendered.jobVersion);
  assert.equal(entries.find((entry) => entry.action === "generate_narration").requestedBy, "automatic_narration_progression");
  assert.equal(entries.some((entry) => entry.action === "publish"), false);
  assert.equal(entries.some((entry) => entry.action === "approve_narration"), false);
  await finish(t, auth, rendered);
  await claimQueued(t, "generate_narration");
  assert.equal((await queued(t)).filter((entry) => entry.action === "generate_narration").length, 1);
});
test("paid content change requests never auto-queue render", async () => {
  const { t } = await fixture();
  await markGenuinelyPaid(t);
  const auth = await command(t, "request_content_changes");
  await finish(t, auth, await t.action(ref("narrationRuntime:advance"), { ...auth, operation: "review" }));
  assert.equal((await read(t)).state, "generation_queued");
  assert.equal((await queued(t)).filter((entry) => entry.requestedBy === "automatic_narration_progression").length, 0);
});
test("unpaid, fictional, and mismatched payment records never auto-queue paid narration work", async () => {
  for (const variant of ["missing_fulfillment_payment", "fictional", "payment_mismatch", "customer_not_paid"]) {
    const { t } = await fixture();
    if (variant !== "missing_fulfillment_payment") await markGenuinelyPaid(t);
    await t.run(async (ctx) => {
      const f = await ctx.db.query("fulfillmentJobs").first();
      const c = await ctx.db.query("customerFlowJobs").first();
      if (variant === "fictional") {
        await ctx.db.patch(f._id, { aggregate: { ...f.aggregate, product: "operator_narration_test", payment: null } });
        await ctx.db.patch(c._id, { job: { ...c.job, payment: { status: "not_applicable" } } });
      }
      if (variant === "payment_mismatch") {
        await ctx.db.patch(f._id, { aggregate: { ...f.aggregate, payment: { ...f.aggregate.payment, providerPaymentId: "pi_other" } } });
      }
      if (variant === "customer_not_paid") {
        await ctx.db.patch(c._id, { job: { ...c.job, payment: { status: "not_applicable" } } });
      }
    });
    let auth = await command(t, "approve_content");
    await finish(t, auth, await t.action(ref("narrationRuntime:advance"), { ...auth, operation: "review" }));
    assert.equal((await queued(t)).filter((entry) => entry.action === "render").length, 0, variant);
    auth = await command(t, "render");
    await finish(t, auth, await t.action(ref("narrationRuntime:advance"), { ...auth, operation: "render" }));
    assert.equal((await queued(t)).filter((entry) => entry.action === "generate_narration").length, 0, variant);
  }
});
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
  const job = await read(t);
  const prepared = job.artifactSets.at(-1);
  const files = [...prepared.files];
  const review = {
    schemaVersion: "1.0",
    jobId,
    revisionId: "r1",
    preparedManifestDigest: prepared.assetManifestDigest,
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
  await t.action(ref("narrationRuntime:advance"), {
    ...auth,
    operation: "fail",
  });
  assert.equal((await read(t)).state, "failed");
});
