import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runTestAOperatorCommand } from "../../src/fulfillment/test-a-operator-startup.mjs";

const validEnvironment = Object.freeze({
  BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
  CONVEX_URL: "https://test-a.convex.cloud",
  CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
  RESEND_API_KEY: "re_test_operator_runner",
  RESEND_FROM: "Bébé Bonjour <onboarding@resend.dev>",
  TEST_A_PUBLICATION_ORIGIN: "https://announcements.example.test",
  TEST_A_PUBLICATION_VERCEL_TEAM_ID: "team_test_a",
  TEST_A_PUBLICATION_VERCEL_PROJECT_ID: "prj_test_a_announcements",
  TEST_A_PUBLICATION_VERCEL_PROJECT_NAME: "bebebonjour-test-a-announcements",
  TEST_A_PUBLICATION_CANARY_JOB_ID: "job_test_001",
  TEST_A_PUBLICATION_CANARY_REVISION_ID: "r1",
  TEST_A_ARTIFACT_ROOT: "/tmp/bebebonjour-test-a-artifacts",
  VERCEL_TOKEN: "vercel_test_token",
});

const statusEnvironment = Object.freeze({
  CONVEX_URL: "https://test-a.convex.cloud",
  CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
});

test("private operator startup rejects invalid cold-start configuration before runner or provider I/O", async () => {
  let runnerConstructions = 0;
  let providerIo = 0;
  const createRunner = () => {
    runnerConstructions += 1;
    return {
      async status() {
        providerIo += 1;
      },
    };
  };
  const invalidEnvironments = [
    {},
    { ...validEnvironment, RESEND_API_KEY: "invalid" },
    { ...validEnvironment, RESEND_FROM: "Other <other@example.test>" },
    { ...validEnvironment, TEST_A_PUBLICATION_VERCEL_PROJECT_NAME: "bebebonjour-fulfillment" },
    { ...validEnvironment, CONVEX_URL: "http://test-a.convex.cloud" },
    { ...validEnvironment, STRIPE_SECRET_KEY: "sk_test_forbidden_operator_value" },
  ];

  for (const environment of invalidEnvironments) {
    await assert.rejects(
      runTestAOperatorCommand({
        argv: ["run-next", "job_test_001"],
        createRunner,
        environment,
      }),
    );
  }
  assert.equal(runnerConstructions, 0);
  assert.equal(providerIo, 0);
});

test("private operator startup invokes one reviewed provider-capable command without an HTTP listener", async () => {
  const invocations = [];
  const result = await runTestAOperatorCommand({
    argv: ["run-next", "job_test_001"],
    environment: validEnvironment,
    createRunner(options) {
      invocations.push({ kind: "construct", options });
      return {
        async runNext(jobId) {
          invocations.push({ kind: "run-next", jobId });
          return { jobId, state: "publish_ready" };
        },
      };
    },
  });

  assert.deepEqual(result, { jobId: "job_test_001", state: "publish_ready" });
  assert.deepEqual(invocations, [
    { kind: "construct", options: { environment: validEnvironment } },
    { kind: "run-next", jobId: "job_test_001" },
  ]);
});

test("status uses the delivery-disabled runner without requiring publication or delivery credentials", async () => {
  const invocations = [];
  const result = await runTestAOperatorCommand({
    argv: ["status", "job_test_001"],
    environment: statusEnvironment,
    createRunner() {
      throw new Error("provider-capable runner must not be constructed");
    },
    createStatusRunner(options) {
      invocations.push({ kind: "construct-status", options });
      return {
        async status(jobId) {
          invocations.push({ kind: "status", jobId });
          return { jobId, state: "publish_ready" };
        },
      };
    },
  });

  assert.deepEqual(result, { jobId: "job_test_001", state: "publish_ready" });
  assert.deepEqual(invocations, [
    { kind: "construct-status", options: { environment: statusEnvironment } },
    { kind: "status", jobId: "job_test_001" },
  ]);
});

test("real provider-capable operator entrypoint fails closed on a credential-free cold start", () => {
  const result = spawnSync(process.execPath, [
    "ops/run-test-a-operator.mjs",
    "run-next",
    "job_test_001",
  ], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /required by the reviewed TEST-A operator secret-store policy/);
  assert.equal(result.stdout, "");
});

test("real status entrypoint reaches hosted-store construction and fails closed without provider credentials", () => {
  const result = spawnSync(process.execPath, [
    "ops/run-test-a-operator.mjs",
    "status",
    "job_test_001",
  ], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CONVEX_URL: "https://127.0.0.1:1",
      CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /RESEND_API_KEY|VERCEL_TOKEN|BEBEBONJOUR_APPROVAL_HMAC_KEY/);
  assert.notEqual(result.stderr, "");
  assert.equal(result.stdout, "");
});
