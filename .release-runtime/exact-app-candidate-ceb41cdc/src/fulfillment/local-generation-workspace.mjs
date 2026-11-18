import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const ARTIFACT_LAYOUTS = Object.freeze({
  private_review: {
    rootKey: "reviewRoot",
    page: ["artifacts", "current", "page.json"],
    transcript: ["artifacts", "current", "transcript.json"],
    inventoryRootKey: "reviewRoot",
    inventoryPrefix: "",
    excludedPaths: new Set(),
  },
  prepared_bundle: {
    rootKey: "preparedRoot",
    page: ["artifacts", "current", "page.json"],
    transcript: ["artifacts", "current", "transcript.json"],
    inventoryRootKey: "preparedRoot",
    inventoryPrefix: "",
    excludedPaths: new Set(["job.json"]),
  },
  narration_review: {
    rootKey: "narrationReviewRoot",
    pageRootKey: "approvedRoot",
    page: ["page.json"],
    transcript: ["artifacts", "transcript.json"],
    inventoryRootKey: "narrationArtifactsRoot",
    inventoryPrefix: "artifacts",
    excludedPaths: new Set(),
  },
});

export function createLocalGenerationWorkspace({ rootPath }) {
  if (typeof rootPath !== "string" || rootPath.trim() === "") {
    throw new Error("A local generation workspace rootPath is required.");
  }
  const resolvedRoot = path.resolve(rootPath);

  async function persistJobInput({ jobId, intakeDigest, intake, selectionId = null }) {
    assertJobId(jobId);
    assertDigest(intakeDigest, "persisted intake digest");
    if (!intake || typeof intake !== "object" || Array.isArray(intake)) {
      throw new Error("A persisted intake object is required.");
    }
    if (selectionId !== null && (typeof selectionId !== "string" || selectionId.trim() === "")) {
      throw new Error("A persisted compose selection must be a non-empty string or null.");
    }
    const jobRoot = path.join(resolvedRoot, "jobs", jobId);
    const inputRoot = path.join(jobRoot, "input");
    const intakePath = path.join(inputRoot, "intake.json");
    const recordPath = path.join(inputRoot, "generation-input.json");
    const record = {
      schemaVersion: "1.0",
      jobId,
      intakeDigest,
      selectionId,
      intake,
    };
    const recordRaw = `${JSON.stringify(record, null, 2)}\n`;
    const intakeRaw = `${JSON.stringify(intake, null, 2)}\n`;
    await mkdir(inputRoot, { recursive: true, mode: 0o700 });
    const existing = await readJsonIfPresent(recordPath);
    if (existing) {
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error("Persisted generation input cannot be rebound to different job inputs.");
      }
      return { intakePath, recordPath };
    }
    await atomicWrite(intakePath, intakeRaw, 0o600);
    await atomicWrite(recordPath, recordRaw, 0o600);
    return { intakePath, recordPath };
  }

  async function resolveJobPaths(job) {
    assertJobId(job?.jobId);
    assertDigest(job?.intakeDigest, "job intake digest");
    const jobRoot = path.join(resolvedRoot, "jobs", job.jobId);
    const inputRoot = path.join(jobRoot, "input");
    const intakePath = path.join(inputRoot, "intake.json");
    const inputRecord = await readJsonRequired(
      path.join(inputRoot, "generation-input.json"),
      "Persisted generation input",
    );
    if (
      inputRecord.schemaVersion !== "1.0"
      || inputRecord.jobId !== job.jobId
      || inputRecord.intakeDigest !== job.intakeDigest
    ) {
      throw new Error("Persisted generation input does not match the exact fulfillment job.");
    }
    const ordinal = revisionOrdinalFor(job);
    const revisionId = `r${ordinal}`;
    const revisionRoot = path.join(jobRoot, "revisions", revisionId);
    const approvedRoot = path.join(revisionRoot, "approved");
    const preparedRoot = path.join(revisionRoot, "prepared");
    const narrationReviewRoot = path.join(revisionRoot, "narration-review");
    const finalRoot = path.join(revisionRoot, "final");
    return {
      workspaceRoot: resolvedRoot,
      jobRoot,
      inputRoot,
      intakePath,
      reviewRoot: path.join(revisionRoot, "private-review"),
      approvedRoot,
      approvedPagePath: path.join(approvedRoot, "page.json"),
      approvalPath: path.join(approvedRoot, "approval.json"),
      preparedRoot,
      narrationReviewRoot,
      narrationArtifactsRoot: path.join(narrationReviewRoot, "artifacts"),
      finalRoot,
      jobPath: path.join(finalRoot, "job.json"),
      manifestRoot: path.join(revisionRoot, "manifests"),
      selectionId: inputRecord.selectionId,
      languages: Array.isArray(inputRecord.intake?.languages) ? [...inputRecord.intake.languages] : [],
      revision: { revisionId, ordinal, inputDigest: job.intakeDigest },
      stableUrl: `https://example.invalid/announcements/${encodeURIComponent(job.jobId)}`,
    };
  }

  async function collectArtifactSet({ kind, paths }) {
    const layout = ARTIFACT_LAYOUTS[kind];
    if (!layout) throw new Error(`Unsupported local artifact kind: ${kind}`);
    const stageRoot = requiredResolvedPath(paths, layout.rootKey);
    const inventoryRoot = requiredResolvedPath(paths, layout.inventoryRootKey);
    const pageRoot = layout.pageRootKey
      ? requiredResolvedPath(paths, layout.pageRootKey)
      : stageRoot;
    for (const candidate of [stageRoot, inventoryRoot, pageRoot]) {
      assertInsideRoot(resolvedRoot, candidate);
    }
    const pagePath = path.join(pageRoot, ...layout.page);
    const transcriptPath = path.join(stageRoot, ...layout.transcript);
    if (!await allRegularFilesExist([pagePath, transcriptPath])) return null;
    const files = await collectFiles(inventoryRoot, layout.inventoryPrefix, layout.excludedPaths);
    if (files.length === 0) return null;
    const manifest = {
      schemaVersion: "1.0",
      kind,
      revisionId: paths.revision?.revisionId,
      files,
    };
    const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestRoot = requiredResolvedPath(paths, "manifestRoot");
    assertInsideRoot(resolvedRoot, manifestRoot);
    const manifestPath = path.join(manifestRoot, `${kind}.json`);
    const existingRaw = await readTextIfPresent(manifestPath);
    if (existingRaw !== null && existingRaw !== manifestRaw) {
      throw new Error(`${kind} artifacts diverge from the persisted manifest.`);
    }
    if (existingRaw === null) {
      await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
      await atomicWrite(manifestPath, manifestRaw, 0o600);
    }
    return {
      kind,
      revisionId: paths.revision.revisionId,
      pageDigest: sha256(await readFile(pagePath)),
      transcriptDigest: sha256(await readFile(transcriptPath)),
      assetManifestDigest: sha256(manifestRaw),
      manifestRef: relativePosix(resolvedRoot, manifestPath),
      files,
    };
  }

  async function cleanupStageOutput({ kind, paths }) {
    const layout = ARTIFACT_LAYOUTS[kind];
    if (!layout) throw new Error(`Unsupported local artifact kind: ${kind}`);
    const stageRoot = requiredResolvedPath(paths, layout.rootKey);
    assertInsideRoot(resolvedRoot, stageRoot);
    const manifestRoot = requiredResolvedPath(paths, "manifestRoot");
    assertInsideRoot(resolvedRoot, manifestRoot);
    const manifestPath = path.join(manifestRoot, `${kind}.json`);
    await Promise.all([
      rm(stageRoot, { recursive: true, force: true }),
      rm(manifestPath, { force: true }),
    ]);
  }

  return {
    rootPath: resolvedRoot,
    persistJobInput,
    resolveJobPaths,
    collectArtifactSet,
    cleanupStageOutput,
  };
}

