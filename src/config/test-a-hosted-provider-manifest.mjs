import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const EXPECTED_TEST_A_HOSTED_PROVIDER_MANIFEST_SHA256 =
  "3605fb59dc51fd7cb9713ee4e8154026cf00bbded6f0b0d7b2800f2da23d224a";

const manifestUrl = new URL("../../ops/test-a-hosted-provider-manifest.json", import.meta.url);

export function loadReviewedTestAOperatorPolicy(
  manifestBytes,
  { expectedDigest = EXPECTED_TEST_A_HOSTED_PROVIDER_MANIFEST_SHA256 } = {},
) {
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (manifestSha256 !== expectedDigest) {
    throw new Error("TEST-A hosted provider manifest digest does not match the reviewed cold-start authority.");
  }

  let manifest;
  try {
    manifest = JSON.parse(bytes);
  } catch (error) {
    throw new Error("TEST-A hosted provider manifest is not valid JSON.", { cause: error });
  }
  if (manifest?.schemaVersion !== "2.0") {
    throw new Error("TEST-A hosted provider manifest schema version is not supported.");
  }

  const runtime = requireRecord(manifest.resendOperatorRuntime, "operator runtime policy");
  requireExactKeys(runtime, [
    "capabilities",
    "environmentVariables",
    "futurePublicationIdentityAuthority",
    "providerOperationsEnabled",
    "publicApiAccess",
    "requiresPersistedHumanApproval",
  ], "operator runtime policy");
  const capabilities = requireUniqueStringArray(runtime.capabilities, "operator capabilities");
  if (JSON.stringify(capabilities) !== JSON.stringify(["status", "persist-approval"])) {
    throw new Error("TEST-A operator capabilities must remain status and persist-approval only.");
  }
  if (runtime.providerOperationsEnabled !== false || runtime.publicApiAccess !== false) {
    throw new Error("TEST-A operator provider operations and public API access must remain disabled.");
  }
  if (runtime.requiresPersistedHumanApproval !== true) {
    throw new Error("TEST-A operator must require persisted human approval.");
  }
  requireString(runtime.futurePublicationIdentityAuthority, "future publication identity authority");
  const secretStore = requireRecord(manifest.secretStores?.resendOperator, "operator secret-store policy");
  const allowedEnvironmentVariables = requireUniqueStringArray(
    secretStore.allowed,
    "operator allowed environment variables",
  );
  const forbiddenEnvironmentVariables = requireUniqueStringArray(
    secretStore.forbidden,
    "operator forbidden environment variables",
  );
  const runtimeEnvironmentVariables = requireUniqueStringArray(
    runtime.environmentVariables,
    "operator runtime environment variables",
  );
  if (JSON.stringify(allowedEnvironmentVariables) !== JSON.stringify(runtimeEnvironmentVariables)) {
    throw new Error("TEST-A operator runtime environment variables do not match the reviewed secret-store policy.");
  }
  if (allowedEnvironmentVariables.some((name) => forbiddenEnvironmentVariables.includes(name))) {
    throw new Error("TEST-A operator environment variables cannot be both allowed and forbidden.");
  }

  return deepFreeze({
    allowedEnvironmentVariables,
    capabilities,
    forbiddenEnvironmentVariables,
    manifestSha256,
    runtimeEnvironmentVariables,
  });
}

export const REVIEWED_TEST_A_OPERATOR_POLICY = loadReviewedTestAOperatorPolicy(
  readFileSync(manifestUrl),
);

