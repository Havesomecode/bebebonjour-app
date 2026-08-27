import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { recordReviewDecisionTransition } from "./job-machine.mjs";
import { createFulfillmentOrchestrator } from "./job-orchestrator.mjs";
import {
  authenticatePersistedReviewApproval,
  createPersistedReviewDecisionVerifier,
} from "./persisted-review-decision.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";

const STAGES = Object.freeze(["prepare_review", "render_approved", "generate_tts", "publish", "deliver"]);
export const TEST_A_RETRY_POLICY = Object.freeze({
  leaseMsByStage: Object.freeze(Object.fromEntries(STAGES.map((stage) => [stage, 300_000]))),
  maxAttemptsByStage: Object.freeze(Object.fromEntries(STAGES.map((stage) => [stage, 2]))),
  backoffMsByStage: Object.freeze(Object.fromEntries(STAGES.map((stage) => [stage, Object.freeze([60_000])]))),
});

export function createTestAOperatorStatusRunner(options = {}) {
  const environment = options.environment || process.env;
  const store = options.store || createHostedStore(options, environment);
  if (typeof store?.getJob !== "function") {
    throw new Error("The TEST-A fulfillment store must implement getJob().");
  }
  const orchestrator = createFulfillmentOrchestrator({
    store,
    handlers: {},
    clock: options.clock,
    tokenFactory: options.tokenFactory,
    retryPolicy: options.retryPolicy || TEST_A_RETRY_POLICY,
  });
  return Object.freeze({
    status(jobId) {
      return orchestrator.status(jobId);
    },
  });
}

export function createTestAOperatorReviewRunner(options = {}) {
  const environment = options.environment || process.env;
  const hmacKey = requiredSecret(environment, "BEBEBONJOUR_APPROVAL_HMAC_KEY", 32);
  const clock = options.clock || (() => new Date().toISOString());
  const tokenFactory = options.tokenFactory || (() => `operator_${randomUUID()}`);
  const store = options.store || createHostedStore(options, environment);
  for (const method of ["getJob", "getReviewApproval", "saveReviewApproval"]) {
    if (typeof store?.[method] !== "function") {
      throw new Error(`The TEST-A fulfillment store must implement ${method}().`);
    }
  }
  const verifyPersistedReview = createPersistedReviewDecisionVerifier({
    approvalStore: store,
    fulfillmentStore: store,
    hmacKey,
  });
  const orchestrator = createFulfillmentOrchestrator({
    store,
    handlers: { verify_review_decision: verifyPersistedReview },
    clock,
    tokenFactory,
    retryPolicy: options.retryPolicy || TEST_A_RETRY_POLICY,
  });
  return Object.freeze({
    async persistAndRecordReview(jobId, approvalInput) {
      const approval = parseApprovalInput(approvalInput);
      if (!approval?.approvalId || !approval?.signature || !approval?.decision) {
        throw new Error("A signed persisted review approval is required.");
      }
      authenticatePersistedReviewApproval(approval, hmacKey);
      requireCanonicalApprovalInput(approvalInput, approval);
      const job = await orchestrator.status(jobId);
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
  });
}

export function createTestAOperatorRunner() {
  throw new Error(
    "The private TEST-A operator is status/review-only; publication and delivery are disabled until authoritative provider inspection is implemented.",
  );
}

function createHostedStore(options, environment) {
  const convexUrl = requiredHttpsOrigin(environment, "CONVEX_URL");
  const backendToken = requiredSecret(environment, "CUSTOMER_FLOW_BACKEND_TOKEN", 32);
  const client = options.convexClient || new ConvexHttpClient(convexUrl);
  return createConvexFulfillmentStore({ client, backendToken });
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

function parseApprovalInput(input) {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > 65_536) {
    throw new Error("Persisted review approval input must be 1-65536 exact stdin bytes.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error) {
    throw new Error("Persisted review approval input must be valid UTF-8.", { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Persisted review approval input is not valid JSON.", { cause: error });
  }
}

function requireCanonicalApprovalInput(input, approval) {
  const canonicalInput = Buffer.from(`${JSON.stringify(approval)}\n`, "utf8");
  if (!input.equals(canonicalInput)) {
    throw new Error("Persisted review approval input must use canonical exact approval bytes.");
  }
}
