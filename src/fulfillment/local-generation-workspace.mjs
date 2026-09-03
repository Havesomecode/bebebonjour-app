import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import {
  assertValidJobScopedEditorialApproval,
  assertValidReviewDossier,
} from "../../scripts/lib/schema-validation.mjs";
import {
  collectArtifactSnapshotFromRoot,
  readBoundedFileFromRoot,
} from "./secure-filesystem-snapshot.mjs";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 2_048;
const MAX_LOCK_BYTES = 4 * 1024;
const STALE_LOCK_GRACE_MS = 30_000;
const ACTIVE_LOCK_TOKENS = new Set();

const ARTIFACT_LAYOUTS = Object.freeze({
  private_review: {
    rootKey: "reviewRoot",
    page: ["artifacts", "current", "page.json"],
    transcript: ["artifacts", "current", "transcript.json"],
    inventoryRootKey: "reviewRoot",
    inventoryPrefix: "",
    excludedPaths: new Set(),
    required: [["review.json"]],
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
    pageManifestPath: "approved/page.json",
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

  async function persistJobInput({
    jobId,
    intakeDigest,
    intake,
    editorialApproval,
    selectionId = null,
    requireExisting = false,
  }) {
    assertJobId(jobId);
    assertDigest(intakeDigest, "persisted intake digest");
    if (!intake || typeof intake !== "object" || Array.isArray(intake)) {
      throw new Error("A persisted intake object is required.");
    }
    if (selectionId !== null && (typeof selectionId !== "string" || selectionId.trim() === "")) {
      throw new Error("A persisted compose selection must be a non-empty string or null.");
    }
    if (editorialApproval !== undefined && editorialApproval !== null) {
      try {
        assertPersistedEditorialApproval(editorialApproval, jobId);
      } catch {
        throw new Error("A matching job-scoped editorial approval is required.");
      }
    }
    const jobRoot = path.join(resolvedRoot, "jobs", jobId);
    const inputRoot = path.join(jobRoot, "input");
    const recordPath = path.join(inputRoot, "generation-input.json");
    const lockPath = path.join(inputRoot, "generation-input.lock");
    const record = {
      schemaVersion: "1.0",
      jobId,
      intakeDigest,
      selectionId,
      intake,
      ...(editorialApproval ? { editorialApproval } : {}),
    };
    const recordRaw = `${JSON.stringify(record, null, 2)}\n`;
    await assertSafeWorkspacePath(resolvedRoot, inputRoot);
    await mkdir(inputRoot, { recursive: true, mode: 0o700 });
    await assertSafeWorkspacePath(resolvedRoot, inputRoot);
    return withExclusiveFileLock(resolvedRoot, lockPath, async () => {
      await assertSafeWorkspacePath(resolvedRoot, recordPath);
      const existing = await readCanonicalJsonIfPresent(resolvedRoot, recordPath, "Persisted generation input");
      if (existing) {
        if (isDeepStrictEqual(existing, record)) {
          return { recordPath };
        }
        const legacyRecord = { ...record };
        delete legacyRecord.editorialApproval;
        if (
          !editorialApproval
          || Object.hasOwn(existing, "editorialApproval")
          || !isDeepStrictEqual(existing, legacyRecord)
        ) {
          throw new Error("Persisted generation input cannot be rebound to different job inputs.");
        }
        await atomicWrite(resolvedRoot, recordPath, recordRaw, 0o600);
        return { recordPath };
      }
      if (requireExisting) {
        throw new Error("Persisted generation input is missing for an existing attempt.");
      }
      await atomicWrite(resolvedRoot, recordPath, recordRaw, 0o600);
      return { recordPath };
    });
  }

  async function resolveJobPaths(job) {
    assertJobId(job?.jobId);
    assertDigest(job?.intakeDigest, "job intake digest");
    const jobRoot = path.join(resolvedRoot, "jobs", job.jobId);
    const inputRoot = path.join(jobRoot, "input");
    const inputRecordPath = path.join(inputRoot, "generation-input.json");
    await assertSafeWorkspacePath(resolvedRoot, inputRoot);
    const inputRecord = await readCanonicalJsonRequired(
      resolvedRoot,
      inputRecordPath,
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
      inputRecordPath,
      intakeSnapshot: structuredClone(inputRecord.intake),
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
      ...(inputRecord.editorialApproval
        ? { editorialApproval: structuredClone(inputRecord.editorialApproval) }
        : {}),
      languages: Array.isArray(inputRecord.intake?.languages) ? [...inputRecord.intake.languages] : [],
      revision: { revisionId, ordinal, inputDigest: job.intakeDigest },
      stableUrl: `https://example.invalid/announcements/${encodeURIComponent(job.jobId)}`,
    };
  }

  async function collectArtifactSet({ kind, paths, requirePersistedManifest = false }) {
    const layout = ARTIFACT_LAYOUTS[kind];
    if (!layout) throw new Error(`Unsupported local artifact kind: ${kind}`);
    const stageRoot = requiredResolvedPath(paths, layout.rootKey);
    const inventoryRoot = requiredResolvedPath(paths, layout.inventoryRootKey);
    const pageRoot = layout.pageRootKey
      ? requiredResolvedPath(paths, layout.pageRootKey)
      : stageRoot;
    const pagePath = path.join(pageRoot, ...layout.page);
    const transcriptPath = path.join(stageRoot, ...layout.transcript);
    const requiredPaths = (layout.required || []).map((segments) => path.join(stageRoot, ...segments));
    const collection = await collectArtifactSnapshotFromRoot({
      rootPath: resolvedRoot,
      inventoryRoot,
      inventoryPrefix: layout.inventoryPrefix,
      excludedPaths: [...layout.excludedPaths],
      pagePath,
      pageManifestPath: layout.pageManifestPath || null,
      transcriptPath,
      transcriptManifestPath: layout.transcriptManifestPath || null,
      requiredPaths,
      maximumFileBytes: MAX_ARTIFACT_BYTES,
      maximumJsonBytes: MAX_JSON_BYTES,
      maximumTotalBytes: MAX_ARTIFACT_TOTAL_BYTES,
      maximumFiles: MAX_ARTIFACT_FILES,
    });
    if (collection === null) return null;
    const files = collection.files.map((file) => ({
      ...file,
      storageId: `local-test:sha256:${file.sha256}`,
    }));
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
    await assertSafeWorkspacePath(resolvedRoot, manifestRoot);
    const manifestPath = path.join(manifestRoot, `${kind}.json`);
    await assertSafeWorkspacePath(resolvedRoot, manifestPath);
    const existingRaw = await readWorkspaceTextIfPresent(resolvedRoot, manifestPath);
    if (existingRaw !== null && existingRaw !== manifestRaw) {
      throw new Error(`${kind} artifacts diverge from the persisted manifest.`);
    }
    if (existingRaw === null && requirePersistedManifest) {
      throw new Error(`${kind} artifact manifest is missing.`);
    }
    if (existingRaw === null) {
      await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
      await atomicWrite(resolvedRoot, manifestPath, manifestRaw, 0o600);
    }
    return {
      kind,
      revisionId: paths.revision.revisionId,
      pageDigest: collection.pageDigest,
      transcriptDigest: collection.transcriptDigest,
      assetManifestDigest: sha256(manifestRaw),
      manifestRef: relativePosix(resolvedRoot, manifestPath),
      files,
    };
  }

  async function validateGeneratedReplay({
    job,
    intake,
    editorialApproval,
    expectedArtifactSet,
  }) {
    assertJobId(job?.jobId);
    assertDigest(job?.intakeDigest, "job intake digest");
    if (!intake || typeof intake !== "object" || Array.isArray(intake)) {
      throw new Error("Replay intake is invalid.");
    }
    assertPersistedEditorialApproval(editorialApproval, job.jobId);
    const jobRoot = path.join(resolvedRoot, "jobs", job.jobId);
    const inputRoot = path.join(jobRoot, "input");
    await assertSafeWorkspacePath(resolvedRoot, inputRoot);
    const generationInputPath = path.join(inputRoot, "generation-input.json");
    await assertSafeWorkspacePath(resolvedRoot, generationInputPath);
    const inputRecord = await readCanonicalJsonRequired(
      resolvedRoot,
      generationInputPath,
      "Persisted generation input",
    );
    assertPersistedGenerationInput(inputRecord, job);
    assertPersistedEditorialApproval(inputRecord.editorialApproval, job.jobId);
    if (!isDeepStrictEqual(inputRecord.editorialApproval, editorialApproval)) {
      return Object.freeze({ approvalMatches: false });
    }
    if (!isDeepStrictEqual(inputRecord.intake, intake)) {
      throw new Error("Persisted generation intake does not match the canonical customer intake.");
    }

    const canonicalIntakeRaw = `${JSON.stringify(inputRecord.intake, null, 2)}\n`;

    const paths = await resolveJobPaths(job);
    if (paths.revision.revisionId !== job.currentRevisionId) {
      throw new Error("Persisted generation revision does not match the terminal job revision.");
    }
    const dossierPath = path.join(paths.reviewRoot, "review.json");
    await assertSafeWorkspacePath(resolvedRoot, dossierPath);
    const dossier = await readCanonicalJsonRequired(
      resolvedRoot,
      dossierPath,
      "Private-review dossier",
    );
    assertValidReviewDossier(dossier);
    const expectedApprovalBinding = {
      approvalType: editorialApproval.record.approvalType,
      jobId: editorialApproval.record.jobId,
      policy: editorialApproval.record.policy,
      recordDigest: editorialApproval.recordDigest,
      sourceDigest: editorialApproval.record.sourceDigest,
    };
    if (
      dossier.inputDigest !== sha256(canonicalIntakeRaw)
      || dossier.materialDigest !== sha256(JSON.stringify(dossier.generationMaterials))
      || !isDeepStrictEqual(
        dossier.generationMaterials.editorialApproval,
        expectedApprovalBinding,
      )
    ) {
      throw new Error("Private-review dossier does not match the exact persisted generation materials.");
    }

    const reconstructed = await collectArtifactSet({
      kind: "private_review",
      paths,
      requirePersistedManifest: true,
    });
    assertPersistedArtifactSet(expectedArtifactSet, job.jobId);
    if (
      !reconstructed
      || !isDeepStrictEqual(
        artifactSetBinding(reconstructed),
        artifactSetBinding(expectedArtifactSet),
      )
    ) {
      throw new Error("Private-review artifacts do not match the exact persisted terminal artifact set.");
    }
    return Object.freeze({ approvalMatches: true });
  }

  async function cleanupStageOutput({ kind, paths }) {
    const layout = ARTIFACT_LAYOUTS[kind];
    if (!layout) throw new Error(`Unsupported local artifact kind: ${kind}`);
    const stageRoot = requiredResolvedPath(paths, layout.rootKey);
    assertInsideRoot(resolvedRoot, stageRoot);
    const manifestRoot = requiredResolvedPath(paths, "manifestRoot");
    assertInsideRoot(resolvedRoot, manifestRoot);
    await assertSafeWorkspacePath(resolvedRoot, stageRoot);
    await assertSafeWorkspacePath(resolvedRoot, manifestRoot);
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
    validateGeneratedReplay,
  };
}

function assertPersistedGenerationInput(record, job) {
  const selectionIdValid = record?.selectionId === null
    || (typeof record?.selectionId === "string" && record.selectionId.trim() !== "");
  const expectedKeys = [
    "editorialApproval",
    "intake",
    "intakeDigest",
    "jobId",
    "schemaVersion",
    "selectionId",
  ];
  if (
    !record
    || typeof record !== "object"
    || Array.isArray(record)
    || Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")
    || record.schemaVersion !== "1.0"
    || record.jobId !== job.jobId
    || record.intakeDigest !== job.intakeDigest
    || !selectionIdValid
    || !record.intake
    || typeof record.intake !== "object"
    || Array.isArray(record.intake)
  ) {
    throw new Error("Persisted generation input does not match the exact fulfillment job.");
  }
}

function assertPersistedEditorialApproval(value, jobId) {
  assertValidJobScopedEditorialApproval(value?.record);
  if (
    value.record.jobId !== jobId
    || !/^[a-f0-9]{64}$/u.test(value?.recordDigest || "")
    || value.recordDigest !== sha256(`${JSON.stringify(value.record, null, 2)}\n`)
    || value.record.sourceDigest !== sha256(JSON.stringify({
      kind: value.record.sourceEvidence.kind,
      reference: value.record.sourceEvidence.reference,
    }))
  ) {
    throw new Error("Persisted generation approval is invalid.");
  }
}

function assertPersistedArtifactSet(value, jobId) {
  const expectedKeys = [
    "artifactSetId",
    "assetManifestDigest",
    "files",
    "kind",
    "manifestRef",
    "pageDigest",
    "revisionId",
    "transcriptDigest",
  ];
  const expectedId = value && `artifacts_${sha256([
    jobId,
    value.revisionId,
    value.kind,
    value.pageDigest,
    value.transcriptDigest,
    value.assetManifestDigest,
  ].join("\0")).slice(0, 24)}`;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")
    || value.artifactSetId !== expectedId
  ) {
    throw new Error("Persisted terminal artifact-set identity is invalid.");
  }
}

function artifactSetBinding(value) {
  return value && {
    kind: value.kind,
    revisionId: value.revisionId,
    pageDigest: value.pageDigest,
    transcriptDigest: value.transcriptDigest,
    assetManifestDigest: value.assetManifestDigest,
    manifestRef: value.manifestRef,
    files: value.files,
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

async function readCanonicalJsonRequired(rootPath, filePath, label) {
  const raw = await readWorkspaceTextIfPresent(rootPath, filePath);
  if (raw === null) throw new Error(`${label} is missing.`);
  return parseCanonicalJson(raw, label);
}

async function readCanonicalJsonIfPresent(rootPath, filePath, label) {
  const raw = await readWorkspaceTextIfPresent(rootPath, filePath);
  return raw === null ? null : parseCanonicalJson(raw, label);
}

async function readWorkspaceTextIfPresent(rootPath, filePath) {
  const snapshot = await readBoundedFileFromRoot({
    rootPath,
    filePath,
    maximumBytes: MAX_JSON_BYTES,
    privateDirectories: false,
    immutableFile: false,
  });
  return snapshot === null
    ? null
    : new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
}

function parseCanonicalJson(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is malformed.`);
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || raw !== `${JSON.stringify(value, null, 2)}\n`
  ) {
    throw new Error(`${label} is not canonical JSON.`);
  }
  return value;
}

async function readJsonIfPresent(filePath) {
  const raw = await readTextIfPresent(filePath);
  return raw === null ? null : JSON.parse(raw);
}

async function readTextIfPresent(filePath) {
  try {
    return (await readRegularFile(filePath, MAX_JSON_BYTES)).toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readRegularFile(filePath, maximumBytes) {
  return (await readRegularFileSnapshot(filePath, maximumBytes)).bytes;
}

async function readRegularFileSnapshot(filePath, maximumBytes) {
  const pathMetadata = await lstat(filePath, { bigint: true });
  assertTrustedRegularFile(pathMetadata, maximumBytes);
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    assertTrustedRegularFile(before, maximumBytes);
    if (before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      throw new Error("Generation workspace file identity or size is invalid.");
    }
    const bytes = await readBoundedHandle(handle, maximumBytes);
    const after = await handle.stat({ bigint: true });
    assertSameFileMetadata(before, after, "Generation workspace file changed while it was read.");
    if (BigInt(bytes.byteLength) !== before.size) {
      throw new Error("Generation workspace file changed while it was read.");
    }
    return { bytes, metadata: before };
  } finally {
    await handle.close();
  }
}

function assertTrustedRegularFile(metadata, maximumBytes) {
  if (!metadata.isFile()) {
    throw new Error("Generation workspace input must be a regular file.");
  }
  if (metadata.nlink !== 1n) {
    throw new Error("Generation workspace input must be a single-link regular file.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())) {
    throw new Error("Generation workspace input ownership is invalid.");
  }
  if (Number(metadata.mode & 0o022n) !== 0) {
    throw new Error("Generation workspace input has shared-write permissions.");
  }
  if (metadata.size < 0n || metadata.size > BigInt(maximumBytes)) {
    throw new Error("Generation workspace input exceeds the maximum byte size.");
  }
}

function assertSameFileMetadata(before, after, message) {
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "uid", "nlink"]) {
    if (before[key] !== after[key]) throw new Error(message);
  }
}

async function readBoundedHandle(handle, maximumBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maximumBytes) {
    const remaining = maximumBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maximumBytes) {
    throw new Error("Generation workspace file exceeds its bounded read limit.");
  }
  return Buffer.concat(chunks, total);
}

async function atomicWrite(root, filePath, content, mode) {
  const parent = path.dirname(filePath);
  await assertSafeWorkspacePath(root, parent);
  await mkdir(parent, { recursive: true });
  await assertSafeWorkspacePath(root, parent);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode, flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function withExclusiveFileLock(root, lockPath, action) {
  await assertSafeWorkspacePath(root, lockPath);
  let handle = null;
  let identity = null;
  const token = randomUUID();
  ACTIVE_LOCK_TOKENS.add(token);
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAtMs: Date.now() })}\n`, "utf8");
        await handle.sync();
        identity = await handle.stat({ bigint: true });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          if (handle) {
            const failedIdentity = await handle.stat({ bigint: true }).catch(() => null);
            await handle.close().catch(() => {});
            await removeOwnedLock(lockPath, failedIdentity);
            handle = null;
          }
          throw error;
        }
        if (!await removeStaleLock(lockPath)) await delay(5);
      }
    }
    if (!handle) throw new Error("Persisted generation input is locked.");
    try {
      return await action();
    } finally {
      await handle.close();
      await removeOwnedLock(lockPath, identity);
    }
  } finally {
    ACTIVE_LOCK_TOKENS.delete(token);
  }
}

