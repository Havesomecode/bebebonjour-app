import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { assertValidJobScopedEditorialApproval } from "../../scripts/lib/schema-validation.mjs";
import { serializeCanonicalJobScopedEditorialApprovalRecord } from "./job-scoped-editorial-approval-canonicalization.mjs";
import { readBoundedFileFromRoot } from "./secure-filesystem-snapshot.mjs";

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
  if (await realpath(configuredRoot) !== artifactRoot) {
    throw new Error("Configured generation root does not match its canonical artifact root.");
  }
  const canonicalApprovalPath = path.join(artifactRoot, path.relative(configuredRoot, approvalPath));

  let snapshot;
  try {
    snapshot = await readBoundedFileFromRoot({
      rootPath: artifactRoot,
      filePath: canonicalApprovalPath,
      maximumBytes: MAX_APPROVAL_BYTES,
      privateDirectories: true,
      immutableFile: true,
    });
  } catch {
    throw new Error("Job-scoped editorial approval filesystem boundary rejected.");
  }
  const bytes = snapshot?.bytes;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_APPROVAL_BYTES) {
    throw new Error("Job-scoped editorial approval size is invalid.");
  }

  let record;
  try {
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Job-scoped editorial approval is not valid JSON.");
  }
  assertValidJobScopedEditorialApproval(record);
  const canonicalBytes = Buffer.from(
    serializeCanonicalJobScopedEditorialApprovalRecord(record),
    "utf8",
  );
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
    recordDigest: snapshot.sha256,
  });
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
