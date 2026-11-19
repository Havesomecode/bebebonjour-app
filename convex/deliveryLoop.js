import { mutationGeneric, queryGeneric, internalMutationGeneric } from "convex/server";
import { v } from "convex/values";
import { promotionEvidence } from './deliveryLoopPromotion.js';
import { TEST_PROMOTION_POLICY, testPromotionBinding, isTestPromotionReceipt, samePromotion } from '../src/delivery-loop/test-promotion.mjs';
import { reviewedNarrationText } from "../src/delivery-loop/reviewed-narration.mjs";
import { validateBrief, briefDigest, suggestBrief, TONES, GENDERS, RELIGIONS } from "../src/delivery-loop/brief.mjs";
import { PAID_MODE, TERMS_VERSION, PREVIEW_MS, isPaid, currentPreview, paidEnabled, activePaid, activePreview, paidEligible, stageState, paidStageGate, paidSafeStatus, expectedLivemode } from "./deliveryLoopPaidPolicy.js";

const LEASE_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const DIGEST = /^[a-f0-9]{64}$/;
const workerArgs = { workerToken: v.string(), jobId: v.string() };
const leaseArgs = { ...workerArgs, leaseToken: v.string() };
const stageValue = v.union(v.literal("generate"), v.literal("finalize"), v.literal("draft_email"), v.literal("final_email"));
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
  const voiceGender = nested ? input.voicePreference?.gender || "neutral" : "neutral";
  if (!Array.isArray(languages) || languages.length < 1 || languages.length > 2 || new Set(languages).size !== languages.length || languages.some((language) => !["fr", "ar"].includes(language)) || !["girl", "boy", "neutral"].includes(gender) || !["general", "islam"].includes(religion) || typeof enabled !== "boolean" || !["male", "female", "neutral"].includes(voiceGender)) throw new Error("invalid_intake");
  if (input.fictional !== undefined && typeof input.fictional !== "boolean") throw new Error("invalid_intake");
  const baby = { firstName: text(nested ? input.baby?.firstName : input.babyName, 100, "invalid_baby_name"), gender };
  if (input.baby?.nameArabic !== undefined) baby.nameArabic = text(input.baby.nameArabic, 100);
  const intake = { schemaVersion: "1.0", requestId: input.requestId ? text(input.requestId, 200) : idempotencyKey, customer: { email, consent: true }, baby, languages: [...languages], context: { religion }, voicePreference: { enabled, gender: voiceGender }, fictional: input.fictional === true, source: "first_party_delivery" };
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
function queueNotice(row, kind, revision) {
  row.data.notices ||= [];
  if (!row.data.notices.some((notice) => notice.kind === kind && notice.revision === revision)) {
    row.data.notices.push({ kind, revision, status: "pending", atMs: Date.now() });
    // chunk 2: schedule sendNotice
  }
}
function authorizeLease(row, token, revision, stage) {
  const lease = row.data.lease;
  if (!lease || !equal(lease.leaseToken, token) || lease.leaseExpiresAtMs <= Date.now() || (revision !== undefined && revision !== row.data.desiredRevision) || (stage !== undefined && stage !== lease.stage) || row.status !== stageState(lease.stage, "running")) throw new Error("stale_lease");
  paidStageGate(row, lease.stage);
  return lease;
}
function safeStatus(row) {
  const paid = isPaid(row);
  const blocked = paid && (row.data.cancelledAtMs || row.data.revokedAtMs || row.data.previewExpiresAtMs <= Date.now());
  let visible = !paid;
  if (paid) {
    try { paidEligible(row); visible = !!row.data.finalPublication && (!row.data.hostingEndsAtMs || row.data.hostingEndsAtMs > Date.now()); } catch { /* fail closed */ }
  }
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
  args: { intake: v.any(), idempotencyKey: v.string(), magicPassword: v.optional(v.string()), orderMode: v.optional(v.union(v.literal("complimentary"), v.literal(PAID_MODE))), previewConsent: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const idempotencyKey = text(args.idempotencyKey, 200);
    const intake = canonicalIntake(args.intake, idempotencyKey);
    const paid = args.orderMode === PAID_MODE;
    if (paid) {
      paidEnabled();
      if (args.previewConsent !== true) throw new Error("preview_consent_required");
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
    if (paid) Object.assign(row.data, { orderMode: PAID_MODE, previewConsent: { acceptedAtMs: Date.now() }, customerDeclaration: { mainlandFranceAdultWithParentalPermissions: true, acceptedAtMs: Date.now() }, payment: { status: "pending" }, correctionsUsed: 0, previewRenewals: 0, previewExpiresAtMs: null, paidApproval: null, paidPermissions: null, editorialApproval: null, finalPublication: null });
    queueNotice(row, "operator_new", 1);
    audit(row, "intake_accepted", { paymentStatus: row.data.payment.status, ...(paid ? { orderMode: PAID_MODE } : {}) });
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
    for (const state of ["generation_running", "finalize_running", "draft_email_running", "final_email_running"]) {
      const running = await ctx.db.query("deliveryLoopJobs").withIndex("by_status", (q) => q.eq("status", state)).take(100);
      for (const row of running) {
        const lease = row.data.lease;
        if (lease.leaseToken === args.leaseToken && lease.workerId === args.workerId && lease.leaseExpiresAtMs > Date.now()) return work(row);
        if (lease.leaseExpiresAtMs > Date.now()) continue;
        const status = lease.effectStartedAtMs !== undefined ? "reconciliation_required" : ["generate", "finalize"].includes(lease.stage) && row.data.generationAttempts >= 3 ? "failed" : stageState(lease.stage, "queued");
        audit(row, "lease_expired", { stage: lease.stage, revision: row.data.desiredRevision, outcome: status });
        // Keep uncertain email lease/journal for manual durable reconciliation.
        if (status !== "reconciliation_required") row.data.lease = null;
        await save(ctx, row, status);
      }
    }
    for (const stage of ["generate", "draft_email", "finalize", "final_email"]) {
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
      if (["generate", "finalize"].includes(stage)) row.data.generationAttempts++;
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
  args: { ...leaseArgs, revision: v.number(), language: v.string(), textDigest: v.string(), storageId: v.id("_storage"), provider: v.literal("openai"), model: v.string(), voice: v.string() },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); authorizeLease(row, args.leaseToken, args.revision, isPaid(row) ? "finalize" : "generate");
    if (!row.data.intake.voicePreference.enabled || !row.data.intake.languages.includes(args.language) || !DIGEST.test(args.textDigest)) throw new Error("invalid_narration");
    text(args.model, 100); text(args.voice, 100); await audioMetadata(ctx, args.storageId);
    const previous = row.data.narrationReceipts.find((r) => r.revision === args.revision && r.language === args.language && r.textDigest === args.textDigest);
    if (previous) {
      if (previous.storageId !== args.storageId || previous.model !== args.model || previous.voice !== args.voice) throw new Error("narration_receipt_conflict");
      return previous;
    }
    if (row.data.narrationReceipts.filter((r) => r.revision === args.revision).length >= 4) throw new Error("narration_limit");
    const receipt = { revision: args.revision, language: args.language, textDigest: args.textDigest, storageId: args.storageId, provider: args.provider, model: args.model, voice: args.voice, recordedAtMs: Date.now() };
    row.data.narrationReceipts.push(receipt);
    if (isPaid(row)) {
      const effect = row.data.narrationEffects?.find((e) => e.revision === args.revision && e.language === args.language && e.textDigest === args.textDigest);
      if (!effect || effect.status !== "inflight") throw new Error("narration_not_fenced");
      effect.status = "complete";
      delete row.data.lease.effectStartedAtMs;
    }
    audit(row, "narration_recorded", { revision: args.revision, language: args.language, textDigest: args.textDigest });
    await save(ctx, row); return receipt;
  },
});
export const publish = mutationGeneric({
  args: { ...leaseArgs, revision: v.number(), contentHtml: v.string(), composition: v.any(), compositionReceipt: v.any(), compositionJson: v.optional(v.string()), contentDigest: v.string(), audioFiles: v.array(v.object({ language: v.string(), storageId: v.id("_storage"), textDigest: v.string() })) },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); const lease = authorizeLease(row, args.leaseToken, args.revision);
    if (!["generate", "finalize"].includes(lease.stage)) throw new Error("stale_lease");
    const paidPreview = isPaid(row) && lease.stage === "generate";
    if (paidPreview && args.audioFiles.length) throw new Error("paid_preview_audio_forbidden");
    if (paidPreview) {
      // Convex normalizes object key order. Preserve the exact validated source
      // serialization so the composer's original output digest survives storage.
      if (typeof args.compositionJson !== "string" || args.compositionJson.length > 30000 || args.compositionReceipt?.provider !== "openai-codex-subscription" || await hash(args.compositionJson) !== args.compositionReceipt.outputDigest || JSON.stringify(sortedJson(JSON.parse(args.compositionJson))) !== JSON.stringify(sortedJson(args.composition))) throw new Error("composition_digest_mismatch");
    }
    if (isPaid(row) && !paidPreview) {
      const preview = paidEligible(row);
      if (args.contentHtml !== preview.contentHtml || args.compositionJson !== preview.compositionJson || JSON.stringify(args.composition) !== JSON.stringify(preview.composition) || JSON.stringify(args.compositionReceipt) !== JSON.stringify(preview.compositionReceipt) || row.data.finalPublication) throw new Error("approved_content_mismatch");
    }
    text(args.contentHtml, 120000, "invalid_content");
    if (!DIGEST.test(args.contentDigest) || await hash(args.contentHtml) !== args.contentDigest) throw new Error("content_digest_mismatch");
    if (!args.composition || !args.compositionReceipt || JSON.stringify(args.composition).length > 30000 || JSON.stringify(args.compositionReceipt).length > 12000) throw new Error("invalid_composition");
    if (args.contentHtml.includes(row.data.reviewToken) || args.contentHtml.includes(row.data.intake.customer.email) || args.contentHtml.includes(args.workerToken)) throw new Error("private_content_leak");
    if (((!isPaid(row) || paidPreview) && row.data.revisions.some((r) => r.revision === args.revision)) || args.audioFiles.length > 2 || new Set(args.audioFiles.map((a) => a.language)).size !== args.audioFiles.length) throw new Error("invalid_publication");
    for (const file of args.audioFiles) {
      if (!row.data.intake.voicePreference.enabled || !row.data.intake.languages.includes(file.language) || !DIGEST.test(file.textDigest)) throw new Error("invalid_audio_file");
      await audioMetadata(ctx, file.storageId);
      if (!row.data.narrationReceipts.some((r) => r.revision === args.revision && r.language === file.language && r.textDigest === file.textDigest && r.storageId === file.storageId)) throw new Error("narration_receipt_required");
    }
    // A voiced request cannot be silently delivered as text-only.
    if (!paidPreview && row.data.intake.voicePreference.enabled && row.data.intake.languages.some((language) => !args.audioFiles.some((file) => file.language === language))) throw new Error("requested_audio_missing");
    const publication = { revision: args.revision, contentHtml: args.contentHtml, composition: args.composition, compositionReceipt: args.compositionReceipt, contentDigest: args.contentDigest, audioFiles: args.audioFiles, publishedAtMs: Date.now() };
    if (isPaid(row)) publication.compositionJson = args.compositionJson;
    if (isPaid(row) && !paidPreview) {
      row.data.finalPublication = publication;
      row.data.hostingEndsAtMs = null;
    } else row.data.revisions.push(publication);
    if (paidPreview) row.data.previewExpiresAtMs = null;
    row.data.latestRevision = args.revision; row.data.lease = null;
    audit(row, "published", { revision: args.revision, contentDigest: args.contentDigest });
    await save(ctx, row, isPaid(row) && !paidPreview ? "final_email_queued" : "draft_email_queued");
    return isPaid(row) ? safeStatus(row) : { ...safeStatus(row), ...links(row) };
  },
});
export const fence = mutationGeneric({
  args: { ...leaseArgs, revision: v.optional(v.number()), stage: stageValue },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); const lease = authorizeLease(row, args.leaseToken, args.revision, args.stage);
    if (["generate", "finalize"].includes(args.stage)) throw new Error("email_stage_required");
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
    if (["generate", "finalize"].includes(args.stage)) throw new Error("email_stage_required");
    const previous = row.data.emailReceipts.find((e) => e.revision === args.revision && e.stage === args.stage);
    if (previous) {
      if (previous.providerMessageId !== args.providerMessageId || previous.leaseToken !== args.leaseToken || previous.provider !== (args.provider || "cloudflare")) throw new Error("email_completion_conflict");
      return safeStatus(row);
    }
    const lease = authorizeLease(row, args.leaseToken, args.revision, args.stage);
    if (lease.effectStartedAtMs === undefined) throw new Error("email_not_fenced");
    if (lease.emailProvider !== (args.provider || "cloudflare")) throw new Error("provider_mismatch");
    row.data.emailReceipts.push({ revision: args.revision, stage: args.stage, provider: lease.emailProvider, providerMessageId: args.providerMessageId, idempotencyKey: lease.emailIdempotencyKey, leaseToken: args.leaseToken, sentAtMs: Date.now() });
    if (isPaid(row)) {
      if (args.stage === "draft_email") row.data.previewExpiresAtMs = Date.now() + PREVIEW_MS;
      else {
        const end = new Date(); const month = end.getUTCMonth(); end.setUTCFullYear(end.getUTCFullYear() + 1);
        if (end.getUTCMonth() !== month) end.setUTCDate(0);
        row.data.deliveredAtMs = Date.now(); row.data.hostingEndsAtMs = end.getTime();
      }
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
    const retry = args.retryable && (!["generate", "finalize"].includes(lease.stage) || row.data.generationAttempts < 3);
    const state = uncertain ? "reconciliation_required" : retry ? stageState(lease.stage, "queued") : "failed";
    audit(row, "work_failed", { reason, stage: lease.stage, revision: row.data.desiredRevision, outcome: state, definitiveProviderFailure: args.providerDefinitiveFailure === true });
    if (!uncertain) row.data.lease = null;
    await save(ctx, row, state); return safeStatus(row);
  },
});
// Technical recovery is not another customer review or a reset of history.
// Only the semantic rejection before narration may resume within the original
// finite generation budget; any downstream/uncertain effect remains fenced.
function correctionRetryAvailable(row) {
  const revision = row.data.desiredRevision;
  return row.status === "failed" && revision >= 2 && !!row.data.feedback && !row.data.lease && row.data.generationAttempts < 3 && row.data.lastError?.stage === "generate" && row.data.lastError?.reason === "correction_not_applied" && row.data.latestRevision < revision && ![row.data.revisions, row.data.narrationReceipts, row.data.emailReceipts].some((receipts) => receipts.some((receipt) => receipt.revision === revision));
}
async function queueCorrectionRetry(ctx, jobId, expectedRevision) {
  const row = await get(ctx, jobId);
  const revision = row.data.desiredRevision;
  if (expectedRevision !== revision) throw new Error("stale_revision");
  if (!correctionRetryAvailable(row)) throw new Error("correction_retry_unavailable");
  audit(row, "correction_retry_authorized", { revision, priorAttempts: row.data.generationAttempts, actor: "operator" });
  await save(ctx, row, "generation_queued");
  return safeStatus(row);
}
export const retryCorrection = mutationGeneric({
  args: { ...workerArgs, expectedRevision: v.number() },
  handler: async (ctx, args) => { auth(args.workerToken); return queueCorrectionRetry(ctx, args.jobId, args.expectedRevision); },
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
      const paid = isPaid(row);
      const published = paid ? row.data.finalPublication : row.data.revisions.length;
      return {
        jobId: row.jobId, status: row.status, createdAtMs: row.data.createdAtMs ?? row._creationTime, fictional: row.data.intake.fictional === true,
        babyName: row.data.intake.baby.firstName, customerEmail: row.data.intake.customer.email, languages: row.data.intake.languages,
        paid, desiredRevision: row.data.desiredRevision, latestRevision: row.data.latestRevision,
        revisions: (paid ? [row.data.finalPublication].filter(Boolean) : row.data.revisions).map((r) => ({ revision: r.revision, publishedAtMs: r.publishedAtMs })),
        publicUrl: published ? links(row).publicUrl : null,
        lastError: row.data.lastError ? { reason: row.data.lastError.reason, stage: row.data.lastError.stage, atMs: row.data.lastError.atMs } : null,
        canRetryCorrection: correctionRetryAvailable(row),
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
    intake: { email: intake.customer?.email ?? null, babyName: baby.firstName ?? null, nameArabic: baby.nameArabic ?? null, gender: baby.gender ?? null, languages: intake.languages ?? [], religion: intake.context?.religion ?? null, birthDate: intake.birthDate ?? null, request: intake.request ?? null, voiceEnabled: intake.voicePreference?.enabled ?? false },
    feedback: d.feedback ?? null, correctionsUsed: d.correctionsUsed ?? 0, brief: current, suggestedBrief: suggested, publicUrl: d.latestRevision ? links(row).publicUrl : null, orderUrl: links(row).reviewUrl, notices: (d.notices || []).map(({kind, revision, status, atMs}) => ({kind, revision, status, atMs})), lastError: d.lastError ?? null, canLaunch: canLaunch(row), canRefuse: row.status === "awaiting_operator", revisions: revisions.map(({revision, publishedAtMs}) => ({revision, publishedAtMs})), options: { tones: TONES, genders: GENDERS, religions: RELIGIONS } };
}
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
    if (pending) queueNotice(row, "customer_payment", 1);
    audit(row, "operator_launched", { revision: d.desiredRevision });
    await save(ctx, row, pending ? "payment_pending" : "generation_queued");
    return operatorDetail(row);
  },
});
export const operatorRefuse = mutationGeneric({
  args: { operatorToken: v.string(), jobId: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => { operatorAuth(args.operatorToken); const row = await get(ctx, args.jobId); if (args.expectedRevision !== row.data.desiredRevision) throw new Error("stale_revision"); if (row.status !== "awaiting_operator") throw new Error("refuse_unavailable"); audit(row, "operator_refused", { revision: args.expectedRevision }); await save(ctx, row, "refused"); return operatorDetail(row); },
});
export const operatorRetryCorrection = mutationGeneric({
  args: { operatorToken: v.string(), jobId: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => { operatorAuth(args.operatorToken); return queueCorrectionRetry(ctx, args.jobId, args.expectedRevision); },
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
      activePreview(row);
      if (operator || actor !== "customer") throw new Error("customer_decision_required");
      if (row.data.paidApproval || row.data.payment.status === "settled") throw new Error("paid_preview_locked");
      if (args.action === "request_changes" && row.data.correctionsUsed >= 2) throw new Error("correction_limit");
    }
    if (!row.data.emailReceipts.some((e) => e.revision === args.expectedRevision && e.stage === "draft_email")) throw new Error("draft_not_delivered");
    if (row.status !== "awaiting_review") throw new Error("review_not_available");
    if (args.action === "request_changes") {
      if (row.data.desiredRevision >= 12) throw new Error("revision_limit");
      row.data.desiredRevision++; row.data.feedback = feedback; row.data.generationAttempts = 0;
      if (isPaid(row)) {
        row.data.correctionsUsed++;
        row.data.paidApproval = null; row.data.paidPermissions = null; row.data.editorialApproval = null;
      }
    } else if (isPaid(row)) row.data.paidApproval = { revision: args.expectedRevision, previewDigest: currentPreview(row).contentDigest, approvedAtMs: Date.now() };
    else row.data.approvedRevision = args.expectedRevision;
    audit(row, `review_${args.action}`, { revision: args.expectedRevision, actor, simulated: actor === "simulated_human", ...(feedback ? { feedback } : {}) });
    row.status = args.action === "request_changes" ? "generation_queued" : isPaid(row) ? "payment_pending" : "final_email_queued";
    const response = safeStatus(row);
    row.data.reviewOperations.push({ idempotencyKey, digest, response });
    await save(ctx, row); return response;
  },
});
export const publicPage = queryGeneric({
  args: { publicToken: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_public_token", (q) => q.eq("publicToken", args.publicToken)).unique();
    if (!row || !row.data.latestRevision) return null;
    if (isPaid(row)) { try { paidEligible(row); } catch { return null; } }
    if (isPaid(row) && (!row.data.finalPublication || row.data.cancelledAtMs || row.data.revokedAtMs || (row.data.hostingEndsAtMs && row.data.hostingEndsAtMs <= Date.now()))) return null;
    const revision = isPaid(row) ? row.data.finalPublication : row.data.revisions.find((r) => r.revision === row.data.latestRevision);
    return { contentHtml: revision.contentHtml, revision: revision.revision, draft: !isPaid(row) && row.data.approvedRevision !== revision.revision, audioLanguages: revision.audioFiles.map((f) => f.language) };
  },
});
export const publicAudio = queryGeneric({
  args: { publicToken: v.string(), revision: v.number(), language: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_public_token", (q) => q.eq("publicToken", args.publicToken)).unique();
    if (row && isPaid(row)) { try { paidEligible(row); } catch { return null; } }
    if (row && isPaid(row) && (!row.data.finalPublication || row.data.cancelledAtMs || row.data.revokedAtMs || (row.data.hostingEndsAtMs && row.data.hostingEndsAtMs <= Date.now()))) return null;
    const file = (row && isPaid(row) ? [row.data.finalPublication] : row?.data.revisions)?.find((r) => r.revision === args.revision)?.audioFiles.find((f) => f.language === args.language);
    return file ? { storageId: file.storageId } : null;
  },
});

