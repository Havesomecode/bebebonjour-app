import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { buildCodexCompositionRequest, sha256 } from "../../scripts/lib/codex-subscription-composition.mjs";
import { createDeliveryLoopWorker, mapCompositionIntake, assertCorrectionApplied } from "../../src/delivery-loop/worker.mjs";

const INTAKE = { schemaVersion: "1.0", customer: { email: "synthetic-private@example.test" }, baby: { firstName: "Aélio-Z", gender: "neutral" }, languages: ["fr", "ar"], context: { religion: "general" }, voicePreference: { gender: "neutral" }, notes: { specificDemands: "Un récit sobre et chaleureux." } };
function compositionFixture() {
  return { schemaVersion: "1.0", languages: Object.fromEntries(["fr", "ar"].map((lang) => [lang, {
    description: lang === "fr" ? "Un nouveau bonheur." : "فرح جديد.",
    introLines: [lang === "fr" ? "Bienvenue, Aélio-Z." : "أهلاً بك."], introNarration: lang === "fr" ? "Bienvenue, Aélio-Z." : "أهلاً بك.",
    blessingLines: [lang === "fr" ? "Que tes jours soient doux." : "أيام جميلة."], blessingNarration: lang === "fr" ? "Que tes jours soient doux." : "أيام جميلة.",
    closingLines: [lang === "fr" ? "Nous t’aimons déjà." : "لك كل الحب."], closingNarration: lang === "fr" ? "Nous t’aimons déjà." : "لك كل الحب.",
  }])) };
}
function receiptFor(intake, composition = compositionFixture()) {
  const metadata = { adapterVersion: "1.0.0", provider: "openai-codex-subscription", model: "synthetic-offline-model", requestDigest: sha256(JSON.stringify({ adapterVersion: "1.0.0", provider: "openai-codex-subscription", model: "synthetic-offline-model", request: buildCodexCompositionRequest(intake) })), outputDigest: sha256(JSON.stringify(composition)) };
  return { composition, metadata };
}
async function fixture(t, overrides = {}) {
  const scratch = process.env.TMPDIR || "/home/hermes/.hermes/cache/scratch";
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "bebe-loop-offline-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const claim = { jobId: "delivery_offline_001", revision: 1, stage: "generate", intake: structuredClone(INTAKE), feedback: null, previousComposition: null, publicToken: "public-offline-token", reviewToken: "private-review-token", publicUrl: "https://offline.example.test/announcements/public-offline-token", reviewUrl: "https://offline.example.test/delivery/review?token=private-review-token", leaseToken: "lease-offline-token", leaseExpiresAtMs: Date.now() + 900_000, ...overrides };
  const remote = { status: "generation_running", desiredRevision: claim.revision, revisions: [], narrationReceipts: [], emailReceipts: [] };
  const client = {
    async mutation(name, args) {
      calls.push({ name, args });
      if (name === "deliveryLoop:claim") return structuredClone(claim);
      if (name === "deliveryLoop:publish") { remote.revisions.push({ revision: args.revision, contentDigest: args.contentDigest }); remote.status = "draft_email_queued"; return { status: remote.status }; }
      if (name === "deliveryLoop:fail") { remote.status = args.retryable ? "generation_queued" : "reconciliation_required"; return { status: remote.status }; }
      throw new Error("unexpected_mutation");
    },
    async query(name, args) { calls.push({ name, args }); assert.equal(name, "deliveryLoop:read"); return structuredClone(remote); },
    async action(name, args) {
      calls.push({ name, args });
      if (name === "deliveryLoopProviders:narrate") {
        const receipt = { revision: args.revision, language: args.language, storageId: `offline-storage-${args.language}`, textDigest: args.textDigest };
        remote.narrationReceipts.push(receipt);
        return { storageId: receipt.storageId, textDigest: receipt.textDigest };
      }
      if (name === "deliveryLoopProviders:sendEmail") {
        const providerMessageId = `offline-message-${args.stage}`;
        remote.emailReceipts.push({ revision: args.revision, stage: args.stage, providerMessageId });
        remote.status = args.stage === "final_email" ? "approved_sent" : "awaiting_review";
        return { providerMessageId, status: remote.status };
      }
      throw new Error("unexpected_action");
    },
  };
  const composer = { async compose(input) { calls.push({ name: "compose", args: input }); return receiptFor(input); } };
  const logs = [];
  const options = { client, composer, stateDir: path.join(root, "state"), workerToken: "offline-worker-secret", workerId: "offline-worker", logger: (event) => logs.push(event), providerTimeoutMs: 1000, requestTimeoutMs: 1000, reconciliationAttempts: 1 };
  return { root, claim, remote, calls, client, composer, logs, options, worker: createDeliveryLoopWorker(options) };
}
function count(context, name) { return context.calls.filter((call) => call.name === name).length; }
async function journalFiles(root) {
  const dirs = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const dir of dirs.filter((entry) => entry.isDirectory())) {
    for (const revision of await readdir(path.join(root, dir.name))) {
      for (const file of await readdir(path.join(root, dir.name, revision))) files.push(path.join(root, dir.name, revision, file));
    }
  }
  return files;
}

