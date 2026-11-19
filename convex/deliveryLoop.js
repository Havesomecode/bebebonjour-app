import { mutationGeneric, queryGeneric, internalMutationGeneric, internalQueryGeneric, makeFunctionReference } from "convex/server";
import { validPhraseStarts } from '../src/delivery-loop/narration-timing.mjs';
import { v } from "convex/values";
import { promotionEvidence } from './deliveryLoopPromotion.js';
import { TEST_PROMOTION_POLICY, testPromotionBinding, isTestPromotionReceipt, samePromotion } from '../src/delivery-loop/test-promotion.mjs';
import { validateBrief, briefDigest, suggestBrief, TONES, GENDERS, RELIGIONS } from "../src/delivery-loop/brief.mjs";
import { catalogMeaning } from "../src/delivery-loop/name-reference.mjs";
import { PAID_MODE, TERMS_VERSION, isPaid, paidEnabled, activePaid, stageState, paidStageGate, paidSafeStatus, expectedLivemode } from "./deliveryLoopPaidPolicy.js";

const LEASE_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const DIGEST = /^[a-f0-9]{64}$/;
const workerArgs = { workerToken: v.string(), jobId: v.string() };
const leaseArgs = { ...workerArgs, leaseToken: v.string() };
const stageValue = v.union(v.literal("generate"), v.literal("draft_email"), v.literal("final_email"));
const hash = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((n) => n.toString(16).padStart(2, "0")).join("");
const randomToken = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
function text(value, max, code = "invalid_input") {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error(code);
  return value.trim();
}
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function auth(token) {
  const configured = process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN;
  if (!configured || configured.length < 32 || !equal(token, configured)) throw new Error("forbidden");
}
function canonicalIntake(input, idempotencyKey) {
  if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 12000) throw new Error("invalid_intake");
  const nested = input.customer !== undefined || input.baby !== undefined;
  const email = text(nested ? input.customer?.email : input.email, 254, "invalid_email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error("invalid_email");
  if ((nested ? input.customer?.consent : input.consent) !== true) throw new Error("consent_required");
  const languages = nested ? input.languages : [input.language];
  const gender = nested ? input.baby?.gender : input.gender;
  const religion = nested ? input.context?.religion : input.context;
  const enabled = nested ? input.voicePreference?.enabled : input.voiceEnabled;
  const rawVoice = nested ? input.voicePreference?.voice : input.voice;
  const voice = rawVoice === undefined || rawVoice === "" ? "pere" : rawVoice;
  if (!["pere", "mere"].includes(voice)) throw new Error("invalid_intake");
  const voiceGender = nested ? input.voicePreference?.gender || "neutral" : "neutral";
  if (!Array.isArray(languages) || languages.length < 1 || languages.length > 2 || new Set(languages).size !== languages.length || languages.some((language) => !["fr", "ar"].includes(language)) || !["girl", "boy", "neutral"].includes(gender) || !["general", "islam"].includes(religion) || typeof enabled !== "boolean" || !["male", "female", "neutral"].includes(voiceGender)) throw new Error("invalid_intake");
  if (input.fictional !== undefined && typeof input.fictional !== "boolean") throw new Error("invalid_intake");
  const baby = { firstName: text(nested ? input.baby?.firstName : input.babyName, 100, "invalid_baby_name"), gender };
  if (input.baby?.nameArabic !== undefined) baby.nameArabic = text(input.baby.nameArabic, 100);
  const intake = { schemaVersion: "1.0", requestId: input.requestId ? text(input.requestId, 200) : idempotencyKey, customer: { email, consent: true }, baby, languages: [...languages], context: { religion }, voicePreference: { enabled, gender: voiceGender, voice }, fictional: input.fictional === true, source: "first_party_delivery" };
  if (input.submittedAt !== undefined) {
    if (typeof input.submittedAt !== "string" || input.submittedAt.length > 40 || !Number.isFinite(Date.parse(input.submittedAt))) throw new Error("invalid_intake");
    intake.submittedAt = input.submittedAt;
  }
  if (input.request !== undefined) intake.request = input.request === "" ? "" : text(input.request, 2000);
  if (input.birthDate !== undefined && input.birthDate !== null && input.birthDate !== "") {
    const date = input.birthDate;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000-") || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("invalid_intake");
    intake.birthDate = date;
  }
  return intake;
}
function origin() {
  const url = process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN || process.env.CONVEX_SITE_URL;
  if (!url) return ""; // Relative first-party URLs remain usable without deployment configuration.
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid_delivery_origin");
  return parsed.origin;
}
function links(row) {
  return { publicUrl: `${origin()}/announcements/${row.publicToken}`, reviewUrl: `${origin()}/delivery/review?jobId=${encodeURIComponent(row.jobId)}&token=${row.data.reviewToken}` };
}
function admission(row) { return { jobId: row.jobId, reviewToken: row.data.reviewToken, ...links(row), ...(isPaid(row) ? { publicUrl: null, orderMode: PAID_MODE } : {}), status: row.status }; }
function full(row) { return { ...row.data, jobId: row.jobId, publicToken: row.publicToken, status: row.status, ...links(row) }; }
function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]));
  return value;
}
export async function get(ctx, jobId) {
  const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).unique();
  if (!row) throw new Error("not_found");
  if (row.data.deletedAtMs) throw new Error("data_deleted");
  return row;
}
export async function save(ctx, row, status = row.status) {
  if (isPaid(row)) row.data.lastActivityAtMs = Date.now();
  if (new TextEncoder().encode(JSON.stringify(row.data)).byteLength > 850000) throw new Error("job_capacity_reached");
  await ctx.db.patch(row._id, { status, data: row.data }); row.status = status;
}
export function audit(row, type, details = {}) { row.data.audit.push({ type, atMs: Date.now(), ...details }); }
// Notices are sent once by deliveryLoopNotices:send; a failure is recorded, never retried.
async function queueNotice(ctx, row, kind, revision) {
  row.data.notices ||= [];
  if (row.data.notices.some((notice) => notice.kind === kind && notice.revision === revision)) return;
  row.data.notices.push({ kind, revision, status: "pending", atMs: Date.now() });
  await ctx.scheduler.runAfter(0, makeFunctionReference("deliveryLoopNotices:send"), { jobId: row.jobId, kind, revision });
}
export const noticeContext = internalQueryGeneric({
  args: { jobId: v.string(), kind: v.string(), revision: v.number() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId);
    const notice = (row.data.notices || []).find((n) => n.kind === args.kind && n.revision === args.revision);
    if (notice?.status !== "pending") return null;
    const brief = (row.data.briefs || []).find((b) => b.revision === args.revision)?.brief;
    return { jobId: row.jobId, kind: args.kind, revision: args.revision, customerEmail: args.kind === "customer_payment" ? row.data.intake.customer.email : null, firstName: brief?.firstName ?? null, reviewUrl: args.kind === "customer_payment" ? links(row).reviewUrl : null };
  },
});
export const finishNotice = internalMutationGeneric({
  args: { jobId: v.string(), kind: v.string(), revision: v.number(), providerMessageId: v.optional(v.string()), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId);
    const notice = (row.data.notices || []).find((n) => n.kind === args.kind && n.revision === args.revision);
    if (notice?.status !== "pending") return;
    Object.assign(notice, args.providerMessageId ? { status: "sent", providerMessageId: args.providerMessageId } : { status: "failed", reason: args.reason || "notice_failed" }, { atMs: Date.now() });
    await save(ctx, row);
  },
});
function authorizeLease(row, token, revision, stage) {
  const lease = row.data.lease;
  if (!lease || !equal(lease.leaseToken, token) || lease.leaseExpiresAtMs <= Date.now() || (revision !== undefined && revision !== row.data.desiredRevision) || (stage !== undefined && stage !== lease.stage) || row.status !== stageState(lease.stage, "running")) throw new Error("stale_lease");
  paidStageGate(row, lease.stage);
  return lease;
}
// Customer-facing state: { jobId, status, desiredRevision, revision, publicUrl,
// draftEmailSent, canReview, fictional } plus, for paid orders, paidSafeStatus().
function safeStatus(row) {
  const paid = isPaid(row);
  const blocked = paid && (row.data.cancelledAtMs || row.data.revokedAtMs);
  const visible = row.data.latestRevision > 0 && !blocked && (!row.data.hostingEndsAtMs || row.data.hostingEndsAtMs > Date.now());
  return { jobId: row.jobId, status: row.status, desiredRevision: row.data.desiredRevision, revision: row.data.latestRevision, publicUrl: visible ? links(row).publicUrl : null, draftEmailSent: row.data.emailReceipts.some((e) => e.revision === row.data.latestRevision && e.stage === "draft_email"), canReview: !blocked && row.status === "awaiting_review" && row.data.desiredRevision === row.data.latestRevision, fictional: row.data.intake.fictional, ...(paid ? paidSafeStatus(row) : {}) };
}
async function throttle(ctx, email, badPassword) {
  let blocked = false;
  for (const [bucketKey, limit] of [["global", 60], [`email:${await hash(email)}`, 5]]) {
    const row = await ctx.db.query("deliveryLoopIntakeThrottle").withIndex("by_bucket_key", (q) => q.eq("bucketKey", bucketKey)).unique();
    const live = row && Date.now() - row.windowStartedAtMs < WINDOW_MS;
    if (live && row.attempts >= limit) blocked = true;
    if (badPassword && !blocked) {
      const values = { bucketKey, windowStartedAtMs: live ? row.windowStartedAtMs : Date.now(), attempts: live ? row.attempts + 1 : 1 };
      if (row) await ctx.db.patch(row._id, values); else await ctx.db.insert("deliveryLoopIntakeThrottle", values);
    }
  }
  return blocked;
}

