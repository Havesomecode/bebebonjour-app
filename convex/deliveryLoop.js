import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

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
function equal(a, b) {
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
function admission(row) { return { jobId: row.jobId, reviewToken: row.data.reviewToken, ...links(row), status: row.status }; }
function full(row) { return { ...row.data, jobId: row.jobId, publicToken: row.publicToken, status: row.status, ...links(row) }; }
async function get(ctx, jobId) {
  const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).unique();
  if (!row) throw new Error("not_found");
  return row;
}
async function save(ctx, row, status = row.status) {
  if (new TextEncoder().encode(JSON.stringify(row.data)).byteLength > 850000) throw new Error("job_capacity_reached");
  await ctx.db.patch(row._id, { status, data: row.data }); row.status = status;
}
function audit(row, type, details = {}) { row.data.audit.push({ type, atMs: Date.now(), ...details }); }
function authorizeLease(row, token, revision, stage) {
  const lease = row.data.lease;
  if (!lease || !equal(lease.leaseToken, token) || lease.leaseExpiresAtMs <= Date.now() || (revision !== undefined && revision !== row.data.desiredRevision) || (stage !== undefined && stage !== lease.stage) || row.status !== `${lease.stage === "generate" ? "generation" : lease.stage}_running`) throw new Error("stale_lease");
  return lease;
}
function safeStatus(row) {
  return { jobId: row.jobId, status: row.status, desiredRevision: row.data.desiredRevision, revision: row.data.latestRevision, publicUrl: links(row).publicUrl, draftEmailSent: row.data.emailReceipts.some((e) => e.revision === row.data.latestRevision && e.stage === "draft_email"), canReview: row.status === "awaiting_review" && row.data.desiredRevision === row.data.latestRevision, fictional: row.data.intake.fictional };
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
  args: { intake: v.any(), idempotencyKey: v.string(), magicPassword: v.string() },
  handler: async (ctx, args) => {
    const idempotencyKey = text(args.idempotencyKey, 200);
    const intake = canonicalIntake(args.intake, idempotencyKey);
    if (args.magicPassword.length > 256) throw new Error("invalid_input");
    const configured = process.env.BEBEBONJOUR_TRIAL_PASSWORD_SHA256;
    if (!DIGEST.test(configured || "")) throw new Error("trial_unavailable");
    const bad = !equal(await hash(args.magicPassword), configured);
    // Return rather than throw: failed authentication counts must commit.
    if (await throttle(ctx, intake.customer.email, bad)) return { error: "intake_rate_limited" };
    if (bad) return { error: "invalid_magic_password" };
    const requestDigest = await hash(JSON.stringify(intake));
    const previous = await ctx.db.query("deliveryLoopJobs").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey)).unique();
    if (previous) {
      if (previous.data.requestDigest !== requestDigest) throw new Error("idempotency_conflict");
      return admission(previous);
    }
    intake.submittedAt ||= new Date().toISOString();
    const row = { jobId: `job_${randomToken()}`, publicToken: randomToken(), idempotencyKey, status: "generation_queued", data: { intake, requestDigest, reviewToken: randomToken(), payment: { status: "waived", reason: "magic_password", waivedAt: new Date().toISOString() }, desiredRevision: 1, latestRevision: 0, feedback: null, revisions: [], narrationReceipts: [], emailReceipts: [], reviewOperations: [], audit: [], lease: null, usedLeaseTokens: [], generationAttempts: 0, lastError: null, createdAtMs: Date.now() } };
    audit(row, "intake_accepted", { paymentStatus: "waived" });
    await ctx.db.insert("deliveryLoopJobs", row);
    return admission(row);
  },
});
export const read = queryGeneric({ args: workerArgs, handler: async (ctx, args) => { auth(args.workerToken); return full(await get(ctx, args.jobId)); } });
export const status = queryGeneric({ args: { jobId: v.string(), reviewToken: v.string() }, handler: async (ctx, args) => { const row = await get(ctx, args.jobId); if (!equal(row.data.reviewToken, args.reviewToken)) throw new Error("forbidden"); return safeStatus(row); } });

