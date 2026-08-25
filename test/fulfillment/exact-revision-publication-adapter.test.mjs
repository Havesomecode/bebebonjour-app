import assert from "node:assert/strict";
import test from "node:test";

import { createExactRevisionPublicationAdapter } from "../../src/fulfillment/exact-revision-publication-adapter.mjs";

const request = Object.freeze({
  jobId: "job_test_001",
  environment: "test",
  product: "announcement-page",
  revisionId: "r1",
  artifactSetId: "artifact-set-test-001",
  artifactManifestDigest: "a".repeat(64),
  artifactSet: {
    kind: "prepared_bundle",
    revisionId: "r1",
    pageDigest: "b".repeat(64),
    transcriptDigest: "c".repeat(64),
    assetManifestDigest: "a".repeat(64),
    manifestRef: "jobs/job_test_001/revisions/r1/manifests/prepared_bundle.json",
    files: [{
      path: "deploy/index.html",
      sha256: "d".repeat(64),
      bytes: 100,
      storageId: `local-test:sha256:${"d".repeat(64)}`,
    }],
  },
  idempotencyKey: `bb_${"e".repeat(64)}`,
});

test("exact revision publication adapter passes only the bound TEST-A artifact manifest to its private provider", async () => {
  const calls = [];
  const adapter = createExactRevisionPublicationAdapter({
    stableOrigin: "https://announcements.example.test",
    provider: {
      async reconcile(value) {
        calls.push({ method: "reconcile", value });
        return null;
      },
      async publish(value) {
        calls.push({ method: "publish", value });
        return {
          provider: "vercel",
          providerReceiptId: "deployment_test_001",
          stableUrl: "https://announcements.example.test/announcements/job_test_001",
          revisionId: value.revisionId,
          artifactManifestDigest: value.artifactManifestDigest,
          idempotencyKey: value.idempotencyKey,
        };
      },
    },
  });

  assert.equal(await adapter.reconcile(request), null);
  const receipt = await adapter.publish(request);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].value, request);
  assert.equal(receipt.revisionId, request.revisionId);
  assert.equal(receipt.artifactManifestDigest, request.artifactManifestDigest);
});

test("exact revision publication adapter rejects unsafe manifest paths before the provider boundary", async () => {
  let calls = 0;
  const adapter = createExactRevisionPublicationAdapter({
    provider: {
      async reconcile() {
        return null;
      },
      async publish() {
        calls += 1;
        return {};
      },
    },
    stableOrigin: "https://announcements.example.test",
  });

  await assert.rejects(adapter.publish({
    ...request,
    artifactSet: {
      ...request.artifactSet,
      manifestRef: "../../private/review.json",
      files: [{ ...request.artifactSet.files[0], path: "../review.json" }],
    },
  }), /safe relative path/i);
  assert.equal(calls, 0);
});
