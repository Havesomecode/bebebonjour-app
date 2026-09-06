import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const DIGEST = /^[a-f0-9]{64}$/u;
const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const REVISION_ID = /^r[1-9][0-9]*$/u;
const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export const saveEditorialApproval = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    approval: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertJobId(args.jobId);
    await assertEditorialApproval(args.approval, args.jobId);
    const existing = await findEditorialApproval(context, args.jobId);
    if (existing) {
      if (JSON.stringify(existing.approval) !== JSON.stringify(args.approval)) {
        throw new Error("Generation editorial approval is immutable once provisioned.");
      }
      return { created: false, approval: existing.approval };
    }
    await context.db.insert("fulfillmentGenerationEditorialApprovals", {
      jobId: args.jobId,
      approval: args.approval,
    });
    return { created: true, approval: args.approval };
  },
});

export const readEditorialApproval = queryGeneric({
  args: { workerToken: v.string(), jobId: v.string() },
  handler: async (context, args) => {
    assertWorkerToken(args.workerToken);
    assertJobId(args.jobId);
    const document = await findEditorialApproval(context, args.jobId);
    return document?.approval || null;
  },
});

export const createArtifactUploadUrl = mutationGeneric({
  args: { workerToken: v.string() },
  handler: async (context, args) => {
    assertWorkerToken(args.workerToken);
    return context.storage.generateUploadUrl();
  },
});

export const commitArtifactSet = mutationGeneric({
  args: {
    workerToken: v.string(),
    jobId: v.string(),
    artifactSet: v.any(),
  },
  handler: async (context, args) => {
    assertWorkerToken(args.workerToken);
    assertJobId(args.jobId);
    await assertArtifactSet(context, args.jobId, args.artifactSet);
    const existing = await findArtifactSet(
      context,
      args.jobId,
      args.artifactSet.revisionId,
      args.artifactSet.kind,
    );
    if (existing) {
      if (JSON.stringify(existing.artifactSet) !== JSON.stringify(args.artifactSet)) {
        throw new Error("Generation artifact set is immutable once committed.");
      }
      return { created: false, artifactSet: existing.artifactSet };
    }
    await context.db.insert("fulfillmentGenerationArtifactSets", {
      jobId: args.jobId,
      revisionId: args.artifactSet.revisionId,
      kind: args.artifactSet.kind,
      artifactSet: args.artifactSet,
    });
    return { created: true, artifactSet: args.artifactSet };
  },
});

export const readArtifactSet = queryGeneric({
  args: {
    workerToken: v.string(),
    jobId: v.string(),
    revisionId: v.string(),
    kind: v.string(),
  },
  handler: async (context, args) => {
    assertWorkerToken(args.workerToken);
    assertJobId(args.jobId);
    if (!REVISION_ID.test(args.revisionId) || args.kind !== "private_review") {
      throw new Error("Generation artifact lookup is invalid.");
    }
    const document = await findArtifactSet(context, args.jobId, args.revisionId, args.kind);
    if (!document) return null;
    const files = [];
    for (const file of document.artifactSet.files) {
      const storageId = context.db.system.normalizeId("_storage", file.storageId);
      if (!storageId) throw new Error("Generation artifact storage id is invalid.");
      const url = await context.storage.getUrl(storageId);
      if (!url) throw new Error("Generation artifact blob is missing.");
      files.push({ ...file, url });
    }
    return { artifactSet: document.artifactSet, files };
  },
});

function findEditorialApproval(context, jobId) {
  return context.db
    .query("fulfillmentGenerationEditorialApprovals")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

function findArtifactSet(context, jobId, revisionId, kind) {
  return context.db
    .query("fulfillmentGenerationArtifactSets")
    .withIndex("by_job_revision_kind", (query) => (
      query.eq("jobId", jobId).eq("revisionId", revisionId).eq("kind", kind)
    ))
    .unique();
}

async function assertEditorialApproval(value, jobId) {
  const record = value?.record;
  const policy = record?.policy;
  const sourceEvidence = record?.sourceEvidence;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== "record\0recordDigest"
    || !record
    || typeof record !== "object"
    || Array.isArray(record)
    || Object.keys(record).sort().join("\0")
      !== "approvalType\0jobId\0policy\0schemaVersion\0sourceDigest\0sourceEvidence"
    || record.schemaVersion !== "1.0"
    || record.approvalType !== "job_scoped_editorial_policy"
    || record.jobId !== jobId
    || !policy
    || typeof policy !== "object"
    || Array.isArray(policy)
    || Object.keys(policy).sort().join("\0")
      !== "genericBlessingsAllowed\0id\0maxStage\0meaningAllowed\0preserveSubmittedName\0scripturalNameAssociationAllowed"
    || policy.id !== "unknown_name_general_wishes"
    || policy.preserveSubmittedName !== true
    || policy.meaningAllowed !== false
    || policy.scripturalNameAssociationAllowed !== false
    || policy.genericBlessingsAllowed !== true
    || policy.maxStage !== "content_review_required"
    || !sourceEvidence
    || typeof sourceEvidence !== "object"
    || Array.isArray(sourceEvidence)
    || Object.keys(sourceEvidence).sort().join("\0") !== "kind\0reference"
    || sourceEvidence.kind !== "kanban_human_decision"
    || !/^kanban:t_[A-Za-z0-9_-]{3,128}$/u.test(sourceEvidence.reference || "")
    || !DIGEST.test(value.recordDigest || "")
    || !DIGEST.test(record.sourceDigest || "")
  ) {
    throw new Error("Generation editorial approval is invalid.");
  }
  const expectedSourceDigest = await sha256Hex(JSON.stringify({
    kind: sourceEvidence.kind,
    reference: sourceEvidence.reference,
  }));
  const expectedRecordDigest = await sha256Hex(
    `${JSON.stringify(canonicalEditorialApprovalRecord(record), null, 2)}\n`,
  );
  if (record.sourceDigest !== expectedSourceDigest || value.recordDigest !== expectedRecordDigest) {
    throw new Error("Generation editorial approval is invalid.");
  }
}

