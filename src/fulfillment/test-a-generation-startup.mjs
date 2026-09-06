import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadJobScopedGenerationApproval } from "./job-scoped-generation-approval.mjs";
import { createTestAGenerationRunner } from "./test-a-generation-runner.mjs";

const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const INERT_GENERATION_ENVIRONMENT_VARIABLES = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "__CF_USER_TEXT_ENCODING",
]);
const LOCAL_GENERATION_ENVIRONMENT_VARIABLES = Object.freeze([
  "CONVEX_URL",
  "CUSTOMER_FLOW_BACKEND_TOKEN",
]);

const defaultRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export async function runTestAGenerationCommand(options = {}) {
  const argv = options.argv || [];
  const [jobId, configuredRoot, approvalPath, ...extra] = argv;
  if (
    !JOB_ID.test(jobId || "")
    || typeof configuredRoot !== "string"
    || typeof approvalPath !== "string"
    || extra.length > 0
  ) {
    throw operatorError("generation_usage_rejected");
  }
  const environment = requireGenerationEnvironment(options.environment || process.env);
  const artifactRoot = requirePrivateArtifactRoot(
    configuredRoot,
    options.repositoryRoot || defaultRepositoryRoot,
  );
  let editorialApproval;
  try {
    editorialApproval = await loadJobScopedGenerationApproval({
      jobId,
      artifactRoot,
      configuredRoot,
      approvalPath,
    });
  } catch {
    throw operatorError("generation_approval_rejected");
  }
  const createRunner = options.createRunner || createTestAGenerationRunner;
  if (typeof createRunner !== "function") throw operatorError("generation_configuration_rejected");
  const runner = createRunner({ environment, artifactRoot, editorialApproval });
  if (typeof runner?.generate !== "function" || Object.keys(runner).some((key) => key !== "generate")) {
    throw operatorError("generation_configuration_rejected");
  }
  return runner.generate(jobId);
}

export function generationOperatorErrorCode(error) {
  const code = error?.name === "TestAGenerationOperatorError" || error?.name === "GenerationStartupError"
    ? error.code
    : null;
  return typeof code === "string" && /^generation_[a-z0-9_]{1,64}$/u.test(code)
    ? code
    : "generation_failed_safely";
}

function requireGenerationEnvironment(environment) {
  const allowedNames = new Set([
    ...LOCAL_GENERATION_ENVIRONMENT_VARIABLES,
    ...INERT_GENERATION_ENVIRONMENT_VARIABLES,
  ]);
  if (
    !environment
    || typeof environment !== "object"
    || Array.isArray(environment)
    || Object.keys(environment).some((name) => !allowedNames.has(name))
  ) {
    throw operatorError("generation_environment_rejected");
  }
  const convexUrl = environment?.CONVEX_URL;
  const backendToken = environment?.CUSTOMER_FLOW_BACKEND_TOKEN;
  if (typeof backendToken !== "string" || Buffer.byteLength(backendToken, "utf8") < 32) {
    throw operatorError("generation_environment_rejected");
  }
  let url;
  try {
    url = new URL(convexUrl);
  } catch {
    throw operatorError("generation_environment_rejected");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== convexUrl
  ) {
    throw operatorError("generation_environment_rejected");
  }
  return Object.freeze(Object.fromEntries(
    LOCAL_GENERATION_ENVIRONMENT_VARIABLES
      .filter((name) => environment[name] !== undefined)
      .map((name) => [name, environment[name]]),
  ));
}

function requirePrivateArtifactRoot(value, repositoryRoot) {
  if (value.trim() !== value || !path.isAbsolute(value)) {
    throw operatorError("generation_artifact_root_rejected");
  }
  let metadata;
  let canonicalRoot;
  let canonicalRepository;
  try {
    metadata = lstatSync(value);
    canonicalRoot = realpathSync(value);
    canonicalRepository = realpathSync(repositoryRoot);
  } catch {
    throw operatorError("generation_artifact_root_rejected");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw operatorError("generation_artifact_root_rejected");
  }
  const relative = path.relative(canonicalRepository, canonicalRoot);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw operatorError("generation_artifact_root_rejected");
  }
  return canonicalRoot;
}

function operatorError(code) {
  const error = new Error(code);
  error.name = "GenerationStartupError";
  error.code = code;
  return error;
}
