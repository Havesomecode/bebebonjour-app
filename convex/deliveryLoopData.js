import { mutationGeneric, queryGeneric, internalMutationGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { equal, get, save, audit, editorialAuth } from "./deliveryLoop.js";
import { isPaid } from "./deliveryLoopPaidPolicy.js";

export const DAY = 24 * 60 * 60 * 1000;
const ref = name => makeFunctionReference(`deliveryLoopData:${name}`);
const customerArgs = { jobId: v.string(), reviewToken: v.string() };
async function customer(ctx, args) {
  const row = await get(ctx, args.jobId);
  if (!equal(row.data.reviewToken, args.reviewToken)) throw new Error("forbidden");
  if (!isPaid(row)) throw new Error("paid_order_required");
  return row;
}
export const exportContent = queryGeneric({
  args: customerArgs,
  handler: async (ctx, args) => {
    const row = await customer(ctx, args); const d = row.data;
    if (!d.finalPublication || !d.deliveredAtMs || !d.hostingEndsAtMs || d.hostingEndsAtMs <= Date.now() || d.closedAtMs || d.deletionRequestedAtMs || d.cancelledAtMs) throw new Error("export_unavailable");
    // Takedown removes public access, not the customer's private export right.
    const final = d.finalPublication; const language = d.intake.languages[0];
    const content = final.composition.languages[language];
    return { revision: final.revision, contentDigest: final.contentDigest, language,
      text: [...content.introLines, ...content.blessingLines, ...content.closingLines].join("\n\n"),
      contentHtml: final.contentHtml, audio: final.audioFiles.map(f => ({ language: f.language, storageId: f.storageId })) };
  },
});
export const inspect = queryGeneric({
  args: { editorialToken: v.string(), jobId: v.string() },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken);
    const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    if (!row || !isPaid(row)) throw new Error("not_found");
    const d = row.data;
    const retained = await ctx.db.query("deliveryLoopRetainedEvidence").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    return { jobId: row.jobId, status: row.status, revokedAtMs: d.revokedAtMs || null,
      deletedAtMs: d.deletedAtMs || null, closedAtMs: d.closedAtMs || null,
      hostingEndsAtMs: d.hostingEndsAtMs || null, workingPurgedAtMs: d.workingPurgedAtMs || null,
      notice: d.closureNotice || null, retainedEvidence: retained?.evidence || null };
  },
});
async function retain(ctx, row, reason) {
  const d = row.data;
  if (d.payment.status === "pending" && !d.lease?.effectStartedAtMs && !d.emailReceipts.length && !d.narrationEffects?.length) return;
  // Explicit allowlist: no free-form feedback/errors, names, email, content,
  // customer capabilities, storage links, or arbitrary provider response bodies.
  const evidence = { payment: d.payment, approval: d.paidApproval || null, permissions: d.paidPermissions || null,
    editorial: d.editorialApproval || null, deliveredAtMs: d.deliveredAtMs || null,
    emailReceipts: d.emailReceipts.map(({ revision, stage, provider, providerMessageId, idempotencyKey, sentAtMs }) => ({ revision, stage, provider: provider || null, providerMessageId, idempotencyKey, sentAtMs })),
    uncertainEffect: d.lease?.effectStartedAtMs ? { stage: d.lease.stage, revision: d.desiredRevision, startedAtMs: d.lease.effectStartedAtMs, emailIdempotencyKey: d.lease.emailIdempotencyKey || null, ...(["draft_email", "final_email"].includes(d.lease.stage) ? { emailProvider: d.lease.emailProvider || null } : {}) } : null,
    narrationEffects: (d.narrationEffects || []).map(({ revision, language, textDigest, status, startedAtMs }) => ({ revision, language, textDigest, status, startedAtMs })),
    notice: d.closureNotice || null };
  const prior = await ctx.db.query("deliveryLoopRetainedEvidence").withIndex("by_job_id", q => q.eq("jobId", row.jobId)).unique();
  const values = { jobId: row.jobId, retainedAtMs: Date.now(), reason, evidence };
  if (prior) await ctx.db.patch(prior._id, values); else await ctx.db.insert("deliveryLoopRetainedEvidence", values);
}
function storageIds(d) {
  return new Set([...(d.revisions || []).flatMap(r => r.audioFiles || []), ...(d.finalPublication?.audioFiles || []), ...(d.narrationReceipts || [])].map(f => f.storageId));
}
async function erase(ctx, row, reason) {
  await retain(ctx, row, reason);
  for (const id of storageIds(row.data)) await ctx.storage.delete(id);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(row.idempotencyKey)))].map(n => n.toString(16).padStart(2, "0")).join("");
  // Hash user-supplied keys too: the tombstone contains no intake or capabilities.
  await ctx.db.patch(row._id, { idempotencyKey: `deleted:${digest}`, status: "data_deleted", data: { orderMode: "paid_route_a", deletedAtMs: Date.now(), reason } });
}
export const customerControl = mutationGeneric({
  args: { ...customerArgs, action: v.union(v.literal("revoke"), v.literal("delete")) },
  handler: async (ctx, args) => {
    const row = await customer(ctx, args);
    row.data.revokedAtMs ||= Date.now();
    if (args.action === "delete") { await erase(ctx, row, "customer_request"); return { status: "data_deleted" }; }
    if (row.status !== "revoked") audit(row, "publication_revoked", { actor: "customer" });
    await save(ctx, row, "revoked"); return { status: "revoked" };
  },
});
export const operatorControl = mutationGeneric({
  args: { editorialToken: v.string(), jobId: v.string(), action: v.union(v.literal("revoke"), v.literal("delete")) },
  handler: async (ctx, args) => {
    editorialAuth(args.editorialToken); const row = await get(ctx, args.jobId);
    if (!isPaid(row)) throw new Error("paid_order_required");
    row.data.revokedAtMs ||= Date.now();
    if (args.action === "delete") { await erase(ctx, row, "operator_request"); return { status: "data_deleted" }; }
    if (row.status !== "revoked") audit(row, "publication_revoked", { actor: "operator" });
    await save(ctx, row, "revoked"); return { status: "revoked" };
  },
});
async function purgeWorking(ctx, row) {
  const finalIds = new Set((row.data.finalPublication?.audioFiles || []).map(f => f.storageId));
  for (const id of storageIds(row.data)) if (!finalIds.has(id)) await ctx.storage.delete(id);
  row.data.revisions = []; row.data.feedback = null; row.data.reviewOperations = [];
  row.data.narrationReceipts = []; row.data.narrationEffects = [];
  row.data.intake = { customer: row.data.intake.customer, languages: row.data.intake.languages, fictional: row.data.intake.fictional };
  row.data.audit = []; row.data.lastError = null; row.data.workingPurgedAtMs = Date.now();
  await save(ctx, row);
}
// Hourly bounded walk with cursor continuation: legacy or >100 rows cannot
// starve newer paid orders. Complimentary rows are never changed.
export const sweep = internalMutationGeneric({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    if (process.env.BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED !== "true") return { disabled: true };
    const page = await ctx.db.query("deliveryLoopJobs").paginate({ cursor: args.cursor || null, numItems: 10 });
    for (const row of page.page) {
      const d = row.data; const now = Date.now();
      if (!isPaid(row) || d.deletedAtMs) continue;
      if (d.hostingEndsAtMs && now >= d.hostingEndsAtMs) { await erase(ctx, row, "hosting_ended"); continue; }
      if (d.cancelledAtMs && now >= d.cancelledAtMs + 30 * DAY) { await erase(ctx, row, "cancelled_retention"); continue; }
      if (!d.deliveredAtMs && !d.cancelledAtMs && d.payment.status !== "settled" && now >= (d.lastActivityAtMs || d.createdAtMs) + 7 * DAY) { await erase(ctx, row, "abandoned_draft"); continue; }
      if (d.deliveredAtMs && !d.workingPurgedAtMs && now >= d.deliveredAtMs + 30 * DAY) await purgeWorking(ctx, row);
      if (d.deliveredAtMs && d.hostingEndsAtMs && now >= d.hostingEndsAtMs - 30 * DAY && !d.closureNotice && !d.revokedAtMs && !d.cancelledAtMs) {
        d.closureNotice = { status: "queued", queuedAtMs: now, hostingEndsAtMs: d.hostingEndsAtMs, idempotencyKey: `bebe-loop:${row.jobId}:${d.latestRevision}:closure_notice` };
        await save(ctx, row);
        await ctx.scheduler.runAfter(0, makeFunctionReference("deliveryLoopDataProviders:sendClosureNotice"), { jobId: row.jobId });
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, ref("sweep"), { cursor: page.continueCursor });
    return { scanned: page.page.length, done: page.isDone };
  },
});
export const beginNotice = internalMutationGeneric({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const row = await get(ctx, args.jobId); const d = row.data;
    if (!isPaid(row) || process.env.BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED !== "true" || d.closureNotice?.status !== "queued" || d.revokedAtMs || d.cancelledAtMs || d.hostingEndsAtMs <= Date.now()) return null;
    const provider = process.env.BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER || 'cloudflare';
    if (provider !== 'cloudflare') throw new Error('email_provider_invalid');
    d.closureNotice.status = "inflight"; d.closureNotice.startedAtMs = Date.now(); d.closureNotice.provider = provider;
    await save(ctx, row);
    return { to: d.intake.customer.email, reviewToken: d.reviewToken, hostingEndsAtMs: d.hostingEndsAtMs, idempotencyKey: d.closureNotice.idempotencyKey, provider };
  },
});
export const finishNotice = internalMutationGeneric({
  args: { jobId: v.string(), providerMessageId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("deliveryLoopJobs").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    if (!row || row.data.deletedAtMs || row.data.closureNotice?.status !== "inflight") return;
    row.data.closureNotice.status = args.providerMessageId ? "sent" : "reconciliation_required";
    if (args.providerMessageId) { row.data.closureNotice.providerMessageId = args.providerMessageId; row.data.closureNotice.sentAtMs = Date.now(); }
    await save(ctx, row);
  },
});
