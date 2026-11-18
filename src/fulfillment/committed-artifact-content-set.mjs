import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  collectArtifactSnapshotFromRoot,
  readBoundedFileFromRoot,
} from "./secure-filesystem-snapshot.mjs";

const DIGEST = /^[a-f0-9]{64}$/u;

/**
 * Capture exact artifact bytes into an opaque, disposable capability.
 *
 * This API intentionally makes no claim that several mutable paths formed an
 * atomic filesystem snapshot. Producer mode commits the exact bytes captured
 * here. Restart mode instead authenticates every captured byte and the complete
 * inventory against a manifest that existed before capture. Consumers can only
 * receive defensive copies of the owned bytes.
 */
export async function captureCommittedArtifactContentSet(input) {
  const authority = validateAuthority(input?.authority);
  const inventoryPrefix = input.inventoryPrefix ?? input.manifestPrefix ?? "";
  const collection = await collectArtifactSnapshotFromRoot({
    rootPath: input.rootPath,
    inventoryRoot: input.inventoryRoot,
    inventoryPrefix,
    excludedPaths: input.excludedPaths,
    pagePath: input.pagePath,
    pageManifestPath: input.pageManifestPath,
    transcriptPath: input.transcriptPath,
    transcriptManifestPath: input.transcriptManifestPath,
    requiredPaths: input.requiredPaths,
    maximumFileBytes: input.maximumFileBytes,
    maximumJsonBytes: input.maximumJsonBytes,
    maximumTotalBytes: input.maximumTotalBytes,
    maximumFiles: input.maximumFiles,
  });
  if (collection === null) return null;

  const ownedBytes = new Map();
  const committedFiles = [];
  let totalBytes = 0;
  try {
    for (const discovered of collection.files) {
      const sourcePath = sourcePathForLogicalArtifact(input, inventoryPrefix, discovered.path);
      const maximumBytes = sourcePath === input.pagePath || sourcePath === input.transcriptPath
        ? input.maximumJsonBytes
        : input.maximumFileBytes;
      const captured = await readBoundedFileFromRoot({
        rootPath: input.rootPath,
        filePath: sourcePath,
        maximumBytes,
      });
      if (captured === null) throw commitmentError(`Artifact disappeared before commitment: ${discovered.path}`);
      const bytes = Buffer.from(captured.bytes);
      totalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > input.maximumTotalBytes) {
        throw commitmentError("Committed artifact bytes exceed the configured total limit.");
      }
      ownedBytes.set(discovered.path, bytes);
      committedFiles.push(Object.freeze({
        path: discovered.path,
        bytes: bytes.byteLength,
        sha256: captured.sha256,
      }));
    }

    committedFiles.sort((left, right) => left.path.localeCompare(right.path));
    if (committedFiles.length === 0) return null;
    assertRequiredSourcesRepresented(input, inventoryPrefix, committedFiles);
    if (authority.type === "persisted-manifest") {
      const actual = committedFiles.map((file) => ({ ...file }));
      if (!isDeepStrictEqual(actual, authority.files)) {
        throw commitmentError("Captured artifact content does not match the persisted manifest.");
      }
    }

    const pageLogicalPath = logicalPathForSource(input, inventoryPrefix, input.pagePath);
    const transcriptLogicalPath = logicalPathForSource(input, inventoryPrefix, input.transcriptPath);
    const pageFile = committedFiles.find((file) => file.path === pageLogicalPath);
    const transcriptFile = committedFiles.find((file) => file.path === transcriptLogicalPath);
    if (!pageFile || !transcriptFile) {
      throw commitmentError("Committed artifact roles are incomplete.");
    }

    let disposed = false;
    const manifest = Object.freeze({
      schemaVersion: "1.0",
      authority: authority.type,
      files: Object.freeze(committedFiles),
      pageDigest: pageFile.sha256,
      transcriptDigest: transcriptFile.sha256,
      totalBytes,
    });
    return Object.freeze({
      manifest,
      read(logicalPath) {
        if (disposed) throw commitmentError("Committed artifact content capability is disposed.");
        const bytes = ownedBytes.get(logicalPath);
        if (!bytes) throw commitmentError(`Committed artifact path is unavailable: ${logicalPath}`);
        return Buffer.from(bytes);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const bytes of ownedBytes.values()) bytes.fill(0);
        ownedBytes.clear();
      },
    });
  } catch (error) {
    for (const bytes of ownedBytes.values()) bytes.fill(0);
    ownedBytes.clear();
    throw error;
  }
}

function validateAuthority(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw commitmentError("A committed-content authority is required.");
  }
  if (value.type === "producer-owned" && Object.keys(value).join("\0") === "type") {
    return Object.freeze({ type: value.type });
  }
  if (value.type !== "persisted-manifest" || !Array.isArray(value.files)) {
    throw commitmentError("Committed-content authority is invalid.");
  }
  const seen = new Set();
  const files = value.files.map((file) => {
    if (
      !file
      || typeof file.path !== "string"
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || !DIGEST.test(file.sha256)
      || seen.has(file.path)
    ) {
      throw commitmentError("Persisted manifest files are invalid.");
    }
    seen.add(file.path);
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({ type: value.type, files });
}

function sourcePathForLogicalArtifact(input, inventoryPrefix, logicalPath) {
  if (input.pageManifestPath && logicalPath === input.pageManifestPath) return input.pagePath;
  if (input.transcriptManifestPath && logicalPath === input.transcriptManifestPath) return input.transcriptPath;
  const relativePath = inventoryPrefix === ""
    ? logicalPath
    : logicalPath.startsWith(`${inventoryPrefix}/`)
      ? logicalPath.slice(inventoryPrefix.length + 1)
      : null;
  if (!relativePath) throw commitmentError(`Artifact path is outside the committed inventory: ${logicalPath}`);
  return path.join(input.inventoryRoot, ...relativePath.split("/"));
}

function logicalPathForSource(input, inventoryPrefix, sourcePath) {
  if (sourcePath === input.pagePath && input.pageManifestPath) return input.pageManifestPath;
  if (sourcePath === input.transcriptPath && input.transcriptManifestPath) return input.transcriptManifestPath;
  const relative = path.relative(input.inventoryRoot, sourcePath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw commitmentError("Artifact role is outside the committed inventory without an explicit manifest path.");
  }
  const logical = relative.split(path.sep).join("/");
  return inventoryPrefix ? `${inventoryPrefix}/${logical}` : logical;
}

function assertRequiredSourcesRepresented(input, inventoryPrefix, files) {
  const filePaths = new Set(files.map((file) => file.path));
  for (const requiredPath of input.requiredPaths || []) {
    const logicalPath = logicalPathForSource(input, inventoryPrefix, requiredPath);
    if (!filePaths.has(logicalPath)) {
      throw commitmentError(`Required artifact is absent from the committed inventory: ${logicalPath}`);
    }
  }
}

function commitmentError(message) {
  const error = new Error(message);
  error.reasonCode = "artifact_content_commitment_invalid";
  error.retryable = false;
  return error;
}
