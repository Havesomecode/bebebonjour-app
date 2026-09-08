import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { createExactRevisionPublicationAdapter } from "./exact-revision-publication-adapter.mjs";
import { createExternalEffectStageHandlers } from "./external-effect-stage-handlers.mjs";
import { createFulfillmentOrchestrator } from "./job-orchestrator.mjs";
import { createPersistedReviewDecisionVerifier } from "./persisted-review-decision.mjs";
import { createResendDeliveryAdapter } from "./resend-delivery-adapter.mjs";
import {
  createVercelTestAPublicationProvider,
  parseAuthoritativeVercelBuildInspection,
} from "./vercel-test-a-publication-provider.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";
import { TEST_A_COMPLETION_JOB_ID } from "../operations/production-completion-worker.mjs";

const TEST_SINK = "delivered@resend.dev";
const RETRY_POLICY = Object.freeze({
  leaseMsByStage: Object.freeze({ render_approved: 300_000, publish: 300_000, deliver: 300_000 }),
  maxAttemptsByStage: Object.freeze({ render_approved: 2, publish: 2, deliver: 2 }),
  backoffMsByStage: Object.freeze({
    render_approved: Object.freeze([60_000]),
    publish: Object.freeze([60_000]),
    deliver: Object.freeze([60_000]),
  }),
});

