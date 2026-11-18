import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Script } from "node:vm";
import { convexTest } from "convex-test";
import { makeFunctionReference, getFunctionName } from "convex/server";
import { sendEmail, inspectEmail } from '../../convex/deliveryLoopProviders.js';
import schema from "../../convex/schema.js";

const workerToken = "offline-delivery-worker-token-over-32-characters";
const password = "fictional-offline-complimentary-password";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const ref = (name) => makeFunctionReference(`deliveryLoop:${name}`);
const intake = { email: "fictional@example.invalid", babyName: "Amal", language: "fr", gender: "girl", context: "general", voiceEnabled: false, consent: true, fictional: true, source: "first_party_delivery" };
function fixture() {
  process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN = workerToken;
  process.env.BEBEBONJOUR_TRIAL_PASSWORD_SHA256 = sha(password);
  process.env.CONVEX_SITE_URL = "https://offline.convex.site";
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./deliveryLoop.js": () => import("../../convex/deliveryLoop.js"),
    "./deliveryLoopHttp.js": () => import("../../convex/deliveryLoopHttp.js"),
    "./http.js": () => import("../../convex/http.js"),
    "./narrationHttp.js": () => import("../../convex/narrationHttp.js"),
  });
}
const submit = (t, idempotencyKey = "intake-offline-001", fields = {}) => t.mutation(ref("submit"), { intake, magicPassword: password, idempotencyKey, ...fields });
const claim = (t, leaseToken = "offline-lease-token-001") => t.mutation(ref("claim"), { workerToken, workerId: "offline-worker", leaseToken });
const read = (t, jobId) => t.query(ref("read"), { workerToken, jobId });

async function publish(t, jobId, lease, label) {
  const contentHtml = `<html><body><h1>${label}</h1></body></html>`;
  return t.mutation(ref("publish"), { workerToken, jobId, leaseToken: lease.leaseToken, revision: lease.revision, contentHtml, contentDigest: sha(contentHtml), composition: { title: label }, compositionReceipt: { provider: "offline", label }, audioFiles: [] });
}
async function email(t, jobId, leaseToken) {
  const lease = await claim(t, leaseToken);
  const fenced = await t.mutation(ref("fence"), { workerToken, jobId, leaseToken, stage: lease.stage });
  assert.equal(fenced.emailIdempotencyKey, `bebe-loop:${jobId}:${lease.revision}:${lease.stage}`);
  assert.equal(fenced.intake.customer.email, intake.email);
  await t.mutation(ref("completeEmail"), { workerToken, jobId, leaseToken, revision: lease.revision, stage: lease.stage, providerMessageId: `offline-${leaseToken}` });
  return lease;
}

test("the actual public HTTP route removes the immutable draft banner only after approval", async () => {
  const t = fixture();
  const admitted = await submit(t);
  const generation = await claim(t);
  const html = '<html><body><!--delivery-loop-draft:start--><aside data-draft-marker>Première version · en attente de votre validation</aside><!--delivery-loop-draft:end--><main>Public story remains unchanged.</main></body></html>';
  await publish(t, admitted.jobId, generation, html);
  await email(t, admitted.jobId, "http-draft-email");
  const path = new URL(admitted.publicUrl).pathname;
  const draft = await t.fetch(path);
  assert.equal(draft.status, 200);
  assert.equal(draft.headers.get("x-bebebonjour-review-status"), "draft");
  assert.match(await draft.text(), /data-draft-marker/);
  const before = await read(t, admitted.jobId);
  await t.mutation(ref("requestReview"), { workerToken, jobId: admitted.jobId, expectedRevision: 1, actor: "simulated_human", action: "approve", idempotencyKey: "http-approve" });
  const approved = await t.fetch(path);
  assert.equal(approved.status, 200);
  assert.equal(approved.headers.get("x-bebebonjour-review-status"), "approved");
  const actual = await approved.text();
  assert.match(actual, /Public story remains unchanged\./);
  assert.doesNotMatch(actual, /data-draft-marker|data-delivery-draft|en attente de votre validation|delivery-loop-draft:start/);
  assert.deepEqual((await read(t, admitted.jobId)).revisions, before.revisions, "HTTP presentation must not rewrite archived publication bytes or their digest");
});