export function loadReviewedTestAGenerationPolicy(
  manifestBytes,
  { expectedDigest = EXPECTED_TEST_A_HOSTED_PROVIDER_MANIFEST_SHA256 } = {},
) {
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (manifestSha256 !== expectedDigest) {
    throw new Error("TEST-A hosted provider manifest digest does not match generation authority.");
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes);
  } catch (error) {
    throw new Error("TEST-A hosted provider manifest is not valid JSON.", { cause: error });
  }
  if (manifest?.schemaVersion !== "2.0") {
    throw new Error("TEST-A hosted provider manifest schema version is not supported.");
  }

  const runtime = requireRecord(manifest.generationOperatorRuntime, "generation operator runtime policy");
  requireExactKeys(runtime, [
    "authorityInputs",
    "capabilities",
    "deployment",
    "environmentVariables",
    "localConfiguration",
    "optionalEnvironmentVariables",
    "providerOperationsEnabled",
    "publicApiAccess",
    "stages",
  ], "generation operator runtime policy");
  const authorityInputs = requireUniqueStringArray(
    runtime.authorityInputs,
    "generation operator authority inputs",
  );
  const capabilities = requireUniqueStringArray(runtime.capabilities, "generation operator capabilities");
  const deployment = requireRecord(runtime.deployment, "generation operator deployment");
  requireExactKeys(deployment, [
    "configPath", "entrypoint", "projectName", "provider", "route", "schedule",
  ], "generation operator deployment");
  const runtimeEnvironmentVariables = requireUniqueStringArray(
    runtime.environmentVariables,
    "generation operator runtime environment variables",
  );
  const localConfiguration = requireUniqueStringArray(
    runtime.localConfiguration,
    "generation operator local configuration",
    { allowEmpty: true },
  );
  const optionalEnvironmentVariables = requireUniqueStringArray(
    runtime.optionalEnvironmentVariables,
    "generation operator optional environment variables",
  );
  const stages = requireUniqueStringArray(runtime.stages, "generation operator stages");
  if (
    JSON.stringify(authorityInputs) !== JSON.stringify([
      "jobId",
      "persistedJobScopedEditorialApproval",
      "convexAuthenticatedPrivateArtifactHttpAction",
      "optionalOneTimeCodexAuthBootstrap",
      "singleLeasedEncryptedCodexAuthState",
    ])
    || JSON.stringify(capabilities) !== JSON.stringify(["prepare-review"])
    || JSON.stringify(runtimeEnvironmentVariables) !== JSON.stringify([
      "CONVEX_URL",
      "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
      "BEBEBONJOUR_OPERATIONS_WORKER_ID",
      "BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS",
      "BEBEBONJOUR_OPERATIONS_WORKER_LIMIT",
      "BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS",
      "BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED",
      "BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY",
      "BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64",
      "BEBEBONJOUR_CODEX_MODEL",
      "BEBEBONJOUR_CODEX_TIMEOUT_MS",
      "BEBEBONJOUR_CODEX_AUTH_LEASE_MS",
      "CRON_SECRET",
    ])
    || JSON.stringify(optionalEnvironmentVariables) !== JSON.stringify([
      "BEBEBONJOUR_CODEX_AUTH_BOOTSTRAP_B64",
    ])
    || JSON.stringify(localConfiguration) !== JSON.stringify([])
    || JSON.stringify(stages) !== JSON.stringify(["prepare_review"])
    || runtime.providerOperationsEnabled
      !== "OpenAI Codex subscription composition and Convex file storage"
    || runtime.publicApiAccess !== false
    || JSON.stringify(deployment) !== JSON.stringify({
      provider: "Vercel",
      projectName: "bebebonjour-generation-worker",
      configPath: "vercel.generation-worker.json",
      entrypoint: "generation-worker/api/worker.mjs",
      route: "GET /api/operations/worker",
      schedule: "*/5 * * * *",
    })
  ) {
    throw new Error("TEST-A generation authority must remain isolated to prepare_review.");
  }
  const secretStore = requireRecord(
    manifest.secretStores?.generationOperator,
    "generation operator secret-store policy",
  );
  const allowedEnvironmentVariables = requireUniqueStringArray(
    secretStore.allowed,
    "generation operator allowed environment variables",
  );
  const forbiddenEnvironmentVariables = requireUniqueStringArray(
    secretStore.forbidden,
    "generation operator forbidden environment variables",
  );
  if (
    JSON.stringify(allowedEnvironmentVariables) !== JSON.stringify(runtimeEnvironmentVariables)
    || allowedEnvironmentVariables.some((name) => forbiddenEnvironmentVariables.includes(name))
  ) {
    throw new Error("TEST-A generation environment does not match its isolated secret-store policy.");
  }
  return deepFreeze({
    allowedEnvironmentVariables,
    authorityInputs,
    capabilities,
    deployment,
    forbiddenEnvironmentVariables,
    localConfiguration,
    optionalEnvironmentVariables,
    manifestSha256,
    runtimeEnvironmentVariables,
    stages,
  });
}

export const REVIEWED_TEST_A_GENERATION_POLICY = loadReviewedTestAGenerationPolicy(
  readFileSync(manifestUrl),
);

