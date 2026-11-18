import { createHash, randomUUID } from "node:crypto";

import { createExactRevisionPublicationAdapter } from "./exact-revision-publication-adapter.mjs";
import { createExternalEffectStageHandlers } from "./external-effect-stage-handlers.mjs";
import { createFulfillmentOrchestrator } from "./job-orchestrator.mjs";
import { createCloudflareDeliveryAdapter } from "./cloudflare-delivery-adapter.mjs";
import { cloudflareConfig } from "../delivery-loop/cloudflare-runtime.mjs";
import {
  createVercelTestAPublicationProvider,
  parseAuthoritativeVercelBuildInspection,
} from "./vercel-test-a-publication-provider.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";
import {
  OWNER_COMPLETION_ACTIONS,
  OWNER_COMPLETION_AUDIO_BYTES,
  OWNER_COMPLETION_INITIAL_VERSION,
  OWNER_COMPLETION_JOB_ID,
  OWNER_COMPLETION_MANIFEST_DIGEST,
  OWNER_COMPLETION_NARRATION_DECISION_ID,
  OWNER_COMPLETION_REVISION_ID,
  OWNER_DELIVERY_EMAIL,
  OWNER_PUBLICATION_PROJECT_NAME,
} from "../operations/owner-completion-policy.mjs";

const OWNER_TARGET_REF = "cloudflare:owner:z-at-havesomecode";
const ALLOWED_STATES = new Set([
  "publish_ready", "publishing", "published", "delivery_queued", "sending", "sent", "complete",
  "failed", "reconciliation_required",
]);
const NO_AUTOMATIC_RETRY_POLICY = Object.freeze({
  leaseMsByStage: Object.freeze({ publish: 300_000, deliver: 300_000 }),
  maxAttemptsByStage: Object.freeze({ publish: 1, deliver: 1 }),
  backoffMsByStage: Object.freeze({ publish: Object.freeze([]), deliver: Object.freeze([]) }),
});

export async function createOwnerCompletionCapabilities(options = {}) {
  const environment = options.environment || process.env;
  const client = options.client;
  const policy = options.policy;
  if (policy?.jobId !== OWNER_COMPLETION_JOB_ID
      || JSON.stringify(policy.actions) !== JSON.stringify(OWNER_COMPLETION_ACTIONS)
      || !client?.query || !client?.mutation) {
    throw new Error("Owner completion capabilities require the exact owner worker policy and Convex client.");
  }
  const completionToken = requiredSecret(environment, "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN", 32);
  const unrestrictedStore = options.fulfillmentStore || createConvexFulfillmentStore({
    client,
    authorization: { completionToken, jobId: policy.jobId },
    functions: {
      getJob: "fulfillment:getCompletionJob",
      getReviewApproval: "fulfillment:getCompletionReviewApproval",
      replaceJob: "fulfillment:replaceCompletionJob",
    },
  });
  const store = restrictStoreToOwnerJob(unrestrictedStore);
  const initialJob = assertOwnerCompletionJob(await store.getJob(policy.jobId));
  const buildInspection = parseAuthoritativeVercelBuildInspection(
    Buffer.from(requiredString(environment, "OWNER_VERCEL_BUILD_INSPECTION_B64"), "base64"),
  );
  if (buildInspection.revisionId !== OWNER_COMPLETION_REVISION_ID) {
    throw new Error("Authoritative Vercel inspection does not bind the exact owner revision.");
  }
  const identity = requireOwnerIdentity(environment, buildInspection);
  const fetchImpl = options.fetch || globalThis.fetch;
  const artifactResolver = createOwnerCompletionArtifactResolver({
    fetch: fetchImpl,
    siteOrigin: convexSiteOrigin(environment.CONVEX_URL),
    completionToken,
    expectedAudioSha256: policy.audioSha256,
  });
  const publicationProvider = createVercelTestAPublicationProvider({
    token: requiredString(environment, "VERCEL_TOKEN"),
    buildInspection,
    teamId: identity.teamId,
    projectId: identity.projectId,
    projectName: identity.projectName,
    stableOrigin: identity.stableOrigin,
    canaryJobId: OWNER_COMPLETION_JOB_ID,
    canaryRevisionId: OWNER_COMPLETION_REVISION_ID,
    requireExistingAliasProject: true,
    requirePrivateDeploymentProtection: false,
    artifactResolver,
    fetch: fetchImpl,
  });
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter: createExactRevisionPublicationAdapter({
      provider: options.publicationProvider || publicationProvider,
      stableOrigin: identity.stableOrigin,
    }),
    deliveryAdapter: createCloudflareDeliveryAdapter({ environment, config: cloudflareConfig(environment),
      fetch: options.fetch, clock: options.clock, policy: { jobId: OWNER_COMPLETION_JOB_ID,
        revisionId: OWNER_COMPLETION_REVISION_ID, artifactManifestDigest: OWNER_COMPLETION_MANIFEST_DIGEST,
        targetRef: OWNER_TARGET_REF, recipient: OWNER_DELIVERY_EMAIL,
        stableUrl: `${identity.stableOrigin}/announcements/${OWNER_COMPLETION_JOB_ID}` } }),
    resolveDeliveryTarget: async (job) => {
      assertOwnerCompletionJob(job);
      return Object.freeze({ targetRef: OWNER_TARGET_REF, email: OWNER_DELIVERY_EMAIL });
    },
  });
  const orchestrator = createFulfillmentOrchestrator({
    store,
    handlers: externalHandlers,
    clock: options.clock || (() => new Date().toISOString()),
    tokenFactory: options.tokenFactory || (() => `owner_completion_${randomUUID()}`),
    retryPolicy: NO_AUTOMATIC_RETRY_POLICY,
  });
  return Object.freeze({
    fulfillmentStore: store,
    fulfillmentOrchestrator: restrictOrchestratorToOwnerJob(orchestrator),
  });
}