test("operator recovery retries only a rejected pre-narration correction and preserves its finite attempt history", async () => {
  const t = fixture();
  const admitted = await submit(t);
  const first = await claim(t);
  await publish(t, admitted.jobId, first, "First draft");
  await email(t, admitted.jobId, "offline-recovery-draft-email");
  await t.mutation(ref("requestReview"), { workerToken, jobId: admitted.jobId, expectedRevision: 1, actor: "simulated_human", action: "request_changes", feedback: "Replace the last sentence with: Welcome Amal.", idempotencyKey: "offline-recovery-correction" });
  const second = await claim(t, "offline-recovery-second-lease");
  await t.mutation(ref("fail"), { workerToken, jobId: admitted.jobId, leaseToken: second.leaseToken, reason: "correction_not_applied", retryable: false });
  const before = await read(t, admitted.jobId);
  const recovery = { workerToken, jobId: admitted.jobId, expectedRevision: 2 };
  await assert.rejects(t.mutation(ref("retryCorrection"), { ...recovery, workerToken: "incorrect" }), /forbidden/);
  await assert.rejects(t.mutation(ref("retryCorrection"), { ...recovery, expectedRevision: 1 }), /stale_revision/);
  assert.equal((await t.mutation(ref("retryCorrection"), recovery)).status, "generation_queued");
  const queued = await read(t, admitted.jobId);
  assert.deepEqual(queued.revisions, before.revisions);
  assert.deepEqual(queued.emailReceipts, before.emailReceipts);
  assert.deepEqual(queued.reviewOperations, before.reviewOperations);
  assert.deepEqual(queued.lastError, before.lastError);
  assert.equal(queued.generationAttempts, 1);
  assert.equal(queued.audit.at(-1).type, "correction_retry_authorized");
  await assert.rejects(t.mutation(ref("retryCorrection"), recovery), /correction_retry_unavailable/);
  const retry = await claim(t, "offline-recovery-third-lease");
  assert.equal(retry.generationAttempts, 2);
  await t.mutation(ref("fail"), { workerToken, jobId: admitted.jobId, leaseToken: retry.leaseToken, reason: "correction_not_applied", retryable: false });
  await t.mutation(ref("retryCorrection"), recovery);
  const final = await claim(t, "offline-recovery-final-lease");
  await t.mutation(ref("fail"), { workerToken, jobId: admitted.jobId, leaseToken: final.leaseToken, reason: "correction_not_applied", retryable: false });
  await assert.rejects(t.mutation(ref("retryCorrection"), recovery), /correction_retry_unavailable/);
  assert.equal((await read(t, admitted.jobId)).generationAttempts, 3);
});

