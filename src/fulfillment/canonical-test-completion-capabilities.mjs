import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { createExactRevisionPublicationAdapter } from "./exact-revision-publication-adapter.mjs";
import { createExternalEffectStageHandlers } from "./external-effect-stage-handlers.mjs";
import { createFulfillmentOrchestrator } from "./job-orchestrator.mjs";
import { authenticatePersistedReviewApproval, signPersistedReviewApproval } from "./persisted-review-decision.mjs";
import { createResendConfiguredTestDeliveryAdapter } from "./resend-delivery-adapter.mjs";
import { createVercelTestAPublicationProvider, parseAuthoritativeVercelBuildInspection } from "./vercel-test-a-publication-provider.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";

const RELEASE_STATES = new Set(["publish_ready", "publishing", "published", "delivery_queued", "sending", "sent",
  "complete", "failed", "reconciliation_required"]);
const RETRY_POLICY = Object.freeze({
  leaseMsByStage: Object.freeze({ publish: 300_000, deliver: 300_000 }),
  maxAttemptsByStage: Object.freeze({ publish: 1, deliver: 1 }),
  backoffMsByStage: Object.freeze({ publish: Object.freeze([]), deliver: Object.freeze([]) }),
});
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function assertCanonicalTestRelease(job, policy, approvals, hmacKey) {
  if (typeof hmacKey !== "string" || Buffer.byteLength(hmacKey) < 32) {
    throw new Error("Canonical release requires the configured review signing key.");
  }
  if (!job || job.jobId !== policy?.jobId || job.environment !== "test" || job.product !== "announcement-page"
      || job.currentRevisionId !== policy.revisionId || !RELEASE_STATES.has(job.state)
      || !Number.isInteger(job.version) || job.version < 1 || !Array.isArray(job.artifactSets)) {
    throw new Error("Canonical TEST release is outside the exact configured job and revision.");
  }
  const kind = job.narrationRequired === true ? "narration_review" : "prepared_bundle";
  if (job.narrationRequired !== true && job.narrationRequired !== false) throw new Error("Narration requirement must be explicit.");
  const release = job.artifactSets.filter((artifact) => artifact.kind === kind && artifact.revisionId === policy.revisionId);
  if (release.length !== 1 || release[0].assetManifestDigest !== policy.manifestDigest
      || !Array.isArray(release[0].files) || !release[0].files.length) {
    throw new Error("Canonical release manifest differs from the exact configured artifact.");
  }
  if (job.narrationRequired === true && !policy.narrationApprovalId) {
    throw new Error("Narrated publication requires a signed exact narration approval.");
  }
  if (job.narrationRequired === false && policy.narrationApprovalId) {
    throw new Error("Content-only publication rejects unrelated narration approval.");
  }
  for (const [type, id, artifactKind] of [
    ["content", policy.contentApprovalId, "private_review"],
    ...(job.narrationRequired ? [["narration", policy.narrationApprovalId, "narration_review"]] : []),
  ]) {
    const approval = authenticatePersistedReviewApproval(approvals?.[id], hmacKey);
    const expected = signPersistedReviewApproval({ hmacKey, job, decision: approval.decision });
    if (approval.approvalId !== id || approval.binding.jobId !== policy.jobId
        || approval.binding.revisionId !== policy.revisionId
        || !isDeepStrictEqual(approval.binding, expected.binding)
        || approval.decision.decisionType !== type || approval.decision.outcome !== "approved") {
      throw new Error("Signed exact review approval does not bind the canonical release.");
    }
    const artifact = job.artifactSets.filter((value) => value.kind === artifactKind && value.revisionId === policy.revisionId);
    if (artifact.length !== 1 || artifact[0].assetManifestDigest !== approval.binding.artifactManifestDigest
        || !["pageDigest", "transcriptDigest", "assetManifestDigest"].every((key) =>
          artifact[0][key] === approval.decision.artifactDigests?.[key])) {
      throw new Error("Signed approval disagrees with the persisted exact artifact manifest.");
    }
    const signedFields = ["decisionType", "revisionId", "outcome", "policyVersion", "rubricVersion", "reviewer",
      "decidedAt", "artifactDigests", "reasons"];
    const matching = (job.reviewDecisions || []).filter((decision) => decision.decisionType === type
      && decision.revisionId === policy.revisionId && signedFields.every((key) =>
        isDeepStrictEqual(decision[key], approval.decision[key])));
    if (matching.length !== 1) throw new Error("Signed approval has no unique recorded canonical review decision.");
  }
  return job;
}