export const submit = mutationGeneric({
  args: { intake: v.any(), idempotencyKey: v.string(), magicPassword: v.optional(v.string()), orderMode: v.optional(v.union(v.literal("complimentary"), v.literal(PAID_MODE))) },
  handler: async (ctx, args) => {
    const idempotencyKey = text(args.idempotencyKey, 200);
    const intake = canonicalIntake(args.intake, idempotencyKey);
    const paid = args.orderMode === PAID_MODE;
    if (paid) {
      var termsUrl = paidEnabled();
      if (args.intake.termsAccepted !== true || args.intake.publication !== true) throw new Error("paid_permissions_required");
      if (args.magicPassword) throw new Error("paid_waiver_forbidden");
      if (intake.languages.length !== 1 || !intake.voicePreference.enabled) throw new Error("paid_offer_mismatch");
      if (args.intake.customerPermissions !== true || intake.context.religion !== "general") throw new Error("paid_permissions_required");
      if (await throttle(ctx, intake.customer.email, true)) return { error: "intake_rate_limited" };
    }
    if (!paid && (typeof args.magicPassword !== "string" || args.magicPassword.length > 256)) throw new Error("invalid_input");
    const configured = process.env.BEBEBONJOUR_TRIAL_PASSWORD_SHA256;
    if (!paid && !DIGEST.test(configured || "")) throw new Error("trial_unavailable");
    const bad = !paid && !equal(await hash(args.magicPassword), configured);
    // Return rather than throw: failed authentication counts must commit.
    if (!paid && await throttle(ctx, intake.customer.email, bad)) return { error: "intake_rate_limited" };
    if (bad) return { error: "invalid_magic_password" };
    const requestDigest = await hash(JSON.stringify(intake));
    if (paid) {
      const deletedKey = `deleted:${await hash(idempotencyKey)}`;
      const tombstone = await ctx.db.query("deliveryLoopJobs").withIndex("by_idempotency_key", q => q.eq("idempotencyKey", deletedKey)).unique();
      if (tombstone) throw new Error("data_deleted");
    }
    const previous = await ctx.db.query("deliveryLoopJobs").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey)).unique();
    if (previous) {
      if (previous.data.requestDigest !== requestDigest || isPaid(previous) !== paid) throw new Error("idempotency_conflict");
      if (previous.data.deletedAtMs) throw new Error("data_deleted");
      return admission(previous);
    }
    intake.submittedAt ||= new Date().toISOString();
    const row = { jobId: `job_${randomToken()}`, publicToken: randomToken(), idempotencyKey, status: "awaiting_operator", data: { intake, requestDigest, reviewToken: randomToken(), payment: { status: "waived", reason: "magic_password", waivedAt: new Date().toISOString() }, desiredRevision: 1, latestRevision: 0, feedback: null, revisions: [], narrationReceipts: [], emailReceipts: [], reviewOperations: [], audit: [], lease: null, usedLeaseTokens: [], generationAttempts: 0, lastError: null, createdAtMs: Date.now() } };
    if (paid) Object.assign(row.data, { orderMode: PAID_MODE, paidConsent: { termsVersion: TERMS_VERSION, termsUrl, publication: true, acceptedAtMs: Date.now() }, customerDeclaration: { mainlandFranceAdultWithParentalPermissions: true, acceptedAtMs: Date.now() }, payment: { status: "pending" }, correctionsUsed: 0 });
    audit(row, "intake_accepted", { paymentStatus: row.data.payment.status, ...(paid ? { orderMode: PAID_MODE } : {}) });
    // Scheduling is transactional with the insert below.
    await queueNotice(ctx, row, "operator_new", 1);
    await ctx.db.insert("deliveryLoopJobs", row);
    return admission(row);
  },
});
export const read = queryGeneric({ args: workerArgs, handler: async (ctx, args) => { auth(args.workerToken); return full(await get(ctx, args.jobId)); } });
export const status = queryGeneric({ args: { jobId: v.string(), reviewToken: v.string() }, handler: async (ctx, args) => { const row = await get(ctx, args.jobId); if (!equal(row.data.reviewToken, args.reviewToken)) throw new Error("forbidden"); return safeStatus(row); } });

