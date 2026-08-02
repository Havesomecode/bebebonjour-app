import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import Stripe from "stripe";

import {
  createStripeWebhookHandler,
  createTallyWebhookHandler,
} from "../../src/http/webhook-handlers.mjs";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";
const postgresTestImage = process.env.POSTGRES_TEST_IMAGE || "quay.io/debezium/postgres:16";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout || ""}${result.stderr || ""}`);
  }
  return result.stdout.trim();
}

async function waitForPostgres(containerName) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "bebebonjour"],
      { encoding: "utf8" },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("PostgreSQL test container did not become ready.");
}

function createPsql(containerName) {
  return (sql) => run(
    "docker",
    ["exec", "-i", containerName, "psql", "-h", "127.0.0.1", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "bebebonjour", "-At"],
    { input: sql },
  );
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  const json = JSON.stringify(value);
  if (json.includes("$payload$")) throw new Error("Synthetic payload contains the SQL delimiter.");
  return `$payload$${json}$payload$::jsonb`;
}

async function readMigrations() {
  const migrationsDirectory = new URL("../../supabase/migrations/", import.meta.url);
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return (await Promise.all(
    files.map((file) => readFile(new URL(file, migrationsDirectory), "utf8")),
  )).join("\n");
}

function createDatabaseStore(psql) {
  return {
    async ingestTallySubmission(normalized, evidence) {
      return JSON.parse(psql(`select public.ingest_tally_submission_v2(
        ${sqlText(normalized.source.eventId)},
        ${sqlText(normalized.source.submissionId)},
        ${sqlText(normalized.payment.paymentId)},
        ${sqlJson(normalized.intake)},
        ${sqlText(evidence.payloadSha256)}
      );`));
    },
    async ingestStripePayment(normalized, evidence) {
      return JSON.parse(psql(`select public.ingest_stripe_payment_v2(
        ${sqlText(normalized.source.eventId)},
        ${sqlText(normalized.payment.paymentId)},
        ${sqlText(normalized.payment.status)},
        ${normalized.payment.amountMinor},
        ${sqlText(normalized.payment.currency)},
        ${sqlText(normalized.payment.email)},
        ${sqlText(evidence.payloadSha256)}
      );`));
    },
    async recordRejectedProviderEvent(rejection) {
      return JSON.parse(psql(`select public.record_rejected_webhook_event(
        ${sqlText(rejection.provider)},
        ${sqlText(rejection.eventId)},
        ${sqlText(rejection.reasonCode)},
        ${sqlText(rejection.payloadSha256)}
      );`));
    },
  };
}

function request(rawBody, headers) {
  const stream = Readable.from([rawBody]);
  stream.method = "POST";
  stream.headers = headers;
  return stream;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value = "") {
      this.body = value;
    },
  };
}

async function invoke(handler, rawBody, headers) {
  const res = response();
  await handler(request(rawBody, headers), res);
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body);
}

test(
  "a synthetic paid order reaches review_required through both webhook handlers",
  { skip: !runDatabaseTests, timeout: 120_000 },
  async (t) => {
    const migrations = await readMigrations();
    const tallyRawBody = await readFile(
      new URL("../fixtures/tally-paid-submission.json", import.meta.url),
    );
    const stripeRawBody = await readFile(
      new URL("../fixtures/stripe-payment-succeeded.json", import.meta.url),
    );
    const tallyFieldMap = JSON.parse(
      await readFile(new URL("../fixtures/tally-field-map.json", import.meta.url), "utf8"),
    );
    const containerName = `bebebonjour-e2e-${process.pid}-${randomUUID().slice(0, 8)}`;

    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--detach",
        "--name",
        containerName,
        "--env",
        "POSTGRES_PASSWORD=test",
        "--env",
        "POSTGRES_DB=bebebonjour",
        postgresTestImage,
      ],
      { stdio: "ignore" },
    );
    t.after(() => spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore" }));
    await waitForPostgres(containerName);

    const psql = createPsql(containerName);
    psql(`create schema extensions;
      create extension pgcrypto with schema extensions;
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      alter default privileges in schema public
        grant all on functions to anon, authenticated, service_role;`);
    psql(migrations);
    const store = createDatabaseStore(psql);

    const tallySecret = "test-tally-secret";
    const tallySignature = createHmac("sha256", tallySecret)
      .update(tallyRawBody)
      .digest("base64");
    const tallyHandler = createTallyWebhookHandler({
      store,
      config: {
        signingSecret: tallySecret,
        normalization: {
          expectedFormId: "form_test_001",
          expectedAmount: 39,
          expectedCurrency: "EUR",
          fieldMap: tallyFieldMap,
        },
      },
    });

    const stripeSecret = "whsec_test_secret";
    const stripe = new Stripe("webhook-signature-test-only");
    const stripeSignature = stripe.webhooks.generateTestHeaderString({
      payload: stripeRawBody.toString("utf8"),
      secret: stripeSecret,
    });
    const stripeHandler = createStripeWebhookHandler({
      store,
      config: {
        signingSecret: stripeSecret,
        normalization: {
          expectedAmountMinor: 3900,
          expectedCurrency: "EUR",
        },
      },
    });

    const tallyResult = await invoke(
      tallyHandler,
      tallyRawBody,
      { "tally-signature": tallySignature },
    );
    assert.deepEqual(tallyResult, { received: true });

    const stripeResult = await invoke(
      stripeHandler,
      stripeRawBody,
      { "stripe-signature": stripeSignature },
    );
    assert.deepEqual(stripeResult, { received: true });

    const replayTally = await invoke(
      tallyHandler,
      tallyRawBody,
      { "tally-signature": tallySignature },
    );
    const replayStripe = await invoke(
      stripeHandler,
      stripeRawBody,
      { "stripe-signature": stripeSignature },
    );
    assert.deepEqual(replayTally, { received: true });
    assert.deepEqual(replayStripe, { received: true });

    const summary = JSON.parse(psql(`select json_build_object(
      'events', (select count(*) from public.webhook_events),
      'payments', (select count(*) from public.stripe_payments),
      'orders', (select count(*) from public.fulfillment_orders),
      'reviewJobs', (select count(*) from public.fulfillment_review_jobs),
      'auditPayloadContainsPii', (
        exists (
          select 1 from public.webhook_events
          where payload::text ilike '%parent@example.com%'
             or payload::text ilike '%Noor%'
        ) or exists (
          select 1 from public.stripe_payments
          where payload::text ilike '%parent@example.com%'
             or payload::text ilike '%Noor%'
        )
      ),
      'stripeHasPlaintextEmailColumn', exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'stripe_payments'
          and column_name = 'customer_email'
      ),
      'stripeEmailDigestValid', (
        select (to_jsonb(payments)->>'customer_email_digest') ~ '^[0-9a-f]{64}$'
        from public.stripe_payments as payments
        limit 1
      ),
      'status', (select status from public.fulfillment_orders limit 1)
    );`));
    assert.deepEqual(summary, {
      events: 2,
      payments: 1,
      orders: 1,
      reviewJobs: 1,
      auditPayloadContainsPii: false,
      stripeHasPlaintextEmailColumn: false,
      stripeEmailDigestValid: true,
      status: "review_required",
    });
  },
);
