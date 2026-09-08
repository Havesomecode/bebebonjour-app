import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TEST_A_COMPLETION_ACTIONS,
  TEST_A_COMPLETION_JOB_ID,
  TEST_A_COMPLETION_LEASE_MS,
} from "../src/operations/production-completion-worker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [
  completionConfig,
  generationConfig,
  completionEntrypoint,
  completionRuntime,
  completionCapabilities,
  publicationProvider,
  packageManifest,
  providerManifest,
] = await Promise.all([
  readFile(path.join(root, "vercel.completion-worker.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "vercel.generation-worker.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "completion-worker/api/worker.mjs"), "utf8"),
  readFile(path.join(root, "src/operations/production-completion-worker.mjs"), "utf8"),
  readFile(path.join(root, "src/fulfillment/test-a-completion-capabilities.mjs"), "utf8"),
  readFile(path.join(root, "src/fulfillment/vercel-test-a-publication-provider.mjs"), "utf8"),
  readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "ops/test-a-hosted-provider-manifest.json"), "utf8").then(JSON.parse),
]);

assert.deepEqual(TEST_A_COMPLETION_ACTIONS, [
  "approve_content", "render", "publish", "queue_delivery", "deliver", "retry",
]);
assert.equal(TEST_A_COMPLETION_JOB_ID, "job_03c25b08-8476-4fe1-923b-43d73feab3ff");
assert.equal(TEST_A_COMPLETION_LEASE_MS, 300_000);
assert.deepEqual(completionConfig.routes, [{
  src: "/api/operations/completion-worker",
  dest: "completion-worker/api/worker.mjs",
}]);
assert.deepEqual(completionConfig.crons, [{
  path: "/api/operations/completion-worker",
  schedule: "*/5 * * * *",
}]);
assert.equal(completionConfig.builds.length, 1);
assert.equal(completionConfig.builds[0].src, "completion-worker/api/worker.mjs");
assert.match(completionEntrypoint, /maxDuration: 300/u);
assert.match(completionEntrypoint, /runTestACompletionWorkerCommand/u);
assert.match(completionEntrypoint, /createLazyOperationsWorkerHttpHandler/u);
for (const forbiddenAuthority of [
  "OPENAI_API_KEY",
  "STRIPE_SECRET_KEY",
  "BEBEBONJOUR_OPERATIONS_TOKEN",
  "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
  "CUSTOMER_FLOW_BACKEND_TOKEN",
  "CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY",
  "TALLY_SIGNING_SECRET",
]) assert.ok(
  providerManifest.secretStores.completionOperator.forbidden.includes(forbiddenAuthority),
  `${forbiddenAuthority} must remain forbidden to the completion runtime.`,
);
assert.deepEqual(
  providerManifest.completionOperatorRuntime.environmentVariables,
  providerManifest.secretStores.completionOperator.allowed,
);
assert.match(completionRuntime, /requireReviewedTestACompletionEnvironment/u);
assert.doesNotMatch(completionRuntime, /requiredExact\(environment, "VERCEL_DEPLOYMENT_ID"/u);
assert.match(completionCapabilities, /delivered@resend\.dev/u);
assert.match(completionCapabilities, /verify_review_decision/u);
assert.match(publicationProvider, /operationTimeoutMs, 240_000/u);
assert.match(publicationProvider, /requestTimeoutMs, 15_000/u);
assert.match(publicationProvider, /"x-vercel-protection-bypass": protectionBypassSecret/u);
for (const command of [
  "npm test",
  "npm run build",
  "npm run test:integration",
  "npm run test:vercel-routing",
  "npm run test:production-audit",
  "npm audit --omit=dev",
]) assert.match(packageManifest.scripts.verify, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
assert.deepEqual(generationConfig.routes, [{
  src: "/api/operations/worker",
  dest: "generation-worker/api/worker.mjs",
}]);
assert.ok(!JSON.stringify(generationConfig).includes("completion-worker"));

console.log(`PASS: completion worker is isolated to ${TEST_A_COMPLETION_JOB_ID}, ${TEST_A_COMPLETION_ACTIONS.length} ordered actions, and ${TEST_A_COMPLETION_LEASE_MS}ms leases.`);