export async function createCanonicalTestCompletionCapabilities(options = {}) {
  const { environment = process.env, policy, client } = options;
  if (!policy?.jobId || !client?.query || !client?.mutation) throw new Error("Canonical completion requires exact policy and Convex client.");
  const hmacKey = environment.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  const token = environment.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN;
  const backing = options.fulfillmentStore || createConvexFulfillmentStore({
    client, authorization: { completionToken: token, jobId: policy.jobId },
    functions: { getJob: "fulfillment:getCompletionJob", getReviewApproval: "fulfillment:getCompletionReviewApproval",
      replaceJob: "fulfillment:replaceCompletionJob" },
  });
  const approvalIds = [policy.contentApprovalId, ...(policy.narrationApprovalId ? [policy.narrationApprovalId] : [])];
  const readApprovals = async () => Object.fromEntries(await Promise.all(approvalIds.map(async (id) =>
    [id, await backing.getReviewApproval(id, policy.jobId)])));
  const store = Object.freeze(Object.fromEntries([
    "getJob", "claimStage", "markExternalEffectStarted", "fenceExternalEffect", "completeStage", "failStage",
    "queueDelivery", "confirmDelivery", "reconcileDelivery",
  ].map((name) => [name, async (jobId, ...args) => {
    if (jobId !== policy.jobId) throw new Error("Canonical completion is restricted to the exact configured job.");
    // Re-validate the canonical aggregate and signed approvals before every state transition.
    assertCanonicalTestRelease(await backing.getJob(jobId, args[0]?.workerAuthority), policy, await readApprovals(), hmacKey);
    const result = await backing[name](jobId, ...args);
    const next = result?.aggregate || result;
    if (next?.jobId === policy.jobId) {
      assertCanonicalTestRelease(next, policy, await readApprovals(), hmacKey);
    }
    return result;
  }])));
  const initial = await store.getJob(policy.jobId);
  const inspection = parseAuthoritativeVercelBuildInspection(Buffer.from(environment.VERCEL_BUILD_INSPECTION_B64, "base64"));
  if (inspection.revisionId !== policy.revisionId
      || inspection.teamId !== environment.CANONICAL_PUBLICATION_VERCEL_TEAM_ID
      || inspection.projectId !== environment.CANONICAL_PUBLICATION_VERCEL_PROJECT_ID
      || inspection.projectName !== environment.CANONICAL_PUBLICATION_VERCEL_PROJECT_NAME) {
    throw new Error("Canonical Vercel inspection does not bind the configured exact release/project.");
  }
  const site = new URL(environment.CONVEX_URL);
  if (!site.hostname.endsWith(".convex.cloud")) throw new Error("Canonical artifact reads require a Convex deployment origin.");
  site.hostname = `${site.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  const resolver = createCanonicalTestArtifactResolver({ policy, siteOrigin: site.origin, completionToken: token,
    fetch: options.fetch || globalThis.fetch });
  const publicationProvider = options.publicationProvider || createVercelTestAPublicationProvider({
    token: environment.VERCEL_TOKEN, buildInspection: inspection,
    teamId: inspection.teamId, projectId: inspection.projectId, projectName: inspection.projectName,
    stableOrigin: environment.CANONICAL_PUBLICATION_ORIGIN, canaryJobId: policy.jobId,
    canaryRevisionId: policy.revisionId, requireExistingAliasProject: true,
    requirePrivateDeploymentProtection: true, protectionBypassSecret: environment.VERCEL_PROTECTION_BYPASS_SECRET,
    artifactResolver: resolver, fetch: options.fetch || globalThis.fetch,
  });
  const handlers = createExternalEffectStageHandlers({
    publicationAdapter: createExactRevisionPublicationAdapter({ provider: publicationProvider,
      stableOrigin: environment.CANONICAL_PUBLICATION_ORIGIN }),
    deliveryAdapter: createResendConfiguredTestDeliveryAdapter({ apiKey: environment.RESEND_API_KEY,
      from: environment.RESEND_FROM, resend: options.resend, clock: options.clock, policy,
      stableUrl: `${environment.CANONICAL_PUBLICATION_ORIGIN}/announcements/${policy.jobId}` }),
    resolveDeliveryTarget: async (job) => {
      assertCanonicalTestRelease(job, policy, await readApprovals(), hmacKey);
      return Object.freeze({ targetRef: policy.targetRef, email: policy.recipient });
    },
  });
  const orchestrator = createFulfillmentOrchestrator({ store, handlers,
    clock: options.clock || (() => new Date().toISOString()),
    tokenFactory: options.tokenFactory || (() => `canonical_completion_${randomUUID()}`), retryPolicy: RETRY_POLICY });
  const scoped = Object.freeze(Object.fromEntries(["status", "runExpectedStage", "queueDelivery"].map((name) =>
    [name, (jobId, ...args) => {
      if (jobId !== policy.jobId) throw new Error("Canonical completion is restricted to the exact configured job.");
      return orchestrator[name](jobId, ...args);
    }])));
  return Object.freeze({ fulfillmentStore: store, fulfillmentOrchestrator: scoped, initialVersion: initial.version });
}

export function createCanonicalTestArtifactResolver({ policy, siteOrigin, completionToken, fetch }) {
  if (typeof fetch !== "function" || !policy?.jobId || !/^https:\/\/[^/?#]+$/u.test(siteOrigin)
      || typeof completionToken !== "string" || completionToken.length < 32) {
    throw new Error("Canonical artifact resolver requires exact private read authority.");
  }
  return Object.freeze({ async resolve(request) {
    const set = request?.artifactSet;
    if (request?.jobId !== policy.jobId || request?.environment !== "test" || request?.product !== "announcement-page"
        || request?.revisionId !== policy.revisionId || request.artifactManifestDigest !== policy.manifestDigest
        || set?.revisionId !== policy.revisionId || set.assetManifestDigest !== policy.manifestDigest
        || !["prepared_bundle", "narration_review"].includes(set.kind) || !Array.isArray(set.files)) {
      throw new Error("Artifact read is outside the exact canonical revision and manifest.");
    }
    const authority = request.artifactReadAuthority;
    if (authority?.workerId !== policy.workerId || !authority.commandId || !authority.leaseToken) {
      throw new Error("Canonical artifact read requires the active command lease claim.");
    }
    const manifestBytes = Buffer.from(`${JSON.stringify({ schemaVersion: "1.0", kind: set.kind,
      revisionId: set.revisionId, files: set.files.map(({ path, storageId, bytes, sha256 }) =>
        ({ path, storageId, bytes, sha256 })) }, null, 2)}\n`);
    if (digest(manifestBytes) !== policy.manifestDigest) throw new Error("Canonical manifest bytes changed.");
    const files = [];
    const seen = new Set();
    for (const file of set.files) {
      const publicPath = file.path.startsWith("deploy/") ? file.path.slice(7)
        : file.path.startsWith("artifacts/audio/") ? `audio/${file.path.slice(16)}` : null;
      if (!publicPath) continue;
      if (publicPath.length > 512 || publicPath.includes("\\") || publicPath.split("/").some((s) => !s || s === "." || s === "..")
          || seen.has(publicPath) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
          || !/^[a-f0-9]{64}$/u.test(file.sha256) || !file.storageId) {
        throw new Error("Canonical manifest contains unsafe or duplicate publication files.");
      }
      seen.add(publicPath);
      const url = new URL("/completion/artifact", siteOrigin);
      for (const [name, value] of Object.entries({ jobId: policy.jobId, revisionId: policy.revisionId,
        storageId: file.storageId })) url.searchParams.set(name, value);
      const response = await fetch(url, { method: "GET", redirect: "error", headers: {
        authorization: `Bearer ${completionToken}`, "x-bebebonjour-worker-id": authority.workerId,
        "x-bebebonjour-command-id": authority.commandId, "x-bebebonjour-lease-token": authority.leaseToken,
      } });
      if (!response.ok || response.headers.get("cache-control") !== "private, no-store"
          || response.headers.get("content-type") !== "application/octet-stream") {
        throw new Error("Canonical artifact read is unavailable or not private.");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error("Canonical artifact bytes changed.");
      files.push(Object.freeze({ sourcePath: file.path, publicPath, sha256: file.sha256, bytes }));
    }
    const entrypointPath = ["fr/index.html", "ar/index.html", "index.html"].find((candidate) => seen.has(candidate));
    if (!entrypointPath || !files.length || (set.kind === "narration_review" && !files.some((f) =>
      f.publicPath.startsWith("audio/") && f.publicPath.endsWith(".mp3")))) {
      throw new Error("Canonical release is missing an approved page or narration audio.");
    }
    return Object.freeze({ manifestBytes, entrypointPath, files: Object.freeze(files) });
  } });
}
