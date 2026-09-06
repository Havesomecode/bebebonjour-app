import assert from "node:assert/strict";
import test from "node:test";

import { createLocalPrepareReviewStageHandler } from "../../src/fulfillment/local-prepare-review-stage-handler.mjs";

const paths = Object.freeze({
  revision: Object.freeze({ revisionId: "r1" }),
  inputRecordPath: "/synthetic/intake.json",
  reviewRoot: "/synthetic/review",
  intakeSnapshot: Object.freeze({ requestId: "req_synthetic" }),
  editorialApproval: Object.freeze({
    record: Object.freeze({ schemaVersion: "1.0" }),
    recordDigest: "a".repeat(64),
  }),
});

test("every deterministic preflight rejection prevents subscription composition", async (t) => {
  for (const state of [
    "needs_editorial_input",
    "name_review_required",
    "blocked",
    "selection_required",
  ]) {
    await t.test(state, async () => {
      let composeCalls = 0;
      let prepareCalls = 0;
      let cleanupCalls = 0;
      const handler = createLocalPrepareReviewStageHandler({
        resolveJobPaths: async () => paths,
        collectArtifactSet: async () => null,
        cleanupStageOutput: async () => { cleanupCalls += 1; },
        preflightComposition: async () => ({ state }),
        compose: async () => { composeCalls += 1; },
        prepareReview: async () => { prepareCalls += 1; },
      });

      await assert.rejects(
        handler({
          job: { jobId: "job_synthetic_preflight" },
          assertStageOwnership: async () => {},
        }),
        new RegExp(`preflight rejected: ${state}`, "iu"),
      );
      assert.equal(composeCalls, 0);
      assert.equal(prepareCalls, 0);
      assert.equal(cleanupCalls, 1);
    });
  }
});
