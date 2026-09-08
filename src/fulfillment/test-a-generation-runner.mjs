import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { ConvexHttpClient } from "convex/browser";

import { createFulfillmentOrchestrator } from "./job-orchestrator.mjs";
import { TEST_A_PREPARE_REVIEW_RETRY_POLICY } from "./test-a-generation-policy.mjs";
import { createLocalGenerationWorkspace } from "./local-generation-workspace.mjs";
import { OperationsCommandError } from "../operations/operations-command-error.mjs";
import { createLocalPrepareReviewStageHandler } from "./local-prepare-review-stage-handler.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";
import { assertValidJobScopedEditorialApproval } from "../../scripts/lib/schema-validation.mjs";
import { RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID } from "./job-machine.mjs";

const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_REASON = /^[a-z0-9_]{1,64}$/u;

export const TEST_A_GENERATION_RETRY_POLICY = Object.freeze({
  leaseMsByStage: Object.freeze({ prepare_review: TEST_A_PREPARE_REVIEW_RETRY_POLICY.leaseMs }),
  maxAttemptsByStage: Object.freeze({ prepare_review: TEST_A_PREPARE_REVIEW_RETRY_POLICY.maxAttempts }),
  backoffMsByStage: Object.freeze({ prepare_review: TEST_A_PREPARE_REVIEW_RETRY_POLICY.backoffMs }),
});

