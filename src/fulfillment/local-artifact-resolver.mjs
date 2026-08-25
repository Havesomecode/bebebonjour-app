import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const KIND_ROOTS = Object.freeze({
  prepared_bundle: "prepared",
  narration_review: "narration-review",
});
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export function createLocalArtifactResolver({ rootPath } = {}) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
    throw new Error("TEST_A_ARTIFACT_ROOT must be an absolute local artifact workspace path.");
  }
  const configuredRoot = path.resolve(rootPath);

  return Object.freeze({
    async resolve(request) {
      const artifactSet = request?.artifactSet;
      const kindRoot = KIND_ROOTS[artifactSet?.kind];
      if (!kindRoot) throw bindingError("The publication artifact kind has no local source resolver.");
      if (artifactSet.revisionId !== request.revisionId) {
        throw bindingError("The local artifact source revision does not match the publication request.");
      }
      const revisionPrefix = `jobs/${request.jobId}/revisions/${request.revisionId}`;
      const expectedManifestRef = `${revisionPrefix}/manifests/${artifactSet.kind}.json`;
      if (artifactSet.manifestRef !== expectedManifestRef) {
        throw bindingError("The persisted artifact manifest reference is outside the exact job revision.");
      }
      if (!Array.isArray(artifactSet.files) || artifactSet.files.length === 0 || artifactSet.files.length > MAX_FILES) {
        throw bindingError("The persisted artifact manifest file count is outside the TEST-A limit.");
      }

      const rootRealPath = await realpath(configuredRoot);
      const manifestPath = path.join(configuredRoot, ...expectedManifestRef.split("/"));
      const manifestBytes = await readRegularFileInside(rootRealPath, manifestPath, "persisted artifact manifest");
      if (sha256(manifestBytes) !== request.artifactManifestDigest) {
        throw bindingError("The persisted manifest digest does not match the exact publication operation.");
      }
      let manifest;
      try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
      } catch {
        throw bindingError("The persisted artifact manifest is not valid JSON.");
      }
      if (
        manifest?.schemaVersion !== "1.0"
        || manifest.kind !== artifactSet.kind
        || manifest.revisionId !== request.revisionId
        || !isDeepStrictEqual(manifest.files, artifactSet.files)
      ) {
        throw bindingError("The persisted artifact manifest does not match the exact artifact set.");
      }

      const seenPaths = new Set();
      const sourceRoot = path.join(configuredRoot, ...revisionPrefix.split("/"), kindRoot);
      let totalBytes = 0;
      const resolvedFiles = [];
      for (const file of artifactSet.files) {
        assertSafeRelativePath(file?.path, "artifact source path");
        if (seenPaths.has(file.path)) throw bindingError("The artifact manifest contains duplicate source paths.");
        seenPaths.add(file.path);
        if (file.storageId !== `local-test:sha256:${file.sha256}`) {
          throw bindingError("The artifact storage id is not bound to its exact source digest.");
        }
        const sourcePath = path.join(sourceRoot, ...file.path.split("/"));
        const bytes = await readRegularFileInside(rootRealPath, sourcePath, `artifact source ${file.path}`);
        if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
          throw bindingError(`Artifact source bytes do not match the persisted digest and count: ${file.path}`);
        }
        totalBytes += bytes.byteLength;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
          throw bindingError("The resolved artifact bytes exceed the TEST-A publication limit.");
        }
        if (file.path.startsWith("deploy/")) {
          const publicPath = file.path.slice("deploy/".length);
          assertSafeRelativePath(publicPath, "public artifact path");
          resolvedFiles.push(Object.freeze({
            sourcePath: file.path,
            publicPath,
            sha256: file.sha256,
            bytes,
          }));
        }
      }
      const slug = resolvedFiles[0]?.publicPath.split("/")[0];
      if (!slug || resolvedFiles.some(({ publicPath }) => !publicPath.startsWith(`${slug}/`))) {
        throw bindingError("The approved deploy bundle must contain exactly one slug namespace.");
      }
      const publicFiles = resolvedFiles.map((file) => Object.freeze({
        ...file,
        publicPath: file.publicPath.slice(slug.length + 1),
      }));
      const entrypointPath = ["fr/index.html", "ar/index.html"]
        .find((candidate) => publicFiles.some(({ publicPath }) => publicPath === candidate));
      if (!entrypointPath) {
        throw bindingError("The approved deploy bundle must contain a French or Arabic language entrypoint.");
      }
      return Object.freeze({
        manifestBytes,
        entrypointPath,
        files: Object.freeze(publicFiles),
      });
    },
  });
}

async function readRegularFileInside(rootRealPath, filePath, label) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    throw bindingError(`${label} is unavailable.`, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw bindingError(`${label} must be a regular non-symbolic file.`);
  let fileRealPath;
  try {
    fileRealPath = await realpath(filePath);
  } catch (error) {
    throw bindingError(`${label} cannot be resolved.`, error);
  }
  const relative = path.relative(rootRealPath, fileRealPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw bindingError(`${label} resolves outside TEST_A_ARTIFACT_ROOT.`);
  }
  try {
    return await readFile(fileRealPath);
  } catch (error) {
    throw bindingError(`${label} cannot be read.`, error);
  }
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw bindingError(`${label} is invalid.`);
  }
  const segments = value.split("/");
  if (
    value.startsWith("/")
    || value.includes("\\")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw bindingError(`${label} must be a safe relative path.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bindingError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.reasonCode = "publication_source_binding_invalid";
  error.retryable = false;
  return error;
}