const operatorToken = "offline-operations-token-over-32-characters";
test("operator console lists jobs newest first with revision links and retries only a failed correction", async () => {
  process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
  const t = fixture();
  const first = await submit(t, "ops-list-001");
  const second = await submit(t, "ops-list-002", { intake: { ...intake, babyName: "Noor" } });
  const lease = await claim(t, "offline-ops-list-lease-001");
  await publish(t, lease.jobId, lease, "First draft");
  await assert.rejects(t.query(ref("operatorJobs"), { operatorToken: "incorrect" }), /forbidden/);
  await assert.rejects(t.query(ref("operatorJobs"), { operatorToken: workerToken }), /forbidden/);
  const listed = await t.query(ref("operatorJobs"), { operatorToken });
  assert.deepEqual(listed.map((job) => job.jobId), [second.jobId, first.jobId]);
  const published = listed.find((job) => job.jobId === lease.jobId);
  assert.equal(published.babyName, lease.jobId === first.jobId ? "Amal" : "Noor");
  assert.equal(published.customerEmail, intake.email);
  assert.deepEqual(published.revisions.map((r) => r.revision), [1]);
  assert.equal(published.publicUrl, `https://offline.convex.site/announcements/${(await read(t, lease.jobId)).publicToken}`);
  assert.equal(published.canRetryCorrection, false);
  assert.equal(JSON.stringify(listed).includes("reviewToken"), false);

  await t.run(async (ctx) => {
    const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_job_id", (q) => q.eq("jobId", second.jobId)).unique();
    await ctx.db.patch(row._id, { status: "failed", data: { ...row.data, desiredRevision: 2, latestRevision: 1, feedback: "A correction", generationAttempts: 1, lastError: { reason: "correction_not_applied", stage: "generate", atMs: 1 } } });
  });
  const failed = (await t.query(ref("operatorJobs"), { operatorToken })).find((job) => job.jobId === second.jobId);
  assert.equal(failed.canRetryCorrection, true);
  assert.equal(failed.desiredRevision, 2);
  assert.equal(failed.lastError.reason, "correction_not_applied");
  const retry = { operatorToken, jobId: second.jobId, expectedRevision: 2 };
  await assert.rejects(t.mutation(ref("operatorRetryCorrection"), { ...retry, operatorToken: workerToken }), /forbidden/);
  await assert.rejects(t.mutation(ref("operatorRetryCorrection"), { ...retry, expectedRevision: 1 }), /stale_revision/);
  assert.equal((await t.mutation(ref("operatorRetryCorrection"), retry)).status, "generation_queued");
  await assert.rejects(t.mutation(ref("operatorRetryCorrection"), retry), /correction_retry_unavailable/);
  assert.equal((await t.query(ref("operatorJobs"), { operatorToken })).find((job) => job.jobId === second.jobId).status, "generation_queued");
});

test("correction recovery rejects paid narration, published content, email effects and unrelated failures", async () => {
  for (const drift of [
    { narrationReceipts: [{ revision: 2 }] },
    { emailReceipts: [{ revision: 2, stage: "draft_email" }] },
    { revisions: [{ revision: 2 }] },
    { lastError: { reason: "composition_provider_failed", stage: "generate" } },
    { lease: { stage: "draft_email", effectStartedAtMs: Date.now() } },
  ]) {
    const t = fixture();
    const admitted = await submit(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("deliveryLoopJobs").first();
      await ctx.db.patch(row._id, { status: "failed", data: { ...row.data, desiredRevision: 2, latestRevision: 1, feedback: "A correction", generationAttempts: 1, lastError: { reason: "correction_not_applied", stage: "generate" }, ...drift } });
    });
    const before = await read(t, admitted.jobId);
    await assert.rejects(t.mutation(ref("retryCorrection"), { workerToken, jobId: admitted.jobId, expectedRevision: 2 }), /correction_retry_unavailable/);
    assert.deepEqual(await read(t, admitted.jobId), before);
  }
});

test("complimentary intake is atomic, canonical, secret-free and idempotent", async () => {
  const t = fixture();
  const job = await submit(t);
  assert.equal(job.status, "generation_queued");
  assert.notEqual(job.reviewToken, new URL(job.publicUrl).pathname.split("/").pop());
  assert.ok(job.reviewToken.length >= 64);
  assert.deepEqual(await submit(t), job);
  await assert.rejects(submit(t, "intake-offline-001", { intake: { ...intake, babyName: "Changed" } }), /idempotency_conflict/);
  const row = await read(t, job.jobId);
  assert.equal(row.payment.status, "waived");
  assert.equal(row.payment.reason, "magic_password");
  assert.equal(row.intake.customer.consent, true);
  assert.equal(row.intake.fictional, true);
  assert.equal(JSON.stringify(row).includes(password), false);
  assert.equal((await t.run((ctx) => ctx.db.query("deliveryLoopJobs").collect())).length, 1);
  const safe = await t.query(ref("status"), { jobId: job.jobId, reviewToken: job.reviewToken });
  assert.equal(JSON.stringify(safe).includes(intake.email), false);
  await assert.rejects(t.query(ref("read"), { workerToken: "incorrect", jobId: job.jobId }), /forbidden/);
});

