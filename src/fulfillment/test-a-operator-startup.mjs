import path from "node:path";

import { createTestAOperatorRunner } from "./operator-runner-test-a.mjs";
import { requireReviewedTestAOperatorIdentity } from "./test-a-operator-runtime-identity.mjs";

const COMMANDS = Object.freeze({
  status: "status",
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
      "Usage: node ops/run-test-a-operator.mjs <status|run-next|queue-delivery|reconcile-delivery> <job_id>",
    );
  }

  const environment = options.environment || process.env;
  requireColdStartConfiguration(environment);
  const createRunner = options.createRunner || createTestAOperatorRunner;
  const runner = createRunner({ environment });
  if (typeof runner?.[method] !== "function") {
    throw new Error(`The private TEST-A operator runner does not implement ${method}().`);
  }
  return runner[method](jobId);
}

function requireColdStartConfiguration(environment) {
  requiredSecret(environment, "BEBEBONJOUR_APPROVAL_HMAC_KEY", 32);
  requiredHttpsOrigin(environment, "CONVEX_URL");
  requiredSecret(environment, "CUSTOMER_FLOW_BACKEND_TOKEN", 32);
  const resendApiKey = requiredString(environment, "RESEND_API_KEY");
  if (!resendApiKey.startsWith("re_")) throw new Error("RESEND_API_KEY must be a Resend API key.");
  requireReviewedTestAOperatorIdentity(environment);
  requiredString(environment, "VERCEL_TOKEN");
  requiredString(environment, "TEST_A_PUBLICATION_CANARY_JOB_ID");
  requiredString(environment, "TEST_A_PUBLICATION_CANARY_REVISION_ID");
  const artifactRoot = requiredString(environment, "TEST_A_ARTIFACT_ROOT");
  if (!path.isAbsolute(artifactRoot)) throw new Error("TEST_A_ARTIFACT_ROOT must be an absolute path.");
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
