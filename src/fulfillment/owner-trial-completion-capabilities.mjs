import { createHash, randomUUID } from "node:crypto";
import { Resend } from "resend";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";
import { createFulfillmentOrchestrator } from "./job-orchestrator.mjs";
import { createExternalEffectStageHandlers } from "./external-effect-stage-handlers.mjs";
import { createVercelTestAPublicationProvider, parseAuthoritativeVercelBuildInspection } from "./vercel-test-a-publication-provider.mjs";
const persistedArtifactFile = ({ path, storageId, objectRef, bytes, sha256 }) => ({ path, storageId: storageId || objectRef?.storageId, bytes, sha256 });
import { stablePrivateValue as canonicalJson } from "./private-generation-authority.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const OWNER_EMAIL = "z@havesomecode.io";

export async function createOwnerTrialCompletionCapabilities(options = {}) {
  const { client, policy } = options;
  const env = options.environment || process.env;
  const token = env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN;
  if (!/^job_owner_trial_[a-f0-9]{32}$/u.test(policy?.jobId || "") || policy.recipient !== OWNER_EMAIL
      || policy.ownerSourceReference !== "kanban:t_4b1eb28f" || policy.workerId !== "owner-trial-completion-worker"
      || !/^[a-f0-9]{64}$/u.test(policy.manifestDigest || "")
      || typeof token !== "string" || token.length < 32) throw new Error("Owner trial completion scope is invalid.");
  const pinnedPolicy = canonicalJson(policy);
  const revalidate = async () => {
    const current = await client.query("ownerTrial:completionPolicy", { completionToken: token, jobId: policy.jobId });
    if (canonicalJson(current) !== pinnedPolicy) throw new Error("Owner trial completion ticket/release binding changed.");
    return current;
  };
  const store = createConvexFulfillmentStore({ client,
    authorization: { completionToken: token }, functions: { getJob: "ownerTrialCompletion:getJob",
      replaceJob: "ownerTrialCompletion:replaceJob", getReviewApproval: "ownerTrialCompletion:getReviewApproval" } });
  const fulfillmentStore = { ...store,
    getReviewApproval: async approvalId => { await revalidate(); return client.query("ownerTrialCompletion:getReviewApproval",
      { completionToken: token, jobId: policy.jobId, approvalId }); },
    createJob() { throw new Error("Owner trial completion cannot create jobs."); },
    saveReviewApproval() { throw new Error("Owner trial completion cannot sign approvals."); },
    recordReviewDecision() { throw new Error("Owner trial completion cannot change review decisions."); } };
  const resolver = createOwnerTrialPublicArtifactResolver({ policy, token, fetch: options.fetch, revalidate,
    siteOrigin: convexSiteOrigin(env.CONVEX_URL) });
  let publicationProvider = options.publicationProvider;
  if (!publicationProvider) {
    const encoded = env.OWNER_TRIAL_VERCEL_BUILD_INSPECTION_B64;
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error("Authoritative owner trial build inspection is required.");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("Owner trial build inspection encoding is not exact.");
    const inspection = parseAuthoritativeVercelBuildInspection(bytes);
    for (const [key, name] of [["teamId", "OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID"],
      ["projectId", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID"], ["projectName", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME"]]) {
      if (!env[name] || inspection[key] !== env[name]) throw new Error("Owner trial isolated Vercel project inspection mismatch.");
    }
    if (inspection.revisionId !== policy.revisionId) throw new Error("Owner trial build inspection revision mismatch.");
    publicationProvider = createVercelTestAPublicationProvider({ token: env.VERCEL_TOKEN, buildInspection: inspection,
      teamId: env.OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID, projectId: env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID,
      projectName: env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME, stableOrigin: policy.origin,
      canaryJobId: policy.jobId, canaryRevisionId: policy.revisionId, artifactResolver: resolver,
      fetch: options.fetch, requirePrivateDeploymentProtection: false, requireExistingAliasProject: true });
  }
  const publicationAdapter = Object.fromEntries(["reconcile", "publish"].map(method => [method, async request => {
    await revalidate(); assertRequest(request, policy);
    if (typeof request.fenceExternalEffect !== "function") throw new Error("Owner trial publication effect fence required.");
    return request.fenceExternalEffect({ effectMayBeIssued: true }, () => publicationProvider[method](request));
  }]));
  const deliveryAdapter = createOwnerTrialDeliveryAdapter({ policy, revalidate, resend: options.resend,
    apiKey: env.RESEND_API_KEY, from: env.OWNER_TRIAL_RESEND_FROM || env.RESEND_FROM, clock: options.clock });
  const handlers = createExternalEffectStageHandlers({ publicationAdapter, deliveryAdapter,
    resolveDeliveryTarget: async (job, targetRef) => {
      await revalidate(); assertJobStatus(job, policy);
      const ref = `resend:fictional:${policy.jobId}`;
      if (targetRef !== null && targetRef !== ref) throw new Error("Owner trial delivery target changed.");
      return { targetRef: ref, email: OWNER_EMAIL };
    } });
  const publicationRecovery = await client.query("ownerTrialPublicationRecovery:recoveryAllowance",
    { completionToken: token, jobId: policy.jobId });
  const stages = ["prepare_review", "render_approved", "generate_tts", "publish", "deliver"];
  const retryPolicy = { leaseMsByStage: Object.fromEntries(stages.map(s => [s, 300000])),
    maxAttemptsByStage: Object.fromEntries(stages.map(s => [s, s === "publish" && publicationRecovery ? publicationRecovery.maxAttempts : 1])),
    backoffMsByStage: Object.fromEntries(stages.map(s => [s, [60000]])) };
  const fulfillmentOrchestrator = createFulfillmentOrchestrator({ store: fulfillmentStore, handlers, retryPolicy,
    ownerTrialPublicationRecovery: publicationRecovery,
    clock: options.clock || (() => new Date().toISOString()), tokenFactory: options.tokenFactory || (() => randomUUID()) });
  await revalidate();
  return Object.freeze({ fulfillmentStore, fulfillmentOrchestrator, artifactResolver: resolver, deliveryAdapter });
}

