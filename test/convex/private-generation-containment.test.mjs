import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../support/legacy-schema.mjs";

const operatorToken = "private-containment-operator-token-32-characters";
const workerToken = "private-containment-worker-token-32-characters";
const ttsToken = "private-containment-tts-token-distinct-32-characters";
function fixture() {
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = "private-containment-backend-token-32-characters";
  process.env.BEBEBONJOUR_PRIVATE_GENERATION_TESTS_ENABLED = "true";
  process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN = "private-containment-control-token-distinct-32-characters";
  process.env.BEBEBONJOUR_TTS_WORKER_TOKEN = ttsToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./privateGeneration.js": () => import("../../convex/privateGeneration.js"),
    "./privateGenerationRuntime.js": () => import("../../convex/privateGenerationRuntime.js"),
    "./operations.js": () => import("../../convex/operations.js"),
    "./generation.js": () => import("../../convex/generation.js"),
    "./narration.js": () => import("../../convex/narration.js"),
  });
}
async function create(t) {
  return t.action(ref("privateGenerationRuntime:createFictionalTest"), {
    operatorToken, acknowledgement: "fictional-unpaid-codex-private-review-only",
    ownerSourceReference: "kanban:t_offline_containment_fixture", idempotencyKey: "containment-offline-001",
  });
}
async function setState(t, state) {
  await t.run(async ctx => {
    const document = await ctx.db.query("fulfillmentJobs").first();
    await ctx.db.patch(document._id, { aggregate: { ...document.aggregate, state } });
  });
}

test("private fictional jobs expose no checkout, publication, delivery or blind retry commands", async () => {
  for (const [state, action, payload] of [
    ["awaiting_payment", "create_checkout", {}],
    ["publish_ready", "publish", { revisionId: "rev_offline", artifactManifestDigest: "a".repeat(64) }],
    ["published", "queue_delivery", { revisionId: "rev_offline", publicationId: "publication_offline", artifactManifestDigest: "a".repeat(64) }],
    ["delivery_queued", "deliver", { revisionId: "rev_offline", publicationId: "publication_offline", artifactManifestDigest: "a".repeat(64) }],
    ["retry_wait", "retry", {}],
  ]) {
    const t = fixture();
    const { jobId } = await create(t);
    await setState(t, state);
    const projected = await t.query(ref("operations:getJob"), { operatorToken, jobId });
    assert.deepEqual(projected.availableActions, [], state);
    await assert.rejects(t.mutation(ref("operations:requestCommand"), {
      operatorToken, jobId, commandId: `command_private_forbidden_${action}`,
      action, payload, expectedState: state, expectedVersion: 1,
    }), /not available/u);
    assert.equal((await t.run(ctx => ctx.db.query("customerFlowOperationsCommands").collect())).length, 0);
  }
});

test("a forged private authority has no available generation action", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  await t.run(async ctx => {
    const document = await ctx.db.query("fulfillmentJobs").first();
    document.aggregate.privateTestAuthority.intakeDigest = "0".repeat(64);
    await ctx.db.patch(document._id, { aggregate: document.aggregate });
  });
  assert.deepEqual((await t.query(ref("operations:getJob"), { operatorToken, jobId })).availableActions, []);
  await assert.rejects(t.mutation(ref("operations:requestCommand"), {
    operatorToken, jobId, commandId: "command_private_forged_generate", action: "generate", payload: {},
    expectedState: "generation_queued", expectedVersion: 1,
  }), /not available/u);
});

test("generation-only private authority cannot expose or claim injected narration", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  await setState(t, "tts_queued");
  const at = new Date().toISOString();
  assert.deepEqual((await t.query(ref("operations:getJob"), { operatorToken, jobId })).availableActions, []);
  await assert.rejects(t.mutation(ref("operations:requestCommand"), {
    operatorToken, jobId, commandId: "command_private_requested_narration", action: "generate_narration",
    expectedState: "tts_queued", expectedVersion: 1, payload: {},
  }), /not available/u);
  await t.run(ctx => ctx.db.insert("customerFlowOperationsCommands", {
    jobId, commandId: "command_private_injected_narration", action: "generate_narration",
    expectedState: "tts_queued", expectedVersion: 1, payload: {}, requestedAt: at,
    requestedBy: "primary_operator", state: "pending", attempts: 0,
    claim: null, lastFailureReason: null, outcome: null, updatedAt: at,
  }));
  assert.deepEqual(await t.mutation(ref("operations:claimCommands"), {
    workerToken: ttsToken, workerId: "hosted-narration-worker", actions: ["generate_narration"],
    limit: 1, leaseMs: 300_000, jobId,
  }), []);
  const command = await t.run(ctx => ctx.db.query("customerFlowOperationsCommands").first());
  assert.equal(command.state, "pending");
  assert.equal(command.claim, null);
});