export function createTestAGenerationRunner(options = {}) {
  const editorialApproval = requireEditorialApproval(options.editorialApproval);
  const environment = options.environment || process.env;
  const hosted = options.customerReader && options.store
    ? null
    : createHostedResources(options, environment);
  const customerReader = options.customerReader || hosted.customerReader;
  const store = restrictGenerationStore(options.store || hosted.store);
  const workspace = options.workspace || createLocalGenerationWorkspace({
    rootPath: requiredString(options.artifactRoot, "generation_artifact_root_rejected"),
  });
  const prepareReview = options.prepareReview || createLocalPrepareReviewStageHandler({
    resolveJobPaths: workspace.resolveJobPaths,
    collectArtifactSet: workspace.collectArtifactSet,
    cleanupStageOutput: workspace.cleanupStageOutput,
    compose: options.compose,
    prepareReview: options.prepareReviewCommand,
  });

  if (typeof customerReader?.readJob !== "function") {
    throw safeError("generation_configuration_rejected");
  }
  if (typeof store?.getJob !== "function") {
    throw safeError("generation_configuration_rejected");
  }
  if (typeof workspace?.persistJobInput !== "function" || typeof prepareReview !== "function") {
    throw safeError("generation_configuration_rejected");
  }
  const clock = options.clock || (() => new Date().toISOString());

  const orchestrator = createFulfillmentOrchestrator({
    store,
    handlers: Object.freeze({ prepare_review: prepareReview }),
    clock,
    tokenFactory: options.tokenFactory || (() => `generation_${randomUUID()}`),
    retryPolicy: options.retryPolicy || TEST_A_GENERATION_RETRY_POLICY,
  });

  return Object.freeze({
    async generate(jobId, generationOptions = {}) {
      try {
        return await generate(jobId, generationOptions);
      } catch (error) {
        if (
          error instanceof TestAGenerationOperatorError
          || (error instanceof OperationsCommandError && error.reasonCode === "active_claim_expired")
        ) {
          throw error;
        }
        throw safeError("generation_backend_failed");
      }
    },
  });

  async function generate(jobId, generationOptions) {
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
      throw safeError("generation_authority_rejected");
    }
    if (editorialApproval.record.jobId !== jobId) {
      throw safeError("generation_approval_rejected");
    }
    let fulfillment = await store.getJob(jobId);
    const customer = await customerReader.readJob(jobId);
    assertCanonicalAuthority({ customer, fulfillment, jobId });

    if (fulfillment.state === "failed") {
      if (jobId !== RECOVERABLE_FAILED_PREPARE_REVIEW_JOB_ID) {
        throw safeError("generation_authority_rejected");
      }
      const failedAttempt = fulfillment.stageAttempts?.at(-1);
      fulfillment = await store.recoverFailedPrepareReview(jobId, {
        commandId: `recover-failed-prepare-review:${jobId}:${failedAttempt?.attemptId || "missing"}`,
        jobId,
        failedAttemptId: failedAttempt?.attemptId,
        intakeDigest: fulfillment.intakeDigest,
        paymentCorrelation: fulfillment.paymentCorrelation,
        editorialApproval: {
          approvalType: editorialApproval.record.approvalType,
          jobId: editorialApproval.record.jobId,
          policy: editorialApproval.record.policy,
          record: editorialApproval.record,
          recordDigest: editorialApproval.recordDigest,
          sourceDigest: editorialApproval.record.sourceDigest,
          intakeDigest: fulfillment.intakeDigest,
        },
      }, clock());
      assertCanonicalAuthority({ customer, fulfillment, jobId });
    }

    if (fulfillment.state === "content_review_required") {
      const expectedArtifactSet = assertGeneratedAggregate(fulfillment);
      let validation;
      try {
        if (typeof workspace.validateGeneratedReplay !== "function") {
          throw new Error("Terminal replay validation is unavailable.");
        }
        validation = await workspace.validateGeneratedReplay({
          job: fulfillment,
          intake: customer.intake,
          editorialApproval,
          expectedArtifactSet,
        });
      } catch {
        throw safeError("generation_authority_rejected");
      }
      if (validation?.approvalMatches === false) {
        throw safeError("generation_approval_rejected");
      }
      if (validation?.approvalMatches !== true) {
        throw safeError("generation_authority_rejected");
      }
      return resultFor(fulfillment, "already_generated");
    }
    if (!isEligibleGenerationState(fulfillment)) {
      throw safeError("generation_authority_rejected");
    }

    try {
      await workspace.persistJobInput({
        jobId,
        intakeDigest: customer.intakeDigest,
        intake: customer.intake,
        editorialApproval,
        requireExisting: (fulfillment.stageAttempts?.length || 0) > 0,
      });
    } catch {
      throw safeError("generation_authority_rejected");
    }
    const status = await orchestrator.runExpectedStage(jobId, "prepare_review", generationOptions);
    if (status?.state === "content_review_required") {
      return resultFor(status, "generated");
    }
    if (status?.state === "retry_wait" && status.retry?.stage === "prepare_review") {
      const latestAttempt = status.stageAttempts.at(-1);
      return {
        ...resultFor(status, "retry_pending"),
        reasonCode: safeReasonCode(latestAttempt?.failure?.reasonCode),
      };
    }
    throw safeError("generation_stage_failed");
  }
}

function requireEditorialApproval(value) {
  try {
    assertValidJobScopedEditorialApproval(value?.record);
  } catch {
    throw safeError("generation_approval_rejected");
  }
  if (
    !DIGEST.test(value?.recordDigest || "")
    || value.recordDigest !== createHash("sha256")
      .update(`${JSON.stringify(value.record, null, 2)}\n`)
      .digest("hex")
    || value.record.sourceDigest !== createHash("sha256")
      .update(JSON.stringify({
        kind: value.record.sourceEvidence.kind,
        reference: value.record.sourceEvidence.reference,
      }))
      .digest("hex")
  ) {
    throw safeError("generation_approval_rejected");
  }
  return Object.freeze(structuredClone(value));
}

class TestAGenerationOperatorError extends Error {
  constructor(code) {
    super(code);
    this.name = "TestAGenerationOperatorError";
    this.code = code;
  }
}

