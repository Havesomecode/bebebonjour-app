import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadReviewedNarrationPolicy,
  requireReviewedNarrationEnvironment,
} from "../../src/config/test-a-hosted-provider-manifest.mjs";

const manifestUrl = new URL(
  "../../ops/test-a-hosted-provider-manifest.json",
  import.meta.url,
);

function validEnvironment() {
  return {
    CONVEX_URL: "https://example.convex.cloud",
    CONVEX_SITE_URL: "https://example.convex.site",
    BEBEBONJOUR_TTS_WORKER_TOKEN: "tts-worker-secret-that-is-at-least-32-bytes",
    OPENAI_API_KEY: "not-a-real-provider-key-that-is-long-enough",
    CRON_SECRET: "cron-secret-that-is-distinct-and-at-least-32-bytes",
  };
}

test("reviewed manifest pins the isolated generate_narration deployment and secret store", async () => {
  const bytes = await readFile(manifestUrl);
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");
  const policy = loadReviewedNarrationPolicy(bytes, { expectedDigest });

  assert.deepEqual(policy.capabilities, ["generate_narration"]);
  assert.deepEqual(policy.stages, ["generate_tts"]);
  assert.deepEqual(policy.deployment, {
    provider: "Vercel",
    projectName: "bebebonjour-narration-worker",
    configPath: "vercel.narration-worker.json",
    entrypoint: "narration-worker/api/worker.mjs",
    route: "GET /api/operations/narration-worker",
    schedule: "*/5 * * * *",
    minimumPlan: "pro",
  });
  assert.deepEqual(policy.allowedEnvironmentVariables, [
    "CONVEX_URL",
    "CONVEX_SITE_URL",
    "BEBEBONJOUR_TTS_WORKER_TOKEN",
    "OPENAI_API_KEY",
    "CRON_SECRET",
  ]);
  for (const forbidden of [
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
    "BEBEBONJOUR_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_OPERATIONS_TOKEN",
    "RESEND_API_KEY",
    "VERCEL_TOKEN",
    "STRIPE_SECRET_KEY",
  ]) {
    assert.ok(policy.forbiddenEnvironmentVariables.includes(forbidden));
  }

  assert.deepEqual(
    requireReviewedNarrationEnvironment(validEnvironment(), { policy }),
    validEnvironment(),
  );
  assert.throws(() =>
    requireReviewedNarrationEnvironment(
      { ...validEnvironment(), RESEND_API_KEY: "forbidden" },
      { policy },
    ),
  );
  assert.throws(() =>
    requireReviewedNarrationEnvironment(
      {
        ...validEnvironment(),
        CRON_SECRET: validEnvironment().BEBEBONJOUR_TTS_WORKER_TOKEN,
      },
      { policy },
    ),
  );
});

test("manifest drift cannot broaden the narration worker beyond generation", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  manifest.narrationOperatorRuntime.capabilities.push("publish");
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");
  assert.throws(
    () => loadReviewedNarrationPolicy(bytes, { expectedDigest }),
    /isolated to generate_narration/,
  );
});
