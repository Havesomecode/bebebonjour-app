import {
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

const DIGEST = /^[a-f0-9]{64}$/u;
const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const REVISION_ID = /^r[1-9][0-9]*$/u;
const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const CLAIMED_GENERATION_ARGS = Object.freeze({
  workerToken: v.string(),
  workerId: v.string(),
  commandId: v.string(),
  leaseToken: v.string(),
  jobId: v.string(),
});
const PREPARE_REVIEW_TRANSITIONS = new Set([
  "generation_queued>generating",
  "generating>content_review_required",
  "generating>retry_wait",
  "generating>failed",
  "failed>generation_queued",
  "retry_wait>generation_queued",
]);
const CODEX_AUTH_SLOT = "primary";
const CODEX_AUTH_ENVELOPE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{16,131072}$/u;

export const initializeCodexAuthState = mutationGeneric({
  args: {
    ...CLAIMED_GENERATION_ARGS,
    envelope: v.string(),
    plaintextDigest: v.string(),
  },
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args);
    assertEncryptedAuthState(args);
    const existing = await findCodexAuthState(context);
    if (existing) {
      return { initialized: false, version: existing.version };
    }
    await context.db.insert("fulfillmentCodexAuthState", {
      slot: CODEX_AUTH_SLOT,
      version: 1,
      envelope: args.envelope,
      plaintextDigest: args.plaintextDigest,
      lease: null,
      updatedAtMs: Date.now(),
    });
    return { initialized: true, version: 1 };
  },
});

export const claimCodexAuthState = mutationGeneric({
  args: {
    ...CLAIMED_GENERATION_ARGS,
    authLeaseMs: v.number(),
  },
  handler: async (context, args) => {
    const command = await assertClaimedGenerationAuthority(context, args);
    if (!Number.isInteger(args.authLeaseMs) || args.authLeaseMs < 1_000 || args.authLeaseMs > 300_000) {
      throw new Error("Codex auth state lease duration is invalid.");
    }
    const state = await findCodexAuthState(context);
    if (!state) throw new Error("Codex auth state is not initialized.");
    const nowMs = Date.now();
    if (state.lease?.leaseExpiresAtMs > nowMs) {
      if (
        state.lease.workerId === args.workerId
        && state.lease.commandId === args.commandId
        && state.lease.commandLeaseToken === args.leaseToken
        && state.lease.jobId === args.jobId
      ) {
        return authLeaseResult(state);
      }
      return { acquired: false };
    }
    const leaseExpiresAtMs = Math.min(nowMs + args.authLeaseMs, command.claim.leaseExpiresAtMs);
    if (leaseExpiresAtMs - nowMs < 1_000) {
      throw new Error("Codex auth state lease cannot outlive the generation command claim.");
    }
    const lease = {
      workerId: args.workerId,
      commandId: args.commandId,
      commandLeaseToken: args.leaseToken,
      jobId: args.jobId,
      authLeaseToken: `codex_auth_lease_${crypto.randomUUID().replaceAll("-", "")}`,
      claimedAtMs: nowMs,
      leaseExpiresAtMs,
    };
    await context.db.patch(state._id, { lease, updatedAtMs: nowMs });
    return authLeaseResult({ ...state, lease });
  },
});

export const commitCodexAuthState = mutationGeneric({
  args: {
    ...CLAIMED_GENERATION_ARGS,
    authLeaseToken: v.string(),
    expectedVersion: v.number(),
    envelope: v.string(),
    plaintextDigest: v.string(),
  },
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args);
    assertEncryptedAuthState(args);
    const state = await requireOwnedCodexAuthLease(context, args);
    if (state.version !== args.expectedVersion) {
      throw new Error("Codex auth state version changed before writeback.");
    }
    const version = state.version + 1;
    await context.db.patch(state._id, {
      version,
      envelope: args.envelope,
      plaintextDigest: args.plaintextDigest,
      lease: null,
      updatedAtMs: Date.now(),
    });
    return { committed: true, version, plaintextDigest: args.plaintextDigest };
  },
});

export const releaseCodexAuthState = mutationGeneric({
  args: {
    ...CLAIMED_GENERATION_ARGS,
    authLeaseToken: v.string(),
    expectedVersion: v.number(),
  },
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args);
    const state = await requireOwnedCodexAuthLease(context, args);
    if (state.version !== args.expectedVersion) {
      throw new Error("Codex auth state version changed before release.");
    }
    await context.db.patch(state._id, { lease: null, updatedAtMs: Date.now() });
    return { released: true };
  },
});

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
  args: CLAIMED_GENERATION_ARGS,
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args, { effectFenceRequired: false });
    const document = await findEditorialApproval(context, args.jobId);
    return document?.approval || null;
  },
});

