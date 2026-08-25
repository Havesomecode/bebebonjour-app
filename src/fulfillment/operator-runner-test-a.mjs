import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { createExactRevisionPublicationAdapter } from "./exact-revision-publication-adapter.mjs";
import { createExternalEffectStageHandlers } from "./external-effect-stage-handlers.mjs";
import { recordReviewDecisionTransition } from "./job-machine.mjs";
import { createFulfillmentOrchestrator } from "./job-orchestrator.mjs";
import {
  createPersistedReviewDecisionVerifier,
} from "./persisted-review-decision.mjs";
import { createLocalArtifactResolver } from "./local-artifact-resolver.mjs";
import { createResendDeliveryAdapter } from "./resend-delivery-adapter.mjs";
import { createVercelTestAPublicationProvider } from "./vercel-test-a-publication-provider.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";

const TEST_SINK = "delivered@resend.dev";
const STAGES = Object.freeze(["prepare_review", "render_approved", "generate_tts", "publish", "deliver"]);
const DEFAULT_RETRY_POLICY = Object.freeze({
  leaseMsByStage: Object.freeze(Object.fromEntries(STAGES.map((stage) => [stage, 300_000]))),
  maxAttemptsByStage: Object.freeze(Object.fromEntries(STAGES.map((stage) => [stage, 2]))),
  backoffMsByStage: Object.freeze(Object.fromEntries(STAGES.map((stage) => [stage, Object.freeze([60_000])]))),
});

export function createTestAOperatorRunner(options = {}) {
  const environment = options.environment || process.env;
  const hmacKey = requiredSecret(environment, "BEBEBONJOUR_APPROVAL_HMAC_KEY", 32);
  const resendApiKey = requiredString(environment, "RESEND_API_KEY");
  if (!resendApiKey.startsWith("re_")) throw new Error("RESEND_API_KEY must be a Resend API key.");
  const resendFrom = requiredString(environment, "RESEND_FROM");
  const publicationOrigin = requiredHttpsOrigin(environment, "TEST_A_PUBLICATION_ORIGIN");
  const clock = options.clock || (() => new Date().toISOString());
  const tokenFactory = options.tokenFactory || (() => `operator_${randomUUID()}`);
  const store = options.store || createHostedStore(options, environment);
  for (const method of ["getJob", "getReviewApproval", "saveReviewApproval"]) {
    if (typeof store?.[method] !== "function") {
      throw new Error(`The TEST-A fulfillment store must implement ${method}().`);
    }
  }

  const publicationProvider = options.publicationProvider || createHostedPublicationProvider(environment);
  const publicationAdapter = createExactRevisionPublicationAdapter({
    provider: publicationProvider,
    stableOrigin: publicationOrigin,
  });
  const deliveryAdapter = createResendDeliveryAdapter({
    apiKey: resendApiKey,
    from: resendFrom,
    resend: options.resend,
    clock,
  });
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter,
    deliveryAdapter,
    resolveDeliveryTarget: async () => ({
      targetRef: "resend:test-a-sink",
      email: TEST_SINK,
    }),
  });
  const verifyPersistedReview = createPersistedReviewDecisionVerifier({
    approvalStore: store,
    fulfillmentStore: store,
    hmacKey,
  });
  const handlers = {
    ...(options.stageHandlers || {}),
    ...externalHandlers,
    verify_review_decision: verifyPersistedReview,
  };
  const orchestrator = createFulfillmentOrchestrator({
    store,
    handlers,
    clock,
    tokenFactory,
    retryPolicy: options.retryPolicy || DEFAULT_RETRY_POLICY,
  });

  return Object.freeze({
    status(jobId) {
      return orchestrator.status(jobId);
    },

    async persistAndRecordReview(jobId, approval) {
      const job = await orchestrator.status(jobId);
      if (!approval?.approvalId || !approval?.signature || !approval?.decision) {
        throw new Error("A signed persisted review approval is required.");
      }
      const verifyCandidate = createPersistedReviewDecisionVerifier({
        hmacKey,
        fulfillmentStore: store,
        approvalStore: {
          async getReviewApproval(approvalId) {
            return approvalId === approval.approvalId ? structuredClone(approval) : null;
          },
        },
      });
      const verified = await verifyCandidate({
        job,
        decision: { approvalId: approval.approvalId },
      });
      const aggregate = await store.getJob(jobId);
      recordReviewDecisionTransition(structuredClone(aggregate), verified, clock());
      const persisted = await store.saveReviewApproval(approval);
      if (!isDeepStrictEqual(persisted, approval)) {
        throw new Error("Persisted human review approval does not match the exact signed decision.");
      }
      return orchestrator.recordReviewDecision(jobId, { approvalId: approval.approvalId });
    },

    runNext(jobId) {
      return orchestrator.runNext(jobId);
    },

    async queueDelivery(jobId) {
      const job = await orchestrator.status(jobId);
      if (job.environment !== "test" || job.product !== "announcement-page") {
        throw new Error("TEST-A delivery is restricted to the test announcement product.");
      }
      return orchestrator.queueDelivery(jobId, {
        commandId: `operator:queue-delivery:${jobId}:${job.currentRevisionId}`,
      });
    },

    reconcileDelivery(jobId) {
      return orchestrator.reconcileDelivery(jobId, {
        commandId: `operator:reconcile-delivery:${jobId}`,
      });
    },
  });
}

function createHostedStore(options, environment) {
  const convexUrl = requiredHttpsOrigin(environment, "CONVEX_URL");
  const backendToken = requiredSecret(environment, "CUSTOMER_FLOW_BACKEND_TOKEN", 32);
  const client = options.convexClient || new ConvexHttpClient(convexUrl);
  return createConvexFulfillmentStore({ client, backendToken });
}

function createHostedPublicationProvider(environment) {
  return createVercelTestAPublicationProvider({
    token: requiredString(environment, "VERCEL_TOKEN"),
    teamId: requiredString(environment, "TEST_A_PUBLICATION_VERCEL_TEAM_ID"),
    projectId: requiredString(environment, "TEST_A_PUBLICATION_VERCEL_PROJECT_ID"),
    projectName: requiredString(environment, "TEST_A_PUBLICATION_VERCEL_PROJECT_NAME"),
    stableOrigin: requiredHttpsOrigin(environment, "TEST_A_PUBLICATION_ORIGIN"),
    canaryJobId: requiredString(environment, "TEST_A_PUBLICATION_CANARY_JOB_ID"),
    canaryRevisionId: requiredString(environment, "TEST_A_PUBLICATION_CANARY_REVISION_ID"),
    artifactResolver: createLocalArtifactResolver({
      rootPath: requiredString(environment, "TEST_A_ARTIFACT_ROOT"),
    }),
  });
}

function requiredString(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  return value.trim();
}

function requiredSecret(environment, name, minimumBytes) {
  const value = requiredString(environment, name);
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes.`);
  }
  return value;
}

function requiredHttpsOrigin(environment, name) {
  const value = requiredString(environment, name);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return url.origin;
}