test("generate composes through subscription, narrates selected languages and publishes, never sends in this lease", async (t) => {
  const f = await fixture(t);
  const result = await f.worker.runOnce();
  assert.equal(result.status, "published");
  assert.equal(count(f, "compose"), 1);
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 2);
  assert.equal(count(f, "deliveryLoopProviders:sendEmail"), 0);
  const publish = f.calls.find((call) => call.name === "deliveryLoop:publish").args;
  assert.equal(publish.contentDigest, createHash("sha256").update(publish.contentHtml).digest("hex"));
  assert.equal(publish.compositionReceipt.provider, "openai-codex-subscription");
  assert.equal(publish.audioFiles.length, 2);
  for (const call of f.calls.filter((call) => call.name === "deliveryLoopProviders:narrate")) assert.equal(call.args.textDigest, sha256(call.args.text));
  assert.doesNotMatch(publish.contentHtml, /synthetic-private|private-review|Un récit sobre/);
  assert.doesNotMatch(JSON.stringify(f.logs), /offline-worker-secret|lease-offline-token|private-review|synthetic-private|Aélio/);
  assert.equal((await stat(f.options.stateDir)).mode & 0o777, 0o700);
  for (const file of await journalFiles(f.options.stateDir)) assert.equal((await stat(file)).mode & 0o777, 0o600);
  // Repeated claim after restart reconciles exact published digest, not effects.
  f.claim.leaseToken = "new-lease-token";
  const restarted = createDeliveryLoopWorker(f.options);
  const again = await restarted.runOnce();
  assert.equal(again.status, "published");
  assert.equal(count(f, "compose"), 1);
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 2);
  assert.equal(count(f, "deliveryLoop:publish"), 1);
});

test("durable narration receipt recovers an action that committed before throwing", async (t) => {
  const f = await fixture(t);
  const action = f.client.action;
  f.client.action = async (name, args) => { const result = await action(name, args); if (args.language === "fr") throw new Error("PRIVATE_PROVIDER_RESPONSE"); return result; };
  assert.equal((await f.worker.runOnce()).status, "published");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 2);
});

test("uncertain narration without durable receipt blocks replay even after restart", async (t) => {
  const f = await fixture(t);
  f.client.action = async (name, args) => { f.calls.push({ name, args }); throw new Error("PRIVATE_PROVIDER_RESPONSE"); };
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 1);
  const failure = f.calls.find((call) => call.name === "deliveryLoop:fail");
  assert.equal(failure.args.retryable, false);
  assert.equal(failure.args.reason, "narration_reconciliation_required");
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_PROVIDER/);
});

test("publish transport failure resumes immutable composition and storage without replay", async (t) => {
  const f = await fixture(t);
  const mutation = f.client.mutation;
  let first = true;
  f.client.mutation = async (name, args) => {
    if (name === "deliveryLoop:publish" && first) { first = false; f.calls.push({ name, args }); throw new Error("offline_transport_down"); }
    return mutation(name, args);
  };
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "published");
  assert.equal(count(f, "compose"), 1);
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 2);
});

test("draft and final email actions own completion and recover committed email by exact readback", async (t) => {
  for (const stage of ["draft_email", "final_email"]) {
    const f = await fixture(t, { stage });
    const action = f.client.action;
    f.client.action = async (name, args) => { await action(name, args); throw new Error("offline_response_lost"); };
    const result = await f.worker.runOnce();
    assert.equal(result.status, "email_sent");
    assert.equal(result.providerMessageId, `offline-message-${stage}`);
    assert.equal(count(f, "deliveryLoopProviders:sendEmail"), 1);
    assert.equal(count(f, "compose"), 0);
    assert.equal(count(f, "deliveryLoop:completeEmail"), 0);
    assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "email_sent");
    assert.equal(count(f, "deliveryLoopProviders:sendEmail"), 1);
  }
});