export function editorialAuth(token) {
  const configured = process.env.BEBEBONJOUR_PAID_EDITORIAL_TOKEN;
  if (!configured || configured.length < 32 || configured === process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN || !equal(configured, token)) throw new Error("forbidden");
}
function exactPaidRevision(row, revision) {
  activePaid(row);
  if (revision !== row.data.latestRevision || revision !== row.data.desiredRevision || !currentPreview(row)) throw new Error("stale_revision");
  return currentPreview(row);
}
async function queuePaidIfEligible(ctx, row) {
  try { paidEligible(row); } catch { await save(ctx, row); return; }
  if (["payment_pending", "editorial_pending", "paid_blocked"].includes(row.status) && !row.data.lease && !row.data.finalPublication) {
    row.data.generationAttempts = 0;
    audit(row, "paid_delivery_eligible", { revision: row.data.desiredRevision });
    await save(ctx, row, "finalize_queued");
  } else await save(ctx, row);
}
export const preview = queryGeneric({
  args: { jobId: v.string(), reviewToken: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId);
    if (!equal(row.data.reviewToken, args.reviewToken)) throw new Error("forbidden");
    activePreview(row);
    const revision = exactPaidRevision(row, args.expectedRevision);
    return { contentHtml: revision.contentHtml, contentDigest: revision.contentDigest, revision: revision.revision };
  },
});
// Only the node action may finalize a provider checkout; callers cannot forge a URL.
export const beginCheckout = internalMutationGeneric({
  args: { jobId: v.string(), reviewToken: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId);
    if (!equal(row.data.reviewToken, args.reviewToken)) throw new Error("forbidden");
    if (!isPaid(row)) throw new Error("paid_order_required");
    const preview = exactPaidRevision(row, args.expectedRevision);
    activePreview(row); paidEnabled();
    const approval = row.data.paidApproval, permissions = row.data.paidPermissions;
    if (approval?.revision !== args.expectedRevision || approval.previewDigest !== preview.contentDigest) throw new Error("content_approval_required");
    if (permissions?.revision !== args.expectedRevision || permissions.previewDigest !== preview.contentDigest || permissions.termsVersion !== TERMS_VERSION || permissions.publication !== true) throw new Error("paid_permissions_required");
    if (row.data.payment.status === "settled") throw new Error("paid_preview_locked");
    const now = Date.now(), checkout = row.data.payment.checkout;
    if (checkout?.revision === args.expectedRevision && checkout.url && checkout.expiresAtMs > now + 60000) return { url: checkout.url };
    // Do not create another payable session during the final minute.
    if (checkout?.url && checkout.expiresAtMs > now || checkout?.pendingSinceMs && checkout.pendingSinceMs > now - 60000) throw new Error("checkout_in_progress");
    // A timed-out create may already exist at Stripe. Retry the same request and
    // idempotency key until its original expiry, never create a second session.
    const uncertain = checkout && !checkout.url && checkout.expiresAtSec * 1000 > now;
    if (uncertain && checkout.revision !== args.expectedRevision) throw new Error("checkout_in_progress");
    const expiresAtSec = uncertain ? checkout.expiresAtSec : Math.floor(Math.min(now + 24 * 60 * 60 * 1000, row.data.previewExpiresAtMs - 60000) / 1000);
    if (expiresAtSec * 1000 < now + 31 * 60 * 1000) throw new Error("preview_expiring");
    const attempt = uncertain ? checkout.attempt : (row.data.checkoutAttempts || 0) + 1; row.data.checkoutAttempts = attempt;
    row.data.payment.checkout = { revision: args.expectedRevision, attempt, pendingSinceMs: now, expiresAtSec };
    audit(row, "checkout_started", { revision: args.expectedRevision, attempt }); await save(ctx, row);
    return { create: { jobId: row.jobId, revision: args.expectedRevision, previewDigest: preview.contentDigest, email: row.data.intake.customer.email, attempt, expiresAtSec, reviewUrl: links(row).reviewUrl } };
  },
});
export const recordCheckout = internalMutationGeneric({
  args: { jobId: v.string(), revision: v.number(), attempt: v.number(), sessionId: v.string(), url: v.string(), expiresAtMs: v.number() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId), checkout = row.data.payment.checkout;
    if (!checkout || checkout.attempt !== args.attempt || checkout.revision !== args.revision || !checkout.pendingSinceMs || row.data.payment.status === "settled") throw new Error("checkout_stale");
    activePreview(row); exactPaidRevision(row, args.revision);
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
export const paidPermissions = mutationGeneric({
  args: { jobId: v.string(), reviewToken: v.string(), expectedRevision: v.number(), termsVersion: v.string(), termsAccepted: v.boolean(), publication: v.boolean() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId);
    if (!equal(row.data.reviewToken, args.reviewToken)) throw new Error("forbidden");
    const preview = exactPaidRevision(row, args.expectedRevision);
    if (row.data.paidApproval?.revision !== args.expectedRevision) throw new Error("content_approval_required");
    const termsUrl = paidEnabled();
    if (args.termsVersion !== TERMS_VERSION || !args.termsAccepted || !args.publication) throw new Error("paid_permissions_required");
    if (row.data.paidPermissions) return safeStatus(row);
    row.data.paidPermissions = { revision: args.expectedRevision, previewDigest: preview.contentDigest, termsVersion: TERMS_VERSION, termsUrl, publication: true, acceptedAtMs: Date.now() };
    audit(row, "paid_permissions_accepted", { revision: args.expectedRevision, termsVersion: TERMS_VERSION });
    await queuePaidIfEligible(ctx, row); return safeStatus(row);
  },
});
// Human-only credential, not the generation worker credential. The operator
// attests to personally reviewing this exact private text; simulation is absent.
export const paidEditorial = mutationGeneric({
  args: { editorialToken: v.string(), jobId: v.string(), expectedRevision: v.number(), previewDigest: v.string(), reviewerId: v.string(), humanReviewed: v.boolean() },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken); const row = await get(ctx, args.jobId);
    const preview = exactPaidRevision(row, args.expectedRevision);
    if (!args.humanReviewed || args.previewDigest !== preview.contentDigest) throw new Error("editorial_approval_required");
    const reviewerId = text(args.reviewerId, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(reviewerId)) throw new Error("invalid_input");
    if (!row.data.editorialApproval) {
      row.data.editorialApproval = { revision: args.expectedRevision, previewDigest: preview.contentDigest, reviewerId, human: true, approvedAtMs: Date.now() };
      audit(row, "human_editorial_approved", { revision: args.expectedRevision, previewDigest: preview.contentDigest, reviewerId });
    }
    await queuePaidIfEligible(ctx, row); return safeStatus(row);
  },
});
export const paidOperatorRead = queryGeneric({
  args: { editorialToken: v.string(), jobId: v.string() },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken); const row = await get(ctx, args.jobId);
    if (!isPaid(row)) throw new Error("paid_order_required");
    const preview = currentPreview(row);
    return { ...safeStatus(row), preview: preview ? { contentHtml: preview.contentHtml, contentDigest: preview.contentDigest, revision: preview.revision } : null, payment: row.data.payment };
  },
});
export const paidControl = mutationGeneric({
  args: { editorialToken: v.string(), jobId: v.string(), expectedRevision: v.number(), action: v.union(v.literal("renew_preview"), v.literal("cancel")) },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken); const row = await get(ctx, args.jobId);
    if (isPaid(row) && args.action === "cancel" && row.data.cancelledAtMs && args.expectedRevision === row.data.latestRevision && args.expectedRevision === row.data.desiredRevision) return safeStatus(row);
    exactPaidRevision(row, args.expectedRevision);
    if (args.action === "renew_preview") {
      if (row.data.previewRenewals >= 1 || row.data.paidApproval || !["awaiting_review", "paid_blocked"].includes(row.status)) throw new Error("preview_renewal_unavailable");
      row.data.previewRenewals++;
      row.data.previewExpiresAtMs = Date.now() + PREVIEW_MS;
      audit(row, "preview_renewed", { revision: args.expectedRevision });
      await save(ctx, row, row.data.emailReceipts.some((e) => e.stage === "draft_email" && e.revision === args.expectedRevision) ? "awaiting_review" : "draft_email_queued");
    } else {
      // Cancellation is not a refund assertion. Keep effect fences for recovery.
      row.data.cancelledAtMs = Date.now();
      audit(row, "paid_cancelled", { revision: args.expectedRevision, paymentStatus: row.data.payment.status });
      await save(ctx, row, "cancelled");
    }
    return safeStatus(row);
  },
});
export const paymentScope = queryGeneric({
  args: { editorialToken: v.string(), jobId: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken); const row = await get(ctx, args.jobId);
    const preview = exactPaidRevision(row, args.expectedRevision);
    if (row.data.paidApproval?.revision !== args.expectedRevision || row.data.paidPermissions?.revision !== args.expectedRevision) throw new Error("paid_permissions_required");
    return { jobId: row.jobId, revision: args.expectedRevision, previewDigest: preview.contentDigest };
  },
});
export const paymentEvidenceFields = { jobId: v.string(), revision: v.number(), previewDigest: v.string(), providerPaymentId: v.string(), amountMinor: v.number(), currency: v.string(), livemode: v.boolean(), settled: v.boolean(), providerAccountId: v.string(), promotion: v.optional(promotionEvidence) };

