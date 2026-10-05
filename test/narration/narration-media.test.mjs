import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CEDAR_NARRATION_INSTRUCTIONS,
  decodeMp3Duration,
  generateNarration,
  readBoundedResponse,
  requestSpeech,
} from "../../src/narration/narration-media.mjs";

function generatedTone() {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=24000",
      "-t",
      "0.65",
      "-ac",
      "1",
      "-codec:a",
      "libmp3lame",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { encoding: null, maxBuffer: 10 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

function ffprobe(bytes) {
  return spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      "pipe:0",
    ],
    { input: bytes, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
}

const tone = generatedTone();
const apiKey = "not-a-real-provider-key-with-32-bytes";

test("Cedar request is exact, single-attempt, bounded, and independently ffprobe-decodable", async () => {
  const calls = [];
  const bytes = await requestSpeech({
    apiKey,
    text: "Bienvenue dans notre famille.",
    idempotencyKey: "command_123-fr-intro",
    signal: AbortSignal.timeout(1_000),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(tone, {
        headers: {
          "content-length": String(tone.length),
          "content-type": "audio/mpeg",
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Authorization, ["Bearer", apiKey].join(" "));
  assert.equal(calls[0].init.headers["Idempotency-Key"], "command_123-fr-intro");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    input: "Bienvenue dans notre famille.",
    response_format: "mp3",
    instructions: CEDAR_NARRATION_INSTRUCTIONS,
  });
  assert.ok((await decodeMp3Duration(bytes)) > 0.5);
  assert.equal(ffprobe(bytes).status, 0);
});

test("provider, timeout, oversized, malformed, and truncated failures are redacted and terminal", async () => {
  const providerSecret = "provider-secret-body-must-not-leak";
  let attempts = 0;
  await assert.rejects(
    requestSpeech({
      apiKey,
      text: "Bienvenue.",
      idempotencyKey: "command_123-fr-intro",
      signal: AbortSignal.timeout(1_000),
      fetch: async () => {
        attempts += 1;
        return new Response(providerSecret, { status: 429 });
      },
    }),
    (error) =>
      error.message === "tts_provider_rejected" &&
      !error.message.includes(providerSecret),
  );
  assert.equal(attempts, 1);

  await assert.rejects(
    readBoundedResponse(
      new Response(new Uint8Array(32), {
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
      8 * 1024 * 1024,
      AbortSignal.timeout(1_000),
    ),
    /response_too_large/,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  let cancelled = false;
  try {
    await assert.rejects(
      readBoundedResponse(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
        1024,
        controller.signal,
      ),
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(cancelled, true);

  const malformed = Buffer.from("not an mp3");
  const truncated = tone.subarray(0, 64);
  await assert.rejects(decodeMp3Duration(malformed), /invalid_audio/);
  await assert.rejects(decodeMp3Duration(truncated), /invalid_audio/);
  assert.notEqual(ffprobe(malformed).status, 0);
  assert.notEqual(ffprobe(truncated).status, 0);
});

test("approved source binding survives durable upload and forged job or revision input is rejected", async () => {
  const source = {
    kind: "prepared_bundle",
    revisionId: "r7",
    pageDigest: "a".repeat(64),
    transcriptDigest: "b".repeat(64),
    assetManifestDigest: "c".repeat(64),
    sourcePrivateReviewManifestDigest: "d".repeat(64),
    manifestRef: "jobs/job_test/revisions/r7/manifests/prepared_bundle.json",
    files: [
      {
        path: "artifacts/current/page.json",
        storageId: "source-page",
        sha256: "a".repeat(64),
        bytes: 10,
      },
    ],
  };
  const page = {
    jobId: "job_test",
    pageRevision: "r7",
    languages: ["fr"],
    sectionOrder: ["intro"],
    sections: {
      intro: { fr: { narrationText: "Bienvenue dans notre famille." } },
    },
  };
  const uploads = [];
  const artifact = await generateNarration({
    jobId: "job_test",
    prepared: source,
    page,
    apiKey,
    idempotencyKey: "command_test",
    signal: AbortSignal.timeout(3_000),
    fetch: async () =>
      new Response(tone, { headers: { "content-type": "audio/mpeg" } }),
    upload: async (path, bytes, contentType) => {
      uploads.push({ path, bytes, contentType });
      return `storage-${uploads.length}`;
    },
  });

  assert.deepEqual(
    artifact.files.find((file) => file.path === source.files[0].path),
    source.files[0],
  );
  assert.equal(
    artifact.sourcePreparedBundleManifestDigest,
    source.assetManifestDigest,
  );
  assert.deepEqual(
    uploads.map(({ path, contentType }) => ({ path, contentType })),
    [
      {
        path: "artifacts/audio/fr/intro.mp3",
        contentType: "audio/mpeg",
      },
      {
        path: "artifacts/transcript.json",
        contentType: "application/json",
      },
      {
        path: "artifacts/narration-review.json",
        contentType: "application/json",
      },
    ],
  );
  const review = JSON.parse(
    uploads.find((upload) => upload.path === "artifacts/narration-review.json").bytes,
  );
  assert.equal(review.jobId, "job_test");
  assert.equal(review.revisionId, "r7");
  assert.equal(review.preparedManifestDigest, source.assetManifestDigest);
  assert.equal(review.model, "gpt-4o-mini-tts");
  assert.equal(review.voice, "cedar");

  for (const changedPage of [
    { ...page, jobId: "job_other" },
    { ...page, pageRevision: "r8" },
  ]) {
    await assert.rejects(
      generateNarration({
        jobId: "job_test",
        prepared: source,
        page: changedPage,
        apiKey,
        idempotencyKey: "command_test",
        signal: AbortSignal.timeout(1_000),
        fetch: async () => new Response(tone),
        upload: async () => "unused",
      }),
      /approved_page_binding_invalid/,
    );
  }
});