export const readClaimedCustomerJob = queryGeneric({
  args: CLAIMED_GENERATION_ARGS,
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args, { effectFenceRequired: false });
    const document = await context.db
      .query("customerFlowJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", args.jobId))
      .unique();
    return document?.job || null;
  },
});

export const getClaimedFulfillmentJob = queryGeneric({
  args: CLAIMED_GENERATION_ARGS,
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args, { effectFenceRequired: false });
    const document = await findFulfillmentJob(context, args.jobId);
    return document?.aggregate || null;
  },
});

export const replaceClaimedFulfillmentJob = mutationGeneric({
  args: {
    ...CLAIMED_GENERATION_ARGS,
    expectedVersion: v.number(),
    aggregate: v.any(),
  },
  handler: async (context, args) => {
    const command = await assertClaimedGenerationAuthority(
      context,
      args,
      { effectFenceRequired: false },
    );
    const document = await findFulfillmentJob(context, args.jobId);
    if (!document) return { updated: false, current: null };
    if (document.aggregate.version !== args.expectedVersion) {
      return { updated: false, current: document.aggregate };
    }
    assertPrepareReviewReplacement(document.aggregate, args.aggregate, args);
    const entersPrepareReview = document.aggregate.state === "generation_queued"
      && args.aggregate.state === "generating";
    if (!entersPrepareReview && !Number.isFinite(command.claim.effectStartedAtMs)) {
      throw new Error("Generation prepare_review claim authorization failed.");
    }
    await context.db.patch(document._id, { aggregate: args.aggregate });
    return { updated: true, aggregate: args.aggregate };
  },
});

export const createArtifactUploadUrl = mutationGeneric({
  args: CLAIMED_GENERATION_ARGS,
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args);
    return context.storage.generateUploadUrl();
  },
});

export const commitArtifactSet = mutationGeneric({
  args: {
    ...CLAIMED_GENERATION_ARGS,
    artifactSet: v.any(),
  },
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args);
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
    ...CLAIMED_GENERATION_ARGS,
    revisionId: v.string(),
    kind: v.string(),
  },
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args);
    if (!REVISION_ID.test(args.revisionId) || args.kind !== "private_review") {
      throw new Error("Generation artifact lookup is invalid.");
    }
    const document = await findArtifactSet(context, args.jobId, args.revisionId, args.kind);
    if (!document) return null;
    for (const file of document.artifactSet.files) {
      const storageId = context.db.system.normalizeId("_storage", file.storageId);
      if (!storageId) throw new Error("Generation artifact storage id is invalid.");
      const metadata = await context.db.system.get(storageId);
      if (!metadata) throw new Error("Generation artifact blob is missing.");
    }
    return { artifactSet: document.artifactSet, files: document.artifactSet.files };
  },
});

export const authorizeArtifactRead = internalQueryGeneric({
  args: {
    ...CLAIMED_GENERATION_ARGS,
    revisionId: v.string(),
    kind: v.string(),
    path: v.string(),
  },
  handler: async (context, args) => {
    await assertClaimedGenerationAuthority(context, args);
    if (!REVISION_ID.test(args.revisionId) || args.kind !== "private_review" || !safeRelativePath(args.path)) {
      throw new Error("Generation artifact lookup is invalid.");
    }
    const document = await findArtifactSet(context, args.jobId, args.revisionId, args.kind);
    const file = document?.artifactSet?.files?.find((entry) => entry.path === args.path);
    if (!file) throw new Error("Generation artifact file is missing.");
    return file;
  },
});

function findCodexAuthState(context) {
  return context.db
    .query("fulfillmentCodexAuthState")
    .withIndex("by_slot", (query) => query.eq("slot", CODEX_AUTH_SLOT))
    .unique();
}

function assertEncryptedAuthState(value) {
  if (
    !CODEX_AUTH_ENVELOPE.test(value?.envelope || "")
    || !DIGEST.test(value?.plaintextDigest || "")
  ) {
    throw new Error("Codex encrypted auth state is invalid.");
  }
}