async function removeStaleLock(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  let identity;
  let record;
  let invalidButStale = false;
  try {
    identity = await handle.stat({ bigint: true });
    if (
      !identity.isFile()
      || identity.nlink !== 1n
      || Number(identity.mode & 0o777n) !== 0o600
      || identity.size <= 0n
      || identity.size > BigInt(MAX_LOCK_BYTES)
      || (typeof process.getuid === "function" && identity.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("Persisted generation input lock is invalid.");
    }
    const bytes = await readBoundedHandle(handle, MAX_LOCK_BYTES);
    const after = await handle.stat({ bigint: true });
    assertSameFileMetadata(identity, after, "Persisted generation input lock changed while it was read.");
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (identity && lockMetadataIsStale(identity)) {
      invalidButStale = true;
    } else if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new Error("Persisted generation input lock is invalid.");
    } else {
      throw error;
    }
  } finally {
    await handle.close();
  }
  if (invalidButStale) {
    await removeOwnedLock(lockPath, identity);
    return true;
  }
  if (
    !record
    || !Number.isInteger(record.pid)
    || record.pid < 1
    || typeof record.token !== "string"
    || record.token.length < 8
    || !Number.isFinite(record.createdAtMs)
  ) {
    throw new Error("Persisted generation input lock is invalid.");
  }
  if (ACTIVE_LOCK_TOKENS.has(record.token)) return false;
  if (record.pid !== process.pid && processIsAlive(record.pid)) return false;
  await removeOwnedLock(lockPath, identity);
  return true;
}