function work(row) {
  const { lease, intake, desiredRevision } = row.data;
  const brief = (row.data.briefs || []).find((item) => item.revision === desiredRevision)?.brief;
  return { jobId: row.jobId, revision: desiredRevision, stage: lease.stage, leaseToken: lease.leaseToken, leaseExpiresAtMs: lease.leaseExpiresAtMs, ...(lease.effectStartedAtMs === undefined ? {} : { effectStartedAtMs: lease.effectStartedAtMs }), orderMode: row.data.orderMode || "complimentary", publicUrl: links(row).publicUrl, ...(lease.stage === "generate" ? { brief } : {}), intake: { languages: intake.languages, voicePreference: intake.voicePreference, fictional: intake.fictional } };
}
export const claim = mutationGeneric({
  args: { workerToken: v.string(), workerId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    auth(args.workerToken);
    text(args.workerId, 200);
    if (text(args.leaseToken, 200).length < 16) throw new Error("invalid_lease_token");
    // Only generation may be blindly reclaimed. An email effect can be accepted
    // by the provider without its completion being committed here.
    for (const state of ["generation_running", "draft_email_running", "final_email_running"]) {
      const running = await ctx.db.query("deliveryLoopJobs").withIndex("by_status", (q) => q.eq("status", state)).take(100);
      for (const row of running) {
        const lease = row.data.lease;
        if (lease.leaseToken === args.leaseToken && lease.workerId === args.workerId && lease.leaseExpiresAtMs > Date.now()) return work(row);
        if (lease.leaseExpiresAtMs > Date.now()) continue;
        const status = lease.effectStartedAtMs !== undefined ? "reconciliation_required" : lease.stage === "generate" && row.data.generationAttempts >= 3 ? "failed" : stageState(lease.stage, "queued");
        audit(row, "lease_expired", { stage: lease.stage, revision: row.data.desiredRevision, outcome: status });
        // Keep uncertain email lease/journal for manual durable reconciliation.
        if (status !== "reconciliation_required") row.data.lease = null;
        await save(ctx, row, status);
      }
    }
    for (const stage of ["generate", "draft_email", "final_email"]) {
      const state = stageState(stage, "queued");
      const rows = await ctx.db.query("deliveryLoopJobs").withIndex("by_status", (q) => q.eq("status", state)).take(100);
      let row;
      for (const candidate of rows) {
        if (stage === "generate" && !(candidate.data.briefs || []).some((item) => item.revision === candidate.data.desiredRevision)) {
          audit(candidate, "generation_denied_missing_brief", { revision: candidate.data.desiredRevision });
          await save(ctx, candidate, "awaiting_operator");
          continue;
        }
        if (stage === "generate" && isPaid(candidate) && candidate.data.payment?.status !== "settled") {
          audit(candidate, "generation_denied_unpaid", { revision: candidate.data.desiredRevision });
          await save(ctx, candidate, "payment_pending");
          continue;
        }
        try { paidStageGate(candidate, stage); row = candidate; break; }
        catch { audit(candidate, "paid_work_denied", { stage }); await save(ctx, candidate, "paid_blocked"); }
      }
      if (!row) continue;
      if (row.data.usedLeaseTokens.includes(args.leaseToken)) throw new Error("reused_lease_token");
      if (stage === "generate") row.data.generationAttempts++;
      row.data.usedLeaseTokens.push(args.leaseToken);
      row.data.lease = { stage, workerId: args.workerId, leaseToken: args.leaseToken, claimedAtMs: Date.now(), leaseExpiresAtMs: Date.now() + LEASE_MS };
      audit(row, "work_claimed", { stage, revision: row.data.desiredRevision });
      await save(ctx, row, stageState(stage, "running"));
      return work(row);
    }
    return null;
  },
});
export const authorizeProvider = queryGeneric({
  args: { ...leaseArgs, revision: v.number(), stage: stageValue },
  handler: async (ctx, args) => { auth(args.workerToken); const row = await get(ctx, args.jobId); authorizeLease(row, args.leaseToken, args.revision, args.stage); return { ...work(row), ...full(row) }; },
});
export const uploadUrl = mutationGeneric({
  args: leaseArgs,
  handler: async (ctx, args) => { auth(args.workerToken); const row = await get(ctx, args.jobId); authorizeLease(row, args.leaseToken, undefined, "generate"); return ctx.storage.generateUploadUrl(); },
});
async function audioMetadata(ctx, storageId) {
  const meta = await ctx.db.system.get(storageId);
  if (!meta || !meta.size || meta.size > 18 * 1024 * 1024 || (meta.contentType !== undefined && !["audio/mpeg", "audio/mp3"].includes(meta.contentType))) throw new Error("invalid_audio_file");
}
export const recordNarration = mutationGeneric({
  args: { ...leaseArgs, revision: v.number(), language: v.string(), textDigest: v.string(), storageId: v.id("_storage"), provider: v.literal("voxcpm"), model: v.string(), voice: v.string(), phraseStarts: v.array(v.number()) },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); authorizeLease(row, args.leaseToken, args.revision, "generate");
    if (!row.data.intake.voicePreference.enabled || !row.data.intake.languages.includes(args.language) || !DIGEST.test(args.textDigest)) throw new Error("invalid_narration");
    if (!validPhraseStarts(args.phraseStarts)) throw new Error("narration_receipt_invalid");
    text(args.model, 100); text(args.voice, 100); await audioMetadata(ctx, args.storageId);
    const previous = row.data.narrationReceipts.find((r) => r.revision === args.revision && r.language === args.language && r.textDigest === args.textDigest);
    if (previous) {
      if (previous.storageId !== args.storageId || previous.model !== args.model || previous.voice !== args.voice || JSON.stringify(previous.phraseStarts) !== JSON.stringify(args.phraseStarts)) throw new Error("narration_receipt_conflict");
      return previous;
    }
    if (row.data.narrationReceipts.filter((r) => r.revision === args.revision).length >= 4) throw new Error("narration_limit");
    const receipt = { revision: args.revision, language: args.language, textDigest: args.textDigest, storageId: args.storageId, provider: args.provider, model: args.model, voice: args.voice, phraseStarts: args.phraseStarts, recordedAtMs: Date.now() };
    row.data.narrationReceipts.push(receipt);
    audit(row, "narration_recorded", { revision: args.revision, language: args.language, textDigest: args.textDigest });
    await save(ctx, row); return receipt;
  },
});
export const publish = mutationGeneric({
  args: { ...leaseArgs, revision: v.number(), contentHtml: v.string(), composition: v.any(), compositionReceipt: v.any(), compositionJson: v.optional(v.string()), contentDigest: v.string(), audioFiles: v.array(v.object({ language: v.string(), storageId: v.id("_storage"), textDigest: v.string(), phraseStarts: v.array(v.number()) })) },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); authorizeLease(row, args.leaseToken, args.revision, "generate");
    if (isPaid(row)) {
      // Convex normalizes object key order. Preserve the exact validated source
      // serialization so the composer's original output digest survives storage.
      if (typeof args.compositionJson !== "string" || args.compositionJson.length > 30000 || args.compositionReceipt?.provider !== "openai-codex-subscription" || await hash(args.compositionJson) !== args.compositionReceipt.outputDigest || JSON.stringify(sortedJson(JSON.parse(args.compositionJson))) !== JSON.stringify(sortedJson(args.composition))) throw new Error("composition_digest_mismatch");
    }
    text(args.contentHtml, 120000, "invalid_content");
    if (!DIGEST.test(args.contentDigest) || await hash(args.contentHtml) !== args.contentDigest) throw new Error("content_digest_mismatch");
    if (!args.composition || !args.compositionReceipt || JSON.stringify(args.composition).length > 30000 || JSON.stringify(args.compositionReceipt).length > 12000) throw new Error("invalid_composition");
    if (args.contentHtml.includes(row.data.reviewToken) || args.contentHtml.includes(row.data.intake.customer.email) || args.contentHtml.includes(args.workerToken)) throw new Error("private_content_leak");
    if (row.data.revisions.some((r) => r.revision === args.revision) || args.audioFiles.length > 2 || new Set(args.audioFiles.map((a) => a.language)).size !== args.audioFiles.length) throw new Error("invalid_publication");
    for (const file of args.audioFiles) {
      if (!row.data.intake.voicePreference.enabled || !row.data.intake.languages.includes(file.language) || !DIGEST.test(file.textDigest)) throw new Error("invalid_audio_file");
      await audioMetadata(ctx, file.storageId);
      if (!row.data.narrationReceipts.some((r) => r.revision === args.revision && r.language === file.language && r.textDigest === file.textDigest && r.storageId === file.storageId && JSON.stringify(r.phraseStarts) === JSON.stringify(file.phraseStarts))) throw new Error("narration_receipt_required");
    }
    // A voiced request cannot be silently delivered as text-only.
    if (row.data.intake.voicePreference.enabled && row.data.intake.languages.some((language) => !args.audioFiles.some((file) => file.language === language))) throw new Error("requested_audio_missing");
    const publication = { revision: args.revision, contentHtml: args.contentHtml, composition: args.composition, compositionReceipt: args.compositionReceipt, contentDigest: args.contentDigest, audioFiles: args.audioFiles, publishedAtMs: Date.now() };
    if (isPaid(row)) publication.compositionJson = args.compositionJson;
    row.data.revisions.push(publication);
    row.data.latestRevision = args.revision; row.data.lease = null;
    audit(row, "published", { revision: args.revision, contentDigest: args.contentDigest });
    await save(ctx, row, "draft_email_queued");
    return { ...safeStatus(row), ...links(row) };
  },
});
export const fence = mutationGeneric({
  args: { ...leaseArgs, revision: v.optional(v.number()), stage: stageValue },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); const lease = authorizeLease(row, args.leaseToken, args.revision, args.stage);
    if (args.stage === "generate") throw new Error("email_stage_required");
    if (lease.effectStartedAtMs === undefined) {
      const provider = process.env.BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER || "cloudflare";
      if (provider !== "cloudflare") throw new Error("email_provider_invalid");
      lease.effectStartedAtMs = Date.now();
      lease.emailProvider = provider;
      lease.emailIdempotencyKey = `bebe-loop:${row.jobId}:${row.data.desiredRevision}:${args.stage}`;
      audit(row, "email_effect_started", { stage: args.stage, revision: row.data.desiredRevision, idempotencyKey: lease.emailIdempotencyKey });
      await save(ctx, row);
    } else throw new Error("email_reconciliation_required");
    return work(row);
  },
});
export const completeEmail = mutationGeneric({
  args: { ...leaseArgs, revision: v.number(), stage: stageValue, providerMessageId: v.string(), provider: v.optional(v.literal("cloudflare")) },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId);
    if (!/^[\x21-\x7e]{1,998}$/.test(args.providerMessageId)) throw new Error("invalid_provider_message_id");
    if (args.stage === "generate") throw new Error("email_stage_required");
    const previous = row.data.emailReceipts.find((e) => e.revision === args.revision && e.stage === args.stage);
    if (previous) {
      if (previous.providerMessageId !== args.providerMessageId || previous.leaseToken !== args.leaseToken || previous.provider !== (args.provider || "cloudflare")) throw new Error("email_completion_conflict");
      return safeStatus(row);
    }
    const lease = authorizeLease(row, args.leaseToken, args.revision, args.stage);
    if (lease.effectStartedAtMs === undefined) throw new Error("email_not_fenced");
    if (lease.emailProvider !== (args.provider || "cloudflare")) throw new Error("provider_mismatch");
    row.data.emailReceipts.push({ revision: args.revision, stage: args.stage, provider: lease.emailProvider, providerMessageId: args.providerMessageId, idempotencyKey: lease.emailIdempotencyKey, leaseToken: args.leaseToken, sentAtMs: Date.now() });
    if (isPaid(row) && args.stage === "final_email") {
      const end = new Date(); const month = end.getUTCMonth(); end.setUTCFullYear(end.getUTCFullYear() + 1);
      if (end.getUTCMonth() !== month) end.setUTCDate(0);
      row.data.deliveredAtMs = Date.now(); row.data.hostingEndsAtMs = end.getTime();
    }
    audit(row, "email_sent", { revision: args.revision, stage: args.stage, providerMessageId: args.providerMessageId, idempotencyKey: lease.emailIdempotencyKey });
    row.data.lease = null;
    await save(ctx, row, args.stage === "draft_email" ? "awaiting_review" : "approved_sent");
    return safeStatus(row);
  },
});
export const fail = mutationGeneric({
  args: { ...leaseArgs, reason: v.string(), retryable: v.boolean(), providerDefinitiveFailure: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); const lease = authorizeLease(row, args.leaseToken);
    const reason = text(args.reason, 500);
    // Workers must use reason codes, never raw provider bodies or credentials.
    if (!/^[a-zA-Z0-9_: .-]+$/.test(reason) || reason.includes(args.workerToken)) throw new Error("invalid_failure_reason");
    row.data.lastError = { reason, stage: lease.stage, atMs: Date.now() };
    const uncertain = lease.effectStartedAtMs !== undefined && (isPaid(row) || args.providerDefinitiveFailure !== true);
    if (!uncertain && args.retryable && lease.stage === "generate" && reason === "voice_worker_unavailable") row.data.generationAttempts = Math.max(0, row.data.generationAttempts - 1);
    const retry = args.retryable && (lease.stage !== "generate" || row.data.generationAttempts < 3);
    const state = uncertain ? "reconciliation_required" : retry ? stageState(lease.stage, "queued") : "failed";
    audit(row, "work_failed", { reason, stage: lease.stage, revision: row.data.desiredRevision, outcome: state, definitiveProviderFailure: args.providerDefinitiveFailure === true });
    if (!uncertain) row.data.lease = null;
    await save(ctx, row, state); return safeStatus(row);
  },
});
// The private ops console holds the operations token, never the worker token.
function operatorAuth(token) {
  const configured = process.env.BEBEBONJOUR_OPERATIONS_TOKEN;
  if (!configured || configured.length < 32 || configured === process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN || !equal(token, configured)) throw new Error("forbidden");
}
export const operatorJobs = queryGeneric({
  args: { operatorToken: v.string() },
  handler: async (ctx, args) => {
    operatorAuth(args.operatorToken);
    const rows = await ctx.db.query("deliveryLoopJobs").order("desc").take(30);
    return rows.filter((row) => !row.data.deletedAtMs).map((row) => {
      const d = row.data, intake = d.intake || {}, revisions = d.revisions || [];
      return {
        jobId: row.jobId, status: row.status, orderMode: d.orderMode || "complimentary", paymentStatus: d.payment?.status || null,
        createdAtMs: d.createdAtMs ?? row._creationTime, fictional: intake.fictional === true,
        babyName: intake.baby?.firstName ?? null, customerEmail: intake.customer?.email ?? null, languages: intake.languages ?? [],
        desiredRevision: d.desiredRevision, latestRevision: d.latestRevision ?? 0,
        revisions: revisions.map((r) => ({ revision: r.revision, publishedAtMs: r.publishedAtMs })),
        publicUrl: revisions.length ? links(row).publicUrl : null,
        lastError: d.lastError ? { reason: d.lastError.reason, stage: d.lastError.stage, atMs: d.lastError.atMs } : null,
      };
    });
  },
});
function canLaunch(row) {
  const d = row.data, rev = d.desiredRevision;
  return row.status === "awaiting_operator" || (row.status === "failed" && d.lastError?.stage === "generate" && !d.lease && ![d.revisions || [], d.narrationReceipts || [], d.emailReceipts || []].some((receipts) => receipts.some((receipt) => receipt.revision === rev)));
}
function operatorDetail(row) {
  const d = row.data, intake = d.intake || {}, baby = intake.baby || {}, revisions = d.revisions || [];
  const current = (d.briefs || []).find((item) => item.revision === d.desiredRevision)?.brief || null;
  const previous = (d.briefs || []).find((item) => item.revision === d.desiredRevision - 1)?.brief;
  const suggested = previous ? Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "languages")) : suggestBrief(intake);
  return { jobId: row.jobId, status: row.status, orderMode: d.orderMode || "complimentary", paymentStatus: d.payment?.status || null, createdAtMs: d.createdAtMs ?? row._creationTime, fictional: intake.fictional === true, desiredRevision: d.desiredRevision, latestRevision: d.latestRevision ?? 0,
    intake: { email: intake.customer?.email ?? null, babyName: baby.firstName ?? null, nameArabic: baby.nameArabic ?? null, gender: baby.gender ?? null, languages: intake.languages ?? [], religion: intake.context?.religion ?? null, birthDate: intake.birthDate ?? null, request: intake.request ?? null, voiceEnabled: intake.voicePreference?.enabled ?? false, voice: intake.voicePreference?.voice ?? "pere" },
    feedback: d.feedback ?? null, correctionsUsed: d.correctionsUsed ?? 0, brief: current, suggestedBrief: suggested, catalogMeaning: catalogMeaningOf(current || suggested), publicUrl: d.latestRevision ? links(row).publicUrl : null, orderUrl: links(row).reviewUrl, notices: (d.notices || []).map(({kind, revision, status, atMs}) => ({kind, revision, status, atMs})), lastError: d.lastError ?? null, canLaunch: canLaunch(row), canRefuse: row.status === "awaiting_operator", revisions: revisions.map(({revision, publishedAtMs}) => ({revision, publishedAtMs})), options: { tones: TONES, genders: GENDERS, religions: RELIGIONS } };
}
function catalogMeaningOf(brief) { try { return brief?.firstName ? catalogMeaning(brief) : null; } catch { return null; } }
export const operatorJob = queryGeneric({ args: { operatorToken: v.string(), jobId: v.string() }, handler: async (ctx, args) => { operatorAuth(args.operatorToken); return operatorDetail(await get(ctx, args.jobId)); } });
export const operatorLaunch = mutationGeneric({
  args: { operatorToken: v.string(), jobId: v.string(), expectedRevision: v.number(), brief: v.any() },
  handler: async (ctx, args) => {
    operatorAuth(args.operatorToken); const row = await get(ctx, args.jobId), d = row.data;
    if (args.expectedRevision !== d.desiredRevision) throw new Error("stale_revision");
    if (!canLaunch(row)) throw new Error("launch_unavailable");
    if (isPaid(row)) paidEnabled();
    const brief = validateBrief(args.brief, { languages: d.intake?.languages, paid: isPaid(row) });
    d.briefs = (d.briefs || []).filter((entry) => entry.revision !== d.desiredRevision);
    d.briefs.push({ revision: d.desiredRevision, brief, briefDigest: await briefDigest(brief), launchedAtMs: Date.now() });
    d.generationAttempts = 0;
    const pending = isPaid(row) && d.desiredRevision === 1 && d.payment?.status !== "settled";
    audit(row, "operator_launched", { revision: d.desiredRevision });
    await save(ctx, row, pending ? "payment_pending" : "generation_queued");
    if (pending) { await queueNotice(ctx, row, "customer_payment", 1); await save(ctx, row); }
    return operatorDetail(row);
  },
});
export const operatorRefuse = mutationGeneric({
  args: { operatorToken: v.string(), jobId: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => { operatorAuth(args.operatorToken); const row = await get(ctx, args.jobId); if (args.expectedRevision !== row.data.desiredRevision) throw new Error("stale_revision"); if (row.status !== "awaiting_operator") throw new Error("refuse_unavailable"); audit(row, "operator_refused", { revision: args.expectedRevision }); await save(ctx, row, "refused"); return operatorDetail(row); },
});
export const requestReview = mutationGeneric({
  args: { jobId: v.string(), workerToken: v.optional(v.string()), reviewToken: v.optional(v.string()), expectedRevision: v.number(), action: v.union(v.literal("request_changes"), v.literal("approve")), feedback: v.optional(v.string()), idempotencyKey: v.string(), actor: v.optional(v.union(v.literal("customer"), v.literal("operator"), v.literal("simulated_human"))) },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId);
    const operator = args.workerToken !== undefined;
    if (operator) auth(args.workerToken); else if (!equal(row.data.reviewToken, args.reviewToken)) throw new Error("forbidden");
    if (!operator && args.actor && args.actor !== "customer") throw new Error("forbidden_actor");
    const actor = operator ? args.actor || "operator" : "customer";
    const idempotencyKey = text(args.idempotencyKey, 200);
    const feedback = args.action === "request_changes" ? text(args.feedback, 2000, "feedback_required") : "";
    if (args.feedback && args.feedback.length > 2000) throw new Error("invalid_feedback");
    const digest = await hash(JSON.stringify({ action: args.action, expectedRevision: args.expectedRevision, feedback, actor }));
    const previous = row.data.reviewOperations.find((r) => r.idempotencyKey === idempotencyKey);
    if (previous) { if (previous.digest !== digest) throw new Error("idempotency_conflict"); return previous.response; }
    if (args.expectedRevision !== row.data.latestRevision || args.expectedRevision !== row.data.desiredRevision) throw new Error("stale_revision");
    if (isPaid(row)) {
      activePaid(row);
      if (operator || actor !== "customer") throw new Error("customer_decision_required");
      if (args.action === "request_changes" && row.data.correctionsUsed >= 2) throw new Error("correction_limit");
    }
    if (!row.data.emailReceipts.some((e) => e.revision === args.expectedRevision && e.stage === "draft_email")) throw new Error("draft_not_delivered");
    if (row.status !== "awaiting_review") throw new Error("review_not_available");
    if (args.action === "request_changes") {
      if (row.data.desiredRevision >= 12) throw new Error("revision_limit");
      row.data.desiredRevision++; row.data.feedback = feedback; row.data.generationAttempts = 0;
      if (isPaid(row)) row.data.correctionsUsed++;
    } else row.data.approvedRevision = args.expectedRevision;
    audit(row, `review_${args.action}`, { revision: args.expectedRevision, actor, simulated: actor === "simulated_human", ...(feedback ? { feedback } : {}) });
    // A correction goes back to the operator, who rewrites the brief before any generation.
    row.status = args.action === "request_changes" ? "awaiting_operator" : "final_email_queued";
    const response = safeStatus(row);
    row.data.reviewOperations.push({ idempotencyKey, digest, response });
    await save(ctx, row);
    if (args.action === "request_changes") { await queueNotice(ctx, row, "operator_correction", row.data.desiredRevision); await save(ctx, row); }
    return response;
  },
});
function publiclyHidden(row) {
  return isPaid(row) && (row.data.cancelledAtMs || row.data.revokedAtMs || (row.data.hostingEndsAtMs && row.data.hostingEndsAtMs <= Date.now()));
}
export const publicPage = queryGeneric({
  args: { publicToken: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_public_token", (q) => q.eq("publicToken", args.publicToken)).unique();
    if (!row || !row.data.latestRevision || row.data.deletedAtMs || publiclyHidden(row)) return null;
    const revision = row.data.revisions.find((r) => r.revision === row.data.latestRevision);
    return { contentHtml: revision.contentHtml, revision: revision.revision, draft: row.data.approvedRevision !== revision.revision, audioLanguages: revision.audioFiles.map((f) => f.language) };
  },
});
export const publicAudio = queryGeneric({
  args: { publicToken: v.string(), revision: v.number(), language: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_public_token", (q) => q.eq("publicToken", args.publicToken)).unique();
    if (!row || row.data.deletedAtMs || publiclyHidden(row)) return null;
    const file = row.data.revisions?.find((r) => r.revision === args.revision)?.audioFiles.find((f) => f.language === args.language);
    return file ? { storageId: file.storageId } : null;
  },
});