function authLeaseResult(state) {
  return {
    acquired: true,
    version: state.version,
    envelope: state.envelope,
    plaintextDigest: state.plaintextDigest,
    authLeaseToken: state.lease.authLeaseToken,
    leaseExpiresAtMs: state.lease.leaseExpiresAtMs,
  };
}

async function requireOwnedCodexAuthLease(context, args) {
  const state = await findCodexAuthState(context);
  if (
    !state
    || state.lease?.workerId !== args.workerId
    || state.lease?.commandId !== args.commandId
    || state.lease?.commandLeaseToken !== args.leaseToken
    || state.lease?.jobId !== args.jobId
    || state.lease?.authLeaseToken !== args.authLeaseToken
    || state.lease?.leaseExpiresAtMs <= Date.now()
  ) {
    throw new Error("Codex auth state lease is not active.");
  }
  return state;
}

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

function findFulfillmentJob(context, jobId) {
  return context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

async function assertClaimedGenerationAuthority(
  context,
  args,
  { effectFenceRequired = true } = {},
) {
  assertWorkerToken(args.workerToken);
  assertJobId(args.jobId);
  const command = await context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (query) => query.eq("commandId", args.commandId))
    .unique();
  if (
    !command
    || command.jobId !== args.jobId
    || command.action !== "generate"
    || command.state !== "running"
    || command.claim?.workerId !== args.workerId
    || command.claim?.leaseToken !== args.leaseToken
    || (effectFenceRequired && !Number.isFinite(command.claim?.effectStartedAtMs))
    || !Number.isFinite(command.claim?.leaseExpiresAtMs)
    || command.claim.leaseExpiresAtMs <= Date.now()
  ) {
    throw new Error("Generation prepare_review claim authorization failed.");
  }
  return command;
}

function assertPrepareReviewReplacement(current, next, args) {
  const mutableFields = new Set([
    "artifactSets", "currentRevisionId", "events", "retry", "revisions", "stageAttempts",
    "state", "updatedAt", "version",
  ]);
  const immutableFields = Object.keys(current).filter((field) => !mutableFields.has(field));
  if (
    !next
    || typeof next !== "object"
    || Array.isArray(next)
    || Object.keys(next).sort().join("\0") !== Object.keys(current).sort().join("\0")
    || next.jobId !== args.jobId
    || next.version !== args.expectedVersion + 1
    || !PREPARE_REVIEW_TRANSITIONS.has(`${current.state}>${next.state}`)
    || immutableFields.some((field) => JSON.stringify(next[field]) !== JSON.stringify(current[field]))
    || !preservesHistory(current.events, next.events, { exactAdded: 1 })
    || !preservesHistory(current.revisions, next.revisions, { maximumAdded: 1 })
    || !preservesHistory(current.artifactSets, next.artifactSets, { maximumAdded: 1 })
    || next.stageAttempts.some((attempt) => attempt?.stage !== "prepare_review")
    || next.artifactSets.some((artifactSet) => artifactSet?.kind !== "private_review")
    || !preservesStageAttempts(current.stageAttempts, next.stageAttempts, args.commandId)
  ) {
    throw new Error("Generation worker may write only the claimed prepare_review transition.");
  }
}

function preservesHistory(current, next, { exactAdded, maximumAdded } = {}) {
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  const added = next.length - current.length;
  if (exactAdded !== undefined ? added !== exactAdded : added < 0 || added > maximumAdded) {
    return false;
  }
  return current.every((entry, index) => JSON.stringify(entry) === JSON.stringify(next[index]));
}

function preservesStageAttempts(current, next, commandId) {
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  if (next.length === current.length + 1) {
    return preservesHistory(current, next, { exactAdded: 1 })
      && next.at(-1)?.stage === "prepare_review"
      && next.at(-1)?.operationsCommandId === commandId;
  }
  if (next.length !== current.length) return false;
  if (next.length === 0) return true;
  if (!current.slice(0, -1).every(
    (entry, index) => JSON.stringify(entry) === JSON.stringify(next[index]),
  )) return false;
  const immutableAttemptFields = [
    "attemptId", "stage", "revisionId", "attemptNumber", "operationNumber", "idempotencyKey",
    "operationBinding", "operationsCommandId", "startedAt", "effectStartedAt",
  ];
  return current.at(-1)?.stage === "prepare_review"
    && immutableAttemptFields.every(
      (field) => JSON.stringify(current.at(-1)?.[field]) === JSON.stringify(next.at(-1)?.[field]),
    );
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
