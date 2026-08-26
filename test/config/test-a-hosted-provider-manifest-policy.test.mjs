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
  } = await import("../../src/config/test-a-hosted-provider-manifest.mjs");

  assert.equal(REVIEWED_TEST_A_OPERATOR_POLICY.manifestSha256, sha256(manifestBytes));
  assert.deepEqual(loadReviewedTestAOperatorPolicy(manifestBytes), REVIEWED_TEST_A_OPERATOR_POLICY);
  assert.deepEqual(REVIEWED_TEST_A_OPERATOR_POLICY.identity, {
    resendFrom: "Bébé Bonjour <onboarding@resend.dev>",
    testSink: "delivered@resend.dev",
    publication: {
      stableOrigin: "https://announcements.example.test",
      teamId: "team_test_a",
      projectId: "prj_test_a_announcements",
      projectName: "bebebonjour-test-a-announcements",
    },
  });
  assert.deepEqual(
    REVIEWED_TEST_A_OPERATOR_POLICY.allowedEnvironmentVariables,
    REVIEWED_TEST_A_OPERATOR_POLICY.runtimeEnvironmentVariables,
  );
});

test("reviewed TEST-A operator policy rejects tampered bytes and contradictory secret-store policy", async () => {
  const manifestBytes = await readFile(manifestUrl);
  const manifest = JSON.parse(manifestBytes);
  const { loadReviewedTestAOperatorPolicy } = await import(
    "../../src/config/test-a-hosted-provider-manifest.mjs"
  );

  const tamperedIdentity = Buffer.from(JSON.stringify({
    ...manifest,
    resendOperatorRuntime: {
      ...manifest.resendOperatorRuntime,
      identity: {
        ...manifest.resendOperatorRuntime.identity,
        testSink: "other@example.test",
      },
    },
  }));
  assert.throws(() => loadReviewedTestAOperatorPolicy(tamperedIdentity), /manifest digest/i);

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
