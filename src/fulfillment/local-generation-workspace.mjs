import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import {
  assertValidJobScopedEditorialApproval,
  assertValidReviewDossier,
} from "../../scripts/lib/schema-validation.mjs";

const FILE_LOCK_ATTEMPTS = 2_000;
const FILE_LOCK_DELAY_MS = 5;
const FILE_LOCK_ENTRY = /^(?<pid>[1-9][0-9]*)-(?<processStartId>[0-9]+|unknown)-(?<token>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?<state>choosing|ticket-(?<ticket>[1-9][0-9]*))$/u;

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
    const intakePath = path.join(inputRoot, "intake.json");
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
    const intakeRaw = `${JSON.stringify(intake, null, 2)}\n`;
    await assertSafeWorkspacePath(resolvedRoot, inputRoot);
    await mkdir(inputRoot, { recursive: true, mode: 0o700 });
    await assertSafeWorkspacePath(resolvedRoot, inputRoot);
    return withExclusiveFileLock(resolvedRoot, lockPath, async () => {
      await assertSafeWorkspacePath(resolvedRoot, recordPath);
      const existing = await readCanonicalJsonIfPresent(recordPath, "Persisted generation input");
      if (existing) {
        await assertSafeWorkspacePath(resolvedRoot, intakePath);
        const persistedIntakeRaw = await readTextRequired(
          intakePath,
          "Persisted generation intake",
        );
        if (persistedIntakeRaw !== intakeRaw) {
          throw new Error("Persisted generation intake bytes are not canonical.");
        }
        if (isDeepStrictEqual(existing, record)) {
          return { intakePath, recordPath };
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
        return { intakePath, recordPath };
      }
      await atomicWrite(resolvedRoot, intakePath, intakeRaw, 0o600);
      await atomicWrite(resolvedRoot, recordPath, recordRaw, 0o600);
      return { intakePath, recordPath };
    });
  }

  async function resolveJobPaths(job) {
    assertJobId(job?.jobId);
    assertDigest(job?.intakeDigest, "job intake digest");
    const jobRoot = path.join(resolvedRoot, "jobs", job.jobId);
    const inputRoot = path.join(jobRoot, "input");
    const intakePath = path.join(inputRoot, "intake.json");
    await assertSafeWorkspacePath(resolvedRoot, inputRoot);
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
    for (const candidate of [stageRoot, inventoryRoot, pageRoot]) {
      assertInsideRoot(resolvedRoot, candidate);
      await assertSafeWorkspacePath(resolvedRoot, candidate);
    }
    const pagePath = path.join(pageRoot, ...layout.page);
    const transcriptPath = path.join(stageRoot, ...layout.transcript);
    const requiredPaths = (layout.required || []).map((segments) => path.join(stageRoot, ...segments));
    if (!await allRegularFilesExist([pagePath, transcriptPath, ...requiredPaths])) return null;
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
    await assertSafeWorkspacePath(resolvedRoot, manifestRoot);
    const manifestPath = path.join(manifestRoot, `${kind}.json`);
    await assertSafeWorkspacePath(resolvedRoot, manifestPath);
    const existingRaw = await readTextIfPresent(manifestPath);
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
      pageDigest: sha256(await readFile(pagePath)),
      transcriptDigest: sha256(await readFile(transcriptPath)),
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

    const intakePath = path.join(inputRoot, "intake.json");
    await assertSafeWorkspacePath(resolvedRoot, intakePath);
    const intakeRaw = await readTextRequired(intakePath, "Persisted generation intake");
    const canonicalIntakeRaw = `${JSON.stringify(intake, null, 2)}\n`;
    if (intakeRaw !== canonicalIntakeRaw) {
      throw new Error("Persisted generation intake bytes are not canonical.");
    }

    const paths = await resolveJobPaths(job);
    if (paths.revision.revisionId !== job.currentRevisionId) {
      throw new Error("Persisted generation revision does not match the terminal job revision.");
    }
    const dossierPath = path.join(paths.reviewRoot, "review.json");
    await assertSafeWorkspacePath(resolvedRoot, dossierPath);
    const dossier = await readCanonicalJsonRequired(
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
      } else if (!entry.isFile()) {
        throw new Error("Generated artifacts cannot contain unsupported filesystem entries.");
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

async function readCanonicalJsonRequired(filePath, label) {
  const raw = await readTextRequired(filePath, label);
  return parseCanonicalJson(raw, label);
}

async function readCanonicalJsonIfPresent(filePath, label) {
  const raw = await readTextIfPresent(filePath);
  return raw === null ? null : parseCanonicalJson(raw, label);
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

async function readTextRequired(filePath, label) {
  const raw = await readTextIfPresent(filePath);
  if (raw === null) throw new Error(`${label} is missing.`);
  return raw;
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
  const processStartId = await readLinuxProcessStartId(process.pid);
  const ownerKey = `${process.pid}-${processStartId || "unknown"}-${randomUUID()}`;
  let ownerPath = null;
  for (let attempt = 0; attempt < FILE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      await assertSafeWorkspacePath(root, lockPath);
      if (!(await lstat(lockPath)).isDirectory()) {
        throw new Error("Persisted generation input is locked.");
      }
      const choosingPath = path.join(lockPath, `${ownerKey}.choosing`);
      await writeFile(choosingPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
      ownerPath = choosingPath;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(FILE_LOCK_DELAY_MS);
    }
  }
  if (!ownerPath) throw new Error("Persisted generation input is locked.");

  try {
    const initialContenders = await liveFileLockContenders(lockPath);
    const ticket = initialContenders.reduce(
      (maximum, contender) => Math.max(maximum, contender.ticket || 0),
      0,
    ) + 1;
    const ticketPath = path.join(lockPath, `${ownerKey}.ticket-${ticket}`);
    await rename(ownerPath, ticketPath);
    ownerPath = ticketPath;

    for (let attempt = 0; attempt < FILE_LOCK_ATTEMPTS; attempt += 1) {
      const contenders = await liveFileLockContenders(lockPath);
      const blocked = contenders.some((contender) => {
        if (contender.ownerKey === ownerKey) return false;
        if (contender.state === "choosing") return true;
        return contender.ticket < ticket
          || (contender.ticket === ticket && contender.ownerKey < ownerKey);
      });
      if (!blocked) return await action();
      await delay(FILE_LOCK_DELAY_MS);
    }
    throw new Error("Persisted generation input is locked.");
  } finally {
    if (ownerPath) await rm(ownerPath, { force: true });
    try {
      await rmdir(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    }
  }
}

async function liveFileLockContenders(lockPath) {
  const entries = await readdir(lockPath, { withFileTypes: true });
  const contenders = [];
  for (const entry of entries) {
    const match = entry.isFile() ? FILE_LOCK_ENTRY.exec(entry.name) : null;
    if (!match?.groups) {
      throw new Error("Persisted generation input lock state is invalid.");
    }
    const pid = Number.parseInt(match.groups.pid, 10);
    const ticket = match.groups.ticket
      ? Number.parseInt(match.groups.ticket, 10)
      : null;
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || (ticket !== null && (!Number.isSafeInteger(ticket) || ticket <= 0))
    ) {
      throw new Error("Persisted generation input lock state is invalid.");
    }
    const expectedProcessStartId = match.groups.processStartId === "unknown"
      ? null
      : match.groups.processStartId;
    if (!await isProcessAlive(pid, expectedProcessStartId)) {
      await rm(path.join(lockPath, entry.name), { force: true });
      continue;
    }
    contenders.push({
      ownerKey: `${match.groups.pid}-${match.groups.processStartId}-${match.groups.token}`,
      state: match.groups.state === "choosing" ? "choosing" : "ticket",
      ticket,
    });
  }
  return contenders;
}

async function isProcessAlive(pid, expectedProcessStartId) {
  if (expectedProcessStartId !== null) {
    const currentProcessStartId = await readLinuxProcessStartId(pid);
    if (currentProcessStartId !== null) {
      return currentProcessStartId === expectedProcessStartId;
    }
    if (await hasLinuxProcfs()) return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function readLinuxProcessStartId(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = raw.lastIndexOf(")");
    const fields = commandEnd === -1
      ? []
      : raw.slice(commandEnd + 1).trim().split(/\s+/u);
    const startId = fields[19];
    if (!/^[0-9]+$/u.test(startId || "")) {
      throw new Error("Persisted generation input lock process identity is invalid.");
    }
    return startId;
  } catch (error) {
    if (
      error?.code === "ENOENT"
      || error?.code === "ENOTDIR"
      || error?.code === "EACCES"
    ) {
      return null;
    }
    throw error;
  }
}

async function hasLinuxProcfs() {
  return (await readLinuxProcessStartId(process.pid)) !== null;
}

async function assertSafeWorkspacePath(root, candidate) {
  assertInsideRoot(root, candidate);
  try {
    if ((await lstat(root)).isSymbolicLink()) {
      throw new Error("Generation workspace root cannot be a symbolic link.");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Generation workspace paths cannot contain symbolic links.");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
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