function createHostedResources(options, environment) {
  const convexUrl = requiredHttpsOrigin(environment, "CONVEX_URL");
  const backendToken = requiredSecret(environment, "CUSTOMER_FLOW_BACKEND_TOKEN", 32);
  const client = options.convexClient || new ConvexHttpClient(convexUrl);
  const store = createConvexFulfillmentStore({ client, backendToken });
  return {
    store,
    customerReader: Object.freeze({
      readJob(jobId) {
        return client.query("customerFlow:readJob", { backendToken, jobId });
      },
    }),
  };
}

function restrictGenerationStore(store) {
  const requiredMethods = [
    "getJob",
    "claimStage",
    "completeStage",
    "failStage",
    "recoverFailedPrepareReview",
    "resumeRetry",
  ];
  for (const method of requiredMethods) {
    if (typeof store?.[method] !== "function") {
      throw safeError("generation_store_rejected");
    }
  }
  return Object.freeze(Object.fromEntries(requiredMethods.map((method) => [
    method,
    (...args) => store[method](...args),
  ])));
}

function assertCanonicalAuthority({ customer, fulfillment, jobId }) {
  const expectedCorrelation = {
    project: "bebebonjour",
    product: "announcement-page",
    environment: "test",
    jobId,
    intakeDigest: customer?.intakeDigest,
  };
  if (
    !customer
    || !fulfillment
    || customer.jobId !== jobId
    || fulfillment.jobId !== jobId
    || !DIGEST.test(customer.intakeDigest || "")
    || customer.intakeDigest !== fulfillment.intakeDigest
    || customer.payment?.status !== "paid"
    || !customer.intake
    || typeof customer.intake !== "object"
    || Array.isArray(customer.intake)
    || customer.intake.requestId !== jobId
    || fulfillment.environment !== "test"
    || fulfillment.product !== "announcement-page"
    || !isDeepStrictEqual(fulfillment.paymentCorrelation, expectedCorrelation)
    || !isDeepStrictEqual(fulfillment.payment?.correlation, expectedCorrelation)
  ) {
    throw safeError("generation_authority_rejected");
  }
}

function isEligibleGenerationState(fulfillment) {
  if (fulfillment.state === "generation_queued") {
    return fulfillment.currentRevisionId === null;
  }
  if (fulfillment.state !== "retry_wait" || fulfillment.retry?.stage !== "prepare_review") {
    return false;
  }
  return fulfillment.currentRevisionId === null
    && fulfillment.stageAttempts.length > 0
    && fulfillment.stageAttempts.every((attempt) => attempt.stage === "prepare_review");
}

function assertGeneratedAggregate(fulfillment) {
  const revisionId = fulfillment.currentRevisionId;
  const matches = Array.isArray(fulfillment.artifactSets)
    ? fulfillment.artifactSets.filter(
      (set) => set.kind === "private_review" && set.revisionId === revisionId,
    )
    : [];
  if (
    typeof revisionId !== "string"
    || !/^r[1-9][0-9]*$/u.test(revisionId)
    || matches.length !== 1
  ) {
    throw safeError("generation_authority_rejected");
  }
  return matches[0];
}

function resultFor(status, outcome) {
  return {
    jobId: status.jobId,
    outcome,
    state: status.state,
    revisionId: status.currentRevisionId,
    intakeDigest: status.intakeDigest,
  };
}

function safeReasonCode(value) {
  return typeof value === "string" && SAFE_REASON.test(value)
    ? value
    : "generation_stage_failed";
}

function safeError(code) {
  return new TestAGenerationOperatorError(code);
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.trim() === "") throw safeError(code);
  return value.trim();
}

function requiredSecret(environment, name, minimumBytes) {
  const value = requiredString(environment?.[name], "generation_environment_rejected");
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw safeError("generation_environment_rejected");
  }
  return value;
}

function requiredHttpsOrigin(environment, name) {
  const value = requiredString(environment?.[name], "generation_environment_rejected");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw safeError("generation_environment_rejected");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== value
  ) {
    throw safeError("generation_environment_rejected");
  }
  return value;
}