export function createOwnerTrialDeliveryAdapter(options = {}) {
  const { policy, revalidate } = options;
  if (policy?.recipient !== OWNER_EMAIL || typeof revalidate !== "function") throw new Error("Owner trial delivery authority required.");
  const resend = options.resend || new Resend(options.apiKey);
  if (typeof options.from !== "string" || !options.from.trim()) throw new Error("Owner trial verified sender is required.");
  const clock = options.clock || (() => new Date().toISOString());
  const targetDigest = sha(canonicalJson({ targetRef: `resend:fictional:${policy.jobId}`, email: OWNER_EMAIL }));
  return Object.freeze({
    async reconcile(request) { await revalidate(); assertRequest(request, policy); return null; },
    async send(request) {
      await revalidate(); assertRequest(request, policy);
      const elapsed = Date.parse(clock()) - Date.parse(request.attemptStartedAt);
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 23 * 60 * 60 * 1000
        || request.target?.email !== OWNER_EMAIL || request.target?.targetRef !== `resend:fictional:${policy.jobId}`
        || request.targetDigest !== targetDigest || request.publication?.stableUrl !== `${policy.origin}/announcements/${policy.jobId}`
        || !/^bb_[a-f0-9]{64}$/u.test(request.idempotencyKey || "") || typeof request.fenceExternalEffect !== "function") {
        throw new Error("Owner trial delivery exact recipient/publication/idempotency fence rejected.");
      }
      const result = await request.fenceExternalEffect({ effectMayBeIssued: true }, async () => {
        await revalidate();
        return resend.emails.send({ from: options.from, to: [OWNER_EMAIL], subject: "OWNER TRIAL — votre annonce fictive est prête",
          html: `<p>Essai fictif OWNER TRIAL — revue déléguée, pas une acceptation propriétaire.</p><p><a href="${escapeHtml(request.publication.stableUrl)}">Découvrir l’annonce</a></p>` },
        { idempotencyKey: request.idempotencyKey });
      });
      if (result.error || !result.data?.id) {
        const error = new Error("Owner trial send outcome unavailable."); error.reasonCode = "resend_send_failed"; error.retryable = false; throw error;
      }
      return { provider: "resend", providerMessageId: result.data.id, revisionId: request.revisionId,
        artifactManifestDigest: request.artifactManifestDigest, targetDigest, idempotencyKey: request.idempotencyKey };
    },
    async status() { throw new Error("Owner trial send acceptance is not delivered/owner acceptance; status requires separate scoped reconciliation."); },
  });
}

