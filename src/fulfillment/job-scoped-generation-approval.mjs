import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { assertValidJobScopedEditorialApproval } from "../../scripts/lib/schema-validation.mjs";

const MAX_APPROVAL_BYTES = 16_384;

export async function loadJobScopedGenerationApproval({
  jobId,
  artifactRoot,
  configuredRoot = artifactRoot,
  approvalPath,
}) {
  if (
    typeof jobId !== "string"
    || typeof artifactRoot !== "string"
    || typeof configuredRoot !== "string"
    || typeof approvalPath !== "string"
    || approvalPath.trim() !== approvalPath
    || !path.isAbsolute(approvalPath)
    || path.resolve(approvalPath) !== approvalPath
  ) {
    throw new Error("Invalid job-scoped editorial approval input.");
  }

  assertStrictChild(configuredRoot, approvalPath);
  const canonicalRoot = await realpath(configuredRoot);
  if (canonicalRoot !== artifactRoot) {
    throw new Error("Job-scoped editorial approval root binding is invalid.");
  }
  const canonicalApproval = await realpath(approvalPath);
  assertStrictChild(canonicalRoot, canonicalApproval);
  await assertPrivatePath(configuredRoot, approvalPath);

  const handle = await open(approvalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateApprovalFile(before);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("Job-scoped editorial approval changed while it was read.");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_APPROVAL_BYTES) {
      throw new Error("Job-scoped editorial approval size is invalid.");
    }

    let record;
    try {
      record = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Job-scoped editorial approval is not valid JSON.");
    }
    assertValidJobScopedEditorialApproval(record);
    const canonicalBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (!bytes.equals(canonicalBytes)) {
      throw new Error("Job-scoped editorial approval must use canonical JSON bytes.");
    }
    if (record.jobId !== jobId) {
      throw new Error("Job-scoped editorial approval does not match the requested job.");
    }
    const expectedSourceDigest = sha256(canonicalSourceEvidence(record.sourceEvidence));
    if (record.sourceDigest !== expectedSourceDigest) {
      throw new Error("Job-scoped editorial approval source binding is invalid.");
    }

    return deepFreeze({
      record: structuredClone(record),
      recordDigest: sha256(canonicalBytes),
    });
  } finally {
    await handle.close();
  }
}

async function assertPrivatePath(root, approvalPath) {
  const relative = path.relative(root, approvalPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Job-scoped editorial approval must be beneath the private artifact root.");
  }

  const rootMetadata = await lstat(root);
  assertPrivateDirectory(rootMetadata);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("Job-scoped editorial approval path cannot contain symbolic links.");
    }
    if (current !== approvalPath) assertPrivateDirectory(metadata);
  }
}

function assertPrivateDirectory(metadata) {
  if (
    !metadata.isDirectory()
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("Job-scoped editorial approval directories must remain private.");
  }
}

function assertPrivateApprovalFile(metadata) {
  if (
    !metadata.isFile()
    || metadata.nlink !== 1n
    || Number(metadata.mode & 0o777n) !== 0o400
    || metadata.size <= 0n
    || metadata.size > BigInt(MAX_APPROVAL_BYTES)
    || (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Job-scoped editorial approval must be an immutable private regular file.");
  }
}

function assertStrictChild(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Job-scoped editorial approval resolves outside the private artifact root.");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSourceEvidence(sourceEvidence) {
  return JSON.stringify({
    kind: sourceEvidence.kind,
    reference: sourceEvidence.reference,
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