test("first publication precedes review; correction retains prior page; final approval queues final email", async () => {
  const t = fixture();
  const job = await submit(t);
  const first = await claim(t);
  assert.equal(first.stage, "generate");
  assert.equal(first.revision, 1);
  assert.ok(first.leaseExpiresAtMs - Date.now() >= 10 * 60 * 1000);
  assert.equal((await t.query(ref("authorizeProvider"), { workerToken, jobId: job.jobId, leaseToken: first.leaseToken, revision: 1, stage: "generate" })).intake.baby.firstName, intake.babyName);
  await publish(t, job.jobId, first, "First actual test draft");
  const publicToken = new URL(job.publicUrl).pathname.split("/").pop();
  assert.equal((await t.query(ref("publicPage"), { publicToken })).revision, 1);
  await assert.rejects(t.mutation(ref("requestReview"), { jobId: job.jobId, reviewToken: job.reviewToken, action: "approve", expectedRevision: 1, idempotencyKey: "before-email" }), /draft_not_delivered/);
  await email(t, job.jobId, "offline-draft-email-001");
  const review = { jobId: job.jobId, workerToken, actor: "simulated_human", action: "request_changes", expectedRevision: 1, feedback: "Use a warmer greeting.", idempotencyKey: "correction-001" };
  const changed = await t.mutation(ref("requestReview"), review);
  assert.equal(changed.status, "generation_queued");
  assert.deepEqual(await t.mutation(ref("requestReview"), review), changed);
  assert.equal((await t.query(ref("publicPage"), { publicToken })).revision, 1);
  const next = await claim(t, "offline-generate-002");
  assert.equal(next.revision, 2);
  assert.equal(next.feedback, review.feedback);
  assert.equal(next.previousComposition.title, "First actual test draft");
  await assert.rejects(publish(t, job.jobId, first, "Stale"), /stale_lease/);
  await publish(t, job.jobId, next, "Corrected draft");
  await email(t, job.jobId, "offline-draft-email-002");
  await assert.rejects(t.mutation(ref("requestReview"), { ...review, action: "approve", expectedRevision: 1, idempotencyKey: "stale-approval" }), /stale_revision/);
  await t.mutation(ref("requestReview"), { jobId: job.jobId, reviewToken: job.reviewToken, action: "approve", expectedRevision: 2, idempotencyKey: "approval-002" });
  await email(t, job.jobId, "offline-final-email-002");
  const row = await read(t, job.jobId);
  assert.equal(row.status, "approved_sent");
  assert.equal(row.revisions.length, 2);
  assert.equal(row.audit.find((event) => event.type === "review_request_changes").simulated, true);
  assert.equal(row.audit.find((event) => event.type === "review_approve").actor, "customer");
  assert.equal((await t.query(ref("publicPage"), { publicToken })).draft, false);
});

test("flat UI and nested worker intake normalize to canonical nested fields without losing consent", async () => {
  const t = fixture();
  const nested = { schemaVersion: "1.0", customer: { email: intake.email, consent: true }, baby: { firstName: intake.babyName, gender: "girl", nameArabic: "أمل" }, languages: ["fr", "ar"], context: { religion: "islam" }, voicePreference: { enabled: true, gender: "neutral" }, fictional: true };
  const job = await submit(t, "nested-intake-001", { intake: nested });
  assert.match(job.jobId, /^job_[a-f0-9]{64}$/);
  const row = await read(t, job.jobId);
  assert.deepEqual(row.intake.customer, nested.customer);
  assert.deepEqual(row.intake.languages, nested.languages);
  assert.deepEqual(row.intake.baby, nested.baby);
  assert.equal(row.intake.context.religion, "islam");
  assert.equal(row.intake.voicePreference.enabled, true);
  assert.deepEqual(await submit(t, "nested-intake-001", { intake: nested }), job);
  await assert.rejects(submit(t, "no-consent", { intake: { ...nested, customer: { ...nested.customer, consent: false } } }), /consent_required/);
  await assert.rejects(submit(t, "large-name", { intake: { ...intake, babyName: "x".repeat(101) } }), /invalid_baby_name/);
});