function revisionOrdinalFor(job) {
  if (job.state === "generating") {
    if (job.currentRevisionId === null) return 1;
    return parseRevisionOrdinal(job.currentRevisionId) + 1;
  }
  if (typeof job.currentRevisionId !== "string") {
    throw new Error("A current revision is required outside content generation.");
  }
  return parseRevisionOrdinal(job.currentRevisionId);
}

function parseRevisionOrdinal(revisionId) {
  const match = /^r([1-9][0-9]*)$/.exec(revisionId || "");
  if (!match) throw new Error("Current revision identity is invalid.");
  return Number.parseInt(match[1], 10);
}

async function collectFiles(root, prefix, excludedPaths) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = relativePosix(root, entryPath);
      const artifactPath = prefix ? `${prefix}/${relativePath}` : relativePath;
      if (entry.isSymbolicLink()) {
        throw new Error(`Generated artifacts cannot contain symbolic links: ${artifactPath}`);
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && !excludedPaths.has(artifactPath)) {
        const bytes = await readFile(entryPath);
        const digest = sha256(bytes);
        files.push({
          path: artifactPath,
          sha256: digest,
          bytes: bytes.byteLength,
          storageId: `local-test:sha256:${digest}`,
        });
      }
    }
  }
  await visit(root);
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function allRegularFilesExist(paths) {
  for (const filePath of paths) {
    try {
      if (!(await lstat(filePath)).isFile()) return false;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function readJsonRequired(filePath, label) {
  const value = await readJsonIfPresent(filePath);
  if (!value) throw new Error(`${label} is missing.`);
  return value;
}

async function readJsonIfPresent(filePath) {
  const raw = await readTextIfPresent(filePath);
  return raw === null ? null : JSON.parse(raw);
}

async function readTextIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filePath, content, mode) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode });
  await rename(temporaryPath, filePath);
}

function requiredResolvedPath(paths, key) {
  const value = paths?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Resolved job path ${key} is required.`);
  }
  return path.resolve(value);
}

function assertInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Generated stage output must be a child of the local workspace root.");
  }
}

function relativePosix(root, candidate) {
  assertInsideRoot(root, candidate);
  return path.relative(root, candidate).split(path.sep).join("/");
}

function assertJobId(jobId) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new Error("Local generation jobId must be a safe opaque identifier.");
  }
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
