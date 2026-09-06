import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../../ops/test-a-hosted-provider-manifest.json", import.meta.url);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("reviewed TEST-A operator policy is loaded from the exact pinned manifest bytes", async () => {
  const manifestBytes = await readFile(manifestUrl);
  const {
    REVIEWED_TEST_A_OPERATOR_POLICY,
    loadReviewedTestAOperatorPolicy,
    requireReviewedTestAOperatorEnvironment,
  } = await import("../../src/config/test-a-hosted-provider-manifest.mjs");

  assert.equal(REVIEWED_TEST_A_OPERATOR_POLICY.manifestSha256, sha256(manifestBytes));
  assert.deepEqual(loadReviewedTestAOperatorPolicy(manifestBytes), REVIEWED_TEST_A_OPERATOR_POLICY);
  assert.deepEqual(REVIEWED_TEST_A_OPERATOR_POLICY.capabilities, ["status", "persist-approval"]);
  assert.equal(Object.hasOwn(REVIEWED_TEST_A_OPERATOR_POLICY, "identity"), false);
  assert.deepEqual(
    REVIEWED_TEST_A_OPERATOR_POLICY.allowedEnvironmentVariables,
    REVIEWED_TEST_A_OPERATOR_POLICY.runtimeEnvironmentVariables,
  );
  assert.deepEqual(REVIEWED_TEST_A_OPERATOR_POLICY.allowedEnvironmentVariables, [
    "CONVEX_URL",
    "CUSTOMER_FLOW_BACKEND_TOKEN",
    "BEBEBONJOUR_APPROVAL_HMAC_KEY",
  ]);
  assert.throws(
    () => requireReviewedTestAOperatorEnvironment({
      CONVEX_URL: "https://test-a.convex.cloud",
      CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
      VERCEL_TOKEN: "raw-env-is-not-provider-proof",
    }, { providerCapable: true }),
    /VERCEL_TOKEN is forbidden/,
  );
});

test("reviewed generation policy grants only prepare_review and canonical read/write authority", async () => {
  const manifestBytes = await readFile(manifestUrl);
  const {
    REVIEWED_TEST_A_GENERATION_POLICY,
    loadReviewedTestAGenerationPolicy,
  } = await import("../../src/config/test-a-hosted-provider-manifest.mjs");

  assert.deepEqual(
    loadReviewedTestAGenerationPolicy(manifestBytes),
    REVIEWED_TEST_A_GENERATION_POLICY,
  );
  assert.deepEqual(REVIEWED_TEST_A_GENERATION_POLICY.capabilities, ["prepare-review"]);
  assert.deepEqual(REVIEWED_TEST_A_GENERATION_POLICY.deployment, {
    provider: "Vercel",
    projectName: "bebebonjour-generation-worker",
    configPath: "vercel.generation-worker.json",
    entrypoint: "generation-worker/api/worker.mjs",
    route: "GET /api/operations/worker",
    schedule: "*/5 * * * *",
  });
  assert.deepEqual(REVIEWED_TEST_A_GENERATION_POLICY.authorityInputs, [
    "jobId",
    "persistedJobScopedEditorialApproval",
    "convexAuthenticatedPrivateArtifactHttpAction",
    "optionalOneTimeCodexAuthBootstrap",
    "singleLeasedEncryptedCodexAuthState",
  ]);
  assert.deepEqual(REVIEWED_TEST_A_GENERATION_POLICY.stages, ["prepare_review"]);
  assert.deepEqual(REVIEWED_TEST_A_GENERATION_POLICY.localConfiguration, []);
  assert.deepEqual(REVIEWED_TEST_A_GENERATION_POLICY.allowedEnvironmentVariables, [
    "CONVEX_URL",
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
    "BEBEBONJOUR_OPERATIONS_WORKER_ID",
    "BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS",
    "BEBEBONJOUR_OPERATIONS_WORKER_LIMIT",
    "BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS",
    "BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED",
    "BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY",
    "BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64",
    "BEBEBONJOUR_CODEX_MODEL",
    "BEBEBONJOUR_CODEX_TIMEOUT_MS",
    "BEBEBONJOUR_CODEX_AUTH_LEASE_MS",
    "CRON_SECRET",
  ]);
  assert.deepEqual(REVIEWED_TEST_A_GENERATION_POLICY.optionalEnvironmentVariables, [
    "BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64",
  ]);
  assert.deepEqual(
    REVIEWED_TEST_A_GENERATION_POLICY.allowedEnvironmentVariables,
    REVIEWED_TEST_A_GENERATION_POLICY.runtimeEnvironmentVariables,
  );
  for (const forbidden of [
    "BEBEBONJOUR_APPROVAL_HMAC_KEY",
    "CUSTOMER_FLOW_BACKEND_TOKEN",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "VERCEL_TOKEN",
  ]) {
    assert.ok(REVIEWED_TEST_A_GENERATION_POLICY.forbiddenEnvironmentVariables.includes(forbidden));
  }
});

