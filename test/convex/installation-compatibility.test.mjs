import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from 'node:child_process';
import test from "node:test";
import { convexTest } from "convex-test";
import { getFunctionName, makeFunctionReference } from "convex/server";
import schema from "../../convex/schema.js";
import http from "../../convex/http.js";

const manifest = JSON.parse(readFileSync(new URL("../../ops/installation-compatibility.json", import.meta.url), "utf8"));
const promotionPins = JSON.parse(readFileSync(new URL('../../ops/promotion-candidate-pins.json', import.meta.url), 'utf8'));
const supportPins = JSON.parse(readFileSync(new URL('../../ops/support-forward-candidate-pins.json', import.meta.url), 'utf8'));
const read = name => readFileSync(new URL(`../../${name}`, import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const ref = name => makeFunctionReference(name);
function normalize(table) {
  const result = structuredClone(table);
  if (result.stagedDocumentType === null) delete result.stagedDocumentType;
  result.indexes = result.indexes.map(index => ({ ...index, fields: index.fields.filter(field => field !== "_creationTime") })).sort((a, b) => a.indexDescriptor < b.indexDescriptor ? -1 : a.indexDescriptor > b.indexDescriptor ? 1 : 0);
  return result;
}
function fixture() {
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./deliveryLoop.js": () => import("../../convex/deliveryLoop.js"),
    "./deliveryLoopData.js": () => import("../../convex/deliveryLoopData.js"),
  });
}

