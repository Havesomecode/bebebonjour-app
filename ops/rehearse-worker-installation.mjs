import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "../convex/schema.js";
import { createDeliveryLoopWorker } from "../src/delivery-loop/worker.mjs";
import { buildCodexCompositionRequest, sha256 } from "../scripts/lib/codex-subscription-composition.mjs";

// This command requires the independently hash-verified recovery extraction.
// Only local fixture state is read/written. All provider actions are substituted;
// unexpected action names and every network request fail closed.
const legacyRoot = process.argv[2];
if (!legacyRoot) throw Error("Usage: node ops/rehearse-worker-installation.mjs RECOVERED_HOST_WORKER_ROOT");
const { createDeliveryLoopWorker: legacyFactory } = await import(pathToFileURL(path.resolve(legacyRoot, "src/delivery-loop/worker.mjs")));
const token = "synthetic-installation-worker-token-32-characters";
const password = "synthetic-installation-password";
const ref = name => makeFunctionReference(name);
process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN = token;
process.env.BEBEBONJOUR_TRIAL_PASSWORD_SHA256 = sha256(password);
process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN = "https://installation.invalid";
process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED = "false";
process.env.BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED = "false";
globalThis.fetch = async () => { throw Error("OFFLINE_NETWORK_FORBIDDEN"); };

const composition = { schemaVersion: "1.0", languages: { fr: {
  description: "Bienvenue.", introLines: ["Bienvenue, Fixture."], introNarration: "Bienvenue, Fixture.",
  blessingLines: ["Des jours doux."], blessingNarration: "Des jours doux.",
  closingLines: ["Nous t’aimons."], closingNarration: "Nous t’aimons.",
} } };
composition.languages.ar = { ...composition.languages.fr };
async function fixture(clock) {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch, "TMPDIR must point to managed scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "installation-worker-"));
  clock.after(() => rm(root, { recursive: true, force: true }));
  const t = convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./deliveryLoop.js": () => import("../convex/deliveryLoop.js"),
    "./deliveryLoopData.js": () => import("../convex/deliveryLoopData.js"),
  });
  let sends = 0, composeCalls = 0, uncertain = false;
  const client = {
    mutation: (name, args) => t.mutation(ref(name), args),
    query: (name, args) => t.query(ref(name), args),
    action: async (name, args) => {
      assert.equal(name, "deliveryLoopProviders:sendEmail", "voice-disabled fixture cannot narrate");
      await t.mutation(ref("deliveryLoop:fence"), args);
      sends++;
      if (uncertain) throw Error("synthetic-uncertain-send");
      return t.mutation(ref("deliveryLoop:completeEmail"), { ...args, providerMessageId: `synthetic_message_${sends}` });
    },
  };
  const composer = { compose: async intake => {
    composeCalls++;
    const metadata = { adapterVersion: "1.0.0", provider: "openai-codex-subscription", model: "synthetic-model", requestDigest: sha256(JSON.stringify({ adapterVersion: "1.0.0", provider: "openai-codex-subscription", model: "synthetic-model", request: buildCodexCompositionRequest(intake) })), outputDigest: sha256(JSON.stringify(composition)) };
    return { composition, metadata };
  } };
  const options = { client, composer, stateDir: path.join(root, "state"), workerToken: token, workerId: "synthetic-paired-worker", logger: record => console.log(JSON.stringify(record)), reconciliationAttempts: 1, providerTimeoutMs: 1000, requestTimeoutMs: 1000 };
  const submit = () => t.mutation(ref("deliveryLoop:submit"), { idempotencyKey: crypto.randomUUID(), magicPassword: password, intake: { email: "fixture@example.invalid", babyName: "Fixture", language: "fr", gender: "neutral", context: "general", voiceEnabled: false, consent: true, fictional: true } });
  return { t, options, submit, sends: () => sends, composeCalls: () => composeCalls, uncertain: () => { uncertain = true; } };
}

test("paired transition: recorded old worker completes a complimentary generation lease; new worker completes review/final flow", async clock => {
  const f = await fixture(clock), job = await f.submit();
  assert.equal((await legacyFactory(f.options).runOnce()).status, "published");
  const published = await f.t.query(ref("deliveryLoop:read"), { workerToken: token, jobId: job.jobId });
  const worker = createDeliveryLoopWorker(f.options);
  assert.equal((await worker.runOnce()).status, "email_sent");
  await f.t.mutation(ref("deliveryLoop:requestReview"), { jobId: job.jobId, reviewToken: job.reviewToken, expectedRevision: 1, action: "approve", idempotencyKey: "synthetic-transition-approve" });
  assert.equal((await worker.runOnce()).status, "email_sent");
  const final = await f.t.query(ref("deliveryLoop:read"), { workerToken: token, jobId: job.jobId });
  assert.equal(final.status, "approved_sent");
  assert.deepEqual(final.revisions, published.revisions);
  assert.equal(final.payment.status, "waived");
  assert.equal(f.composeCalls(), 1);
  assert.equal(f.sends(), 2);
  assert.equal((await worker.runOnce()).status, "idle");
});

test("paired transition preserves recorded old-worker uncertain email fence and shared journal without replay", async clock => {
  const f = await fixture(clock), job = await f.submit();
  const old = legacyFactory(f.options);
  assert.equal((await old.runOnce()).status, "published");
  f.uncertain();
  assert.equal((await old.runOnce()).status, "failed");
  const before = await f.t.query(ref("deliveryLoop:read"), { workerToken: token, jobId: job.jobId });
  assert.equal(before.status, "reconciliation_required");
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "idle");
  assert.equal(f.sends(), 1);
  assert.equal(f.composeCalls(), 1);
  assert.deepEqual(await f.t.query(ref("deliveryLoop:read"), { workerToken: token, jobId: job.jobId }), before);
});

test("paired transition cannot steal an active recorded-worker lease before a drained handoff", async clock => {
  const f = await fixture(clock), job = await f.submit();
  const claimed = await f.t.mutation(ref("deliveryLoop:claim"), { workerToken: token, workerId: "synthetic-old-inflight", leaseToken: "synthetic-active-lease" });
  assert.equal(claimed.jobId, job.jobId);
  const before = await f.t.query(ref("deliveryLoop:read"), { workerToken: token, jobId: job.jobId });
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "idle");
  assert.equal(f.sends(), 0);
  assert.equal(f.composeCalls(), 0);
  assert.deepEqual(await f.t.query(ref("deliveryLoop:read"), { workerToken: token, jobId: job.jobId }), before);
});