test("reviewed generation runtime rejects broad or incomplete mounted authority", async () => {
  const {
    requireReviewedTestAGenerationEnvironment,
  } = await import("../../src/config/test-a-hosted-provider-manifest.mjs");
  const exactEnvironment = {
    CONVEX_URL: "https://test-a.convex.cloud",
    BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: "worker-token-with-at-least-thirty-two-bytes",
    BEBEBONJOUR_OPERATIONS_WORKER_ID: "generation-worker-1",
    BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "generate",
    BEBEBONJOUR_OPERATIONS_WORKER_LIMIT: "5",
    BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS: "120000",
    BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED: "true",
    BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64url"),
    BEBEBONJOUR_CODEX_MODEL: "gpt-5.6-sol",
    BEBEBONJOUR_CODEX_TIMEOUT_MS: "90000",
    BEBEBONJOUR_CODEX_AUTH_LEASE_MS: "110000",
    CRON_SECRET: "cron-secret-with-at-least-thirty-two-bytes",
  };

  assert.deepEqual(requireReviewedTestAGenerationEnvironment(exactEnvironment), exactEnvironment);
  assert.throws(
    () => requireReviewedTestAGenerationEnvironment({
      ...exactEnvironment,
      CUSTOMER_FLOW_BACKEND_TOKEN: "broad-backend-token-with-at-least-thirty-two-bytes",
    }),
    /CUSTOMER_FLOW_BACKEND_TOKEN is forbidden/u,
  );
  assert.throws(
    () => requireReviewedTestAGenerationEnvironment({
      ...exactEnvironment,
      BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "",
    }),
    /(is required|must equal generate)/u,
  );
});

test("reviewed TEST-A operator policy rejects tampered bytes and contradictory secret-store policy", async () => {
  const manifestBytes = await readFile(manifestUrl);
  const manifest = JSON.parse(manifestBytes);
  const { loadReviewedTestAOperatorPolicy } = await import(
    "../../src/config/test-a-hosted-provider-manifest.mjs"
  );

  const tamperedRuntime = Buffer.from(JSON.stringify({
    ...manifest,
    resendOperatorRuntime: {
      ...manifest.resendOperatorRuntime,
      capabilities: ["status", "persist-approval", "run-next"],
    },
  }));
  assert.throws(() => loadReviewedTestAOperatorPolicy(tamperedRuntime), /manifest digest/i);

  const contradictoryPolicy = structuredClone(manifest);
  contradictoryPolicy.secretStores.resendOperator.allowed = [
    ...contradictoryPolicy.secretStores.resendOperator.allowed,
    "STRIPE_SECRET_KEY",
  ];
  const contradictoryBytes = Buffer.from(JSON.stringify(contradictoryPolicy));
  assert.throws(
    () => loadReviewedTestAOperatorPolicy(contradictoryBytes, { expectedDigest: sha256(contradictoryBytes) }),
    /allowed and forbidden|environment variables/i,
  );
});