export async function createTestACompletionCapabilities(options = {}) {
  const environment = options.environment || process.env;
  const client = options.client;
  const policy = options.policy;
  if (policy?.jobId !== TEST_A_COMPLETION_JOB_ID || !client?.query || !client?.mutation) {
    throw new Error("TEST-A completion capabilities require the exact worker policy and Convex client.");
  }
  const completionToken = requiredSecret(environment, "BEBEBONJOUR_COMPLETION_WORKER_TOKEN", 32);
  const hmacKey = requiredSecret(environment, "BEBEBONJOUR_APPROVAL_HMAC_KEY", 32);
  const unrestrictedStore = options.fulfillmentStore || createConvexFulfillmentStore({
    client,
    authorization: { completionToken, jobId: policy.jobId },
    functions: {
      getJob: "fulfillment:getCompletionJob",
      getReviewApproval: "fulfillment:getCompletionReviewApproval",
      replaceJob: "fulfillment:replaceCompletionJob",
    },
  });
  const store = restrictStoreToSyntheticJob(unrestrictedStore, policy.jobId);
  const initialJob = await store.getJob(policy.jobId);
  assertSyntheticJob(initialJob, policy.jobId);

  const buildInspection = parseAuthoritativeVercelBuildInspection(
    Buffer.from(requiredString(environment, "VERCEL_BUILD_INSPECTION_B64"), "base64"),
  );
  const identity = requireCompletionIdentity(environment, buildInspection);
  if (buildInspection.revisionId !== initialJob.currentRevisionId) {
    throw new Error("Authoritative Vercel inspection does not bind the current synthetic revision.");
  }
  const artifactResolver = createHostedCompletionArtifactResolver({
    fetch: options.fetch || globalThis.fetch,
    siteOrigin: convexSiteOrigin(environment.CONVEX_URL),
    backendToken: completionToken,
    jobId: policy.jobId,
  });
  const publicationProvider = createVercelTestAPublicationProvider({
    token: requiredString(environment, "VERCEL_TOKEN"),
    buildInspection,
    teamId: identity.publication.teamId,
    projectId: identity.publication.projectId,
    projectName: identity.publication.projectName,
    stableOrigin: identity.publication.stableOrigin,
    canaryJobId: policy.jobId,
    canaryRevisionId: initialJob.currentRevisionId,
    requirePrivateDeploymentProtection: true,
    protectionBypassSecret: requiredSecret(environment, "VERCEL_PROTECTION_BYPASS_SECRET", 32),
    artifactResolver,
    fetch: options.fetch || globalThis.fetch,
  });
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter: createExactRevisionPublicationAdapter({
      provider: options.publicationProvider || publicationProvider,
      stableOrigin: identity.publication.stableOrigin,
    }),
    deliveryAdapter: createResendDeliveryAdapter({
      apiKey: environment.RESEND_API_KEY,
      from: identity.resendFrom,
      resend: options.resend,
      clock: options.clock,
    }),
    resolveDeliveryTarget: async (job) => {
      assertSyntheticJob(job, policy.jobId);
      return { targetRef: "resend:test-a-sink", email: TEST_SINK };
    },
  });
  const verifyApproval = createPersistedReviewDecisionVerifier({
    approvalStore: store,
    fulfillmentStore: store,
    hmacKey,
  });
  const clock = options.clock || (() => new Date().toISOString());
  const orchestrator = createFulfillmentOrchestrator({
    store,
    handlers: Object.freeze({
      verify_review_decision: async ({ job, decision }) => {
        const verified = await verifyApproval({
          job,
          decision: { approvalId: decision.approvalId },
        });
        const withoutCommandBinding = (value) => Object.fromEntries(
          Object.entries(value).filter(([key]) => !["commandId", "operationsCommandId"].includes(key)),
        );
        if (!isDeepStrictEqual(withoutCommandBinding(verified), withoutCommandBinding(decision))) {
          throw new Error("Completion review decision changed after authorization.");
        }
        return decision;
      },
      render_approved: async (context) => promoteReviewedArtifactSet({
        ...context,
        job: await store.getJob(policy.jobId, context.artifactReadAuthority),
      }),
      ...externalHandlers,
    }),
    clock,
    tokenFactory: options.tokenFactory || (() => `completion_${randomUUID()}`),
    retryPolicy: RETRY_POLICY,
  });

  return Object.freeze({
    fulfillmentStore: store,
    fulfillmentOrchestrator: restrictOrchestratorToSyntheticJob(orchestrator, policy.jobId),
    async authorizeReviewDecision(request) {
      if (request.jobId !== policy.jobId || request.decisionType !== "content" || request.outcome !== "approved") {
        throw new Error("Completion review authority is restricted to the synthetic content approval.");
      }
      const job = await store.getJob(policy.jobId);
      assertSyntheticJob(job, policy.jobId);
      if (job.version !== request.expectedVersion) {
        throw new Error("Completion review command is stale.");
      }
      const verified = await verifyApproval({
        job,
        decision: { approvalId: policy.approvalId },
      });
      assertApprovalCommandBinding(request, verified, job);
      return Object.freeze({
        ...verified,
        commandId: request.commandId,
        operationsCommandId: request.commandId,
      });
    },
  });
}

function restrictStoreToSyntheticJob(store, jobId) {
  const methods = [
    "getJob", "getReviewApproval", "recordReviewDecision", "claimStage", "markExternalEffectStarted",
    "fenceExternalEffect", "completeStage", "failStage", "resumeRetry", "queueDelivery",
    "confirmDelivery", "reconcileDelivery",
  ];
  return Object.freeze(Object.fromEntries(methods.map((name) => [name, (...args) => {
    if (name !== "getReviewApproval" && args[0] !== jobId) {
      throw new Error("Completion store access is restricted to the exact synthetic job.");
    }
    return store[name](...args);
  }])));
}

function restrictOrchestratorToSyntheticJob(orchestrator, jobId) {
  const methods = ["status", "recordReviewDecision", "runExpectedStage", "queueDelivery", "resumeRetry"];
  return Object.freeze(Object.fromEntries(methods.map((name) => [name, (candidateJobId, ...args) => {
    if (candidateJobId !== jobId) {
      throw new Error("Completion orchestration is restricted to the exact synthetic job.");
    }
    return orchestrator[name](candidateJobId, ...args);
  }])));
}