async function assertArtifactSet(context, jobId, value) {
  const keys = [
    "assetManifestDigest",
    "files",
    "kind",
    "manifestRef",
    "pageDigest",
    "revisionId",
    "transcriptDigest",
  ];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== keys.join("\0")
    || value.kind !== "private_review"
    || !REVISION_ID.test(value.revisionId || "")
    || value.manifestRef !== `jobs/${jobId}/revisions/${value.revisionId}/manifests/private_review.json`
    || !DIGEST.test(value.pageDigest || "")
    || !DIGEST.test(value.transcriptDigest || "")
    || !DIGEST.test(value.assetManifestDigest || "")
    || !Array.isArray(value.files)
    || value.files.length === 0
    || value.files.length > MAX_FILES
  ) {
    throw new Error("Generation artifact set is invalid.");
  }
  let totalBytes = 0;
  const paths = new Set();
  for (const file of value.files) {
    assertArtifactFile(file);
    totalBytes += file.bytes;
    if (paths.has(file.path) || totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Generation artifact inventory is invalid.");
    }
    paths.add(file.path);
    const storageId = context.db.system.normalizeId("_storage", file.storageId);
    const metadata = storageId ? await context.db.system.get(storageId) : null;
    if (!metadata || metadata.size !== file.bytes || !metadataDigestMatches(metadata.sha256, file.sha256)) {
      throw new Error("Generation artifact blob does not match its declared integrity metadata.");
    }
  }
}

function assertArtifactFile(file) {
  if (
    !file
    || typeof file !== "object"
    || Array.isArray(file)
    || Object.keys(file).sort().join("\0") !== "bytes\0path\0sha256\0storageId"
    || !safeRelativePath(file.path)
    || !Number.isInteger(file.bytes)
    || file.bytes < 0
    || file.bytes > MAX_FILE_BYTES
    || !DIGEST.test(file.sha256 || "")
    || typeof file.storageId !== "string"
    || file.storageId.trim() === ""
  ) {
    throw new Error("Generation artifact file is invalid.");
  }
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function metadataDigestMatches(metadataDigest, expectedHexDigest) {
  if (metadataDigest === expectedHexDigest) return true;
  const bytes = expectedHexDigest.match(/.{2}/gu)?.map((pair) => Number.parseInt(pair, 16));
  if (!bytes || bytes.length !== 32) return false;
  return metadataDigest === globalThis.btoa(String.fromCharCode(...bytes));
}

function assertJobId(value) {
  if (typeof value !== "string" || !JOB_ID.test(value)) {
    throw new Error("Generation storage job id is invalid.");
  }
}

function assertBackendToken(value) {
  const expected = process.env.CUSTOMER_FLOW_BACKEND_TOKEN;
  if (!expected || expected.length < 32 || value !== expected) {
    throw new Error("Customer-flow backend authorization failed.");
  }
}

function assertWorkerToken(value) {
  const expected = process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN;
  const backendToken = process.env.CUSTOMER_FLOW_BACKEND_TOKEN;
  if (
    !expected
    || expected.length < 32
    || value !== expected
    || (backendToken && value === backendToken)
  ) {
    throw new Error("Generation worker authorization failed.");
  }
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalEditorialApprovalRecord(record) {
  return {
    schemaVersion: record.schemaVersion,
    approvalType: record.approvalType,
    jobId: record.jobId,
    policy: {
      id: record.policy.id,
      preserveSubmittedName: record.policy.preserveSubmittedName,
      meaningAllowed: record.policy.meaningAllowed,
      scripturalNameAssociationAllowed: record.policy.scripturalNameAssociationAllowed,
      genericBlessingsAllowed: record.policy.genericBlessingsAllowed,
      maxStage: record.policy.maxStage,
    },
    sourceEvidence: {
      kind: record.sourceEvidence.kind,
      reference: record.sourceEvidence.reference,
    },
    sourceDigest: record.sourceDigest,
  };
}
