import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import {
  assertValidNarrationApproval,
  assertValidNarrationManifest,
  assertValidNarrationReview,
} from "../scripts/lib/schema-validation.mjs";

const schema = JSON.parse(
  await readFile(new URL("../schemas/narration-manifest.schema.json", import.meta.url), "utf8"),
);

const manifest = {
  language: "fr",
  generatedAt: "2026-08-04T12:00:00.000Z",
  files: [
    {
      index: 1,
      section: "intro",
      time: "00:00",
      seconds: 0,
      file: "../_assets/blessed-arrival-1-0-0-r1/audio/narration/fr/01-intro.mp3",
    },
  ],
};

test("narration manifest schema accepts browser-only fields and rejects provider metadata", () => {
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: { "date-time": true },
  }).compile(schema);

  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...manifest, provider: "openai" }), false);
});

test("private narration review and approval schemas reject undeclared evidence", async () => {
  const [reviewSchema, approvalSchema] = await Promise.all([
    readFile(new URL("../schemas/narration-review.schema.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../schemas/narration-approval.schema.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: { "date-time": true },
  });
  const validateReview = ajv.compile(reviewSchema);
  const validateApproval = ajv.compile(approvalSchema);
  const digest = "a".repeat(64);
  const review = {
    schemaVersion: "1.0",
    state: "narration_review_required",
    pageId: "page-bayane",
    revision: "r1",
    buildId: "blessed-arrival-1-0-0-r1",
    contentApprovalDigest: digest,
    preparedBundleDigest: digest,
    generatedAt: "2026-08-04T12:00:00.000Z",
    languages: ["ar", "fr"],
    results: [
      { language: "ar", status: "ok", files: 6 },
      { language: "fr", status: "ok", files: 6 }
    ],
    mediaDigest: digest,
    generation: {
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voiceByLanguage: { ar: "onyx", fr: "coral" },
    },
    artifacts: {
      root: "artifacts",
      transcript: "artifacts/transcript.json",
    },
  };
  const approval = {
    schemaVersion: "1.0",
    state: "approved",
    reviewer: "operator@example.test",
    reviewedAt: "2026-08-04T12:30:00.000Z",
    pageId: "page-bayane",
    revision: "r1",
    buildId: "blessed-arrival-1-0-0-r1",
    contentApprovalDigest: digest,
    basePreparedBundleDigest: digest,
    narrationReviewDigest: digest,
    mediaDigest: digest,
    preparedBundleDigest: digest,
    acknowledgedLanguages: ["ar", "fr"],
    signatureAlgorithm: "hmac-sha256",
    artifacts: {
      narrationReview: "narration-review/review.json",
      narrationApproval: "narration-approval.json",
    },
    signature: digest,
  };

  assert.equal(validateReview(review), true, JSON.stringify(validateReview.errors));
  assert.equal(validateApproval(approval), true, JSON.stringify(validateApproval.errors));
  assert.equal(validateReview({ ...review, rawProviderResponse: {} }), false);
  assert.equal(validateApproval({ ...approval, signingKey: "forbidden" }), false);
  assert.throws(
    () => assertValidNarrationReview({ ...review, generatedAt: "not-a-date" }),
    /invalid narration review/i,
  );
  assert.throws(
    () => assertValidNarrationReview({ ...review, generatedAt: "2026-02-30T12:00:00Z" }),
    /invalid narration review/i,
  );
  assert.throws(
    () => assertValidNarrationManifest({ ...manifest, generatedAt: "not-a-date" }),
    /invalid narration manifest/i,
  );
  assert.throws(
    () => assertValidNarrationApproval({ ...approval, reviewedAt: "not-a-date" }),
    /invalid narration approval/i,
  );
});
