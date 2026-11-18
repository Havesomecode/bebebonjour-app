import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { convexTest } from "convex-test";
import schema from "../../convex/schema.js";
import { ABUSE_POLICY, advanceBudget } from "../../convex/abusePolicy.js";
import { createHostedAbuseBudget } from "../../src/http/abuse-budget.mjs";
import { createHostedCustomerFlowHttpApi } from "../../src/customer-flow/hosted-http-api.mjs";
import { createHostedTallyIntakeProcessor } from "../../src/customer-flow/hosted-tally-intake.mjs";
import { createLazyTallyIntakeHandler } from "../../src/http/tally-intake-handler.mjs";
import { createCustomerFlowId, createCustomerFlowService } from "../../src/customer-flow/service.mjs";
import { createInMemoryCustomerFlowStore } from "../../src/customer-flow/memory-store.mjs";

const backendToken = "synthetic-backend-token-at-least-32-characters";
const accessToken = "synthetic-test-access-token-at-least-32-characters";
const intake = { schemaVersion: "1.0", customer: { email: "security@example.test", consent: true },
  baby: { firstName: "أمل", gender: "girl" }, languages: ["fr", "ar"],
  voicePreference: { enabled: false, gender: "neutral" } };

function fixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./abuse.js": () => import("../../convex/abuse.js"),
    "./customerFlow.js": () => import("../../convex/customerFlow.js"),
    "./fulfillment.js": () => import("../../convex/fulfillment.js"),
  });
}
function budget(client) { return createHostedAbuseBudget({ client, backendToken }); }
function api(client, service = {}) {
  return createHostedCustomerFlowHttpApi({ service, testAccessToken: accessToken,
    stripeProcessor: async () => { throw new Error("Unexpected provider effect"); },
    consumeBudget: budget(client) });
}

test("all attempt budgets expire independently; daily limits survive minute rollover", () => {
  for (const [scope, policy] of Object.entries(ABUSE_POLICY)) {
    let row = null;
    const now = 86_400_000 + 1234;
    for (let count = 0; count < policy.minute; count++) {
      const result = advanceBudget(row, scope, now);
      assert.equal(result.allowed, true);
      row = result.next;
    }
    assert.equal(advanceBudget(row, scope, now).allowed, false);
    assert.equal(advanceBudget(row, scope, now + 60_000).allowed, true);
    row.dayAttempts = policy.day;
    assert.equal(advanceBudget(row, scope, now + 60_000).allowed, false);
    assert.equal(advanceBudget(row, scope, now + 86_400_000).allowed, true);
  }
  assert.throws(() => advanceBudget(null, "__proto__", 0));
});

test("concurrent replicas share an authenticated constant-cardinality Convex budget", async (t) => {
  t.mock.method(Date, "now", () => 86_401_234);
  const client = fixture();
  const results = await Promise.all(Array.from({ length: 60 }, () =>
    client.mutation("abuse:consume", { backendToken, scope: "intake" })));
  assert.equal(results.filter((result) => result.allowed).length, ABUSE_POLICY.intake.minute);
  assert.ok(results.filter((result) => !result.allowed).every((result) => result.retryAfterSeconds > 0));
  await assert.rejects(client.mutation("abuse:consume", { backendToken: "wrong", scope: "status" }));
  await assert.rejects(client.mutation("abuse:consume", { backendToken, scope: "arbitrary-id" }));
  await assert.rejects(client.mutation("abuse:consume", { backendToken, scope: "status", nowMs: 0 }));
  const rows = await client.run((ctx) => ctx.db.query("customerFlowAbuseBudgets").collect());
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["_creationTime", "_id", "dayAttempts", "dayStartedAtMs",
    "minuteAttempts", "minuteStartedAtMs", "scope"].sort());
  assert.equal(rows[0].minuteAttempts, 30);
  assert.equal(JSON.stringify(rows).includes(backendToken), false);
  // New server instance does not reset budgets. New backend time does.
  await assert.rejects(budget(client)("intake"), (e) => e.statusCode === 429);
  t.mock.method(Date, "now", () => 86_461_234);
  await budget(client)("intake");
});