test("bad-password throttles commit durably and retain no raw password, IP or email", async () => {
  const t = fixture();
  for (let i = 0; i < 5; i++) assert.equal((await submit(t, `bad-${i}`, { magicPassword: "incorrect-fictional-password" })).error, "invalid_magic_password");
  assert.equal((await submit(t, "bad-six", { magicPassword: "incorrect-fictional-password" })).error, "intake_rate_limited");
  assert.equal((await submit(t)).error, "intake_rate_limited");
  const throttleRows = await t.run((ctx) => ctx.db.query("deliveryLoopIntakeThrottle").collect());
  const serialized = JSON.stringify(throttleRows);
  assert.equal(serialized.includes(intake.email), false);
  assert.equal(serialized.includes("incorrect-fictional-password"), false);
  assert.equal(throttleRows.find((r) => r.bucketKey.startsWith("email:")).attempts, 5);
  await t.run(async (ctx) => { for (const row of await ctx.db.query("deliveryLoopIntakeThrottle").collect()) await ctx.db.patch(row._id, { windowStartedAtMs: Date.now() - 16 * 60 * 1000 }); });
  assert.equal((await submit(t)).status, "generation_queued");
});

async function expire(t, jobId) {
  await t.run(async (ctx) => { const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).unique(); row.data.lease.leaseExpiresAtMs = Date.now() - 1; await ctx.db.patch(row._id, { data: row.data }); });
}
test("generation leases reclaim with CAS and bounded retries; uncertain emails never reclaim", async () => {
  const t = fixture();
  const job = await submit(t);
  const first = await claim(t);
  assert.equal(await claim(t, "other-offline-lease-001"), null);
  await expire(t, job.jobId);
  const second = await claim(t, "offline-reclaim-002");
  assert.equal(second.jobId, job.jobId);
  await assert.rejects(t.query(ref("authorizeProvider"), { workerToken, jobId: job.jobId, leaseToken: first.leaseToken, revision: 1, stage: "generate" }), /stale_lease/);
  await publish(t, job.jobId, second, "Lease reclaimed draft");
  const mail = await claim(t, "offline-uncertain-email-003");
  await assert.rejects(t.mutation(ref("completeEmail"), { workerToken, jobId: job.jobId, leaseToken: mail.leaseToken, revision: 1, stage: "draft_email", providerMessageId: "offline-unfenced-id" }), /email_not_fenced/);
  await t.mutation(ref("fence"), { workerToken, jobId: job.jobId, leaseToken: mail.leaseToken, revision: 1, stage: "draft_email" });
  await expire(t, job.jobId);
  assert.equal(await claim(t, "offline-no-email-reclaim-004"), null);
  const row = await read(t, job.jobId);
  assert.equal(row.status, "reconciliation_required");
  assert.equal(row.lease.emailIdempotencyKey, `bebe-loop:${job.jobId}:1:draft_email`);
  assert.equal(row.emailReceipts.length, 0);

  const other = await submit(t, "bounded-generation-job-001");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const lease = await claim(t, `offline-bounded-generation-${attempt}`);
    const failed = await t.mutation(ref("fail"), { workerToken, jobId: other.jobId, leaseToken: lease.leaseToken, reason: "offline_retryable_failure", retryable: true });
    assert.equal(failed.status, attempt < 3 ? "generation_queued" : "failed");
  }
  assert.equal(await claim(t, "offline-exhausted-generation-004"), null);
});

test("only worker auth can label simulation; review feedback and replay are bounded", async () => {
  const t = fixture(); const job = await submit(t);
  const lease = await claim(t); await publish(t, job.jobId, lease, "Review auth draft"); await email(t, job.jobId, "offline-review-auth-email-001");
  const args = { jobId: job.jobId, reviewToken: job.reviewToken, expectedRevision: 1, action: "request_changes", feedback: "Please adjust.", idempotencyKey: "review-auth-001" };
  await assert.rejects(t.mutation(ref("requestReview"), { ...args, actor: "simulated_human" }), /forbidden_actor/);
  await assert.rejects(t.mutation(ref("requestReview"), { ...args, feedback: "x".repeat(2001) }), /feedback_required/);
  await assert.rejects(t.mutation(ref("requestReview"), { ...args, reviewToken: "incorrect" }), /forbidden/);
  await t.mutation(ref("requestReview"), args);
  await assert.rejects(t.mutation(ref("requestReview"), { ...args, feedback: "Different feedback" }), /idempotency_conflict/);
  assert.equal((await read(t, job.jobId)).audit.find((event) => event.type === "review_request_changes").simulated, false);
});