export function promoteReviewedArtifactSet(context) {
  assertSyntheticJob(context?.job, TEST_A_COMPLETION_JOB_ID);
  const contentDecision = [...(context.job.reviewDecisions || [])].reverse().find((decision) => (
    decision.decisionType === "content" && decision.revisionId === context.job.currentRevisionId
  ));
  if (contentDecision?.outcome !== "approved") {
    throw new Error("Only the authenticated approved private bundle may be promoted.");
  }
  const source = [...(context.job.artifactSets || [])].reverse().find((artifact) => (
    artifact.kind === "private_review" && artifact.revisionId === context.job.currentRevisionId
  ));
  if (!source || source.assetManifestDigest !== contentDecision.artifactDigests?.assetManifestDigest) {
    throw new Error("Approved private artifact binding is unavailable.");
  }
  const previewPaths = source.files.filter((file) => file.path.startsWith("private-preview/"));
  const slug = previewPaths[0]?.path.split("/")[1];
  if (!slug || previewPaths.some((file) => !file.path.startsWith(`private-preview/${slug}/`))) {
    throw new Error("Approved private preview has no single deployable namespace.");
  }
  const files = previewPaths.map((file) => Object.freeze({
    ...file,
    path: `deploy/${file.path.slice(`private-preview/${slug}/`.length)}`,
  }));
  const manifest = {
    schemaVersion: "1.0",
    kind: "prepared_bundle",
    revisionId: source.revisionId,
    files,
  };
  const assetManifestDigest = sha256(`${JSON.stringify(manifest, null, 2)}\n`);
  const artifactSet = {
    artifactSetId: `artifacts_${sha256([
      context.job.jobId,
      source.revisionId,
      "prepared_bundle",
      source.pageDigest,
      source.transcriptDigest,
      assetManifestDigest,
    ].join("\0")).slice(0, 24)}`,
    kind: "prepared_bundle",
    revisionId: source.revisionId,
    pageDigest: source.pageDigest,
    transcriptDigest: source.transcriptDigest,
    assetManifestDigest,
    manifestRef: `jobs/${context.job.jobId}/revisions/${source.revisionId}/manifests/prepared_bundle.json`,
    files,
  };
  return { artifactSet };
}