test('worker import/help loads the expected dynamic composition schema without credentials or network', () => {
  assert.equal(sha(read('schemas/codex-subscription-composition.schema.json')), '56e487e835075c08345705f49b15f7f6cb907cc2d258df58989b64bfd8508b8e');
  const result = spawnSync(process.execPath, ['scripts/run-delivery-loop-worker.mjs', '--help'], {
    cwd: new URL('../../', import.meta.url), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^Usage: node scripts\/run-delivery-loop-worker.mjs/);
});

test("installation preserves all 23 production validators/indexes and adds only four paid tables", () => {
  const current = JSON.parse(schema.export()), production = manifest.productionSchema;
  assert.equal(current.schemaValidation, production.schemaValidation);
  assert.equal(production.tables.length, 23);
  assert.equal(current.tables.length, 27);
  for (const table of production.tables) {
    assert.deepEqual(normalize(current.tables.find(item => item.tableName === table.tableName)), normalize(table), table.tableName);
  }
  assert.deepEqual(current.tables.filter(table => !production.tables.some(old => old.tableName === table.tableName)).map(table => table.tableName).sort(), ["customerFlowAbuseBudgets", "deliveryLoopPaymentEvents", "deliveryLoopPaymentEvidence", "deliveryLoopRetainedEvidence"]);
});

test("installation retains all existing production artifact routes and every accepted paid/complimentary route", () => {
  const routes = http.getRoutes().map(([route, method]) => `${method} ${route}`).sort();
  assert.deepEqual(routes, [
    "GET /announcements/*", "GET /completion/artifact", "GET /delivery", "GET /delivery/data/operator",
    "GET /delivery/export", "GET /delivery/operator", "GET /delivery/review",
    "GET /delivery/terms/route-a-39-v2",
    "GET /generation/artifact", "GET /narration/artifact", "POST /delivery/checkout", "POST /delivery/data", "POST /delivery/data/operator",
    "POST /delivery/intake", "POST /delivery/operator", "POST /delivery/payment/webhook", "POST /delivery/review",
  ].sort());
});

test("completion artifact dispatch retains separate owner-trial/ordinary authority and private responses", async () => {
  const trialToken = "synthetic-owner-trial-completion-token";
  const ordinaryToken = "synthetic-ordinary-completion-token";
  process.env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN = trialToken;
  const handler = http.lookup("/completion/artifact", "GET")[0];
  const blob = new Blob(["synthetic private artifact"]);
  for (const [token, functionName, expectedStatus] of [
    [trialToken, "ownerTrialCompletion:authorizeArtifactRead", 200],
    [ordinaryToken, "fulfillment:authorizeCompletionArtifactRead", 200],
    ["synthetic-wrong-token", "fulfillment:authorizeCompletionArtifactRead", 403],
    ["", "fulfillment:authorizeCompletionArtifactRead", 403],
  ]) {
    let calls = 0;
    const response = await handler._handler({
      runQuery: async (functionRef, args) => {
        calls++;
        assert.equal(getFunctionName(functionRef), functionName);
        assert.equal(args.completionToken, token);
        if (token !== trialToken && token !== ordinaryToken) throw Error("synthetic-forbidden");
        return { storageId: "synthetic_storage", bytes: blob.size };
      },
      storage: { get: async id => { assert.equal(id, "synthetic_storage"); return blob; } },
    }, new Request("https://installation.invalid/completion/artifact?jobId=synthetic_job&revisionId=synthetic_revision&storageId=synthetic_storage", { headers: token ? { authorization: `Bearer ${token}` } : {} }));
    assert.equal(calls, 1);
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  delete process.env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN;
});

test("compatible rollback retains financial/event rows and uncertain-effect fences while paid activation and hourly automation are disabled", async () => {
  Object.assign(process.env, manifest.rollback.configuration);
  const token = "synthetic-rollback-worker-token-32-characters";
  process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN = token;
  const t = fixture();
  const event = { providerAccountId: "acct_synthetic", providerEventId: "evt_synthetic", rawBodySha256: "a".repeat(64), type: "payment_intent.succeeded", livemode: true, disposition: "settled", reason: "accepted", processedAtMs: 1 };
  const payment = { jobId: "synthetic_rollback", revision: 1, previewDigest: "b".repeat(64), providerPaymentId: "pi_synthetic", amountMinor: 3900, currency: "eur", livemode: true, settled: true, providerAccountId: "acct_synthetic", provider: "stripe", status: "settled", verifiedAtMs: 1 };
  const retained = { jobId: payment.jobId, retainedAtMs: 1, reason: "synthetic", evidence: { payment, email: { status: "reconciliation_required" } } };
  const row = { jobId: payment.jobId, publicToken: "synthetic-public-token", idempotencyKey: "synthetic-rollback-id", status: "reconciliation_required", data: { orderMode: "paid_route_a", createdAtMs: 1, desiredRevision: 1, payment, lease: { stage: "final_email", effectStartedAtMs: 1 }, lastError: { reason: "email_reconciliation_required" } } };
  const ids = await t.run(async ctx => Promise.all([
    ctx.db.insert("deliveryLoopPaymentEvents", event), ctx.db.insert("deliveryLoopPaymentEvidence", payment),
    ctx.db.insert("deliveryLoopRetainedEvidence", retained), ctx.db.insert("deliveryLoopJobs", row),
    ctx.db.insert("ownerTrialReviews", { jobId: "job_owner_trial_synthetic", decisionType: "publish", receipt: { synthetic: true } }),
  ]));
  const before = await t.run(async ctx => Promise.all(ids.map(id => ctx.db.get(id))));
  assert.deepEqual(await t.mutation(ref("deliveryLoopData:sweep"), {}), { disabled: true });
  assert.equal(await t.mutation(ref("deliveryLoop:claim"), { workerToken: token, workerId: "synthetic-rollback-worker", leaseToken: "synthetic-rollback-lease" }), null);
  await assert.rejects(t.mutation(ref("deliveryLoop:submit"), { orderMode: "paid_route_a", idempotencyKey: "synthetic-new-paid", intake: { email: "fixture@example.invalid", babyName: "Fixture", language: "fr", gender: "neutral", context: "general", voiceEnabled: false, consent: true, termsAccepted: true, publication: true, customerPermissions: true } }), /paid.*disabled|paid_route_unavailable/);
  assert.deepEqual(await t.run(async ctx => Promise.all(ids.map(id => ctx.db.get(id)))), before);
  assert.equal(manifest.rollback.legacyWorkerRestartAllowed, false);
  assert.equal(manifest.rollback.clearJournalsOrFences, false);
});