test("narration receipts survive generation reclaim, immutable public audio resolves stored bytes", async () => {
  const t = fixture(); const job = await submit(t, "audio-intake-001", { intake: { ...intake, voiceEnabled: true } });
  const first = await claim(t);
  const fixtureBytes = new TextEncoder().encode("OFFLINE STORAGE FIXTURE — not generated speech".repeat(5));
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([fixtureBytes], { type: "audio/mpeg" })));
  const narration = { workerToken, jobId: job.jobId, leaseToken: first.leaseToken, revision: 1, language: "fr", textDigest: sha("offline-narration-text"), storageId, provider: "openai", model: "offline-model-fixture", voice: "cedar" };
  await t.mutation(ref("recordNarration"), narration);
  assert.deepEqual(await t.mutation(ref("recordNarration"), narration), (await read(t, job.jobId)).narrationReceipts[0]);
  await assert.rejects(publish(t, job.jobId, first, "Audio missing"), /requested_audio_missing/);
  await expire(t, job.jobId);
  const reclaimed = await claim(t, "offline-audio-reclaim-002");
  assert.equal(reclaimed.narrationReceipts[0].storageId, storageId);
  const contentHtml = '<html><body><h1>Annonce audio</h1></body></html>';
  await t.mutation(ref("publish"), { workerToken, jobId: job.jobId, leaseToken: reclaimed.leaseToken, revision: 1, contentHtml, contentDigest: sha(contentHtml), composition: { title: "Audio" }, compositionReceipt: { provider: "offline" }, audioFiles: [{ language: "fr", storageId, textDigest: narration.textDigest }] });
  const publicToken = reclaimed.publicToken;
  const response = await t.fetch(`/announcements/${publicToken}/audio/1/fr`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), fixtureBytes);
  assert.equal((await t.fetch(`/announcements/${publicToken}/audio/2/fr`)).status, 404);
  assert.equal((await t.fetch(`/announcements/${publicToken}/audio/1/ar`)).status, 404);
});

test("same-domain proxy: configured public origin is accepted, others stay forbidden, links use it", async () => {
  const saved = process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN;
  process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN = "https://www.bebebonjour.com";
  try {
    const t = fixture();
    const post = (value, origin) => t.fetch("/delivery/intake", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(value) });
    const payload = { intake, idempotencyKey: "same-domain-001", magicPassword: password };
    assert.equal((await post(payload, "https://attacker.invalid")).status, 403);
    assert.equal((await post(payload, "https://www.bebebonjour.com.attacker.invalid")).status, 403);
    const ok = await post(payload, "https://www.bebebonjour.com");
    assert.equal(ok.status, 200);
    const job = await ok.json();
    assert.match(job.reviewUrl, /^https:\/\/www\.bebebonjour\.com\/delivery\/review\?/);
    assert.match(job.publicUrl, /^https:\/\/www\.bebebonjour\.com\/announcements\//);
  } finally {
    if (saved === undefined) delete process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN; else process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN = saved;
  }
});