test("injected dual-fenced private narration has no metadata, upload or read capability", async () => {
  for (const variant of ["valid-authority", "drifted-intake", "stripped-markers"]) {
    const t = fixture();
    const { jobId } = await create(t);
    const now = Date.now();
    const at = new Date(now).toISOString();
    const commandId = "command_private_running_narration";
    const auth = { workerToken: ttsToken, workerId: "hosted-narration-worker",
      commandId, leaseToken: "offline-narration-lease", jobId };
    await t.run(async ctx => {
      const f = await ctx.db.query("fulfillmentJobs").first();
      const customer = await ctx.db.query("customerFlowJobs").first();
      const aggregate = { ...f.aggregate, state: "tts_generating", version: 2,
        stageAttempts: [{ stage: "generate_tts", status: "running", operationsCommandId: commandId,
          leaseExpiresAt: new Date(now + 300_000).toISOString(), effectStartedAt: at }] };
      if (variant === "drifted-intake") customer.job.intake.baby.firstName = "offline-drifted-name";
      if (variant === "stripped-markers") {
        delete customer.job.privateTestAuthority;
        delete aggregate.privateTestAuthority;
        aggregate.product = "ordinary_unpaid_near_match";
      }
      await ctx.db.patch(customer._id, { job: customer.job });
      await ctx.db.patch(f._id, { aggregate });
      await ctx.db.insert("customerFlowOperationsCommands", {
        jobId, commandId, action: "generate_narration", expectedState: "tts_queued", expectedVersion: 1,
        payload: {}, requestedAt: at, requestedBy: "primary_operator", state: "running", attempts: 1,
        claim: { workerId: auth.workerId, leaseToken: auth.leaseToken, claimedAtMs: now,
          leaseExpiresAtMs: now + 300_000, effectStartedAtMs: now },
        lastFailureReason: null, outcome: null, updatedAt: at,
      });
    });
    const { jobId: ignoredJobId, ...fenceAuth } = auth;
    assert.deepEqual(await t.mutation(ref("operations:fenceCommand"), {
      ...fenceAuth, leaseMs: 300_000, effectMayBeIssued: true,
    }), { active: false, command: null }, variant);
    for (const name of ["readClaim", "readEffectClaim", "readPrepared"]) {
      await assert.rejects(t.query(ref(`narration:${name}`), auth), /private-test authority/u, variant);
    }
    await assert.rejects(t.mutation(ref("narration:createUploadUrl"), auth), /private-test authority/u, variant);
    await assert.rejects(t.mutation(ref("narration:commitTransition"), {
      ...auth, expectedVersion: 2, aggregate: { version: 3, artifactSets: [] },
    }), /private-test authority/u, variant);
    const { workerToken: token, ...readAuth } = auth;
    await assert.rejects(t.query(ref("narration:authorizeRead"), {
      ...readAuth, token, mode: "worker", revisionId: "r1", path: "artifacts/current/page.json",
    }), /private-test authority/u, variant);
    assert.equal((await t.run(ctx => ctx.db.system.query("_storage").collect())).length, 0);
  }
});