export function editorialAuth(token) {
  const configured = process.env.BEBEBONJOUR_PAID_EDITORIAL_TOKEN;
  if (!configured || configured.length < 32 || configured === process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN || !equal(configured, token)) throw new Error("forbidden");
}
// The payment is bound to the brief the operator launched for revision 1.
function paidBrief(row) {
  activePaid(row);
  const entry = (row.data.briefs || []).find((b) => b.revision === 1);
  if (!entry) throw new Error("operator_launch_required");
  return entry;
}
// Only the node action may finalize a provider checkout; callers cannot forge a URL.
export const beginCheckout = internalMutationGeneric({
  args: { jobId: v.string(), reviewToken: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId);
    if (!equal(row.data.reviewToken, args.reviewToken)) throw new Error("forbidden");
    if (!isPaid(row)) throw new Error("paid_order_required");
    if (args.expectedRevision !== 1) throw new Error("stale_revision");
    const brief = paidBrief(row); paidEnabled();
    if (row.data.payment.status === "settled") throw new Error("payment_already_settled");
    if (row.status !== "payment_pending") throw new Error("checkout_unavailable");
    const now = Date.now(), checkout = row.data.payment.checkout;
    if (checkout?.url && checkout.expiresAtMs > now + 60000) return { url: checkout.url };
    // Do not create another payable session during the final minute.
    if (checkout?.url && checkout.expiresAtMs > now || checkout?.pendingSinceMs && checkout.pendingSinceMs > now - 60000) throw new Error("checkout_in_progress");
    // A timed-out create may already exist at Stripe. Retry the same request and
    // idempotency key until its original expiry, never create a second session.
    const uncertain = checkout && !checkout.url && checkout.expiresAtSec * 1000 > now;
    const expiresAtSec = uncertain ? checkout.expiresAtSec : Math.floor((now + 23 * 60 * 60 * 1000) / 1000);
    const attempt = uncertain ? checkout.attempt : (row.data.checkoutAttempts || 0) + 1; row.data.checkoutAttempts = attempt;
    row.data.payment.checkout = { revision: 1, attempt, pendingSinceMs: now, expiresAtSec };
    audit(row, "checkout_started", { revision: 1, attempt }); await save(ctx, row);
    return { create: { jobId: row.jobId, revision: 1, previewDigest: brief.briefDigest, email: row.data.intake.customer.email, attempt, expiresAtSec, reviewUrl: links(row).reviewUrl } };
  },
});
export const recordCheckout = internalMutationGeneric({
  args: { jobId: v.string(), revision: v.number(), attempt: v.number(), sessionId: v.string(), url: v.string(), expiresAtMs: v.number() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId), checkout = row.data.payment.checkout;
    if (!checkout || checkout.attempt !== args.attempt || checkout.revision !== args.revision || !checkout.pendingSinceMs || row.data.payment.status === "settled") throw new Error("checkout_stale");
    paidBrief(row);
    row.data.payment.checkout = { revision: args.revision, attempt: args.attempt, sessionId: args.sessionId, url: args.url, expiresAtMs: args.expiresAtMs };
    audit(row, "checkout_created", { sessionId: args.sessionId }); await save(ctx, row);
  },
});
export const clearCheckout = internalMutationGeneric({
  args: { jobId: v.string(), attempt: v.number() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId), checkout = row.data.payment.checkout;
    if (checkout?.attempt === args.attempt && !checkout.url) { delete checkout.pendingSinceMs; await save(ctx, row); }
  },
});
export const paidOperatorRead = queryGeneric({
  args: { editorialToken: v.string(), jobId: v.string() },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken); const row = await get(ctx, args.jobId);
    if (!isPaid(row)) throw new Error("paid_order_required");
    const brief = (row.data.briefs || []).find((b) => b.revision === 1);
    return { ...safeStatus(row), briefDigest: brief?.briefDigest || null, payment: row.data.payment };
  },
});
export const paidControl = mutationGeneric({
  args: { editorialToken: v.string(), jobId: v.string(), expectedRevision: v.number(), action: v.literal("cancel") },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken); const row = await get(ctx, args.jobId);
    if (!isPaid(row)) throw new Error("paid_order_required");
    if (args.expectedRevision !== row.data.desiredRevision) throw new Error("stale_revision");
    if (row.data.cancelledAtMs) return safeStatus(row);
    activePaid(row);
    // Cancellation is not a refund assertion. Keep effect fences for recovery.
    row.data.cancelledAtMs = Date.now();
    audit(row, "paid_cancelled", { revision: args.expectedRevision, paymentStatus: row.data.payment.status });
    await save(ctx, row, "cancelled");
    return safeStatus(row);
  },
});
export const paymentScope = queryGeneric({
  args: { editorialToken: v.string(), jobId: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken); const row = await get(ctx, args.jobId);
    if (args.expectedRevision !== 1) throw new Error("stale_revision");
    return { jobId: row.jobId, revision: 1, previewDigest: paidBrief(row).briefDigest };
  },
});
// `previewDigest` carries the revision-1 brief digest (stored field name kept).
export const paymentEvidenceFields = { jobId: v.string(), revision: v.number(), previewDigest: v.string(), providerPaymentId: v.string(), amountMinor: v.number(), currency: v.string(), livemode: v.boolean(), settled: v.boolean(), providerAccountId: v.string(), promotion: v.optional(promotionEvidence) };