function lockMetadataIsStale(metadata) {
  return Date.now() - Number(metadata.mtimeMs) >= STALE_LOCK_GRACE_MS;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function removeOwnedLock(lockPath, identity) {
  if (!identity) return;
  const quarantinePath = `${lockPath}.${process.pid}.${randomUUID()}.quarantine`;
  try {
    const current = await lstat(lockPath, { bigint: true });
    if (current.dev !== identity.dev || current.ino !== identity.ino) return;
    await rename(lockPath, quarantinePath);
    const quarantined = await lstat(quarantinePath, { bigint: true });
    if (quarantined.dev !== identity.dev || quarantined.ino !== identity.ino) {
      throw new Error("Persisted generation input lock identity changed during quarantine.");
    }
    await rm(quarantinePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertSafeWorkspacePath(root, candidate) {
  assertInsideRoot(root, candidate);
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink()) {
      throw new Error("Generation workspace root cannot be a symbolic link.");
    }
    assertTrustedWorkspaceDirectory(rootMetadata);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error("Generation workspace paths cannot contain symbolic links.");
      }
      const isFinal = index === parts.length - 1;
      if (!isFinal || metadata.isDirectory()) {
        assertTrustedWorkspaceDirectory(metadata);
      } else if (!metadata.isFile()
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
        || (metadata.mode & 0o022) !== 0) {
        throw new Error("Generation workspace files must be regular files owned by the current user without shared write access.");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function assertTrustedWorkspaceDirectory(metadata) {
  if (!metadata.isDirectory()
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (metadata.mode & 0o022) !== 0) {
    throw new Error("Generation workspace directories must be owned by the current user without shared write access.");
  }
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
