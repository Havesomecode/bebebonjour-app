import {
  commandPrepareReview,
  preflightPrivateReviewComposition,
} from "../../scripts/lib/commands.mjs";

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
  const compose = options.compose || null;
  if (compose !== null && typeof compose !== "function") {
    throw new Error("The local subscription composition capability is invalid.");
  }
  const preflightComposition = options.preflightComposition || preflightPrivateReviewComposition;
  if (compose !== null && typeof preflightComposition !== "function") {
    throw new Error("The private-review composition preflight is required.");
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
      const intakeSnapshot = requiredIntakeSnapshot(paths);
      const editorialApproval = requiredEditorialApproval(paths);
      const prepareArgs = {
        input: requiredPath(paths, "inputRecordPath"),
        output: requiredPath(paths, "reviewRoot"),
        ...(paths.selectionId ? { select: paths.selectionId } : {}),
      };
      if (compose) {
        const preflight = await preflightComposition(prepareArgs, {
          editorialApproval,
          intakeSnapshot,
        });
        if (preflight?.state !== "composition_ready") {
          throw new Error(`Private-review composition preflight rejected: ${preflight?.state || "invalid"}.`);
        }
      }
      const composition = compose
        ? await compose(intakeSnapshot, { signal: context.signal })
        : null;
      if (compose) await context.assertStageOwnership();
      await prepareReview(prepareArgs, {
        editorialApproval,
        intakeSnapshot,
        ...(composition ? { composition } : {}),
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