test("uncertain email is fenced locally; no blind replay, including subsequent leases", async (t) => {
  const f = await fixture(t, { stage: "draft_email" });
  f.client.action = async (name, args) => { f.calls.push({ name, args }); f.remote.status = "reconciliation_required"; throw new Error("PRIVATE_PROVIDER_ERROR"); };
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(f.calls.find((call) => call.name === "deliveryLoop:fail").args.retryable, false);
  f.claim.leaseToken = "another-token";
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoopProviders:sendEmail"), 1);
});

test("an unverified successful provider reply is not treated as a sent email", async (t) => {
  const f = await fixture(t, { stage: "draft_email" });
  f.client.action = async () => ({ providerMessageId: "uncommitted-message", status: "awaiting_review" });
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(f.calls.find((call) => call.name === "deliveryLoop:fail").args.reason, "email_reconciliation_required");
});

test("correction maps prior prose and original request as bounded data, asserts exact closing in text and narration", async (t) => {
  const feedback = "Remplacer la dernière phrase par « Tu es notre plus belle aventure. »";
  const f = await fixture(t, { revision: 2, feedback, previousComposition: compositionFixture() });
  const projected = mapCompositionIntake(f.claim);
  assert.equal(projected.notes.specificDemands.includes(INTAKE.notes.specificDemands), true);
  assert.equal(projected.notes.specificDemands.includes(feedback), true);
  assert.equal(projected.notes.specificDemands.includes("Nous t’aimons déjà."), true);
  assert.ok(Buffer.byteLength(projected.notes.specificDemands) <= 2000);
  assert.equal(projected.customer, undefined);
  assert.throws(() => assertCorrectionApplied(compositionFixture(), f.claim), /correction_not_applied/);
  const rejected = await f.worker.runOnce();
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.retryable, true, "a content-only semantic miss should use the backend's finite generation budget");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 0);
  const corrected = compositionFixture();
  corrected.languages.fr.closingLines = ["Tu es notre plus belle aventure."];
  corrected.languages.fr.closingNarration = "Tu es notre plus belle aventure.";
  assert.doesNotThrow(() => assertCorrectionApplied(corrected, f.claim));
});

test("oversize feedback is rejected, never silently truncated", () => {
  assert.throws(() => mapCompositionIntake({ intake: INTAKE, feedback: "é".repeat(1100), previousComposition: compositionFixture(), revision: 2 }), /composition_input_too_large/);
});

test("immutable receipt mismatch and changed input cannot publish stale content", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.worker.runOnce()).status, "published");
  f.claim.intake.baby.firstName = "A different name";
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoop:publish"), 1);
  assert.equal(count(f, "compose"), 1);
});

test("expired leases perform no effects, and state directories reject symlinks", async (t) => {
  const f = await fixture(t, { leaseExpiresAtMs: Date.now() - 1 });
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(count(f, "compose"), 0);
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 0);
  const target = path.join(f.root, "symlink-target");
  await mkdir(target);
  const linked = path.join(f.root, "linked-state");
  await symlink(target, linked);
  const unsafe = createDeliveryLoopWorker({ ...f.options, stateDir: linked });
  await assert.rejects(unsafe.runOnce(), /unsafe_state_directory/);
});

test("one local worker at a time; restart can recover a dead pid lock", async (t) => {
  const f = await fixture(t);
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.composer.compose = async (input) => { entered(); await hold; return receiptFor(input); };
  const running = f.worker.runOnce();
  await started;
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "busy");
  release();
  assert.equal((await running).status, "published");
  const lock = path.join(f.options.stateDir, ".worker.lock");
  await writeFile(lock, JSON.stringify({ pid: 2147483647, host: (await import("node:os")).hostname(), token: "dead-token" }), { mode: 0o600 });
  assert.equal((await f.worker.runOnce()).status, "published");
});

test("text-only intake performs no narration and publishes no audio controls", async (t) => {
  const f = await fixture(t);
  f.claim.intake.voicePreference.enabled = false;
  assert.equal((await f.worker.runOnce()).status, "published");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 0);
  const publication = f.calls.find((call) => call.name === "deliveryLoop:publish").args;
  assert.deepEqual(publication.audioFiles, []);
  assert.doesNotMatch(publication.contentHtml, /<audio|data-play=|Une narration créée/);
});