test("private render metadata remains available only while the persisted intake authority matches", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const auth = { workerToken: process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN,
    workerId: "hosted-narration-worker", commandId: "command_private_running_render",
    leaseToken: "offline-private-render-lease", jobId };
  await t.run(async ctx => {
    const f = await ctx.db.query("fulfillmentJobs").first();
    await ctx.db.patch(f._id, { aggregate: { ...f.aggregate, state: "rendering", version: 2,
      stageAttempts: [{ stage: "render", status: "running", operationsCommandId: auth.commandId,
        leaseExpiresAt: new Date(now + 300_000).toISOString(), effectStartedAt: at }] } });
    await ctx.db.insert("customerFlowOperationsCommands", {
      jobId, commandId: auth.commandId, action: "render", expectedState: "content_approved", expectedVersion: 1,
      payload: {}, requestedAt: at, requestedBy: "primary_operator", state: "running", attempts: 1,
      claim: { workerId: auth.workerId, leaseToken: auth.leaseToken, claimedAtMs: now,
        leaseExpiresAtMs: now + 300_000, effectStartedAtMs: now },
      lastFailureReason: null, outcome: null, updatedAt: at,
    });
  });
  assert.equal((await t.query(ref("narration:readClaim"), auth)).job.jobId, jobId);
  await t.run(async ctx => {
    const customer = await ctx.db.query("customerFlowJobs").first();
    customer.job.intake.baby.firstName = "offline-drifted-name";
    await ctx.db.patch(customer._id, { job: customer.job });
  });
  await assert.rejects(t.query(ref("narration:readClaim"), auth), /private-test authority/u);
  await assert.rejects(t.mutation(ref("narration:createUploadUrl"), auth), /private-test authority/u);
});

test("an injected pending private checkout command cannot be claimed by the broad worker", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  await setState(t, "awaiting_payment");
  const at = new Date().toISOString();
  await t.run(ctx => ctx.db.insert("customerFlowOperationsCommands", {
    jobId, commandId: "command_private_injected_checkout", action: "create_checkout",
    expectedState: "awaiting_payment", expectedVersion: 1, payload: {}, requestedAt: at,
    requestedBy: "primary_operator", state: "pending", attempts: 0,
    claim: null, lastFailureReason: null, outcome: null, updatedAt: at,
  }));
  const claims = await t.mutation(ref("operations:claimCommands"), {
    workerToken, workerId: "offline-containment-worker", actions: ["create_checkout"],
    limit: 1, leaseMs: 300_000, jobId,
  });
  assert.deepEqual(claims, []);
  const commands = await t.run(ctx => ctx.db.query("customerFlowOperationsCommands").collect());
  assert.equal(commands[0].state, "pending");
  assert.equal(commands[0].claim, null);
});

test("an injected running private checkout cannot receive an external effect fence", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  await setState(t, "awaiting_payment");
  const now = Date.now();
  const at = new Date(now).toISOString();
  await t.run(ctx => ctx.db.insert("customerFlowOperationsCommands", {
    jobId, commandId: "command_private_running_checkout", action: "create_checkout",
    expectedState: "awaiting_payment", expectedVersion: 1, payload: {}, requestedAt: at,
    requestedBy: "primary_operator", state: "running", attempts: 1,
    claim: { workerId: "offline-containment-worker", leaseToken: "offline-checkout-lease",
      claimedAtMs: now, leaseExpiresAtMs: now + 300_000 },
    lastFailureReason: null, outcome: null, updatedAt: at,
  }));
  assert.deepEqual(await t.mutation(ref("operations:fenceCommand"), {
    workerToken, commandId: "command_private_running_checkout", workerId: "offline-containment-worker",
    leaseToken: "offline-checkout-lease", leaseMs: 300_000, effectMayBeIssued: true,
  }), { active: false, command: null });
  const commands = await t.run(ctx => ctx.db.query("customerFlowOperationsCommands").collect());
  assert.equal(commands[0].claim.effectStartedAtMs, undefined);
});

test("generation metadata capabilities reject a private authority that drifts after claiming", async () => {
  const t = fixture();
  const { jobId } = await create(t);
  const now = Date.now();
  const at = new Date(now).toISOString();
  await t.run(async ctx => {
    const customer = await ctx.db.query("customerFlowJobs").first();
    customer.job.intake.baby.firstName = "offline-tampered-name";
    await ctx.db.patch(customer._id, { job: customer.job });
    await ctx.db.insert("customerFlowOperationsCommands", {
      jobId, commandId: "command_private_drifted_generate", action: "generate",
      expectedState: "generation_queued", expectedVersion: 1, payload: {}, requestedAt: at,
      requestedBy: "primary_operator", state: "running", attempts: 1,
      claim: { workerId: "offline-containment-worker", leaseToken: "offline-generate-lease",
        claimedAtMs: now, leaseExpiresAtMs: now + 300_000 },
      lastFailureReason: null, outcome: null, updatedAt: at,
    });
  });
  await assert.rejects(t.query(ref("generation:getClaimedFulfillmentJob"), {
    workerToken, jobId, commandId: "command_private_drifted_generate",
    workerId: "offline-containment-worker", leaseToken: "offline-generate-lease",
  }), /private-test authority/u);
});
