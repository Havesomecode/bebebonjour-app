import { commandPrepareReview } from "../../scripts/lib/commands.mjs";

export function createLocalPrepareReviewStageHandler(options = {}) {
  if (
    typeof options.resolveJobPaths !== "function"
    || typeof options.collectArtifactSet !== "function"
    || typeof options.cleanupStageOutput !== "function"
  ) {
    throw new Error("Generation-only path resolution, artifact collection, and cleanup are required.");
  }
  const prepareReview = options.prepareReview || commandPrepareReview;
  if (typeof prepareReview !== "function") {
    throw new Error("The deterministic prepare-review command is required.");
  }

  return async function prepareReviewStage(context) {
    if (typeof context?.assertStageOwnership !== "function") {
      throw new Error("Generation-only stage ownership verification is required.");
    }
    await context.assertStageOwnership();
    const paths = await options.resolveJobPaths(context.job);
    const expectedRevisionId = paths?.revision?.revisionId;
    if (!paths || typeof paths !== "object" || !expectedRevisionId) {
      throw new Error("Generation-only job paths could not be resolved.");
    }
    const existing = await options.collectArtifactSet({
      kind: "private_review",
      context,
      paths,
    });
    if (existing) {
      assertArtifactBinding(existing, expectedRevisionId);
      return {
        revision: structuredClone(paths.revision),
        artifactSet: existing,
      };
    }

    try {
      await prepareReview({
        input: requiredPath(paths, "inputRecordPath"),
        output: requiredPath(paths, "reviewRoot"),
        ...(paths.selectionId ? { select: paths.selectionId } : {}),
      }, {
        editorialApproval: requiredEditorialApproval(paths),
        intakeSnapshot: requiredIntakeSnapshot(paths),
        silent: true,
      });
      await context.assertStageOwnership();
    } catch (error) {
      let stillOwned = false;
      try {
        await context.assertStageOwnership();
        stillOwned = true;
      } catch {
        // A stale attempt must not remove output that a successor lease may own.
      }
      if (stillOwned) {
        await options.cleanupStageOutput({ kind: "private_review", context, paths });
      }
      throw error;
    }

    const artifactSet = await options.collectArtifactSet({
      kind: "private_review",
      context,
      paths,
    });
    assertArtifactBinding(artifactSet, expectedRevisionId);
    return {
      revision: structuredClone(paths.revision),
      artifactSet,
    };
  };
}

function requiredEditorialApproval(paths) {
  const approval = paths?.editorialApproval;
  if (
    !approval
    || typeof approval !== "object"
    || typeof approval.record !== "object"
    || typeof approval.recordDigest !== "string"
  ) {
    throw new Error("Resolved generation-only editorial approval is required.");
  }
  return approval;
}

function requiredIntakeSnapshot(paths) {
  const intake = paths?.intakeSnapshot;
  if (!intake || typeof intake !== "object" || Array.isArray(intake)) {
    throw new Error("Resolved generation-only intake snapshot is required.");
  }
  return structuredClone(intake);
}

function assertArtifactBinding(artifactSet, expectedRevisionId) {
  if (artifactSet?.kind !== "private_review" || artifactSet.revisionId !== expectedRevisionId) {
    throw new Error("Private-review artifacts must bind the exact generated revision.");
  }
}

function requiredPath(paths, key) {
  const value = paths?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Resolved generation-only path ${key} is required.`);
  }
  return value;
}
