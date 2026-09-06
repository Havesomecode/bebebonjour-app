import { ConvexHttpClient } from "convex/browser";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadJobScopedGenerationApproval } from "./job-scoped-generation-approval.mjs";

const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function persistTestAGenerationApproval(options = {}) {
  const [jobId, configuredRoot, approvalPath, ...extra] = options.argv || [];
  if (
    !JOB_ID.test(jobId || "")
    || typeof configuredRoot !== "string"
    || typeof approvalPath !== "string"
    || extra.length > 0
  ) {
    throw new Error("Usage: persist-test-a-generation-approval <job_id> <private_root> <approval_json>");
  }
  const environment = options.environment || process.env;
  const convexUrl = requiredHttpsOrigin(environment.CONVEX_URL);
  const backendToken = requiredSecret(environment.CUSTOMER_FLOW_BACKEND_TOKEN);
  const artifactRoot = requirePrivateRoot(
    configuredRoot,
    options.repositoryRoot || defaultRepositoryRoot,
  );
  const approval = await loadJobScopedGenerationApproval({
    jobId,
    artifactRoot,
    configuredRoot,
    approvalPath,
  });
  const client = options.client || new ConvexHttpClient(convexUrl);
  if (typeof client.mutation !== "function") {
    throw new Error("Generation approval provisioning requires the canonical Convex client.");
  }
  const result = await client.mutation("generation:saveEditorialApproval", {
    backendToken,
    jobId,
    approval,
  });
  if (
    typeof result?.created !== "boolean"
    || result?.approval?.recordDigest !== approval.recordDigest
    || result?.approval?.record?.jobId !== jobId
  ) {
    throw new Error("Generation approval persistence readback is invalid.");
  }
  return Object.freeze({
    status: result.created ? "created" : "already_present",
    jobId,
    recordDigest: approval.recordDigest,
  });
}

export function generationApprovalProvisioningErrorCode() {
  return "generation_approval_persistence_failed_safely";
}

function requirePrivateRoot(value, repositoryRoot) {
  if (typeof value !== "string" || value.trim() !== value || !path.isAbsolute(value)) {
    throw new Error("Generation approval root must be an absolute private directory.");
  }
  let metadata;
  let root;
  let repository;
  try {
    metadata = lstatSync(value);
    root = realpathSync(value);
    repository = realpathSync(repositoryRoot);
  } catch {
    throw new Error("Generation approval root must be an existing private directory.");
  }
  const relative = path.relative(repository, root);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
    || relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    throw new Error("Generation approval root is not an isolated private directory.");
  }
  return root;
}

function requiredHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CONVEX_URL must be an exact HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CONVEX_URL must be an exact HTTPS origin.");
  }
  return value;
}

function requiredSecret(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("CUSTOMER_FLOW_BACKEND_TOKEN must contain at least 32 bytes.");
  }
  return value;
}