test("HTTP intake/review/publication journey works without credentials or provider effects", async () => {
  const t = fixture();
  const page = await t.fetch('/delivery'); const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /name="consent" required/); assert.match(html, /avant révision humaine/);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  const post = (path, value, headers = {}) => t.fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  const payload = { intake, idempotencyKey: "http-intake-001", magicPassword: password };
  const accepted = await post('/delivery/intake', payload); assert.equal(accepted.status, 200); const job = await accepted.json();
  assert.deepEqual(await (await post('/delivery/intake', payload)).json(), job);
  const publicPath = new URL(job.publicUrl).pathname;
  assert.match(await (await t.fetch(publicPath)).text(), /se prépare/);
  const lease = await claim(t); await publish(t, job.jobId, lease, "HTTP first draft");
  const draft = await t.fetch(publicPath); const draftHtml = await draft.text();
  assert.match(draftHtml, /Première version — en attente de révision/);
  for (const privateValue of [intake.email, job.reviewToken, workerToken, 'compositionReceipt']) assert.equal(draftHtml.includes(privateValue), false);
  assert.equal(draft.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(draft.headers.get('content-security-policy'), /sandbox/);
  assert.equal(draft.headers.get('referrer-policy'), 'no-referrer');
  const reviewPath = new URL(job.reviewUrl).pathname + new URL(job.reviewUrl).search;
  const waiting = await t.fetch(reviewPath); assert.equal(waiting.status, 200); assert.match(await waiting.text(), /disabled/);
  await email(t, job.jobId, "offline-http-draft-email-001");
  const review = await t.fetch(reviewPath); const reviewHtml = await review.text();
  for (const match of reviewHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  assert.match(reviewHtml, /maxlength="2000"/);
  const approved = await post('/delivery/review', { jobId: job.jobId, reviewToken: job.reviewToken, action: "approve", expectedRevision: 1, idempotencyKey: "http-review-001" });
  assert.equal(approved.status, 200); assert.equal((await approved.json()).status, "final_email_queued");
  assert.doesNotMatch(await (await t.fetch(publicPath)).text(), /Première version — en attente de révision/);
  assert.equal((await post('/delivery/intake', payload, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await t.fetch('/delivery/intake', { method: "POST", body: JSON.stringify(payload) })).status, 415);
  assert.equal((await post('/delivery/intake', { ...payload, intake: { ...intake, huge: 'x'.repeat(17000) } })).status, 413);
  assert.equal((await t.fetch('/delivery/review?jobId='+job.jobId+'&token=incorrect')).status, 403);
  assert.equal((await t.fetch('/announcements/malformed-token')).status, 404);
});

test("uploads/publication are lease-fenced, digest-bound and reject private capability leaks", async () => {
  const t = fixture(); const job = await submit(t); const lease = await claim(t);
  assert.match(await t.mutation(ref("uploadUrl"), { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken }), /^https:/);
  const args = { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken, revision: 1, contentHtml: '<h1>Bound draft</h1>', composition: { title: 'Bound' }, compositionReceipt: { provider: 'offline' }, contentDigest: 'f'.repeat(64), audioFiles: [] };
  await assert.rejects(t.mutation(ref("publish"), args), /content_digest_mismatch/);
  const privateHtml = `<p>${job.reviewToken}</p>`;
  await assert.rejects(t.mutation(ref("publish"), { ...args, contentHtml: privateHtml, contentDigest: sha(privateHtml) }), /private_content_leak/);
  await expire(t, job.jobId);
  await assert.rejects(t.mutation(ref("uploadUrl"), { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken }), /stale_lease/);
  assert.equal((await read(t, job.jobId)).latestRevision, 0);
});

test("email admissions retain provider identity and opaque Cloudflare receipts", async () => {
  const t = fixture(); const job = await submit(t); const generation = await claim(t);
  await publish(t, job.jobId, generation, "Provider binding draft");
  const lease = await claim(t, "provider-binding-email-lease");
  const args = { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken, revision: 1, stage: "draft_email" };
  process.env.BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER = "cloudflare";
  try {
    const fenced = await t.mutation(ref("fence"), args);
    assert.equal(fenced.emailProvider, "cloudflare");
    const opaque = `<${"opaque".repeat(40)}@example.invalid>`;
    await assert.rejects(t.mutation(ref("completeEmail"), { ...args, provider: "other", providerMessageId: opaque }), /Validator error/);
    await t.mutation(ref("completeEmail"), { ...args, provider: "cloudflare", providerMessageId: opaque });
    const stored = (await read(t, job.jobId)).emailReceipts.at(-1);
    assert.equal(stored.provider, "cloudflare");
    assert.equal(stored.providerMessageId, opaque);
  } finally { delete process.env.BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER; }
});

test("actual Cloudflare action admits one concurrent send and survives a lost completion acknowledgement", async () => {
  const t=fixture(), job=await submit(t), generation=await claim(t); await publish(t,job.jobId,generation,'Cloudflare draft');
  const lease=await claim(t,'cloudflare-concurrent-lease'); const args={workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,revision:1,stage:'draft_email'};
  const names=['BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER','BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID','BEBEBONJOUR_CLOUDFLARE_ZONE_ID','BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN','BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN'];const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));const original=globalThis.fetch;
  Object.assign(process.env,{BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER:'cloudflare',BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),BEBEBONJOUR_CLOUDFLARE_ZONE_ID:'b'.repeat(32),BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN:'synthetic-send-token',BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN:'synthetic-read-token'});
  let started, release; const reached=new Promise(r=>started=r), gate=new Promise(r=>release=r);let calls=0;
  globalThis.fetch=async(_url,opts)=>{calls++;started();await gate;const body=JSON.parse(opts.body);return Response.json({success:true,errors:[],result:{message_id:'<durable@example.invalid>',queued:[body.to],delivered:[],permanent_bounces:[]}});};
  const ctx={runQuery:(fn,a)=>t.query(fn,a),runMutation:async(fn,a)=>{const result=await t.mutation(fn,a);if(getFunctionName(fn).endsWith(':completeEmail'))throw new Error('lost_db_ack');return result;}};
  try {const first=sendEmail._handler(ctx,args);await reached;await assert.rejects(sendEmail._handler(ctx,args),/email_reconciliation_required/);release();await assert.rejects(first,/lost_db_ack/);const row=await read(t,job.jobId);assert.equal(calls,1);assert.equal(row.emailReceipts[0].provider,'cloudflare');assert.equal(row.emailReceipts[0].providerMessageId,'<durable@example.invalid>');await assert.rejects(sendEmail._handler(ctx,args));assert.equal(calls,1);
    process.env.BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER='other';
    globalThis.fetch=async(url,opts)=>{assert.equal(url,'https://api.cloudflare.com/client/v4/graphql');const datetime=JSON.parse(opts.body).variables.end;return Response.json({data:{viewer:{zones:[{emailSendingAdaptive:[{messageId:'<durable@example.invalid>',status:'delivered',datetime}]}]}}});};
    await assert.rejects(inspectEmail._handler(ctx,{workerToken,jobId:job.jobId,providerMessageId:'<durable@example.invalid>'}), /cloudflare_status_unavailable/);}
  finally {release();globalThis.fetch=original;for(const k of names)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
});

