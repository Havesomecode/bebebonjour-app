import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOwnerTrialCompletionHttpHandler } from "../../owner-trial-completion-worker/api/worker.mjs";

const environment = { OWNER_TRIAL_INVOKE_SECRET: "trial-invoke-" + "s".repeat(32), OWNER_TRIAL_JOB_ID: "job_owner_trial_" + "a".repeat(32), CRON_SECRET: "legacy-" + "l".repeat(32) };
function response() { return { headers: {}, body: null, statusCode: null,
  setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = JSON.parse(value); } }; }

test("trial completion HTTP is manual-only, distinct-secret protected, and binds one configured job", async () => {
  let calls = 0;
  const handler = createOwnerTrialCompletionHttpHandler({ environment, runWorker: async () => { calls += 1; return { claimed: 0, completed: 0, failed: 0 }; } });
  for (const [method, authorization, status] of [["GET", null, 401], ["GET", `Bearer ${environment.CRON_SECRET}`, 401], ["POST", `Bearer ${environment.OWNER_TRIAL_INVOKE_SECRET}`, 405]]) {
    const result = response(); await handler({ method, headers: { authorization } }, result);
    assert.equal(result.statusCode, status); assert.equal(result.headers["Cache-Control"], "private, no-store");
  }
  assert.equal(calls, 0);
  const result = response(); await handler({ method: "GET", headers: { authorization: `Bearer ${environment.OWNER_TRIAL_INVOKE_SECRET}` } }, result);
  assert.equal(result.statusCode, 200); assert.equal(calls, 1); assert.deepEqual(result.body, { claimed: 0, completed: 0, failed: 0 });
});

test("trial completion HTTP never falls back to legacy cron authority or a non-trial job", () => {
  assert.throws(() => createOwnerTrialCompletionHttpHandler({ environment: { CRON_SECRET: environment.CRON_SECRET, OWNER_TRIAL_JOB_ID: environment.OWNER_TRIAL_JOB_ID } }), /manual invocation secret/u);
  assert.throws(() => createOwnerTrialCompletionHttpHandler({ environment: { ...environment, OWNER_TRIAL_JOB_ID: "job_customer_other" } }), /job binding/u);
});

test("trial completion deployment preserves legacy owner endpoint and has no schedule", async () => {
  const configuration = JSON.parse(await readFile(new URL("../../vercel.owner-trial-completion-worker.json", import.meta.url), "utf8"));
  assert.equal(Object.hasOwn(configuration, "crons"), false);
  assert.deepEqual(configuration.routes, [
    { src: "/api/operations/owner-completion-worker", dest: "owner-completion-worker/api/worker.mjs" },
    { src: "/api/operations/owner-trial-completion-worker", dest: "owner-trial-completion-worker/api/worker.mjs" },
    { src: "/api/operations/owner-trial-publication-diagnostics", dest: "owner-trial-completion-worker/api/publication-diagnostics.mjs" }
  ]);
});