test("narration success without a committed storage receipt is not publishable", async (t) => {
  const f = await fixture(t);
  f.client.action = async (name, args) => { f.calls.push({ name, args }); return { storageId: "uncommitted-storage", textDigest: args.textDigest }; };
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoop:publish"), 0);
  assert.equal(f.calls.find((call) => call.name === "deliveryLoop:fail").args.reason, "narration_reconciliation_required");
});

test("backend read outage cannot be treated as absence before a paid provider effect", async (t) => {
  const f = await fixture(t);
  f.client.query = async () => { throw new Error("offline_read_outage"); };
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 0);
});

test("remote publication digest conflict cannot be overwritten", async (t) => {
  const f = await fixture(t);
  f.remote.revisions.push({ revision: 1, contentDigest: "0".repeat(64) });
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoop:publish"), 0);
  assert.equal(f.calls.find((call) => call.name === "deliveryLoop:fail").args.reason, "publication_digest_conflict");
});

test("remote email effect fence blocks calls when local journal is absent", async (t) => {
  const f = await fixture(t, { stage: "draft_email", effectStartedAtMs: Date.now() });
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoopProviders:sendEmail"), 0);
});

test("description-only changes do not satisfy a narrative correction", () => {
  const old = compositionFixture();
  const descriptionOnly = structuredClone(old);
  descriptionOnly.languages.fr.description = "Une nouvelle description, mais la prose est inchangée.";
  assert.throws(() => assertCorrectionApplied(descriptionOnly, { intake: INTAKE, feedback: "Rendre la conclusion plus douce.", previousComposition: old }), /correction_not_applied/);
});

test("timeout in narration is bounded, reconciled and never retried automatically", async (t) => {
  const f = await fixture(t);
  f.client.action = async (name, args) => { f.calls.push({ name, args }); return new Promise(() => {}); };
  const worker = createDeliveryLoopWorker({ ...f.options, providerTimeoutMs: 15 });
  assert.equal((await worker.runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 1);
  assert.equal(f.calls.find((call) => call.name === "deliveryLoop:fail").args.reason, "narration_reconciliation_required");
});

test("provider transports rejecting the worker token fail without paid effect replay", async (t) => {
  const f = await fixture(t);
  f.client.action = async (name, args) => { f.calls.push({ name, args }); throw new Error("forbidden"); };
  assert.equal((await f.worker.runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 1);
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "failed");
  assert.equal(count(f, "deliveryLoopProviders:narrate"), 1);
});

test("correction revision two publishes genuinely corrected visible and narration text on the same public URL", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.worker.runOnce()).status, "published");
  const firstPublication = f.calls.find((call) => call.name === "deliveryLoop:publish").args;
  f.claim.revision = 2;
  f.claim.feedback = "Remplacer la dernière phrase par « Tu es notre plus belle aventure. »";
  f.claim.previousComposition = firstPublication.composition;
  f.claim.leaseToken = "offline-second-revision-lease";
  f.remote.desiredRevision = 2;
  f.composer.compose = async (input) => {
    f.calls.push({ name: "compose", args: input });
    const composition = compositionFixture();
    composition.languages.fr.closingLines = ["Tu es notre plus belle aventure."];
    composition.languages.fr.closingNarration = "Tu es notre plus belle aventure.";
    return receiptFor(input, composition);
  };
  assert.equal((await createDeliveryLoopWorker(f.options).runOnce()).status, "published");
  const publications = f.calls.filter((call) => call.name === "deliveryLoop:publish");
  const corrected = publications[1].args;
  assert.notEqual(corrected.contentDigest, firstPublication.contentDigest);
  assert.match(corrected.contentHtml, /Tu es notre plus belle aventure\./);
  assert.doesNotMatch(corrected.contentHtml, /Nous t’aimons déjà/);
  assert.match(corrected.contentHtml, /public-offline-token\/audio\/2\/fr/);
  assert.match(f.calls.find((call) => call.name === "deliveryLoopProviders:narrate" && call.args.revision === 2 && call.args.language === "fr").args.text, /Tu es notre plus belle aventure\.$/);
});

test("continuous loop waits on empty/error polling and exits on cancellation", async (t) => {
  const f = await fixture(t);
  f.client.mutation = async () => { throw new Error("PRIVATE_NETWORK_ERROR"); };
  const controller = new AbortController();
  const waits = [];
  await f.worker.run({ signal: controller.signal, pollIntervalMs: 5, sleep: async (ms) => { waits.push(ms); controller.abort(); } });
  assert.deepEqual(waits, [5]);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_NETWORK_ERROR/);
});
