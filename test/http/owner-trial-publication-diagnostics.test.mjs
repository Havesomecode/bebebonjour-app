import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
// Offline fixtures only: never a provider result or customer artifact.
const jobId = "job_owner_trial_" + "a".repeat(32);
const inspection = { schemaVersion: "1.0", source: "vercel inspect --format=json", deploymentId: "dpl_offline",
  buildId: "bld_offline", teamId: "team_offline", projectId: "prj_offline", projectName: "offline-trial", revisionId: "r1" };
const environment = { OWNER_TRIAL_INVOKE_SECRET: "offline-invoke-" + "s".repeat(32), OWNER_TRIAL_JOB_ID: jobId,
  BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: "offline-worker-" + "t".repeat(32), VERCEL_TOKEN: "offline-vercel-only",
  CONVEX_URL: "https://offline.convex.cloud", OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID: inspection.teamId,
  OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID: inspection.projectId, OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME: inspection.projectName,
  OWNER_TRIAL_VERCEL_BUILD_INSPECTION_B64: Buffer.from(JSON.stringify(inspection)).toString("base64") };
function response() { return { headers: {}, body: null, statusCode: null,
  setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = JSON.parse(value); } }; }
function fixture() {
  const paths = ["deploy/fr/index.html", "deploy/ar/index.html", "deploy/fr/app.js", "deploy/ar/app.js", "deploy/shared/app.css",
    "artifacts/audio/fr/intro.mp3", "artifacts/current/intake.json"];
  const files = paths.map((path, i) => ({ path, storageId: `private-storage-${i}`, bytes: 1, sha256: sha("x") }));
  const manifestDigest = sha(Buffer.from(`${JSON.stringify({ schemaVersion: "1.0", kind: "narration_review", revisionId: "r1", files }, null, 2)}\n`));
  const policy = { jobId, revisionId: "r1", manifestDigest, recipient: "z@havesomecode.io", ownerSourceReference: "kanban:t_4b1eb28f",
    workerId: "owner-trial-completion-worker", origin: "https://offline-trial.example.invalid", intakeDigest: sha("offline-intake") };
  const job = { jobId, environment: "test", product: "announcement-page", currentRevisionId: "r1", intakeDigest: policy.intakeDigest,
    state: "reconciliation_required", artifactSets: [{ kind: "narration_review", revisionId: "r1", artifactSetId: "set_offline", assetManifestDigest: manifestDigest, files }],
    stageAttempts: [{ stage: "publish", revisionId: "r1", idempotencyKey: `bb_${"e".repeat(64)}`, operationsCommandId: "owner_completion_publish_offline",
      failure: { reasonCode: "publication_scope_invalid" }, status: "reconciliation_required" }],
    privateCustomerContent: "DO_NOT_DISCLOSE_CUSTOMER_CONTENT" };
  const queries = [], requests = [];
  const client = { async query(name, args) { queries.push({ name, args });
    assert.equal(args.jobId, jobId); assert.equal(args.completionToken, environment.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN);
    if (name === "ownerTrial:completionPolicy") return structuredClone(policy);
    if (name === "ownerTrialCompletion:getJob") return structuredClone(job);
    assert.fail(`Unexpected read ${name}`);
  }, mutation() { assert.fail("No mutations permitted"); }, action() { assert.fail("No actions permitted"); } };
  const fetch = async (url, init) => { const u = new URL(url); requests.push(u);
    assert.equal(u.origin, "https://api.vercel.com"); assert.equal(u.searchParams.get("teamId"), inspection.teamId);
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.ok(init.signal instanceof AbortSignal);
    let data;
    if (u.pathname === `/v9/projects/${inspection.projectId}`) data = { id: inspection.projectId, name: inspection.projectName, accountId: inspection.teamId };
    else if (u.pathname.startsWith("/v4/aliases/")) data = { alias: new URL(policy.origin).hostname, projectId: inspection.projectId };
    else if (u.pathname === `/v13/deployments/${inspection.deploymentId}`) data = { id: inspection.deploymentId, projectId: inspection.projectId, name: inspection.projectName, team: { id: inspection.teamId }, readyState: "READY" };
    else if (u.pathname === `/v11/deployments/${inspection.deploymentId}/builds`) data = { builds: [{ id: inspection.buildId, readyState: "READY" }] };
    else assert.fail(`Unexpected read-only endpoint ${u.pathname}`);
    return new Response(JSON.stringify(data));
  };
  return { policy, job, queries, requests, client, fetch };
}
async function handler(options) {
  const module = await import("../../owner-trial-completion-worker/api/publication-diagnostics.mjs").catch(() => null);
  assert.equal(typeof module?.createOwnerTrialPublicationDiagnosticsHttpHandler, "function", "The authenticated diagnostics endpoint must exist");
  return module.createOwnerTrialPublicationDiagnosticsHttpHandler(options);
}
async function invoke(h, overrides = {}) { const result = response(); await h({ method: "GET", url: "/api/operations/owner-trial-publication-diagnostics",
  headers: { authorization: `Bearer ${environment.OWNER_TRIAL_INVOKE_SECRET}` }, ...overrides }, result); return result; }