export function createHostedCompletionArtifactResolver(options = {}) {
  const fetchImpl = options.fetch;
  const siteOrigin = options.siteOrigin;
  const backendToken = options.backendToken;
  const jobId = options.jobId;
  if (typeof fetchImpl !== "function" || jobId !== TEST_A_COMPLETION_JOB_ID) {
    throw new Error("Hosted completion artifact resolver is not configured.");
  }
  return Object.freeze({
    async resolve(request) {
      assertSyntheticRequest(request, jobId);
      const authority = requireArtifactReadAuthority(request.artifactReadAuthority);
      const manifest = {
        schemaVersion: "1.0",
        kind: "prepared_bundle",
        revisionId: request.revisionId,
        files: request.artifactSet.files,
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      if (sha256(manifestBytes) !== request.artifactManifestDigest) {
        throw new Error("Completion publication manifest digest changed.");
      }
      const files = [];
      for (const file of request.artifactSet.files) {
        if (!file.path.startsWith("deploy/")) continue;
        const url = new URL("/completion/artifact", siteOrigin);
        for (const [name, value] of Object.entries({
          jobId,
          revisionId: request.revisionId,
          storageId: file.storageId,
        })) url.searchParams.set(name, value);
        const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${backendToken}`,
            "x-bebebonjour-worker-id": authority.workerId,
            "x-bebebonjour-command-id": authority.commandId,
            "x-bebebonjour-lease-token": authority.leaseToken,
          },
          redirect: "error",
        });
        if (!response.ok
            || response.headers.get("cache-control") !== "private, no-store"
            || response.headers.get("content-type") !== "application/octet-stream") {
          throw new Error("Bound completion artifact is unavailable or not private.");
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
          throw new Error("Bound completion artifact bytes changed.");
        }
        files.push(Object.freeze({
          sourcePath: file.path,
          publicPath: file.path.slice("deploy/".length),
          sha256: file.sha256,
          bytes,
        }));
      }
      const entrypointPath = ["fr/index.html", "ar/index.html", "index.html"]
        .find((candidate) => files.some((file) => file.publicPath === candidate));
      if (!entrypointPath || files.length === 0) {
        throw new Error("Bound completion artifact has no private publication entrypoint.");
      }
      return Object.freeze({ manifestBytes, entrypointPath, files: Object.freeze(files) });
    },
  });
}

function assertApprovalCommandBinding(request, verified, job) {
  const source = [...(job.artifactSets || [])].reverse().find((artifact) => (
    artifact.kind === "private_review" && artifact.revisionId === job.currentRevisionId
  ));
  if (
    verified.revisionId !== request.payload?.revisionId
    || verified.revisionId !== job.currentRevisionId
    || request.payload?.artifactManifestDigest !== source?.assetManifestDigest
    || !isDeepStrictEqual(request.payload?.artifactDigests, verified.artifactDigests)
  ) {
    throw new Error("Completion review command does not bind the signed revision and digests.");
  }
}

function assertSyntheticRequest(request, jobId) {
  if (request?.jobId !== jobId || request.environment !== "test"
      || request.product !== "announcement-page" || request.artifactSet?.kind !== "prepared_bundle") {
    throw new Error("Completion provider request is not the exact synthetic TEST-A identity.");
  }
}

function assertSyntheticJob(job, jobId) {
  if (!job || job.jobId !== jobId || job.environment !== "test" || job.product !== "announcement-page") {
    throw new Error("Completion authority rejected non-synthetic job data.");
  }
}

function requireCompletionIdentity(environment, buildInspection) {
  for (const [name, expected] of [
    ["TEST_A_PUBLICATION_VERCEL_TEAM_ID", buildInspection.teamId],
    ["TEST_A_PUBLICATION_VERCEL_PROJECT_ID", buildInspection.projectId],
    ["TEST_A_PUBLICATION_VERCEL_PROJECT_NAME", buildInspection.projectName],
  ]) {
    if (requiredString(environment, name) !== expected) {
      throw new Error(`${name} does not match the authoritative Vercel inspection.`);
    }
  }
  return Object.freeze({
    resendFrom: requiredString(environment, "RESEND_FROM"),
    publication: Object.freeze({
      stableOrigin: exactHttpsOrigin(environment.TEST_A_PUBLICATION_ORIGIN),
      teamId: buildInspection.teamId,
      projectId: buildInspection.projectId,
      projectName: buildInspection.projectName,
    }),
  });
}

function requireArtifactReadAuthority(value) {
  if (!value || value.workerId !== "test-a-completion-worker") {
    throw new Error("Artifact reads require an active completion command claim.");
  }
  for (const name of ["commandId", "leaseToken"]) {
    if (typeof value[name] !== "string" || value[name].trim() === "") {
      throw new Error("Artifact reads require an active completion command claim.");
    }
  }
  return value;
}

function exactHttpsOrigin(value) {
  const exact = requiredString({ value }, "value");
  const url = new URL(exact);
  if (url.protocol !== "https:" || url.origin !== exact || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TEST-A publication origin must be an exact HTTPS origin.");
  }
  return exact;
}

function convexSiteOrigin(convexUrl) {
  const url = new URL(convexUrl);
  if (!url.hostname.endsWith(".convex.cloud")) {
    throw new Error("Completion artifact origin requires a canonical Convex deployment URL.");
  }
  url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return url.origin;
}

function requiredString(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  return value.trim();
}

function requiredSecret(environment, name, minimumBytes) {
  const value = requiredString(environment, name);
  if (Buffer.byteLength(value, "utf8") < minimumBytes) throw new Error(`${name} is invalid.`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
