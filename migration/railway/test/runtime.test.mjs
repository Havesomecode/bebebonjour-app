import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Stripe from "stripe";
import { createCandidateRuntime, loadConfig } from "../runtime.mjs";
import { openTestDatabase } from "./database.mjs";

const access = "synthetic-candidate-access-token-32-chars";
const key = Buffer.alloc(32, 7).toString("base64");
const env = {
  BB_CANDIDATE_MODE: "synthetic",
  DATABASE_URL: "postgresql://unused@127.0.0.1/bb_candidate",
  CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: key,
  CUSTOMER_FLOW_TEST_ACCESS_TOKEN: access,
  CUSTOMER_FLOW_ALLOWED_ORIGINS: '["http://localhost:3000","https://bonjour.example.test"]',
  STRIPE_SECRET_KEY: "sk_test_synthetic_no_network",
  STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET: "whsec_synthetic",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://bonjour.example.test/suivi?checkout=success",
  STRIPE_CHECKOUT_CANCEL_URL: "https://bonjour.example.test/suivi?checkout=cancel",
};
const intake = {
  schemaVersion: "1.0",
  customer: { email: "railway@example.test", consent: true },
  baby: { firstName: "Test", gender: "neutral" },
  languages: ["fr"],
  voicePreference: { enabled: false, gender: "neutral" },
};
const headers = { "content-type": "application/json", "x-test-a-access-token": access };
const prefix = "/api/customer-flow";

test("candidate startup refuses real mode, live Stripe, invalid crypto and permissive origins", () => {
  for (const overrides of [
    { BB_CANDIDATE_MODE: "production" }, { BB_CANDIDATE_MODE: undefined },
    { STRIPE_SECRET_KEY: "sk_live_forbidden" }, { CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: "bad" },
    { CUSTOMER_FLOW_ALLOWED_ORIGINS: '["*"]' }, { CUSTOMER_FLOW_TEST_ACCESS_TOKEN: "short" },
    { PORT: "70000" }, { DATABASE_URL: "https://invalid.test" },
  ]) assert.throws(() => loadConfig({ ...env, ...overrides }));
});