export function assertOwnerCompletionJob(job) {
  const artifact = [...(job?.artifactSets || [])].reverse().find((entry) => (
    entry?.kind === "narration_review" && entry.revisionId === OWNER_COMPLETION_REVISION_ID
  ));
  const decision = [...(job?.reviewDecisions || [])].reverse().find((entry) => (
    entry?.decisionId === OWNER_COMPLETION_NARRATION_DECISION_ID
  ));
  const audioFiles = (artifact?.files || []).filter((file) => (
    typeof file?.path === "string" && file.path.startsWith("artifacts/audio/") && file.path.endsWith(".mp3")
  ));
  if (!job
      || job.jobId !== OWNER_COMPLETION_JOB_ID
      || job.environment !== "test"
      || job.product !== "announcement-page"
      || job.narrationRequired !== true
      || job.currentRevisionId !== OWNER_COMPLETION_REVISION_ID
      || !Number.isInteger(job.version)
      || job.version < OWNER_COMPLETION_INITIAL_VERSION
      || !ALLOWED_STATES.has(job.state)
      || artifact?.assetManifestDigest !== OWNER_COMPLETION_MANIFEST_DIGEST
      || decision?.decisionType !== "narration"
      || decision.revisionId !== OWNER_COMPLETION_REVISION_ID
      || decision.outcome !== "approved"
      || decision.artifactDigests?.assetManifestDigest !== OWNER_COMPLETION_MANIFEST_DIGEST
      || audioFiles.length !== 1
      || audioFiles[0].bytes !== OWNER_COMPLETION_AUDIO_BYTES
      || !/^48387158[a-f0-9]{53}58c$/u.test(audioFiles[0].sha256 || "")) {
    throw new Error("Owner completion rejected data outside the exact approved narrated release.");
  }
  return job;
}