test("read-only trial diagnostics identifies exact configured project/alias/build and blocked artifact resolution without exposing data", async () => {
  const f = fixture(); const h = await handler({ environment, client: f.client, fetch: f.fetch });
  const result = await invoke(h);
  assert.equal(result.statusCode, 200); assert.equal(result.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(result.body.checks.map(c => [c.name, c.status, c.reason]), [
    ["configuration", "pass", "configured_identity_bound"], ["completion_policy", "pass", "persisted_policy_bound"],
    ["artifact_manifest", "pass", "persisted_manifest_bound"], ["artifact_resolution", "blocked", "active_publish_fence_required"],
    ["vercel_project", "pass", "project_identity_bound"], ["vercel_alias", "pass", "alias_project_bound"],
    ["vercel_deployment", "pass", "deployment_identity_bound"], ["vercel_build", "pass", "build_identity_bound"]
  ]);
  assert.deepEqual(result.body.checks[2].staticPaths, ["deploy/ar/app.js", "deploy/ar/index.html", "deploy/fr/app.js", "deploy/fr/index.html", "deploy/shared/app.css"]);
  assert.equal(result.body.checks[2].publicFileCount, 6);
  assert.equal(f.requests.length, 4); assert.deepEqual(f.queries.map(q => q.name), ["ownerTrial:completionPolicy", "ownerTrialCompletion:getJob", "ownerTrial:completionPolicy"]);
  const output = JSON.stringify(result.body);
  for (const secret of [...Object.values(environment).filter(v => /offline-(?:worker|invoke|vercel)/u.test(v)),
    "DO_NOT_DISCLOSE_CUSTOMER_CONTENT", "private-storage", "intake.json", f.policy.recipient, f.policy.origin]) assert.ok(!output.includes(secret));
  assert.equal(f.job.state, "reconciliation_required");
  assert.equal(f.job.stageAttempts[0].failure.reasonCode, "publication_scope_invalid");
});

test("diagnostics rejects methods, missing/wrong/legacy authorization, and query target overrides before any read", async () => {
  const f = fixture(); const h = await handler({ environment, client: f.client, fetch: f.fetch });
  for (const [request, status] of [
    [{ method: "POST" }, 405], [{ method: "HEAD" }, 405], [{ method: "OPTIONS" }, 405],
    [{ headers: {} }, 401], [{ headers: { authorization: "Bearer legacy-cron" } }, 401],
    [{ headers: { authorization: `Bearer ${environment.VERCEL_TOKEN}` } }, 401],
    [{ headers: { authorization: [`Bearer ${environment.OWNER_TRIAL_INVOKE_SECRET}`] } }, 401],
    [{ url: "/api/operations/owner-trial-publication-diagnostics?jobId=other" }, 400],
    [{ url: "/api/operations/owner-trial-publication-diagnostics?target=https://evil.invalid" }, 400],
    [{ query: { jobId: "other" } }, 400],
  ]) {
    const result = await invoke(h, request);
    assert.equal(result.statusCode, status); assert.equal(result.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(result.headers["Cache-Control"], "private, no-store");
    if (status === 405) assert.equal(result.headers.Allow, "GET");
  }
  assert.equal(f.queries.length, 0); assert.equal(f.requests.length, 0);
});

test("diagnostics requires a dedicated 32-byte secret and exact immutable trial job with no cron fallback", async () => {
  const { createOwnerTrialPublicationDiagnosticsHttpHandler: create } = await import("../../owner-trial-completion-worker/api/publication-diagnostics.mjs");
  for (const secret of [undefined, "s".repeat(31)]) assert.throws(() => create({ environment: { ...environment, OWNER_TRIAL_INVOKE_SECRET: secret, CRON_SECRET: "c".repeat(32) } }), /secret/u);
  for (const binding of [undefined, "job_customer_other", jobId + "x"]) assert.throws(() => create({ environment: { ...environment, OWNER_TRIAL_JOB_ID: binding } }), /job binding/u);
});

test("diagnostics captures configured job and provider target instead of accepting later environment retargeting", async () => {
  const f = fixture(), env = { ...environment }; const h = await handler({ environment: env, client: f.client, fetch: f.fetch });
  env.OWNER_TRIAL_JOB_ID = "job_owner_trial_" + "b".repeat(32);
  env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID = "evil-project"; env.CONVEX_URL = "https://evil.invalid";
  const result = await invoke(h); assert.equal(result.statusCode, 200);
  assert.ok(result.body.checks.every(c => c.status !== "fail"));
});

test("invalid configuration never performs backend or provider reads and does not disclose inputs", async () => {
  for (const change of [ { CONVEX_URL: "https://evil.invalid" }, { VERCEL_TOKEN: "" },
    { OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID: "evil-team" }, { OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID: "evil-project" },
    { OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME: "evil-project" }, { OWNER_TRIAL_VERCEL_BUILD_INSPECTION_B64: "not base64 private" },
    { BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: environment.OWNER_TRIAL_INVOKE_SECRET } ]) {
    const f = fixture(); const result = await invoke(await handler({ environment: { ...environment, ...change }, client: f.client, fetch: f.fetch }));
    assert.deepEqual(result.body, { checks: [{ name: "configuration", status: "fail", reason: "configuration_rejected" }] });
    assert.equal(f.queries.length, 0); assert.equal(f.requests.length, 0);
  }
});

test("policy mismatch or drift blocks provider access without emitting persisted content", async () => {
  for (const key of ["jobId", "revisionId", "recipient", "ownerSourceReference", "workerId", "manifestDigest", "intakeDigest", "origin", "drift"]) {
    const f = fixture(); const baseQuery = f.client.query; let count = 0;
    f.client.query = async (name, args) => { const value = await baseQuery(name, args); if (name === "ownerTrial:completionPolicy") {
      count++; if (key !== "drift" || count === 2) value[key === "drift" ? "ticketId" : key] = "DO_NOT_DISCLOSE_POLICY";
    } return value; };
    const result = await invoke(await handler({ environment, client: f.client, fetch: f.fetch }));
    assert.equal(result.body.checks.at(-1).reason, "persisted_policy_rejected"); assert.equal(f.requests.length, 0);
    assert.ok(!JSON.stringify(result.body).includes("DO_NOT_DISCLOSE_POLICY"));
  }
});

test("manifest digest, job identity and unique release are verified without resolving any storage", async () => {
  for (const corrupt of [f => { f.job.jobId = "other"; }, f => { f.job.intakeDigest = "other"; },
    f => { f.job.artifactSets.push(structuredClone(f.job.artifactSets[0])); },
    f => { f.job.artifactSets[0].files[0].sha256 = sha("changed"); }, f => { f.job.artifactSets[0].files[0].path = "private"; }]) {
    const f = fixture(); corrupt(f); const before = JSON.stringify(f.job);
    const result = await invoke(await handler({ environment, client: f.client, fetch: f.fetch }));
    assert.equal(result.body.checks.find(c => c.name === "artifact_manifest").reason, "persisted_manifest_rejected");
    assert.equal(f.requests.length, 0); assert.equal(JSON.stringify(f.job), before);
    assert.deepEqual(result.body.checks.at(-1), { name: "artifact_resolution", status: "blocked", reason: "active_publish_fence_required" });
  }
});

test("each mismatched Vercel identity fails its fixed check without echoing provider data", async () => {
  for (const name of ["vercel_project", "vercel_alias", "vercel_deployment", "vercel_build"]) {
    const f = fixture(); const baseFetch = f.fetch; let count = 0;
    const result = await invoke(await handler({ environment, client: f.client, fetch: async (url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${environment.VERCEL_TOKEN}`);
      const result = await baseFetch(url, init); const data = await result.json();
      if (["vercel_project", "vercel_alias", "vercel_deployment", "vercel_build"][count++] === name) {
        if (name === "vercel_build") data.builds[0].id = "DO_NOT_DISCLOSE_PROVIDER";
        else if (name === "vercel_alias") data.projectId = "DO_NOT_DISCLOSE_PROVIDER";
        else if (name === "vercel_project") data.accountId = "DO_NOT_DISCLOSE_PROVIDER";
        else data.team.id = "DO_NOT_DISCLOSE_PROVIDER";
      } return new Response(JSON.stringify(data));
    } }));
    assert.equal(result.body.checks.find(c => c.name === name).reason, "provider_identity_rejected");
    assert.ok(!JSON.stringify(result.body).includes("DO_NOT_DISCLOSE_PROVIDER"));
  }
});

test("provider errors, redirects and malformed bodies become fixed safe failures", async () => {
  for (const fetch of [async () => { throw new Error("PRIVATE_URL_TOKEN_BODY"); },
    async () => new Response("PRIVATE_URL_TOKEN_BODY", { status: 403 }),
    async () => new Response("PRIVATE_URL_TOKEN_BODY", { status: 302, headers: { location: "https://evil.invalid/private" } }),
    async () => new Response("PRIVATE_URL_TOKEN_BODY")]) {
    const f = fixture(); const result = await invoke(await handler({ environment, client: f.client, fetch }));
    assert.ok(result.body.checks.slice(-4).every(c => c.status === "fail" && c.reason === "provider_read_rejected"));
    assert.ok(!JSON.stringify(result.body).includes("PRIVATE"));
  }
});

test("diagnostics finitely bounds a hanging provider read", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); let started; const ready = new Promise(resolve => { started = resolve; });
  const h = await handler({ environment, client: f.client, fetch: async (url, init) => {
    if (new URL(url).pathname.startsWith("/v9/")) { started(); return new Promise(() => {}); } return f.fetch(url, init);
  } });
  const pending = invoke(h); await ready; t.mock.timers.tick(5000); const result = await pending;
  assert.equal(result.body.checks.find(c => c.name === "vercel_project").reason, "provider_read_rejected");
});

test("provider JSON reads are bounded rather than accepting arbitrarily large bodies", async () => {
  const f = fixture(); const result = await invoke(await handler({ environment, client: f.client,
    fetch: async () => new Response(JSON.stringify({ id: inspection.projectId, name: inspection.projectName, accountId: inspection.teamId, privateContent: "x".repeat(70000) })) }));
  assert.equal(result.body.checks.find(c => c.name === "vercel_project").reason, "provider_read_rejected");
});

test("duplicate build identities are rejected even if one duplicate is READY", async () => {
  const f = fixture(); const baseFetch = f.fetch; const result = await invoke(await handler({ environment, client: f.client, fetch: async (url, init) => {
    const result = await baseFetch(url, init); const data = await result.json();
    if (data.builds) data.builds.push({ id: inspection.buildId, readyState: "ERROR" });
    return new Response(JSON.stringify(data));
  } }));
  assert.equal(result.body.checks.find(c => c.name === "vercel_build").reason, "provider_identity_rejected");
});

test("diagnostic runtime allows all seven individually bounded reads to finish safely", async () => {
  const { config } = await import("../../owner-trial-completion-worker/api/publication-diagnostics.mjs");
  assert.ok(config.maxDuration > 35);
});

test("diagnostics is wired into the existing Vercel deployment and owner-trial syntax build without a cron", async () => {
  const { readFile } = await import("node:fs/promises");
  const configuration = JSON.parse(await readFile(new URL("../../vercel.owner-trial-completion-worker.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const path = "owner-trial-completion-worker/api/publication-diagnostics.mjs";
  assert.ok(configuration.builds.some(build => build.src === path && build.use === "@vercel/node"));
  assert.ok(configuration.routes.some(route => route.src === "/api/operations/owner-trial-publication-diagnostics" && route.dest === path));
  assert.equal(Object.hasOwn(configuration, "crons"), false);
  assert.ok(pkg.scripts["build:owner-trial"].includes(`node --check ./${path}`));
});
