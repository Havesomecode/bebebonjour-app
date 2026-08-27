import { requireReviewedTestAOperatorEnvironment } from "../config/test-a-hosted-provider-manifest.mjs";
import {
  createTestAOperatorReviewRunner,
  createTestAOperatorStatusRunner,
} from "./operator-runner-test-a.mjs";

const COMMANDS = Object.freeze({
  status: "status",
  "persist-approval": "persistAndRecordReview",
  "run-next": "runNext",
  "queue-delivery": "queueDelivery",
  "reconcile-delivery": "reconcileDelivery",
});

export async function runTestAOperatorCommand(options = {}) {
  const argv = options.argv || [];
  const [command, jobId, ...extra] = argv;
  const method = COMMANDS[command];
  if (!method || !/^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(jobId || "") || extra.length > 0) {
    throw new Error(
      "Usage: node ops/run-test-a-operator.mjs <status|persist-approval|run-next|queue-delivery|reconcile-delivery> <job_id>",
    );
  }

  if (command === "run-next" || command === "queue-delivery" || command === "reconcile-delivery") {
    throw new Error(
      `${command} is disabled: this private TEST-A operator is status/review-only. `
      + "Use status or persist-approval. Re-enable provider commands only after authoritative Vercel "
      + "deployment inspection and the patched local Vercel CLI are pinned and reviewed; no Vercel or Resend I/O was attempted.",
    );
  }

  const environment = options.environment || process.env;
  const reviewOnly = command === "persist-approval";
  requireColdStartConfiguration(environment);
  if (reviewOnly) requiredSecret(environment, "BEBEBONJOUR_APPROVAL_HMAC_KEY", 32);
  const createRunner = reviewOnly
    ? options.createReviewRunner || createTestAOperatorReviewRunner
    : options.createStatusRunner || createTestAOperatorStatusRunner;
  if (typeof createRunner !== "function") {
    throw new Error("The private TEST-A review-only runner is unavailable.");
  }
  const runner = createRunner({ environment });
  if (typeof runner?.[method] !== "function") {
    throw new Error(`The private TEST-A operator runner does not implement ${method}().`);
  }
  return runner[method](jobId, reviewOnly ? options.approvalInput : undefined);
}

function requireColdStartConfiguration(environment) {
  requireReviewedTestAOperatorEnvironment(environment, { providerCapable: false });
  requiredHttpsOrigin(environment, "CONVEX_URL");
  requiredSecret(environment, "CUSTOMER_FLOW_BACKEND_TOKEN", 32);
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