export function createOwnerCompletionArtifactResolver(options = {}) {
  const fetchImpl = options.fetch;
  const siteOrigin = exactHttpsOrigin(options.siteOrigin, "Owner Convex site origin");
  const completionToken = requiredValue(options.completionToken, "Owner completion token");
  const expectedAudioSha256 = requiredValue(options.expectedAudioSha256, "Approved owner audio digest");
  const expectedManifestDigest = options.expectedManifestDigest || OWNER_COMPLETION_MANIFEST_DIGEST;
  if (typeof fetchImpl !== "function"
      || !/^[a-f0-9]{64}$/u.test(expectedAudioSha256)
      || !/^[a-f0-9]{64}$/u.test(expectedManifestDigest)) {
    throw new Error("Owner completion artifact resolver is not configured.");
  }
  return Object.freeze({
    async resolve(request) {
      assertOwnerProviderRequest(request, expectedAudioSha256, expectedManifestDigest);
      const manifestBytes = ownerManifestBytes(request.artifactSet);
      if (sha256(manifestBytes) !== expectedManifestDigest) {
        throw new Error("Owner publication manifest bytes changed from the exact approved manifest.");
      }
      const authority = requireArtifactReadAuthority(request.artifactReadAuthority);
      const selected = [];
      const seenPaths = new Set();
      for (const file of request.artifactSet.files) {
        const publicPath = publicPathFor(file.path);
        if (publicPath === null) continue;
        if (!safePublicPath(publicPath) || seenPaths.has(publicPath)) {
          throw new Error("Owner publication contains an unsafe or duplicate public path.");
        }
        seenPaths.add(publicPath);
        const url = new URL("/completion/artifact", siteOrigin);
        for (const [name, value] of Object.entries({
          jobId: OWNER_COMPLETION_JOB_ID,
          revisionId: OWNER_COMPLETION_REVISION_ID,
          storageId: file.storageId,
        })) url.searchParams.set(name, value);
        const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${completionToken}`,
            "x-bebebonjour-worker-id": authority.workerId,
            "x-bebebonjour-command-id": authority.commandId,
            "x-bebebonjour-lease-token": authority.leaseToken,
          },
          redirect: "error",
        });
        if (!response.ok
            || response.headers.get("cache-control") !== "private, no-store"
            || response.headers.get("content-type") !== "application/octet-stream") {
          throw new Error("Bound owner completion artifact is unavailable or not private.");
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
          throw new Error("Bound owner completion artifact bytes changed.");
        }
        selected.push(Object.freeze({ sourcePath: file.path, publicPath, sha256: file.sha256, bytes }));
      }
      const entrypointPath = ["fr/index.html", "ar/index.html", "index.html"]
        .find((candidate) => selected.some((file) => file.publicPath === candidate));
      const audio = selected.filter((file) => file.publicPath.startsWith("audio/") && file.publicPath.endsWith(".mp3"));
      if (entrypointPath !== "fr/index.html" || audio.length !== 1
          || audio[0].publicPath !== "audio/fr/intro.mp3"
          || audio[0].bytes.length !== OWNER_COMPLETION_AUDIO_BYTES
          || audio[0].sha256 !== expectedAudioSha256) {
        throw new Error("Owner publication must contain the exact approved page and audio bytes.");
      }
      const shellBytes = ownerPlayableEntrypointBytes(entrypointPath, audio[0].publicPath);
      selected.push(Object.freeze({
        sourcePath: "generated/owner-playable-entrypoint.html",
        publicPath: "index.html",
        sha256: sha256(shellBytes),
        bytes: shellBytes,
      }));
      return Object.freeze({
        manifestBytes,
        entrypointPath: "index.html",
        files: Object.freeze(selected),
      });
    },
  });
}

function assertOwnerProviderRequest(request, expectedAudioSha256, expectedManifestDigest) {
  const audio = request?.artifactSet?.files?.filter((file) => (
    file.path?.startsWith("artifacts/audio/") && file.path.endsWith(".mp3")
  ));
  if (request?.jobId !== OWNER_COMPLETION_JOB_ID
      || request.environment !== "test"
      || request.product !== "announcement-page"
      || request.revisionId !== OWNER_COMPLETION_REVISION_ID
      || request.artifactManifestDigest !== expectedManifestDigest
      || request.artifactSet?.kind !== "narration_review"
      || request.artifactSet.revisionId !== OWNER_COMPLETION_REVISION_ID
      || request.artifactSet.assetManifestDigest !== expectedManifestDigest
      || audio?.length !== 1
      || audio[0].bytes !== OWNER_COMPLETION_AUDIO_BYTES
      || audio[0].sha256 !== expectedAudioSha256) {
    throw new Error("Completion provider request is not the exact approved owner release.");
  }
}

function ownerManifestBytes(artifactSet) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: "1.0",
    kind: artifactSet.kind,
    revisionId: artifactSet.revisionId,
    files: artifactSet.files.map(({ path, storageId, bytes, sha256 }) => ({ path, storageId, bytes, sha256 })),
  }, null, 2)}\n`, "utf8");
}

function ownerPlayableEntrypointBytes(pagePath, audioPath) {
  return Buffer.from(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bébé Bonjour — Votre annonce</title>
  <style>
    :root { color-scheme: light; font-family: Georgia, "Times New Roman", serif; background: #f5f0e7; color: #20241f; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; grid-template-rows: 1fr auto; }
    iframe { width: 100%; min-height: calc(100vh - 7.5rem); border: 0; background: #f5f0e7; }
    footer { position: sticky; bottom: 0; padding: 1rem clamp(1rem, 4vw, 3rem); border-top: 1px solid #c9c0af; background: #f5f0e7; }
    p { margin: 0 0 .6rem; font-size: .9rem; color: #4b5548; }
    audio { display: block; width: 100%; }
  </style>
</head>
<body>
  <iframe title="Annonce Bébé Bonjour" src="./${pagePath}"></iframe>
  <footer>
    <p>Écouter l’annonce</p>
    <audio controls preload="metadata" src="./${audioPath}"></audio>
  </footer>
</body>
</html>
`, "utf8");
}

function publicPathFor(sourcePath) {
  if (sourcePath.startsWith("deploy/")) return sourcePath.slice("deploy/".length);
  if (sourcePath.startsWith("artifacts/audio/")) return `audio/${sourcePath.slice("artifacts/audio/".length)}`;
  return null;
}

function safePublicPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function restrictStoreToOwnerJob(store) {
  const methods = [
    "getJob", "claimStage", "markExternalEffectStarted", "fenceExternalEffect", "completeStage",
    "failStage", "queueDelivery", "confirmDelivery", "reconcileDelivery",
  ];
  return Object.freeze(Object.fromEntries(methods.map((name) => [name, async (...args) => {
    if (args[0] !== OWNER_COMPLETION_JOB_ID) throw new Error("Owner completion store is restricted to the exact job.");
    const result = await store[name](...args);
    if (name === "getJob") assertOwnerCompletionJob(result);
    else if (result?.aggregate) assertOwnerCompletionJob(result.aggregate);
    else if (result?.jobId) assertOwnerCompletionJob(result);
    return result;
  }])));
}

function restrictOrchestratorToOwnerJob(orchestrator) {
  const methods = ["status", "runExpectedStage", "queueDelivery"];
  return Object.freeze(Object.fromEntries(methods.map((name) => [name, (jobId, ...args) => {
    if (jobId !== OWNER_COMPLETION_JOB_ID) throw new Error("Owner completion orchestration is restricted to the exact job.");
    return orchestrator[name](jobId, ...args);
  }])));
}

function requireOwnerIdentity(environment, inspection) {
  const values = {
    teamId: requiredString(environment, "OWNER_PUBLICATION_VERCEL_TEAM_ID"),
    projectId: requiredString(environment, "OWNER_PUBLICATION_VERCEL_PROJECT_ID"),
    projectName: requiredString(environment, "OWNER_PUBLICATION_VERCEL_PROJECT_NAME"),
    stableOrigin: exactHttpsOrigin(environment.OWNER_PUBLICATION_ORIGIN, "Owner publication origin"),
  };
  if (values.teamId !== inspection.teamId || values.projectId !== inspection.projectId
      || values.projectName !== inspection.projectName || values.projectName !== OWNER_PUBLICATION_PROJECT_NAME) {
    throw new Error("Owner publication identity does not match authoritative Vercel inspection.");
  }
  return Object.freeze(values);
}

function requireArtifactReadAuthority(value) {
  if (!value || value.workerId !== "owner-completion-worker") {
    throw new Error("Owner artifact reads require an active exact command claim.");
  }
  for (const name of ["commandId", "leaseToken"]) requiredValue(value[name], `Owner artifact ${name}`);
  return value;
}

function convexSiteOrigin(convexUrl) {
  const url = new URL(convexUrl);
  if (!url.hostname.endsWith(".convex.cloud")) throw new Error("Owner artifact origin requires a canonical Convex URL.");
  url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return url.origin;
}

function exactHttpsOrigin(value, label) {
  const exact = requiredValue(value, label);
  const url = new URL(exact);
  if (url.protocol !== "https:" || url.origin !== exact || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an exact HTTPS origin.`);
  }
  return exact;
}

function requiredString(environment, name) {
  return requiredValue(environment?.[name], name);
}
function requiredValue(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
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