export function loadReviewedTestACompletionPolicy(
  manifestBytes,
  { expectedDigest = EXPECTED_TEST_A_HOSTED_PROVIDER_MANIFEST_SHA256 } = {},
) {
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (manifestSha256 !== expectedDigest) {
    throw new Error("TEST-A hosted provider manifest digest does not match completion authority.");
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes);
  } catch (error) {
    throw new Error("TEST-A hosted provider manifest is not valid JSON.", { cause: error });
  }
  if (manifest?.schemaVersion !== "2.0") {
    throw new Error("TEST-A hosted provider manifest schema version is not supported.");
  }

  const runtime = requireRecord(manifest.completionOperatorRuntime, "completion operator runtime policy");
  requireExactKeys(runtime, [
    "authorityInputs", "capabilities", "deployment", "environmentVariables",
    "providerOperationsEnabled", "publicApiAccess", "stages",
  ], "completion operator runtime policy");
  const authorityInputs = requireUniqueStringArray(runtime.authorityInputs, "completion authority inputs");
  const capabilities = requireUniqueStringArray(runtime.capabilities, "completion capabilities");
  const deployment = requireRecord(runtime.deployment, "completion deployment");
  requireExactKeys(deployment, [
    "configPath", "entrypoint", "minimumPlan", "projectName", "provider", "route", "schedule",
  ], "completion deployment");
  const runtimeEnvironmentVariables = requireUniqueStringArray(
    runtime.environmentVariables,
    "completion runtime environment variables",
  );
  const stages = requireUniqueStringArray(runtime.stages, "completion stages");
  const expectedEnvironmentVariables = [
    "CONVEX_URL",
    "BEBEBONJOUR_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_OPERATIONS_WORKER_ID",
    "BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS",
    "BEBEBONJOUR_OPERATIONS_WORKER_LIMIT",
    "BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS",
    "BEBEBONJOUR_TEST_A_COMPLETION_JOB_ID",
    "BEBEBONJOUR_APPROVAL_HMAC_KEY",
    "BEBEBONJOUR_TEST_A_APPROVAL_ID",
    "VERCEL_TOKEN",
    "VERCEL_PROTECTION_BYPASS_SECRET",
    "VERCEL_BUILD_INSPECTION_B64",
    "RESEND_API_KEY",
    "RESEND_FROM",
    "TEST_A_PUBLICATION_ORIGIN",
    "TEST_A_PUBLICATION_VERCEL_TEAM_ID",
    "TEST_A_PUBLICATION_VERCEL_PROJECT_ID",
    "TEST_A_PUBLICATION_VERCEL_PROJECT_NAME",
    "CRON_SECRET",
  ];
  if (
    JSON.stringify(authorityInputs) !== JSON.stringify([
      "fixedSyntheticJobId",
      "persistedSignedContentApproval",
      "claimScopedConvexArtifactReads",
      "authoritativePublicationInspection",
      "fixedResendTestSink",
    ])
    || JSON.stringify(capabilities) !== JSON.stringify([
      "approve_content", "render", "publish", "queue_delivery", "deliver", "retry",
    ])
    || JSON.stringify(runtimeEnvironmentVariables) !== JSON.stringify(expectedEnvironmentVariables)
    || JSON.stringify(stages) !== JSON.stringify(["render_approved", "publish", "deliver"])
    || runtime.providerOperationsEnabled
      !== "access-protected Vercel TEST-A publication and Resend test-sink delivery"
    || runtime.publicApiAccess !== false
    || JSON.stringify(deployment) !== JSON.stringify({
      provider: "Vercel",
      projectName: "bebebonjour-completion-worker",
      configPath: "vercel.completion-worker.json",
      entrypoint: "completion-worker/api/worker.mjs",
      route: "GET /api/operations/completion-worker",
      schedule: "*/5 * * * *",
      minimumPlan: "pro",
    })
  ) {
    throw new Error("TEST-A completion authority must remain fixed and isolated.");
  }
  const secretStore = requireRecord(
    manifest.secretStores?.completionOperator,
    "completion operator secret-store policy",
  );
  const allowedEnvironmentVariables = requireUniqueStringArray(
    secretStore.allowed,
    "completion allowed environment variables",
  );
  const forbiddenEnvironmentVariables = requireUniqueStringArray(
    secretStore.forbidden,
    "completion forbidden environment variables",
  );
  if (
    JSON.stringify(allowedEnvironmentVariables) !== JSON.stringify(runtimeEnvironmentVariables)
    || allowedEnvironmentVariables.some((name) => forbiddenEnvironmentVariables.includes(name))
  ) {
    throw new Error("TEST-A completion environment does not match its isolated secret-store policy.");
  }
  return deepFreeze({
    allowedEnvironmentVariables,
    authorityInputs,
    capabilities,
    deployment,
    forbiddenEnvironmentVariables,
    manifestSha256,
    runtimeEnvironmentVariables,
    stages,
  });
}