// Validate before writing so the event adapter can durably reject business
// mismatches without catching a partially applied settlement. Writes below are
// deliberately outside that catch and roll back the whole Convex transaction.
export async function preparePaymentEvidence(ctx, args) {
  const row = await get(ctx, args.jobId);
  if (!isPaid(row)) throw new Error("paid_order_required");
  const prior = await ctx.db.query("deliveryLoopPaymentEvidence").withIndex("by_payment_id", (q) => q.eq("providerPaymentId", args.providerPaymentId)).unique();
  if (!prior) activePaid(row);
  const brief = (row.data.briefs || []).find((b) => b.revision === 1);
  const promotional = isTestPromotionReceipt(args);
  if (args.revision !== 1 || !brief || args.previewDigest !== brief.briefDigest || !(args.amountMinor === 3900 && !args.promotion || promotional) || args.currency !== "eur" || !args.settled || !/^pi_[A-Za-z0-9]+$/.test(args.providerPaymentId) || args.providerAccountId !== process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID) throw new Error("payment_evidence_mismatch");
  if (row.data.paidConsent?.termsVersion !== TERMS_VERSION || row.data.paidConsent.publication !== true) throw new Error("paid_permissions_required");
  if (promotional && !prior) {
    if (!samePromotion(args.promotion, testPromotionBinding(args, args.providerAccountId, args.livemode))) throw new Error('payment_evidence_mismatch');
    const uses = await ctx.db.query('deliveryLoopPaymentEvidence').withIndex('by_promotion_policy', q => q.eq('promotion.policyId', TEST_PROMOTION_POLICY)).take(6);
    if (uses.some(use => use.promotion.checkoutSessionId === args.promotion.checkoutSessionId)) throw new Error('payment_evidence_conflict');
    if (uses.length >= 5) throw new Error('payment_promotion_limit');
  }
  if (prior) {
    if (prior.jobId !== row.jobId || prior.revision !== args.revision || prior.previewDigest !== args.previewDigest || prior.livemode !== args.livemode || prior.providerAccountId !== args.providerAccountId || prior.amountMinor !== args.amountMinor || (prior.promotion || args.promotion) && !samePromotion(prior.promotion, args.promotion)) throw new Error("payment_evidence_conflict");
  } else if (row.data.payment.status === "settled") throw new Error("payment_already_settled");
  return { row, prior };
}
export async function commitPaymentEvidence(ctx, args, { row, prior }) {
  if (prior) return safeStatus(row);
  const receipt = { ...args, provider: "stripe", status: args.livemode === expectedLivemode() ? "settled" : "test_only", verifiedAtMs: Date.now() };
  await ctx.db.insert("deliveryLoopPaymentEvidence", receipt);
  row.data.payment = receipt.status === "test_only" && row.data.payment.checkout ? { ...receipt, checkout: row.data.payment.checkout } : receipt;
  audit(row, "stripe_payment_verified", { revision: args.revision, providerPaymentId: args.providerPaymentId, livemode: args.livemode });
  // Money taken for an order that is no longer waiting stays recorded for the operator.
  const start = receipt.status === "settled" && row.status === "payment_pending";
  if (start) { row.data.generationAttempts = 0; audit(row, "generation_unlocked_by_payment", { revision: row.data.desiredRevision }); }
  await save(ctx, row, start ? "generation_queued" : row.status);
  return safeStatus(row);
}
// Internal-only settlement: both adapters retrieve genuine Stripe evidence.
export const recordPaymentEvidence = internalMutationGeneric({
  args: paymentEvidenceFields,
  handler: async (ctx, args) => commitPaymentEvidence(ctx, args, await preparePaymentEvidence(ctx, args)),
});
// Narration happens inside the leased generate stage for both order modes.
export const beginNarration = mutationGeneric({
  args: { ...leaseArgs, revision: v.number(), language: v.string(), textDigest: v.string() },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId);
    authorizeLease(row, args.leaseToken, args.revision, "generate");
    if (!row.data.intake.languages.includes(args.language) || !DIGEST.test(args.textDigest)) throw new Error("invalid_narration");
    return { allowed: true };
  },
});
