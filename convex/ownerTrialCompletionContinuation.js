import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { hashTrial } from "./ownerTrial.js";
import { assertOwnerTrialCompletionToken, reviewedOwnerTrialCompletionPolicy } from "./ownerTrialCompletion.js";
import { assertOwnerTrialOperator, OWNER_TRIAL_SOURCE } from "../src/fulfillment/owner-trial-authority.mjs";
import { stablePrivateValue as canonicalJson } from "../src/fulfillment/private-generation-authority.mjs";

const lookup = (ctx, table, index, field, value) => ctx.db.query(table).withIndex(index, q => q.eq(field, value)).unique();
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const strip = ({ _id, _creationTime, ...value }) => value;
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const fail = () => { throw new Error("Owner trial completion continuation rejected."); };
const requests = ["jobId", "expectedVersion", "expectedBindingDigest", "previousReceiptId", "ownerSourceReference", "authorizationReference", "expiresAt"];
const requestOf = args => Object.fromEntries(requests.map(k => [k, args[k]]));
const rowsFor = (ctx, jobId) => ctx.db.query("ownerTrialCompletionContinuations").withIndex("by_job_id", q => q.eq("jobId", jobId)).collect();

async function signature(value) {
  const secret = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  if (typeof secret !== "string" || new TextEncoder().encode(secret).length < 32
    || ["BEBEBONJOUR_OPERATIONS_TOKEN", "BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN",
      "BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN"].some(k => process.env[k] === secret)) fail();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalJson(value))))]
    .map(n => n.toString(16).padStart(2, "0")).join("");
}
async function exactBinding(ctx, policy) {
  if (process.env.OWNER_TRIAL_JOB_ID !== policy.jobId) fail();
  const ticket = await lookup(ctx, "ownerTrialTickets", "by_ticket_id", "ticketId", policy.ticketId);
  const customer = (await lookup(ctx, "customerFlowJobs", "by_job_id", "jobId", policy.jobId)).job;
  const job = (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", policy.jobId)).aggregate;
  const { state, version, updatedAt, publication, publishedRevisionId, stageAttempts, events, deliveryAttempts, retry, ...immutableJob } = job;
  const reviews = await ctx.db.query("ownerTrialReviews").withIndex("by_job_type", q => q.eq("jobId", policy.jobId)).collect();
  const approvals = await Promise.all([policy.contentApprovalId, policy.narrationApprovalId].map(id =>
    lookup(ctx, "fulfillmentReviewApprovals", "by_approval_id", "approvalId", id)));
  const editorial = await lookup(ctx, "fulfillmentGenerationEditorialApprovals", "by_job_id", "jobId", policy.jobId);
  const provider = Object.fromEntries(["OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID",
    "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME"].map(name => [name, process.env[name]]));
  if (Object.values(provider).some(x => typeof x !== "string" || !x) || !ticket.redeemed || !iso(ticket.binding.expiresAt)) fail();
  return { policy, actions: ["deliver", "publish", "queue_delivery"], leaseMs: 300000,
    ticketDigest: await hashTrial(canonicalJson(strip(ticket))),
    customerDigest: await hashTrial(canonicalJson(customer)),
    releaseDigest: await hashTrial(canonicalJson({ immutableJob, priorStages: stageAttempts.filter(a => !["publish", "deliver"].includes(a.stage)),
      reviews: reviews.map(strip).sort((a, b) => a.decisionType.localeCompare(b.decisionType)), approvals: approvals.map(strip), editorial: editorial ? strip(editorial) : null })), provider };
}
function validRequest(request) {
  return same(requestOf(request), request) && /^job_owner_trial_[a-f0-9]{32}$/u.test(request.jobId || "")
    && Number.isSafeInteger(request.expectedVersion) && request.expectedVersion > 0
    && /^[a-f0-9]{64}$/u.test(request.expectedBindingDigest || "")
    && (request.previousReceiptId === null || /^continuation_[a-f0-9]{24}$/u.test(request.previousReceiptId || ""))
    && request.ownerSourceReference === OWNER_TRIAL_SOURCE
    && /^kanban:t_4b1eb28f:completion:[A-Za-z0-9_-]{8,128}$/u.test(request.authorizationReference || "") && iso(request.expiresAt);
}
async function history(ctx, policy) {
  const rows = await rowsFor(ctx, policy.jobId), binding = await exactBinding(ctx, policy);
  const receipts = rows.map(row => row.receipt).sort((a, b) => a.sequence - b.sequence);
  let previous = null;
  const refs = new Set();
  for (const [i, r] of receipts.entries()) {
    const unsigned = { schemaVersion: "1.0", kind: "owner_trial_completion_continuation", receiptId: r.receiptId,
      sequence: r.sequence, issuedAt: r.issuedAt, request: r.request, requestDigest: r.requestDigest, binding: r.binding };
    if (!same(r, { ...unsigned, signature: r.signature }) || !validRequest(r.request) || r.request.jobId !== policy.jobId
      || !same(r.binding, binding) || r.request.expectedBindingDigest !== await hashTrial(canonicalJson(binding)) || !iso(r.issuedAt) || r.sequence !== i + 1
      || r.request.previousReceiptId !== (previous?.receiptId || null) || refs.has(r.request.authorizationReference)
      || Date.parse(r.request.expiresAt) <= Date.parse(r.issuedAt)
      || Date.parse(r.request.expiresAt) - Date.parse(r.issuedAt) > 86400000
      || (previous && Date.parse(r.issuedAt) < Date.parse(previous.request.expiresAt))
      || r.requestDigest !== await hashTrial(canonicalJson(r.request))
      || r.receiptId !== `continuation_${r.requestDigest.slice(0, 24)}`
      || r.signature !== await signature(unsigned)) fail();
    refs.add(r.request.authorizationReference); previous = r;
  }
  return { receipts, binding };
}
// Read-only completion seam. Receipt grants time, never a retry or provider-absence claim.
export async function verifiedCompletionContinuation(ctx, policy) {
  if (!(await rowsFor(ctx, policy.jobId)).length) return null;
  const { receipts } = await history(ctx, policy), latest = receipts.at(-1);
  if (Date.parse(latest.issuedAt) > Date.now() || Date.parse(latest.request.expiresAt) <= Date.now()) fail();
  return latest;
}
function authorizeRoles(args) {
  assertOwnerTrialOperator(args.operatorToken); assertOwnerTrialCompletionToken(args.completionToken);
  if (["BEBEBONJOUR_APPROVAL_HMAC_KEY", "BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN",
    "OWNER_TRIAL_INVOKE_SECRET", "CRON_SECRET"].some(k => process.env[k] === args.operatorToken)) fail();
}
// Authenticated read-only inspection commitment; not a release or retry capability.
export const authorizationContext = queryGeneric({ args: { operatorToken: v.string(), completionToken: v.string(), jobId: v.string() },
  handler: async (ctx, args) => {
    authorizeRoles(args);
    const policy = await reviewedOwnerTrialCompletionPolicy(ctx, args.jobId);
    const { receipts, binding } = await history(ctx, policy);
    const job = (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", args.jobId)).aggregate;
    return { expectedVersion: job.version, bindingDigest: await hashTrial(canonicalJson(binding)), previousReceiptId: receipts.at(-1)?.receiptId || null };
  } });
export const authorizeContinuation = mutationGeneric({ args: { operatorToken: v.string(), completionToken: v.string(), jobId: v.string(),
  expectedVersion: v.number(), expectedBindingDigest: v.string(), previousReceiptId: v.union(v.null(), v.string()), ownerSourceReference: v.string(),
  authorizationReference: v.string(), expiresAt: v.string() }, handler: async (ctx, args) => {
    authorizeRoles(args);
    const request = requestOf(args);
    if (!validRequest(request)) fail();
    const policy = await reviewedOwnerTrialCompletionPolicy(ctx, args.jobId);
    const ticket = await lookup(ctx, "ownerTrialTickets", "by_ticket_id", "ticketId", policy.ticketId);
    if (Date.parse(ticket.binding.expiresAt) > Date.now()) fail();
    const { receipts, binding } = await history(ctx, policy);
    if (request.expectedBindingDigest !== await hashTrial(canonicalJson(binding))) fail();
    const prior = receipts.find(r => r.request.authorizationReference === request.authorizationReference);
    if (prior) {
      if (!same(prior.request, request) || prior !== receipts.at(-1) || Date.parse(prior.request.expiresAt) <= Date.now()) fail();
      return { issued: false, receiptId: prior.receiptId, expiresAt: prior.request.expiresAt };
    }
    const job = (await lookup(ctx, "fulfillmentJobs", "by_job_id", "jobId", args.jobId)).aggregate;
    const latest = receipts.at(-1), now = Date.now();
    if (job.version !== args.expectedVersion || request.previousReceiptId !== (latest?.receiptId || null)
      || (latest && Date.parse(latest.request.expiresAt) > now) || Date.parse(request.expiresAt) <= now
      || Date.parse(request.expiresAt) - now > 86400000 || ["publishing", "sending", "complete"].includes(job.state)
      || job.stageAttempts.some(a => a.status === "running")
      || (await ctx.db.query("customerFlowOperationsCommands").withIndex("by_job_id_and_state", q => q.eq("jobId", args.jobId).eq("state", "running")).collect()).length
      || (await ctx.db.query("customerFlowOperationsCommands").withIndex("by_job_id_and_state", q => q.eq("jobId", args.jobId).eq("state", "pending")).collect()).length) fail();
    const requestDigest = await hashTrial(canonicalJson(request)), receiptId = `continuation_${requestDigest.slice(0, 24)}`;
    const unsigned = { schemaVersion: "1.0", kind: "owner_trial_completion_continuation", receiptId,
      sequence: receipts.length + 1, issuedAt: new Date(now).toISOString(), request, requestDigest, binding };
    const receipt = { ...unsigned, signature: await signature(unsigned) };
    await ctx.db.insert("ownerTrialCompletionContinuations", { jobId: args.jobId, receipt });
    return { issued: true, receiptId, expiresAt: request.expiresAt };
  } });
