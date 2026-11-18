export const OWNER_COMPLETION_JOB_ID = "job_narration_test_650a15d1-39bd-4dec-bc0d-3519ace71aa7";
export const OWNER_COMPLETION_REVISION_ID = "r1";
export const OWNER_COMPLETION_INITIAL_VERSION = 8;
export const OWNER_COMPLETION_NARRATION_DECISION_ID = "review_c4c5a7589bf08d2f674671d0";
export const OWNER_COMPLETION_MANIFEST_DIGEST = "182a2b2d6d99a3a1887aed9b7ae84c4dae9be3cef04b7c563122144ed8095209";
export const OWNER_COMPLETION_AUDIO_BYTES = 173_568;
export const OWNER_DELIVERY_EMAIL = "z@havesomecode.io";
export const OWNER_PUBLICATION_PROJECT_NAME = "bebebonjour-test-a-announcements";
export const OWNER_COMPLETION_LEASE_MS = 300_000;
export const OWNER_COMPLETION_ACTIONS = Object.freeze(["publish", "queue_delivery", "deliver"]);

const ACTION_SCOPE = OWNER_COMPLETION_ACTIONS.join(",");

export function requireOwnerCompletionEnvironment(environment = process.env) {
  const jobId = requiredExact(environment, "BEBEBONJOUR_OWNER_COMPLETION_JOB_ID", OWNER_COMPLETION_JOB_ID);
  requiredHttpsOrigin(environment, "CONVEX_URL");
  requiredSecret(environment, "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN", 32);
  requiredExact(environment, "BEBEBONJOUR_OWNER_COMPLETION_WORKER_ID", "owner-completion-worker");
  requiredExact(environment, "BEBEBONJOUR_OWNER_COMPLETION_WORKER_ACTIONS", ACTION_SCOPE);
  requiredExact(environment, "BEBEBONJOUR_OWNER_COMPLETION_WORKER_LIMIT", "1");
  requiredExact(environment, "BEBEBONJOUR_OWNER_COMPLETION_WORKER_LEASE_MS", String(OWNER_COMPLETION_LEASE_MS));
  requiredString(environment, "VERCEL_TOKEN");
  requiredHttpsOrigin(environment, "OWNER_PUBLICATION_ORIGIN");
  for (const name of ["OWNER_PUBLICATION_VERCEL_TEAM_ID", "OWNER_PUBLICATION_VERCEL_PROJECT_ID"]) {
    requiredString(environment, name);
  }
  requiredExact(environment, "OWNER_PUBLICATION_VERCEL_PROJECT_NAME", OWNER_PUBLICATION_PROJECT_NAME);
  requiredBase64(environment, "OWNER_VERCEL_BUILD_INSPECTION_B64", 65_536);
  const audioSha256 = requiredString(environment, "OWNER_APPROVED_AUDIO_SHA256");
  if (!/^48387158[a-f0-9]{53}58c$/u.test(audioSha256)) {
    throw new Error("OWNER_APPROVED_AUDIO_SHA256 must be the exact approved 64-character digest.");
  }
  requiredExact(environment, "OWNER_APPROVED_AUDIO_BYTES", String(OWNER_COMPLETION_AUDIO_BYTES));
  requiredSecret(environment, "CRON_SECRET", 32);
  if (environment.CRON_SECRET === environment.BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN) {
    throw new Error("Owner completion CRON_SECRET must be distinct from the worker token.");
  }
  return Object.freeze({
    jobId,
    revisionId: OWNER_COMPLETION_REVISION_ID,
    narrationDecisionId: OWNER_COMPLETION_NARRATION_DECISION_ID,
    artifactManifestDigest: OWNER_COMPLETION_MANIFEST_DIGEST,
    audioSha256,
    audioBytes: OWNER_COMPLETION_AUDIO_BYTES,
    recipient: OWNER_DELIVERY_EMAIL,
    workerId: "owner-completion-worker",
    actions: OWNER_COMPLETION_ACTIONS,
    limit: 1,
    leaseMs: OWNER_COMPLETION_LEASE_MS,
  });
}

function requiredExact(environment, name, expected) {
  const value = requiredString(environment, name);
  if (value !== expected) throw new Error(`${name} must match the exact owner completion policy.`);
  return expected;
}

function requiredString(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  return value.trim();
}

function requiredSecret(environment, name, minimumBytes) {
  const value = requiredString(environment, name);
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes.`);
  }
  return value;
}

function requiredHttpsOrigin(environment, name) {
  const value = requiredString(environment, name);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return value;
}

function requiredBase64(environment, name, maximumBytes) {
  const value = requiredString(environment, name);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be canonical bounded base64.`);
  }
  return decoded;
}
