import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NARRATION_WORKER_POLICY,
  createProductionNarrationWorker,
  requireNarrationWorkerEnvironment,
} from "../../src/operations/production-narration-worker.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pageBytes = Buffer.from(
  JSON.stringify({
    jobId: "job_narration_test",
    pageRevision: "r1",
    languages: ["fr"],
    sectionOrder: ["intro"],
    sections: { intro: { fr: { narrationText: "Bienvenue." } } },
  }),
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

function preparedBundle() {
  return {
    kind: "prepared_bundle",
    revisionId: "r1",
    pageDigest: hash(pageBytes),
    transcriptDigest: "b".repeat(64),
    assetManifestDigest: "c".repeat(64),
    sourcePrivateReviewManifestDigest: "d".repeat(64),
    manifestRef:
      "jobs/job_narration_test/revisions/r1/manifests/prepared_bundle.json",
    files: [
      {
        path: "artifacts/current/page.json",
        storageId: "source-page",
        bytes: pageBytes.length,
        sha256: hash(pageBytes),
      },
    ],
  };
}

test("production narration policy is one worker, one action, one lease", () => {
  assert.deepEqual(NARRATION_WORKER_POLICY, {
    workerId: "hosted-narration-worker",
    actions: ["generate_narration"],
    limit: 1,
    leaseMs: 300000,
  });
  const environment = requireNarrationWorkerEnvironment(validEnvironment());
  assert.equal(environment.CONVEX_URL, "https://example.convex.cloud");
  assert.equal(
    environment.BEBEBONJOUR_TTS_WORKER_TOKEN,
    validEnvironment().BEBEBONJOUR_TTS_WORKER_TOKEN,
  );

  for (const changed of [
    { OPENAI_API_KEY: undefined },
    { CONVEX_URL: "http://example.convex.cloud" },
    { CONVEX_SITE_URL: "https://example.convex.site/path" },
    { BEBEBONJOUR_TTS_WORKER_TOKEN: "short" },
    {
      CRON_SECRET:
        validEnvironment().BEBEBONJOUR_TTS_WORKER_TOKEN,
    },
    {
      OPENAI_API_KEY:
        validEnvironment().BEBEBONJOUR_TTS_WORKER_TOKEN,
    },
  ]) {
    assert.throws(() =>
      requireNarrationWorkerEnvironment({ ...validEnvironment(), ...changed }),
    );
  }
});

