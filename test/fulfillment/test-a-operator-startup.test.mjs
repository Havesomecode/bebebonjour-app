import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runTestAOperatorCommand } from "../../src/fulfillment/test-a-operator-startup.mjs";

const statusEnvironment = Object.freeze({
  CONVEX_URL: "https://test-a.convex.cloud",
  CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
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

test("persist-approval passes exact stdin bytes to the fixed review-only runner", async () => {
  const approvalInput = Buffer.from('{"approvalId":"approval_0123456789abcdef01234567"}\n', "utf8");
  const invocations = [];
  const result = await runTestAOperatorCommand({
    argv: ["persist-approval", "job_test_001"],
    approvalInput,
    environment: {
      ...statusEnvironment,
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
    },
    createRunner() {
      throw new Error("provider-capable runner must not be constructed");
    },
    createReviewRunner(options) {
      invocations.push({ kind: "construct-review", options });
      return {
        async persistAndRecordReview(jobId, input) {
          invocations.push({ kind: "persist-approval", jobId, input });
          return { jobId, state: "render_queued" };
        },
      };
    },
  });

  assert.deepEqual(result, { jobId: "job_test_001", state: "render_queued" });
  assert.equal(invocations[0].kind, "construct-review");
  assert.equal(invocations[1].kind, "persist-approval");
  assert.equal(invocations[1].jobId, "job_test_001");
  assert.equal(invocations[1].input, approvalInput);
});

test("persist-approval rejects JSON argv instead of treating shell text as authenticated input", async () => {
  await assert.rejects(
    runTestAOperatorCommand({
      argv: ["persist-approval", "job_test_001", '{"approvalId":"approval_0123456789abcdef01234567"}'],
      approvalInput: Buffer.from("{}\n"),
      environment: {},
    }),
    /Usage:/,
  );
});

test("real persist-approval entrypoint reads stdin and rejects malformed bytes before hosted I/O", () => {
  const result = spawnSync(process.execPath, [
    "ops/run-test-a-operator.mjs",
    "persist-approval",
    "job_test_001",
  ], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    input: Buffer.from("not-json\n", "utf8"),
    env: {
      PATH: process.env.PATH,
      ...statusEnvironment,
      BEBEBONJOUR_APPROVAL_HMAC_KEY: "operator-review-key-with-at-least-thirty-two-bytes",
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /approval input is not valid JSON/i);
  assert.doesNotMatch(result.stderr, /VERCEL_TOKEN|RESEND_API_KEY|ECONNREFUSED/);
  assert.equal(result.stdout, "");
});

test("provider-capable commands fail closed with remediation before secrets, runners, or provider I/O", async () => {
  let runnerConstructions = 0;
  for (const command of ["run-next", "queue-delivery", "reconcile-delivery"]) {
    await assert.rejects(
      runTestAOperatorCommand({
        argv: [command, "job_test_001"],
        environment: {},
        createRunner() {
          runnerConstructions += 1;
          return {};
        },
      }),
      new RegExp(`${command} is disabled.*status or persist-approval.*authoritative Vercel.*patched local Vercel CLI`, "is"),
    );
  }
  assert.equal(runnerConstructions, 0);
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
  assert.match(result.stderr, /run-next is disabled.*status or persist-approval.*authoritative Vercel/is);
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