function work(row) {
  const latest = row.data.revisions.find((r) => r.revision === row.data.latestRevision);
  return { ...full(row), revision: row.data.desiredRevision, stage: row.data.lease.stage, leaseToken: row.data.lease.leaseToken, leaseExpiresAtMs: row.data.lease.leaseExpiresAtMs, effectStartedAtMs: row.data.lease.effectStartedAtMs ?? null, emailIdempotencyKey: `bebe-loop:${row.jobId}:${row.data.desiredRevision}:${row.data.lease.stage}`, previousComposition: latest?.composition ?? null };
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
        const status = lease.stage !== "generate" && lease.effectStartedAtMs !== undefined ? "reconciliation_required" : lease.stage === "generate" && row.data.generationAttempts >= 3 ? "failed" : `${lease.stage === "generate" ? "generation" : lease.stage}_queued`;
        audit(row, "lease_expired", { stage: lease.stage, revision: row.data.desiredRevision, outcome: status });
        // Keep uncertain email lease/journal for manual durable reconciliation.
        if (status !== "reconciliation_required") row.data.lease = null;
        await save(ctx, row, status);
      }
    }
    for (const stage of ["generate", "draft_email", "final_email"]) {
      const state = `${stage === "generate" ? "generation" : stage}_queued`;
      const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_status", (q) => q.eq("status", state)).first();
      if (!row) continue;
      if (row.data.usedLeaseTokens.includes(args.leaseToken)) throw new Error("reused_lease_token");
      if (stage === "generate") row.data.generationAttempts++;
      row.data.usedLeaseTokens.push(args.leaseToken);
      row.data.lease = { stage, workerId: args.workerId, leaseToken: args.leaseToken, claimedAtMs: Date.now(), leaseExpiresAtMs: Date.now() + LEASE_MS };
      audit(row, "work_claimed", { stage, revision: row.data.desiredRevision });
      await save(ctx, row, `${stage === "generate" ? "generation" : stage}_running`);
      return work(row);
    }
    return null;
  },
});
export const authorizeProvider = queryGeneric({
  args: { ...leaseArgs, revision: v.number(), stage: stageValue },
  handler: async (ctx, args) => { auth(args.workerToken); const row = await get(ctx, args.jobId); authorizeLease(row, args.leaseToken, args.revision, args.stage); return work(row); },
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
    auth(args.workerToken); const row = await get(ctx, args.jobId); authorizeLease(row, args.leaseToken, args.revision, "generate");
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
    audit(row, "narration_recorded", { revision: args.revision, language: args.language, textDigest: args.textDigest });
    await save(ctx, row); return receipt;
  },
});
export const publish = mutationGeneric({
  args: { ...leaseArgs, revision: v.number(), contentHtml: v.string(), composition: v.any(), compositionReceipt: v.any(), contentDigest: v.string(), audioFiles: v.array(v.object({ language: v.string(), storageId: v.id("_storage"), textDigest: v.string() })) },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); authorizeLease(row, args.leaseToken, args.revision, "generate");
    text(args.contentHtml, 120000, "invalid_content");
    if (!DIGEST.test(args.contentDigest) || await hash(args.contentHtml) !== args.contentDigest) throw new Error("content_digest_mismatch");
    if (!args.composition || !args.compositionReceipt || JSON.stringify(args.composition).length > 30000 || JSON.stringify(args.compositionReceipt).length > 12000) throw new Error("invalid_composition");
    if (args.contentHtml.includes(row.data.reviewToken) || args.contentHtml.includes(row.data.intake.customer.email) || args.contentHtml.includes(args.workerToken)) throw new Error("private_content_leak");
    if (row.data.revisions.some((r) => r.revision === args.revision) || args.audioFiles.length > 2 || new Set(args.audioFiles.map((a) => a.language)).size !== args.audioFiles.length) throw new Error("invalid_publication");
    for (const file of args.audioFiles) {
      if (!row.data.intake.voicePreference.enabled || !row.data.intake.languages.includes(file.language) || !DIGEST.test(file.textDigest)) throw new Error("invalid_audio_file");
      await audioMetadata(ctx, file.storageId);
      if (!row.data.narrationReceipts.some((r) => r.revision === args.revision && r.language === file.language && r.textDigest === file.textDigest && r.storageId === file.storageId)) throw new Error("narration_receipt_required");
    }
    // A voiced request cannot be silently delivered as text-only.
    if (row.data.intake.voicePreference.enabled && row.data.intake.languages.some((language) => !args.audioFiles.some((file) => file.language === language))) throw new Error("requested_audio_missing");
    row.data.revisions.push({ revision: args.revision, contentHtml: args.contentHtml, composition: args.composition, compositionReceipt: args.compositionReceipt, contentDigest: args.contentDigest, audioFiles: args.audioFiles, publishedAtMs: Date.now() });
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
      lease.effectStartedAtMs = Date.now();
      lease.emailIdempotencyKey = `bebe-loop:${row.jobId}:${row.data.desiredRevision}:${args.stage}`;
      audit(row, "email_effect_started", { stage: args.stage, revision: row.data.desiredRevision, idempotencyKey: lease.emailIdempotencyKey });
      await save(ctx, row);
    }
    return work(row);
  },
});
export const completeEmail = mutationGeneric({
  args: { ...leaseArgs, revision: v.number(), stage: stageValue, providerMessageId: v.string() },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId); text(args.providerMessageId, 200);
    if (args.stage === "generate") throw new Error("email_stage_required");
    const previous = row.data.emailReceipts.find((e) => e.revision === args.revision && e.stage === args.stage);
    if (previous) {
      if (previous.providerMessageId !== args.providerMessageId || previous.leaseToken !== args.leaseToken) throw new Error("email_completion_conflict");
      return safeStatus(row);
    }
    const lease = authorizeLease(row, args.leaseToken, args.revision, args.stage);
    if (lease.effectStartedAtMs === undefined) throw new Error("email_not_fenced");
    row.data.emailReceipts.push({ revision: args.revision, stage: args.stage, providerMessageId: args.providerMessageId, idempotencyKey: lease.emailIdempotencyKey, leaseToken: args.leaseToken, sentAtMs: Date.now() });
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
    const uncertain = lease.stage !== "generate" && lease.effectStartedAtMs !== undefined && args.providerDefinitiveFailure !== true;
    const retry = args.retryable && (lease.stage !== "generate" || row.data.generationAttempts < 3);
    const state = uncertain ? "reconciliation_required" : retry ? `${lease.stage === "generate" ? "generation" : lease.stage}_queued` : "failed";
    audit(row, "work_failed", { reason, stage: lease.stage, revision: row.data.desiredRevision, outcome: state, definitiveProviderFailure: args.providerDefinitiveFailure === true });
    if (!uncertain) row.data.lease = null;
    await save(ctx, row, state); return safeStatus(row);
  },
});
// Technical recovery is not another customer review or a reset of history.
// Only the semantic rejection before narration may resume within the original
// finite generation budget; any downstream/uncertain effect remains fenced.
export const retryCorrection = mutationGeneric({
  args: { ...workerArgs, expectedRevision: v.number() },
  handler: async (ctx, args) => {
    auth(args.workerToken); const row = await get(ctx, args.jobId);
    const revision = row.data.desiredRevision;
    if (args.expectedRevision !== revision) throw new Error("stale_revision");
    if (row.status !== "failed" || revision < 2 || !row.data.feedback || row.data.lease || row.data.generationAttempts >= 3 || row.data.lastError?.stage !== "generate" || row.data.lastError?.reason !== "correction_not_applied" || row.data.latestRevision >= revision || [row.data.revisions, row.data.narrationReceipts, row.data.emailReceipts].some((receipts) => receipts.some((receipt) => receipt.revision === revision))) throw new Error("correction_retry_unavailable");
    audit(row, "correction_retry_authorized", { revision, priorAttempts: row.data.generationAttempts, actor: "operator" });
    await save(ctx, row, "generation_queued");
    return safeStatus(row);
  },
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
    if (!row.data.emailReceipts.some((e) => e.revision === args.expectedRevision && e.stage === "draft_email")) throw new Error("draft_not_delivered");
    if (row.status !== "awaiting_review") throw new Error("review_not_available");
    if (args.action === "request_changes") {
      if (row.data.desiredRevision >= 12) throw new Error("revision_limit");
      row.data.desiredRevision++; row.data.feedback = feedback; row.data.generationAttempts = 0;
    } else row.data.approvedRevision = args.expectedRevision;
    audit(row, `review_${args.action}`, { revision: args.expectedRevision, actor, simulated: actor === "simulated_human", ...(feedback ? { feedback } : {}) });
    row.status = args.action === "request_changes" ? "generation_queued" : "final_email_queued";
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
    const revision = row.data.revisions.find((r) => r.revision === row.data.latestRevision);
    return { contentHtml: revision.contentHtml, revision: revision.revision, draft: row.data.approvedRevision !== revision.revision, audioLanguages: revision.audioFiles.map((f) => f.language) };
  },
});
export const publicAudio = queryGeneric({
  args: { publicToken: v.string(), revision: v.number(), language: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_public_token", (q) => q.eq("publicToken", args.publicToken)).unique();
    const file = row?.data.revisions.find((r) => r.revision === args.revision)?.audioFiles.find((f) => f.language === args.language);
    return file ? { storageId: file.storageId } : null;
  },
});