test("daily admission denies before intake state or provider work; outages fail closed", async () => {
  const client = fixture();
  const nowMs = Date.now();
  await client.run((ctx) => ctx.db.insert("customerFlowAbuseBudgets", {
    scope: "intake", minuteStartedAtMs: Math.floor(nowMs / 60_000) * 60_000,
    dayStartedAtMs: Math.floor(nowMs / 86_400_000) * 86_400_000,
    minuteAttempts: 0, dayAttempts: ABUSE_POLICY.intake.day,
  }));
  let calls = 0;
  const first = api(client, { async submitIntake() { calls++; } });
  const response = await first.request("/api/customer-flow/v1/intakes", { method: "POST",
    headers: { "content-type": "application/json", "x-test-a-access-token": accessToken },
    body: JSON.stringify(intake) });
  assert.equal(response.status, 429);
  assert.match(response.headers.get("retry-after"), /^\d+$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls, 0);
  const broken = api({ async mutation() { throw new Error("private token, IP and content"); } });
  const unavailable = await broken.request("/api/customer-flow/webhooks/stripe", { method: "POST" });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes("private token"), false);
});

test("capability guessing shares status admission and wrong versus absent jobs remain indistinguishable", async () => {
  const store = createInMemoryCustomerFlowStore();
  const service = createCustomerFlowService({ store,
    paymentGateway: { async createCheckoutSession() { throw new Error("Unexpected provider effect"); } } });
  const submission = await service.submitIntake(intake);
  assert.match(submission.intakeToken, /^tok_[A-Za-z0-9_-]{43}$/);
  const client = fixture();
  const app = api(client, service);
  const request = (jobId, token) => app.request(`/api/customer-flow/v1/jobs/${jobId}/status`, {
    headers: { "x-test-a-access-token": accessToken, authorization: `Bearer ${token}` } });
  const wrong = await request(submission.jobId, "wrong-capability");
  const missing = await request("job_missing", "wrong-capability");
  assert.equal(wrong.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await wrong.json(), await missing.json());
  const good = await request(submission.jobId, submission.intakeToken);
  assert.equal(good.status, 200);
  const status = await good.json();
  assert.equal(JSON.stringify(status).includes("security@example.test"), false);
  await client.run(async (ctx) => {
    const row = await ctx.db.query("customerFlowAbuseBudgets").first();
    await ctx.db.patch(row._id, { minuteAttempts: ABUSE_POLICY.status.minute });
  });
  assert.equal((await request("job_another", createCustomerFlowId("token"))).status, 429);
  assert.equal((await request(submission.jobId, submission.intakeToken)).status, 429);
});

test("HEAD cannot bypass exhausted or unavailable status admission", async () => {
  for (const statusCode of [429, 503]) {
    const { CustomerFlowError } = await import("../../src/customer-flow/service.mjs");
    let reads = 0;
    const scopes = [];
    const app = createHostedCustomerFlowHttpApi({
      service: { async getStatus() { reads++; return {}; } },
      testAccessToken: accessToken, stripeProcessor: async () => ({}),
      consumeBudget: async (scope) => {
        scopes.push(scope);
        throw Object.assign(new CustomerFlowError(statusCode,
          statusCode === 429 ? "rate_limited" : "abuse_control_unavailable", "denied"),
        { retryAfterSeconds: 30 });
      },
    });
    for (const method of ["GET", "HEAD"]) {
      const response = await app.request("/api/customer-flow/v1/jobs/job_guess/status", {
        method, headers: { "x-test-a-access-token": accessToken, authorization: "Bearer wrong-capability" },
      });
      assert.equal(response.status, statusCode);
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (statusCode === 429) assert.equal(response.headers.get("retry-after"), "30");
    }
    assert.deepEqual(scopes, ["status", "status"]);
    assert.equal(reads, 0);
  }
});

