import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createLocalGenerationWorkspace } from "./local-generation-workspace.mjs";

export function createHostedGenerationWorkspace(options = {}) {
  const rootPath = options.rootPath;
  const artifactStore = options.artifactStore;
  if (typeof rootPath !== "string" || rootPath.trim() === "") {
    throw new Error("Hosted generation requires an ephemeral staging root.");
  }
  for (const method of ["readArtifactSet", "uploadArtifactSet", "downloadArtifact"]) {
    if (typeof artifactStore?.[method] !== "function") {
      throw new Error(`Hosted generation artifact store ${method} is required.`);
    }
  }
  const local = createLocalGenerationWorkspace({ rootPath });

  return Object.freeze({
    rootPath: local.rootPath,

    persistJobInput(input) {
      return local.persistJobInput({ ...input, requireExisting: false });
    },

    resolveJobPaths: local.resolveJobPaths,

    async collectArtifactSet(input) {
      assertPrivateReview(input);
      const jobId = input.context?.job?.jobId;
      const revisionId = input.paths?.revision?.revisionId;
      const remote = await artifactStore.readArtifactSet(jobId, revisionId, "private_review");
      if (remote) {
        const reconstructed = await hydrateRemoteArtifactSet({ remote, paths: input.paths });
        assertSameArtifactBinding(reconstructed.hosted, remote.artifactSet);
        return remote.artifactSet;
      }

      const captured = await local.captureArtifactSet(input);
      if (!captured) return null;
      try {
        return await artifactStore.uploadArtifactSet({
          jobId,
          artifactSet: captured.artifactSet,
          readArtifact: captured.readArtifact,
        });
      } finally {
        captured.dispose();
      }
    },

    cleanupStageOutput: local.cleanupStageOutput,

    async validateGeneratedReplay(input) {
      await local.persistJobInput({
        jobId: input.job.jobId,
        intakeDigest: input.job.intakeDigest,
        intake: input.intake,
        editorialApproval: input.editorialApproval,
        requireExisting: false,
      });
      const paths = await local.resolveJobPaths(input.job);
      const remote = await artifactStore.readArtifactSet(
        input.job.jobId,
        input.job.currentRevisionId,
        "private_review",
      );
      if (!remote) throw new Error("Durable private-review artifacts are missing.");
      assertSameArtifactBinding(withoutArtifactSetId(input.expectedArtifactSet), remote.artifactSet);
      const reconstructed = await hydrateRemoteArtifactSet({ remote, paths });
      const expectedArtifactSet = {
        ...withoutOperationsCommandId(input.expectedArtifactSet),
        assetManifestDigest: reconstructed.local.assetManifestDigest,
        files: reconstructed.local.files,
      };
      expectedArtifactSet.artifactSetId = localArtifactSetId(input.job.jobId, expectedArtifactSet);
      return local.validateGeneratedReplay({
        ...input,
        expectedArtifactSet,
      });
    },
  });

  async function hydrateRemoteArtifactSet({ remote, paths }) {
    for (const file of remote.files) {
      const target = safeArtifactPath(paths.reviewRoot, file.path);
      const bytes = await artifactStore.downloadArtifact(file, remote.artifactSet);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600 });
    }
    const localFiles = remote.artifactSet.files.map((file) => ({
      ...file,
      storageId: `local-test:sha256:${file.sha256}`,
    }));
    const manifest = {
      schemaVersion: "1.0",
      kind: "private_review",
      revisionId: paths.revision.revisionId,
      files: localFiles,
    };
    const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
    await mkdir(paths.manifestRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(paths.manifestRoot, "private_review.json"), manifestRaw, { mode: 0o600 });
    const localArtifactSet = await local.collectArtifactSet({
      kind: "private_review",
      paths,
      requirePersistedManifest: true,
    });
    if (!localArtifactSet || localArtifactSet.assetManifestDigest !== sha256(manifestRaw)) {
      throw new Error("Durable artifact hydration did not reproduce the local generation manifest.");
    }
    return { hosted: remote.artifactSet, local: localArtifactSet };
  }
}

function assertPrivateReview(input) {
  if (
    input?.kind !== "private_review"
    || typeof input.context?.job?.jobId !== "string"
    || typeof input.paths?.revision?.revisionId !== "string"
    || typeof input.paths?.reviewRoot !== "string"
  ) {
    throw new Error("Hosted generation storage permits only a bound private-review artifact set.");
  }
}

function safeArtifactPath(rootPath, relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath === ""
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Hosted generation artifact path is invalid.");
  }
  const target = path.resolve(rootPath, relativePath);
  const relative = path.relative(path.resolve(rootPath), target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Hosted generation artifact resolves outside its ephemeral stage root.");
  }
  return target;
}

function assertSameArtifactBinding(left, right) {
  const keys = [
    "assetManifestDigest",
    "files",
    "kind",
    "manifestRef",
    "pageDigest",
    "revisionId",
    "transcriptDigest",
  ];
  if (!left || !right || !isDeepStrictEqual(
    Object.fromEntries(keys.map((key) => [key, left[key]])),
    Object.fromEntries(keys.map((key) => [key, right[key]])),
  )) {
    throw new Error("Durable generation artifact binding does not match the canonical fulfillment aggregate.");
  }
}

function withoutArtifactSetId(value) {
  if (!value || typeof value !== "object") return value;
  const { artifactSetId: _artifactSetId, operationsCommandId: _operationsCommandId, ...rest } = value;
  return rest;
}

function withoutOperationsCommandId(value) {
  if (!value || typeof value !== "object") return value;
  const { operationsCommandId: _operationsCommandId, ...rest } = value;
  return rest;
}

function localArtifactSetId(jobId, artifactSet) {
  return `artifacts_${sha256([
    jobId,
    artifactSet.revisionId,
    artifactSet.kind,
    artifactSet.pageDigest,
    artifactSet.transcriptDigest,
    artifactSet.assetManifestDigest,
  ].join("\0")).slice(0, 24)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