// Validate before writing so the event adapter can durably reject business
// mismatches without catching a partially applied settlement. Writes below are
// deliberately outside that catch and roll back the whole Convex transaction.
export async function preparePaymentEvidence(ctx, args) {
  const row = await get(ctx, args.jobId); const preview = exactPaidRevision(row, args.revision);
  const promotional = isTestPromotionReceipt(args);
  if (args.previewDigest !== preview.contentDigest || !(args.amountMinor === 3900 && !args.promotion || promotional) || args.currency !== "eur" || !args.settled || !/^pi_[A-Za-z0-9]+$/.test(args.providerPaymentId) || args.providerAccountId !== process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID) throw new Error("payment_evidence_mismatch");
  if (row.data.paidApproval?.revision !== args.revision || row.data.paidPermissions?.revision !== args.revision) throw new Error("paid_permissions_required");
  const prior = await ctx.db.query("deliveryLoopPaymentEvidence").withIndex("by_payment_id", (q) => q.eq("providerPaymentId", args.providerPaymentId)).unique();
  if (promotional && !prior) {
    activePreview(row);
    if (row.data.paidApproval.previewDigest !== args.previewDigest || row.data.paidPermissions.previewDigest !== args.previewDigest
        || row.data.paidPermissions.termsVersion !== TERMS_VERSION || row.data.paidPermissions.publication !== true) throw new Error('paid_permissions_required');
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
  await queuePaidIfEligible(ctx, row); return safeStatus(row);
}
// Internal-only settlement: both adapters retrieve genuine Stripe evidence.
export const recordPaymentEvidence = internalMutationGeneric({
  args: paymentEvidenceFields,
  handler: async (ctx, args) => commitPaymentEvidence(ctx, args, await preparePaymentEvidence(ctx, args)),
});
export const beginNarration = mutationGeneric({
  args: { ...leaseArgs, revision: v.number(), language: v.string(), textDigest: v.string() },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId);
    const lease = authorizeLease(row, args.leaseToken, args.revision, isPaid(row) ? "finalize" : "generate");
    if (!isPaid(row)) return { allowed: true };
    const content = paidEligible(row).composition.languages?.[args.language];
    if (!row.data.intake.languages.includes(args.language) || !content || args.textDigest !== await hash(reviewedNarrationText(content))) throw new Error("approved_content_mismatch");
    row.data.narrationEffects ||= [];
    if (row.data.narrationEffects.some((e) => e.revision === args.revision && e.language === args.language)) throw new Error("narration_reconciliation_required");
    lease.effectStartedAtMs = Date.now();
    row.data.narrationEffects.push({ revision: args.revision, language: args.language, textDigest: args.textDigest, status: "inflight", startedAtMs: Date.now() });
    audit(row, "paid_narration_started", { revision: args.revision, language: args.language, textDigest: args.textDigest });
    await save(ctx, row); return { allowed: true };
  },
});