test("a repeated email fence cannot admit a second provider call", async () => {
  const t = fixture(); const job = await submit(t); const generation = await claim(t);
  await publish(t, job.jobId, generation, "Single admission draft");
  const lease = await claim(t, "single-admission-email-lease");
  const args = { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken, revision: 1, stage: "draft_email" };
  await t.mutation(ref("fence"), args);
  await assert.rejects(t.mutation(ref("fence"), args), /email_reconciliation_required/);
});

test("explicit definitive email rejection retries the same key; ambiguous failure stays reconciliable", async () => {
  const t = fixture(); const job = await submit(t); const generation = await claim(t); await publish(t, job.jobId, generation, "Email failure draft");
  const first = await claim(t, "offline-email-rejected-001");
  const key = (await t.mutation(ref("fence"), { workerToken, jobId: job.jobId, leaseToken: first.leaseToken, revision: 1, stage: "draft_email" })).emailIdempotencyKey;
  const rejected = await t.mutation(ref("fail"), { workerToken, jobId: job.jobId, leaseToken: first.leaseToken, reason: "offline_definitive_rejection", retryable: true, providerDefinitiveFailure: true });
  assert.equal(rejected.status, "draft_email_queued");
  const retry = await claim(t, "offline-email-rejected-002");
  assert.equal(retry.emailIdempotencyKey, key);
  await t.mutation(ref("fence"), { workerToken, jobId: job.jobId, leaseToken: retry.leaseToken, revision: 1, stage: "draft_email" });
  const ambiguous = await t.mutation(ref("fail"), { workerToken, jobId: job.jobId, leaseToken: retry.leaseToken, reason: "offline_uncertain_transport", retryable: true });
  assert.equal(ambiguous.status, "reconciliation_required");
  assert.equal(await claim(t, "offline-email-not-retryable-003"), null);
  assert.equal((await read(t, job.jobId)).lease.emailIdempotencyKey, key);
});