export const REVIEWED_TEST_A_COMPLETION_POLICY = loadReviewedTestACompletionPolicy(
  readFileSync(manifestUrl),
);

export function requireReviewedTestACompletionEnvironment(
  environment,
  { policy = REVIEWED_TEST_A_COMPLETION_POLICY } = {},
) {
  for (const name of policy.forbiddenEnvironmentVariables) {
    if (environment?.[name] !== undefined) {
      throw new Error(`${name} is forbidden by the reviewed TEST-A completion secret-store policy.`);
    }
  }
  for (const name of policy.allowedEnvironmentVariables) {
    if (typeof environment?.[name] !== "string" || environment[name].trim() === "") {
      throw new Error(`${name} is required by the reviewed TEST-A completion secret-store policy.`);
    }
  }
  if (environment.CRON_SECRET === environment.BEBEBONJOUR_COMPLETION_WORKER_TOKEN) {
    throw new Error("CRON_SECRET must be distinct from BEBEBONJOUR_COMPLETION_WORKER_TOKEN.");
  }
  return Object.freeze(Object.fromEntries(
    policy.allowedEnvironmentVariables.map((name) => [name, environment[name]]),
  ));
}

export function requireReviewedTestAGenerationEnvironment(
  environment,
  { policy = REVIEWED_TEST_A_GENERATION_POLICY } = {},
) {
  for (const name of policy.forbiddenEnvironmentVariables) {
    if (environment?.[name] !== undefined) {
      throw new Error(`${name} is forbidden by the reviewed TEST-A generation secret-store policy.`);
    }
  }
  for (const name of policy.allowedEnvironmentVariables) {
    if (policy.optionalEnvironmentVariables.includes(name) && environment?.[name] === undefined) {
      continue;
    }
    if (typeof environment?.[name] !== "string" || environment[name].trim() === "") {
      throw new Error(`${name} is required by the reviewed TEST-A generation secret-store policy.`);
    }
  }
  if (environment.CRON_SECRET === environment.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN) {
    throw new Error("CRON_SECRET must be distinct from BEBEBONJOUR_OPERATIONS_WORKER_TOKEN.");
  }
  if (environment.BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS !== "generate") {
    throw new Error("BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS must equal generate.");
  }
  if (environment.BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED !== "true") {
    throw new Error("BEBEBONJOUR_CODEX_SUBSCRIPTION_ENABLED must equal true.");
  }
  return Object.freeze(Object.fromEntries(
    policy.allowedEnvironmentVariables
      .filter((name) => environment[name] !== undefined)
      .map((name) => [name, environment[name]]),
  ));
}

export function requireReviewedTestAOperatorEnvironment(
  environment,
  { providerCapable, policy = REVIEWED_TEST_A_OPERATOR_POLICY } = {},
) {
  for (const name of policy.forbiddenEnvironmentVariables) {
    if (environment?.[name] !== undefined) {
      throw new Error(`${name} is forbidden by the reviewed TEST-A operator secret-store policy.`);
    }
  }
  const requiredNames = providerCapable
    ? policy.allowedEnvironmentVariables
    : ["CONVEX_URL", "CUSTOMER_FLOW_BACKEND_TOKEN"];
  for (const name of requiredNames) {
    if (!policy.allowedEnvironmentVariables.includes(name)) {
      throw new Error(`${name} is not allowed by the reviewed TEST-A operator secret-store policy.`);
    }
    if (typeof environment?.[name] !== "string" || environment[name].trim() === "") {
      throw new Error(`${name} is required by the reviewed TEST-A operator secret-store policy.`);
    }
  }
  return policy;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`TEST-A ${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error(`TEST-A ${label} fields do not match the reviewed manifest schema.`);
  }
}

function requireUniqueStringArray(value, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
    || new Set(value).size !== value.length
  ) {
    throw new Error(`TEST-A ${label} must be a${allowEmpty ? "" : " non-empty"} unique string list.`);
  }
  return [...value];
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`TEST-A ${label} must be an exact non-empty string.`);
  }
  return value;
}

function requireExactHttpsOrigin(value, label) {
  const exact = requireString(value, label);
  const url = new URL(exact);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== exact
  ) {
    throw new Error(`TEST-A ${label} must be an exact HTTPS origin.`);
  }
  return exact;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