export function createOwnerTrialPublicArtifactResolver({ policy, token, siteOrigin, fetch: fetchImpl = globalThis.fetch, revalidate }) {
  if (typeof siteOrigin !== "string" || !/^https:\/\/[a-z0-9-]+\.convex\.site$/u.test(siteOrigin)) {
    throw new Error("Owner trial pinned Convex site origin is required.");
  }
  return Object.freeze({ async resolve(request) {
    await revalidate(); assertRequest(request, policy);
    const set = request.artifactSet;
    if (set?.kind !== "narration_review" || set.revisionId !== policy.revisionId || set.assetManifestDigest !== policy.manifestDigest
      || set.artifactSetId !== request.artifactSetId || !Array.isArray(set.files)) throw new Error("Owner trial publication manifest rejected.");
    const manifestBytes = Buffer.from(`${JSON.stringify({ schemaVersion: "1.0", kind: set.kind, revisionId: set.revisionId,
      files: set.files.map(persistedArtifactFile) }, null, 2)}\n`);
    if (sha(manifestBytes) !== policy.manifestDigest) throw new Error("Owner trial manifest bytes changed.");
    const authority = request.artifactReadAuthority;
    if (authority?.workerId !== "owner-trial-completion-worker" || typeof authority.commandId !== "string"
      || typeof authority.leaseToken !== "string" || typeof request.fenceExternalEffect !== "function") throw new Error("Owner trial artifact command fence required.");
    const paths = new Set(), bundles = new Map();
    for (const file of set.files) {
      if (typeof file.path !== "string" || paths.has(file.path)) throw new Error("Owner trial duplicate/unsafe artifact path.");
      paths.add(file.path);
      if (file.path.startsWith("deploy/_assets/")) {
        const match = /^deploy\/_assets\/([a-z0-9]+(?:-[a-z0-9]+){0,30})\/(app\.js|phrase-progress\.mjs|styles\.css|og-image\.svg)$/u.exec(file.path);
        if (!match) throw new Error("Owner trial unsafe runtime asset path.");
        const names = bundles.get(match[1]) || new Set(); names.add(match[2]); bundles.set(match[1], names);
      }
    }
    if ([...bundles.values()].some(names => names.size !== 4)) throw new Error("Owner trial incomplete runtime bundle.");
    const files = [];
    for (const file of set.files) {
      let publicPath;
      if (/^deploy\/(?:fr\/|ar\/)?index\.html$/u.test(file.path)
        || /^(?:deploy\/(?:fr|ar)\/app\.js|deploy\/shared\/app\.css)$/u.test(file.path)
        || /^deploy\/_assets\/[a-z0-9]+(?:-[a-z0-9]+){0,30}\/(?:app\.js|phrase-progress\.mjs|styles\.css|og-image\.svg)$/u.test(file.path)) publicPath = file.path.slice(7);
      else if (/^artifacts\/audio\/[A-Za-z0-9/_-]+\.mp3$/u.test(file.path)) publicPath = file.path;
      else continue; // Private intake, review, transcript, manifests, and receipts never become public files.
      await revalidate();
      const storageId = file.storageId || file.objectRef?.storageId;
      const url = new URL("/completion/artifact", siteOrigin);
      for (const [k, value] of Object.entries({ jobId: policy.jobId, revisionId: policy.revisionId, storageId })) url.searchParams.set(k, value);
      const response = await request.fenceExternalEffect({ effectMayBeIssued: true }, () => fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, "x-bebebonjour-worker-id": authority.workerId,
          "x-bebebonjour-command-id": authority.commandId, "x-bebebonjour-lease-token": authority.leaseToken }, redirect: "error", cache: "no-store" }));
      if (!response.ok || response.headers.get("cache-control") !== "private, no-store"
        || response.headers.get("content-type") !== "application/octet-stream") throw new Error("Owner trial scoped artifact read failed.");
      let bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error("Owner trial persisted artifact bytes changed.");
      if (/\.(?:html|js|mjs|css|svg)$/u.test(publicPath)) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/z@havesomecode\.io|specificDemands|customerEmail|intakeDigest|approvalId|providerReceiptId|ticketSecret|storageId|private-preview|https?:\/\/[^\s"'<>]*convex\./iu.test(text)) {
          throw new Error("Owner trial public text contains private provenance.");
        }
      }
      if (publicPath.endsWith(".html")) {
        let html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!/<head(?:\s[^>]*)?>/iu.test(html)) {
          throw new Error("Owner trial public HTML contains private provenance or lacks a head.");
        }
        html = html.replace(/<meta\b[^>]*name\s*=\s*["']robots["'][^>]*>/giu, "")
          .replace(/<head(?:\s[^>]*)?>/iu, '$&<meta name="robots" content="noindex, nofollow, noarchive"><meta name="owner-trial" content="fictional-delegated-review-not-owner-acceptance">');
        bytes = Buffer.from(html);
      }
      files.push({ path: file.path, publicPath, bytes, sha256: sha(bytes) });
    }
    const entrypointPath = ["index.html", "fr/index.html"].find(p => files.some(f => f.publicPath === p));
    if (!entrypointPath || !files.some(f => f.publicPath.endsWith(".mp3"))) throw new Error("Owner trial public HTML/audio missing.");
    assertPublicRuntimeClosure(files);
    return { files, manifestBytes, entrypointPath };
  } });
}
function assertPublicRuntimeClosure(files) {
  const publicPaths = new Set(files.map(file => file.publicPath));
  const reject = () => { throw new Error("Owner trial unsafe or incomplete public runtime dependency."); };
  for (const file of files) {
    if (!/\.(?:html|js|mjs|css|svg)$/u.test(file.publicPath)) continue;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    const references = [];
    if (file.publicPath.endsWith(".html")) {
      for (const tag of text.matchAll(/<(?:script|link|img|audio|video|source)\b[^>]*>/giu)) {
        if (/\b(?:src|href|poster)\s*=\s*[^"'\s]/iu.test(tag[0])) reject();
        for (const match of tag[0].matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/giu)) references.push(match[1]);
      }
    } else if (/\.(?:m?js)$/u.test(file.publicPath)) {
      // Computed module loading cannot establish an exact approved dependency set.
      if (/\bimport\s*\(\s*[^"'\s]/u.test(text)) reject();
      for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gu)) references.push(match[1] || match[2]);
    } else if (file.publicPath.endsWith(".css")) {
      for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)|@import\s+["']([^"']+)["']/giu)) references.push(match[1] || match[2]);
    } else if (file.publicPath.endsWith(".svg")) {
      if (/<(?:script|foreignObject)\b|\bon[a-z]+\s*=/iu.test(text)) reject();
      for (const match of text.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']+)["']/giu)) references.push(match[1]);
    }
    for (const reference of references) {
      if (reference.startsWith("#")) continue;
      // Reject encoded traversal, schemes, query aliases, and private endpoints.
      if (!reference || /[%\\?#:]|^\/\//u.test(reference)) reject();
      const base = "https://owner-trial-public.invalid/";
      const url = new URL(reference, `${base}${file.publicPath}`);
      if (url.origin !== "https://owner-trial-public.invalid" || !publicPaths.has(url.pathname.slice(1))) reject();
    }
  }
}

function assertRequest(r, p) {
  if (r?.jobId !== p.jobId || r.environment !== "test" || r.product !== "announcement-page"
    || r.revisionId !== p.revisionId || r.artifactManifestDigest !== p.manifestDigest) throw new Error("Owner trial external effect scope rejected.");
}
function assertJobStatus(j, p) {
  if (j?.jobId !== p.jobId || j.environment !== "test" || j.product !== "announcement-page"
    || j.currentRevisionId !== p.revisionId || j.intakeDigest !== p.intakeDigest) throw new Error("Owner trial status binding rejected.");
}
function convexSiteOrigin(value) {
  if (typeof value !== "string" || !/^https:\/\/[a-z0-9-]+\.convex\.cloud$/u.test(value)) {
    throw new Error("Owner trial Convex deployment URL is required.");
  }
  return value.replace(/\.cloud$/u, ".site");
}
function escapeHtml(s) { return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