test("PostgreSQL HTTP intake, private auth, raw signed Stripe and restart are durable", async (t) => {
  const db = await openTestDatabase(t);
  const id = randomUUID().replaceAll("-", "");
  const signingStripe = new Stripe(env.STRIPE_SECRET_KEY);
  const calls = [];
  const stripe = {
    webhooks: signingStripe.webhooks,
    checkout: { sessions: { async create(payload, options) {
      calls.push({ payload, options });
      return { id: `cs_test_${id}`, url: "https://checkout.stripe.com/c/pay/test", livemode: false };
    } } },
  };
  let runtime = createCandidateRuntime({ config: loadConfig(env), pool: db.pool, stripe });
  const submit = (body, keyId = `candidate:${id}`) => runtime.api.request(`${prefix}/v1/intakes`, {
    method: "POST", headers: { ...headers, "idempotency-key": keyId }, body: JSON.stringify(body),
  });
  assert.equal((await runtime.api.request(`${prefix}/v1/intakes`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intake),
  })).status, 401);
  assert.equal((await submit({ ...intake, customer: { ...intake.customer, email: "real@example.com" } })).status, 400);
  const submissions = await Promise.all(Array.from({ length: 8 }, () => submit(intake)));
  assert.deepEqual(submissions.map((r) => r.status), Array(8).fill(201));
  const bodies = await Promise.all(submissions.map((r) => r.json()));
  const submission = bodies[0];
  assert.ok(bodies.every((body) => JSON.stringify(body) === JSON.stringify(submission)));
  assert.equal((await submit({ ...intake, request: "different" })).status, 409);
  const other = await (await submit(intake, `candidate:other:${id}`)).json();
  const jobUrl = `${prefix}/v1/jobs/${submission.jobId}`;
  const privateHeaders = { ...headers, authorization: `Bearer ${submission.intakeToken}` };
  assert.equal((await runtime.api.request(`${jobUrl}/status`, { headers })).status, 404);
  assert.equal((await runtime.api.request(`${jobUrl}/status`, { headers: { ...headers, authorization: `Bearer ${other.intakeToken}` } })).status, 404);
  assert.equal((await runtime.api.request(`${jobUrl}/status`, { headers: { ...privateHeaders, origin: "https://evil.test" } })).status, 403);
  assert.equal((await runtime.api.request("/operator/jobs", { headers: privateHeaders })).status, 404);
  const checkout = await runtime.api.request(`${jobUrl}/checkout`, { method: "POST", headers: privateHeaders });
  assert.equal(checkout.status, 200);
  assert.equal(calls.length, 1);
  const event = {
    id: `evt_test_${id}`, object: "event", type: "checkout.session.completed", livemode: false,
    data: { object: { id: `cs_test_${id}`, object: "checkout.session", payment_status: "paid", livemode: false,
      amount_total: 3900, currency: "eur", payment_intent: `pi_test_${id}`, metadata: calls[0].payload.metadata } },
  };
  const webhook = (candidate, valid = true) => {
    const payload = JSON.stringify(candidate);
    const signature = signingStripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET });
    return runtime.api.request(`${prefix}/webhooks/stripe`, {
      method: "POST", headers: { "stripe-signature": signature }, body: valid ? payload : `${payload} `,
    });
  };
  assert.equal((await webhook(event, false)).status, 400);
  assert.equal((await webhook({ ...event, data: { object: { ...event.data.object, amount_total: 1 } } })).status, 400);
  const paid = await Promise.all([webhook(event), webhook(event), webhook({ ...event, id: `evt_other_${id}` })]);
  assert.deepEqual(paid.map((r) => r.status), [200, 200, 200]);
  assert.equal((await webhook({ ...event, created: 1 })).status, 500);
  const job = await runtime.fulfillmentStore.getJob(submission.jobId);
  assert.equal(job.events.filter((e) => e.type === "payment_recorded").length, 1);
  const stored = await db.pool.query("SELECT response FROM bb_candidate.submissions WHERE idempotency_key=$1", [`candidate:${id}`]);
  assert.ok(!JSON.stringify(stored.rows).includes(submission.intakeToken));
  assert.match(stored.rows[0].response.intakeTokenCiphertext, /^v1\./);
  await runtime.close();
  runtime = createCandidateRuntime({ config: loadConfig(env), pool: db.newPool(), stripe });
  t.after(() => runtime.close());
  const status = await runtime.api.request(`${jobUrl}/status`, { headers: privateHeaders });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal((await status.json()).status, "generation_pending");
  assert.equal((await submit(intake)).status, 201);
  const ready = await runtime.api.request("/healthz");
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, persistence: "postgresql", mode: "synthetic" });
});

test("intake transaction rolls back both jobs when the final SQL constraint fails", async (t) => {
  const db = await openTestDatabase(t);
  const runtime = createCandidateRuntime({ config: loadConfig(env), pool: db.pool, stripe: new Stripe(env.STRIPE_SECRET_KEY) });
  const persist = runtime.customerStore.createJob;
  let attemptedId;
  runtime.customerStore.createJob = (job, keyId, response, _digest, options) => {
    attemptedId = job.jobId;
    // Force a real PostgreSQL CHECK violation at the final INSERT, after both jobs.
    return persist(job, keyId, response, "invalid-digest", options);
  };
  await assert.rejects(() => runtime.service.submitIntake(intake, { idempotencyKey: `rollback:${randomUUID()}` }), /check constraint/);
  assert.ok(attemptedId);
  assert.equal(await runtime.customerStore.readJob(attemptedId), null);
  assert.equal(await runtime.fulfillmentStore.getJob(attemptedId), null);
  const submissions = await db.pool.query("SELECT 1 FROM bb_candidate.submissions WHERE job_id=$1", [attemptedId]);
  assert.equal(submissions.rowCount, 0);
});
