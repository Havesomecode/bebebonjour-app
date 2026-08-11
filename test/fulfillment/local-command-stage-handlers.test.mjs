import assert from "node:assert/strict";
import test from "node:test";

import { createLocalCommandStageHandlers } from "../../src/fulfillment/local-command-stage-handlers.mjs";

const DIGESTS = Object.freeze({
  pageDigest: "1".repeat(64),
  transcriptDigest: "2".repeat(64),
  assetManifestDigest: "3".repeat(64),
});

function fixture() {
  const calls = [];
  const artifactKinds = [];
  const record = (name) => async (args) => calls.push({ name, args });
  const commands = {
    prepareReview: record("prepare-review"),
    render: record("render"),
    tts: record("tts"),
    deploy: record("deploy"),
    send: record("send"),
    status: record("status"),
  };
  const paths = {
    intakePath: "/synthetic/intake.json",
    reviewRoot: "/synthetic/private-review",
    approvedPagePath: "/synthetic/approved/page.json",
    approvalPath: "/synthetic/approved/approval.json",
    preparedRoot: "/synthetic/prepared",
    narrationReviewRoot: "/synthetic/narration-review",
    finalRoot: "/synthetic/final",
    jobPath: "/synthetic/final/job.json",
    revision: { revisionId: "r1", ordinal: 1, inputDigest: "a".repeat(64) },
    stableUrl: "https://example.invalid/announcements/job_synthetic_001",
  };
  const handlers = createLocalCommandStageHandlers({
    commands,
    resolveJobPaths: async () => paths,
    collectArtifactSet: async ({ kind }) => {
      artifactKinds.push(kind);
      return { kind, revisionId: "r1", ...DIGESTS };
    },
  });
  return { artifactKinds, calls, handlers, paths };
}

test("local command handlers map every lifecycle stage to the existing generator commands", async () => {
  const { artifactKinds, calls, handlers } = fixture();
  const context = {
    job: { jobId: "job_synthetic_001", currentRevisionId: "r1" },
    idempotencyKey: "bb_stable_key",
  };

  const prepared = await handlers.prepare_review({
    ...context,
    job: { ...context.job, currentRevisionId: null },
  });
  const rendered = await handlers.render_approved(context);
  const narration = await handlers.generate_tts(context);
  const publication = await handlers.publish(context);
  const delivery = await handlers.deliver(context);
  await handlers.legacyStatus(context);

  assert.deepEqual(prepared, {
    revision: { revisionId: "r1", ordinal: 1, inputDigest: "a".repeat(64) },
    artifactSet: { kind: "private_review", revisionId: "r1", ...DIGESTS },
  });
  assert.equal(rendered.artifactSet.kind, "prepared_bundle");
  assert.equal(narration.artifactSet.kind, "narration_review");
  assert.deepEqual(publication.publication, {
    provider: "vercel-dry-run",
    revisionId: "r1",
    stableUrl: "https://example.invalid/announcements/job_synthetic_001",
    artifactManifestDigest: DIGESTS.assetManifestDigest,
    providerReceiptId: "bb_stable_key",
  });
  assert.deepEqual(delivery.delivery, {
    provider: "console-dry-run",
    revisionId: "r1",
    providerMessageId: "bb_stable_key",
  });
  assert.deepEqual(artifactKinds, [
    "private_review",
    "prepared_bundle",
    "narration_review",
    "prepared_bundle",
  ]);
  assert.deepEqual(calls, [
    { name: "prepare-review", args: { input: "/synthetic/intake.json", output: "/synthetic/private-review" } },
    {
      name: "render",
      args: {
        input: "/synthetic/approved/page.json",
        approval: "/synthetic/approved/approval.json",
        output: "/synthetic/prepared",
      },
    },
    {
      name: "tts",
      args: {
        input: "/synthetic/approved/page.json",
        approval: "/synthetic/approved/approval.json",
        prepared: "/synthetic/prepared",
        output: "/synthetic/narration-review",
        lang: "all",
      },
    },
    {
      name: "deploy",
      args: {
        input: "/synthetic/final",
        job: "/synthetic/final/job.json",
        "dry-run": true,
        "idempotency-key": "bb_stable_key",
      },
    },
    {
      name: "send",
      args: {
        job: "/synthetic/final/job.json",
        provider: "console",
        "dry-run": true,
        "idempotency-key": "bb_stable_key",
      },
    },
    { name: "status", args: { job: "/synthetic/final/job.json", json: true } },
  ]);
});

test("local publication binds the narrated artifact set after narration approval", async () => {
  const { artifactKinds, handlers } = fixture();
  await handlers.publish({
    job: {
      jobId: "job_synthetic_001",
      currentRevisionId: "r1",
      narrationDecision: { outcome: "approved" },
    },
    idempotencyKey: "bb_narrated_release_key",
  });

  assert.deepEqual(artifactKinds, ["narration_review"]);
});

test("local publication accepts an IPv6 loopback verification URL", async () => {
  const { handlers, paths } = fixture();
  paths.stableUrl = "http://[::1]:4173/announcements/job_synthetic_001";

  const result = await handlers.publish({
    job: { jobId: "job_synthetic_001", currentRevisionId: "r1" },
    idempotencyKey: "bb_ipv6_loopback_key",
  });
  assert.equal(result.publication.stableUrl, paths.stableUrl);
});

test("local command handlers reject non-local publication and delivery configuration", () => {
  assert.throws(
    () => createLocalCommandStageHandlers({
      mode: "production",
      commands: {},
      resolveJobPaths: async () => ({}),
      collectArtifactSet: async () => ({}),
    }),
    /TEST-A local verification only/i,
  );
});

test("local command handlers require an explicitly injected no-network TTS adapter", () => {
  assert.throws(
    () => createLocalCommandStageHandlers({
      resolveJobPaths: async () => ({}),
      collectArtifactSet: async () => ({}),
    }),
    /no-network TTS adapter/i,
  );
});