test("intake rejects unvalidated fields, file smuggling, controls and malformed nesting before persistence", async () => {
  let writes = 0;
  const service = createCustomerFlowService({ store: { async createJob() { writes++; } },
    paymentGateway: { async createCheckoutSession() {} } });
  for (const bad of [
    { ...intake, file: { url: "http://169.254.169.254/" } },
    { ...intake, __proto__: null, payment: { status: "paid" } },
    { ...intake, baby: { ...intake.baby, firstName: "name\u0000secret" } },
    { ...intake, customer: { ...intake.customer, hiddenContent: "sensitive" } },
    { ...intake, context: { religion: "x".repeat(101) } },
    { ...intake, voicePreference: [] },
  ]) {
    await assert.rejects(service.submitIntake(bad), (e) => e.code === "invalid_intake");
  }
  assert.equal(writes, 0);
});

async function tallyFixture(client) {
  const signingSecret = "synthetic-tally-signing-secret-32-characters";
  const event = JSON.parse(await readFile(new URL("../fixtures/tally-intake-submission.json", import.meta.url)));
  const fieldMap = JSON.parse(await readFile(new URL("../fixtures/tally-intake-field-map.json", import.meta.url)));
  const process = createHostedTallyIntakeProcessor({ convexClient: client, environment: {
    CONVEX_URL: "https://synthetic.convex.cloud", CUSTOMER_FLOW_BACKEND_TOKEN: backendToken,
    CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    TALLY_INTAKE_SIGNING_SECRET: signingSecret, TALLY_INTAKE_FORM_ID: event.data.formId,
    TALLY_INTAKE_FIELD_MAP: JSON.stringify(fieldMap),
  } });
  const rawBody = Buffer.from(JSON.stringify(event));
  return { process, rawBody, signature: createHmac("sha256", signingSecret).update(rawBody).digest("base64") };
}

test("signed Tally retries converge across replicas; invalid signatures produce no jobs or event records", async () => {
  const client = fixture();
  const input = await tallyFixture(client);
  await assert.rejects(input.process({ ...input, signature: "invalid" }), (e) => e.statusCode === 401);
  const before = await client.run(async (ctx) => ({ jobs: await ctx.db.query("customerFlowJobs").collect(),
    events: await ctx.db.query("customerFlowProviderEvents").collect() }));
  assert.deepEqual(before, { jobs: [], events: [] });
  const second = await tallyFixture(client);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? input : second).process(input)));
  assert.equal(new Set(results.map((r) => r.jobId)).size, 1);
  const rows = await client.run(async (ctx) => ({ jobs: await ctx.db.query("customerFlowJobs").collect(),
    work: await ctx.db.query("customerFlowWorkItems").collect(),
    responses: await ctx.db.query("customerFlowSubmissions").collect() }));
  assert.equal(rows.jobs.length, 1);
  assert.equal(rows.work.length, 1);
  assert.equal(rows.jobs[0].job.intakeTokenDigest.length, 64);
  assert.match(rows.responses[0].response.intakeTokenCiphertext, /^v1\./);
  assert.equal(JSON.stringify(rows).includes('"intakeToken":'), false);
});

test("Tally HTTP responses never reflect untrusted exception codes; limit has retry and no-store headers", async () => {
  const unavailable = createLazyTallyIntakeHandler({ processor: async () => {
    throw Object.assign(new Error("private content"), { code: "private-email@example.test", statusCode: 418 });
  } });
  const limited = createLazyTallyIntakeHandler({ processor: async () => {
    const { CustomerFlowError } = await import("../../src/customer-flow/service.mjs");
    throw Object.assign(new CustomerFlowError(429, "rate_limited", "Request limit reached."), { retryAfterSeconds: 30 });
  } });
  for (const [handler, status] of [[unavailable, 500], [limited, 429]]) {
    const request = Readable.from([Buffer.from("{}")]);
    request.method = "POST"; request.headers = { "content-type": "application/json" };
    const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await handler(request, response);
    assert.equal(response.statusCode, status);
    assert.equal(response.body.includes("private"), false);
    assert.equal(response.headers["cache-control"], "no-store");
    if (status === 429) assert.equal(response.headers["retry-after"], "30");
  }
});
