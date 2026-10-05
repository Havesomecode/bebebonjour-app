import { createHash, timingSafeEqual } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { parseAuthoritativeVercelBuildInspection } from "../../src/fulfillment/vercel-test-a-publication-provider.mjs";
import { stablePrivateValue } from "../../src/fulfillment/private-generation-authority.mjs";

export const config = { runtime: "nodejs", maxDuration: 45 };
const TIMEOUT_MS = 5000;
const STATIC_PATHS = Object.freeze(["deploy/ar/app.js", "deploy/ar/index.html", "deploy/fr/app.js", "deploy/fr/index.html", "deploy/index.html", "deploy/shared/app.css"]);
const check = (name, status, reason, extra = {}) => ({ name, status, reason, ...extra });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function send(response, statusCode, body) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}
function bearer(value, secret) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(typeof value === "string" ? value : "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("diagnostic_timeout")), TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}
async function readProviderJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_read_rejected");
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("provider_read_rejected");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel(); reader.releaseLock(); }
}
function configuration(env) {
  const token = env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN;
  if (typeof token !== "string" || Buffer.byteLength(token) < 32 || token === env.OWNER_TRIAL_INVOKE_SECRET
      || typeof env.VERCEL_TOKEN !== "string" || !env.VERCEL_TOKEN.trim()
      || !/^https:\/\/[a-z0-9-]+\.convex\.cloud$/u.test(env.CONVEX_URL || "")) throw new Error("configuration_rejected");
  const encoded = env.OWNER_TRIAL_VERCEL_BUILD_INSPECTION_B64;
  if (typeof encoded !== "string" || encoded.length > 87384 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error("configuration_rejected");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("configuration_rejected");
  const identity = parseAuthoritativeVercelBuildInspection(bytes);
  for (const [key, name] of [["teamId", "OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID"], ["projectId", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID"], ["projectName", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME"]]) {
    if (!env[name] || identity[key] !== env[name]) throw new Error("configuration_rejected");
  }
  return identity;
}
function policyBound(policy, jobId, identity) {
  if (policy?.jobId !== jobId || policy.workerId !== "owner-trial-completion-worker"
      || policy.recipient !== "z@havesomecode.io" || policy.ownerSourceReference !== "kanban:t_4b1eb28f"
      || policy.revisionId !== identity.revisionId || !hex(policy.manifestDigest) || !hex(policy.intakeDigest)) return false;
  try {
    const origin = new URL(policy.origin);
    return origin.protocol === "https:" && origin.origin === policy.origin && !origin.username && !origin.password;
  } catch { return false; }
}
function manifestBound(job, policy) {
  if (job?.jobId !== policy.jobId || job.environment !== "test" || job.product !== "announcement-page"
      || job.currentRevisionId !== policy.revisionId || job.intakeDigest !== policy.intakeDigest || !Array.isArray(job.artifactSets)) return null;
  const sets = job.artifactSets.filter(set => set.kind === "narration_review" && set.revisionId === policy.revisionId);
  if (sets.length !== 1 || sets[0].assetManifestDigest !== policy.manifestDigest || !Array.isArray(sets[0].files)) return null;
  const set = sets[0], files = set.files.map(({ path, storageId, objectRef, bytes, sha256 }) => ({ path, storageId: storageId || objectRef?.storageId, bytes, sha256 }));
  if (files.some(file => typeof file.path !== "string" || typeof file.storageId !== "string" || !file.storageId
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !hex(file.sha256)) || new Set(files.map(file => file.path)).size !== files.length) return null;
  const digest = sha(Buffer.from(`${JSON.stringify({ schemaVersion: "1.0", kind: set.kind, revisionId: set.revisionId, files }, null, 2)}\n`));
  if (digest !== policy.manifestDigest) return null;
  const publicFiles = files.filter(file => STATIC_PATHS.includes(file.path) || /^artifacts\/audio\/[A-Za-z0-9/_-]+\.mp3$/u.test(file.path));
  if (!publicFiles.some(file => ["deploy/index.html", "deploy/fr/index.html"].includes(file.path)) || !publicFiles.some(file => file.path.endsWith(".mp3"))) return null;
  return { staticPaths: STATIC_PATHS.filter(path => publicFiles.some(file => file.path === path)), publicFileCount: publicFiles.length };
}

// This module never creates capabilities, claims commands, or resolves artifact bytes.
export function createOwnerTrialPublicationDiagnosticsHttpHandler(options = {}) {
  const source = options.environment || process.env;
  const secret = source.OWNER_TRIAL_INVOKE_SECRET, jobId = source.OWNER_TRIAL_JOB_ID;
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error("Owner trial manual invocation secret is required.");
  if (!/^job_owner_trial_[a-f0-9]{32}$/u.test(jobId || "")) throw new Error("Owner trial manual invocation job binding is required.");
  // Capture only the configured inputs; subsequent request/environment changes cannot retarget this handler.
  const env = Object.freeze(Object.fromEntries(["OWNER_TRIAL_INVOKE_SECRET", "BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN", "VERCEL_TOKEN", "CONVEX_URL",
    "OWNER_TRIAL_VERCEL_BUILD_INSPECTION_B64", "OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID", "OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME"].map(name => [name, source[name]])));
  return async (request, response) => {
    if (request.method !== "GET") { response.setHeader("Allow", "GET"); return send(response, 405, { status: "error", code: "method_not_allowed" }); }
    if (!bearer(request.headers?.authorization, secret)) return send(response, 401, { status: "error", code: "unauthorized" });
    try {
      const url = new URL(request.url || "/", "https://diagnostics.invalid");
      if (url.search || (request.query && Object.keys(request.query).length)) return send(response, 400, { status: "error", code: "request_scope_rejected" });
    } catch { return send(response, 400, { status: "error", code: "request_scope_rejected" }); }
    const checks = [];
    let identity;
    try { identity = configuration(env); } catch {
      return send(response, 200, { checks: [check("configuration", "fail", "configuration_rejected")] });
    }
    checks.push(check("configuration", "pass", "configured_identity_bound"));
    let policy, job;
    try {
      const client = options.client || new ConvexHttpClient(env.CONVEX_URL);
      const args = { completionToken: env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN, jobId };
      policy = await bounded(() => client.query("ownerTrial:completionPolicy", args));
      if (!policyBound(policy, jobId, identity)) throw new Error("policy_rejected");
      const pinned = stablePrivateValue(policy);
      job = await bounded(() => client.query("ownerTrialCompletion:getJob", args));
      const current = await bounded(() => client.query("ownerTrial:completionPolicy", args));
      if (stablePrivateValue(current) !== pinned) throw new Error("policy_rejected");
    } catch {
      checks.push(check("completion_policy", "fail", "persisted_policy_rejected"));
      return send(response, 200, { checks });
    }
    checks.push(check("completion_policy", "pass", "persisted_policy_bound"));
    let manifest;
    try { manifest = manifestBound(job, policy); } catch { manifest = null; }
    checks.push(check("artifact_manifest", manifest ? "pass" : "fail", manifest ? "persisted_manifest_bound" : "persisted_manifest_rejected", manifest || {}));
    checks.push(check("artifact_resolution", "blocked", "active_publish_fence_required"));
    if (!manifest) return send(response, 200, { checks });
    const fetchImpl = options.fetch || globalThis.fetch;
    const reads = [
      ["vercel_project", `/v9/projects/${encodeURIComponent(identity.projectId)}`, data => data?.id === identity.projectId && data.name === identity.projectName && data.accountId === identity.teamId, "project_identity_bound"],
      ["vercel_alias", `/v4/aliases/${encodeURIComponent(new URL(policy.origin).hostname)}`, data => data?.alias === new URL(policy.origin).hostname && data.projectId === identity.projectId, "alias_project_bound"],
      ["vercel_deployment", `/v13/deployments/${encodeURIComponent(identity.deploymentId)}`, data => data?.id === identity.deploymentId && data.projectId === identity.projectId && data.name === identity.projectName && data.team?.id === identity.teamId && data.readyState === "READY", "deployment_identity_bound"],
      ["vercel_build", `/v11/deployments/${encodeURIComponent(identity.deploymentId)}/builds`, data => Array.isArray(data?.builds) && data.builds.filter(build => build?.id === identity.buildId).length === 1 && data.builds.find(build => build?.id === identity.buildId)?.readyState === "READY", "build_identity_bound"],
    ];
    for (const [name, path, validate, reason] of reads) {
      try {
        const url = new URL(path, "https://api.vercel.com"); url.searchParams.set("teamId", identity.teamId);
        const data = await bounded(async () => {
          const result = await fetchImpl(url, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Bearer ${env.VERCEL_TOKEN}`, accept: "application/json" } });
          if (!result.ok) throw new Error("provider_read_rejected");
          return readProviderJson(result);
        });
        checks.push(check(name, validate(data) ? "pass" : "fail", validate(data) ? reason : "provider_identity_rejected"));
      } catch { checks.push(check(name, "fail", "provider_read_rejected")); }
    }
    return send(response, 200, { checks });
  };
}
export default async function publicationDiagnostics(request, response) {
  try { return await createOwnerTrialPublicationDiagnosticsHttpHandler()(request, response); }
  catch { return send(response, 500, { status: "error", code: "diagnostics_configuration_rejected" }); }
}