test("worker fences exactly one generation, reads exact approved page, uploads typed bytes, and completes durably", async () => {
  const calls = [];
  const command = {
    commandId: "command_narration_generation_123",
    jobId: "job_narration_test",
    action: "generate_narration",
    expectedState: "tts_queued",
    expectedVersion: 7,
    payload: {},
    claim: {
      leaseToken: "lease-token-12345678",
      leaseExpiresAtMs: Date.now() + 60_000,
    },
  };
  const client = {
    query: async (name, args) => {
      calls.push([name, args]);
      if (name === "operations:workerHealth") {
        return { protocolVersion: "1.0", scope: "narration_generation" };
      }
      if (name === "narration:readPrepared") return preparedBundle();
      throw new Error(`unexpected query ${name}`);
    },
    mutation: async (name, args) => {
      calls.push([name, args]);
      if (name === "operations:claimCommands") return [command];
      if (name === "operations:fenceCommand") {
        return { active: true, command };
      }
      if (name === "narration:createUploadUrl") {
        return "https://example.convex.cloud/api/storage/upload";
      }
      if (name === "operations:completeCommand") return null;
      throw new Error(`unexpected mutation ${name}`);
    },
    action: async (name, args) => {
      calls.push([name, args]);
      if (name !== "narrationRuntime:advance") {
        throw new Error(`unexpected action ${name}`);
      }
      if (args.operation === "begin") return { state: "tts_generating" };
      if (args.operation === "fence") return { state: "tts_generating" };
      if (args.operation === "complete") {
        return {
          code: "narration_prepared",
          artifactSetId: "artifact-narration",
          revisionId: "r1",
          jobVersion: 9,
        };
      }
      throw new Error(`unexpected narration operation ${args.operation}`);
    },
  };
  const fetchCalls = [];
  const fetchImpl = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    if (init.method === "POST") {
      assert.equal(init.headers["Content-Type"], "audio/mpeg");
      return new Response(JSON.stringify({ storageId: "stored-audio" }), {
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(new URL(url).pathname, "/narration/artifact");
    return new Response(pageBytes, {
      headers: {
        "content-length": String(pageBytes.length),
        "content-type": "application/json",
      },
    });
  };
  const worker = createProductionNarrationWorker({
    environment: validEnvironment(),
    client,
    fetch: fetchImpl,
    generateNarration: async ({ upload, prepared, page, idempotencyKey }) => {
      calls.push(["provider:generate", { idempotencyKey }]);
      assert.equal(prepared.assetManifestDigest, "c".repeat(64));
      assert.equal(page.jobId, command.jobId);
      assert.equal(idempotencyKey, command.commandId);
      const storageId = await upload(
        "artifacts/audio/fr/intro.mp3",
        Buffer.from("audio"),
        "audio/mpeg",
      );
      assert.equal(storageId, "stored-audio");
      return {
        kind: "narration_review",
        revisionId: "r1",
        pageDigest: prepared.pageDigest,
        transcriptDigest: "e".repeat(64),
        sourcePreparedBundleManifestDigest: prepared.assetManifestDigest,
        assetManifestDigest: "f".repeat(64),
        manifestRef:
          "jobs/job_narration_test/revisions/r1/manifests/narration_review.json",
        files: prepared.files,
      };
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "ok",
    protocolVersion: "1.0",
    workerId: "hosted-narration-worker",
    enabledActionCount: 1,
    claimed: 1,
    completed: 1,
    failed: 0,
  });
  const claim = calls.find(([name]) => name === "operations:claimCommands")[1];
  assert.deepEqual(claim.actions, ["generate_narration"]);
  assert.equal(claim.limit, 1);
  assert.equal(claim.leaseMs, 300000);
  assert.equal(claim.jobId, undefined);
  assert.deepEqual(
    calls
      .filter(([name]) => name === "narrationRuntime:advance")
      .map(([, args]) => args.operation),
    ["begin", "fence", "complete"],
  );
  const queueFenceIndex = calls.findIndex(([name]) => name === "operations:fenceCommand");
  const aggregateFenceIndex = calls.findIndex(([, args]) => args?.operation === "fence");
  const providerIndex = calls.findIndex(([name]) => name === "provider:generate");
  assert.ok(queueFenceIndex < aggregateFenceIndex);
  assert.ok(aggregateFenceIndex < providerIndex);
  assert.equal(
    calls.filter(
      ([name, args]) =>
        name === "operations:fenceCommand" && args.effectMayBeIssued,
    ).length,
    1,
  );
  assert.equal(fetchCalls.length, 2);
});

test("an aggregate-fence failure never invokes the narration provider", async () => {
  const calls = [];
  let providerInvocationCount = 0;
  const command = {
    commandId: "command_narration_generation_fence_failure",
    jobId: "job_narration_test",
    action: "generate_narration",
    expectedState: "tts_queued",
    expectedVersion: 7,
    payload: {},
    claim: {
      leaseToken: "lease-token-fence-failure",
      leaseExpiresAtMs: Date.now() + 60_000,
    },
  };
  const client = {
    query: async (name) => {
      if (name === "operations:workerHealth") {
        return { protocolVersion: "1.0", scope: "narration_generation" };
      }
      if (name === "narration:readPrepared") return preparedBundle();
      throw new Error(`unexpected query ${name}`);
    },
    mutation: async (name, args) => {
      calls.push([name, args]);
      if (name === "operations:claimCommands") return [command];
      if (name === "operations:fenceCommand") return { active: true, command };
      if (name === "operations:failCommand") return null;
      throw new Error(`unexpected mutation ${name}`);
    },
    action: async (name, args) => {
      calls.push([name, args]);
      if (name === "narrationRuntime:advance" && args.operation === "begin") {
        return { state: "tts_generating" };
      }
      if (name === "narrationRuntime:advance" && args.operation === "fence") {
        throw new Error("aggregate fence unavailable");
      }
      if (name === "narrationRuntime:advance" && args.operation === "fail") {
        return { state: "failed" };
      }
      throw new Error(`unexpected action ${name}`);
    },
  };
  const worker = createProductionNarrationWorker({
    environment: validEnvironment(),
    client,
    fetch: async () => new Response(pageBytes, {
      headers: {
        "content-length": String(pageBytes.length),
        "content-type": "application/json",
      },
    }),
    generateNarration: async () => {
      providerInvocationCount += 1;
      throw new Error("provider must not run before the aggregate fence");
    },
  });

  const result = await worker.runOnce();
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);
  assert.equal(providerInvocationCount, 0);
  assert.ok(calls.some(([name, args]) => (
    name === "operations:fenceCommand" && args.effectMayBeIssued === true
  )));
  assert.ok(calls.some(([name, args]) => (
    name === "narrationRuntime:advance" && args.operation === "fence"
  )));
  assert.ok(!calls.some(([name]) => name === "operations:completeCommand"));
});

test("uncertain provider failures are redacted, non-retryable, and never completed", async () => {
  const calls = [];
  const command = {
    commandId: "command_narration_generation_456",
    jobId: "job_narration_test",
    action: "generate_narration",
    expectedState: "tts_queued",
    expectedVersion: 7,
    payload: {},
    claim: {
      leaseToken: "lease-token-12345678",
      leaseExpiresAtMs: Date.now() + 60_000,
    },
  };
  const client = {
    query: async (name) => {
      if (name === "operations:workerHealth") {
        return { protocolVersion: "1.0", scope: "narration_generation" };
      }
      if (name === "narration:readPrepared") return preparedBundle();
      throw new Error(`unexpected query ${name}`);
    },
    mutation: async (name, args) => {
      calls.push([name, args]);
      if (name === "operations:claimCommands") return [command];
      if (name === "operations:fenceCommand") return { active: true, command };
      if (name === "operations:failCommand") return null;
      throw new Error(`unexpected mutation ${name}`);
    },
    action: async (name, args) => {
      calls.push([name, args]);
      if (name === "narrationRuntime:advance" && args.operation === "begin") {
        return { state: "tts_generating" };
      }
      if (name === "narrationRuntime:advance" && args.operation === "fence") {
        return { state: "tts_generating" };
      }
      if (name === "narrationRuntime:advance" && args.operation === "fail") {
        return { state: "reconciliation_required" };
      }
      throw new Error(`unexpected action ${name}`);
    },
  };
  const worker = createProductionNarrationWorker({
    environment: validEnvironment(),
    client,
    fetch: async () => new Response(pageBytes),
    generateNarration: async () => {
      throw new Error("provider-secret-body-must-not-leak");
    },
  });

  const result = await worker.runOnce();
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);
  assert.ok(
    !calls.some(([name]) => name === "operations:completeCommand"),
  );
  const failure = calls.find(([name]) => name === "operations:failCommand")[1];
  assert.equal(failure.reasonCode, "operation_failed");
  assert.equal(failure.retryable, false);
  assert.ok(!JSON.stringify(calls).includes("provider-secret-body-must-not-leak"));
});
