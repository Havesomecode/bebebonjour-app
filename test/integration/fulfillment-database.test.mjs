import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";
const postgresTestImage = process.env.POSTGRES_TEST_IMAGE || "quay.io/debezium/postgres:16";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout || ""}${result.stderr || ""}`,
    );
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

function psql(containerName, sql) {
  return run(
    "docker",
    ["exec", "-i", containerName, "psql", "-h", "127.0.0.1", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "bebebonjour", "-At"],
    { input: sql },
  );
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

test(
  "provider ordering and retries create one review job per valid order",
  { skip: !runDatabaseTests, timeout: 120_000 },
  async (t) => {
    const migrations = await readMigrations();
    const containerName = `bebebonjour-postgres-test-${process.pid}`;

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
    t.after(() => {
      spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore" });
    });

    await waitForPostgres(containerName);
    psql(
      containerName,
      `create schema extensions;
       create extension pgcrypto with schema extensions;
       create role anon nologin;
       create role authenticated nologin;
       create role service_role nologin;
       alter default privileges in schema public
         grant all on functions to anon, authenticated, service_role;`,
    );
    psql(containerName, migrations);

    const permissions = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'anonLegacyRpc', has_function_privilege('anon', 'public.ingest_tally_submission(text,text,text,jsonb,jsonb)', 'EXECUTE'),
        'authenticatedLegacyRpc', has_function_privilege('authenticated', 'public.ingest_tally_submission(text,text,text,jsonb,jsonb)', 'EXECUTE'),
        'serviceLegacyRpc', has_function_privilege('service_role', 'public.ingest_tally_submission(text,text,text,jsonb,jsonb)', 'EXECUTE'),
        'anonV2Rpc', has_function_privilege('anon', 'public.ingest_tally_submission_v2(text,text,text,jsonb,text)', 'EXECUTE'),
        'serviceV2Rpc', has_function_privilege('service_role', 'public.ingest_tally_submission_v2(text,text,text,jsonb,text)', 'EXECUTE'),
        'serviceRejectRpc', has_function_privilege('service_role', 'public.record_rejected_webhook_event(text,text,text,text)', 'EXECUTE'),
        'anonOrdersSelect', has_table_privilege('anon', 'public.fulfillment_orders', 'SELECT')
      );`,
    ));
    assert.deepEqual(permissions, {
      anonLegacyRpc: false,
      authenticatedLegacyRpc: false,
      serviceLegacyRpc: false,
      anonV2Rpc: false,
      serviceV2Rpc: true,
      serviceRejectRpc: true,
      anonOrdersSelect: false,
    });

    const rejectedDigest = "c".repeat(64);
    const rejectedOnce = JSON.parse(psql(
      containerName,
      `select public.record_rejected_webhook_event(
        'tally', 'evt_tally_rejected', 'normalization_failed', '${rejectedDigest}'
      );`,
    ));
    const rejectedTwice = JSON.parse(psql(
      containerName,
      `select public.record_rejected_webhook_event(
        'tally', 'evt_tally_rejected', 'normalization_failed', '${rejectedDigest}'
      );`,
    ));
    assert.deepEqual(rejectedOnce, { duplicate: false, rejected: true });
    assert.deepEqual(rejectedTwice, { duplicate: true, rejected: true });

    const stripeEvent = {
      id: "evt_stripe_001",
      type: "payment_intent.succeeded",
    };
    const tallyEvent = {
      eventId: "evt_tally_001",
      data: { submissionId: "submission_001", formId: "form_test_001" },
    };
    const intake = {
      schemaVersion: "1.0",
      requestId: "tally_submission_001",
      submittedAt: "2026-08-02T12:29:59.000Z",
      customer: { email: "parent@example.com" },
      baby: { firstName: "Amal", nameArabic: "أمل", gender: "girl" },
      languages: ["fr", "ar"],
      voicePreference: { gender: "female" },
    };

    const ingest = `
      select public.ingest_stripe_payment(
        'evt_stripe_001',
        'pi_test_001',
        'succeeded',
        3900,
        'EUR',
        null,
        $json$${JSON.stringify(stripeEvent)}$json$::jsonb
      );
      select public.ingest_tally_submission(
        'evt_tally_001',
        'submission_001',
        'pi_test_001',
        $json$${JSON.stringify(intake)}$json$::jsonb,
        $json$${JSON.stringify(tallyEvent)}$json$::jsonb
      );
    `;

    psql(containerName, ingest);
    psql(containerName, ingest);

    const stripeDigest = "a".repeat(64);
    const tallyDigest = "b".repeat(64);
    psql(
      containerName,
      `select public.ingest_stripe_payment_v2(
        'evt_stripe_001', 'pi_test_001', 'succeeded', 3900, 'EUR', null, '${stripeDigest}'
      );
      select public.ingest_tally_submission_v2(
        'evt_tally_001', 'submission_001', 'pi_test_001',
        $json$${JSON.stringify(intake)}$json$::jsonb,
        '${tallyDigest}'
      );`,
    );

    const tallyFirstIntake = {
      ...intake,
      requestId: "tally_submission_002",
      customer: { email: "second-parent@example.com" },
      baby: { ...intake.baby, firstName: "Noor" },
    };
    const tallyFirst = `
      select public.ingest_tally_submission(
        'evt_tally_002',
        'submission_002',
        'pi_test_002',
        $json$${JSON.stringify(tallyFirstIntake)}$json$::jsonb,
        $json$${JSON.stringify({ eventId: "evt_tally_002" })}$json$::jsonb
      );
      select public.ingest_stripe_payment(
        'evt_stripe_002',
        'pi_test_002',
        'succeeded',
        3900,
        'EUR',
        null,
        $json$${JSON.stringify({ id: "evt_stripe_002" })}$json$::jsonb
      );
    `;
    psql(containerName, tallyFirst);
    psql(containerName, tallyFirst);

    const blockedIntake = {
      ...intake,
      requestId: "tally_submission_003",
      customer: { email: "third-parent@example.com" },
      baby: { ...intake.baby, firstName: "Aya" },
    };
    const mismatchedPayment = `
      select public.ingest_tally_submission(
        'evt_tally_003',
        'submission_003',
        'pi_test_003',
        $json$${JSON.stringify(blockedIntake)}$json$::jsonb,
        $json$${JSON.stringify({ eventId: "evt_tally_003" })}$json$::jsonb
      );
      select public.ingest_stripe_payment(
        'evt_stripe_003',
        'pi_test_003',
        'succeeded',
        1,
        'EUR',
        'third-parent@example.com',
        $json$${JSON.stringify({ id: "evt_stripe_003" })}$json$::jsonb
      );
    `;
    psql(containerName, mismatchedPayment);
    psql(containerName, mismatchedPayment);

    const conflict = `
      select public.ingest_tally_submission(
        'evt_tally_conflict_001',
        'submission_001',
        'pi_conflict_001',
        $json$${JSON.stringify(intake)}$json$::jsonb,
        $json$${JSON.stringify({ eventId: "evt_tally_conflict_001" })}$json$::jsonb
      );
      select public.ingest_stripe_payment(
        'evt_stripe_original_replayed',
        'pi_test_001',
        'succeeded',
        3900,
        'EUR',
        null,
        $json$${JSON.stringify({ id: "evt_stripe_original_replayed" })}$json$::jsonb
      );
    `;
    psql(containerName, conflict);

    const duplicatePaymentIntake = {
      ...intake,
      requestId: "tally_submission_duplicate_payment",
      customer: { email: "duplicate-payment@example.com" },
      baby: { ...intake.baby, firstName: "Lina" },
    };
    const duplicatePaymentClaim = JSON.parse(psql(
      containerName,
      `select public.ingest_tally_submission(
        'evt_tally_duplicate_payment',
        'submission_duplicate_payment',
        'pi_test_002',
        $json$${JSON.stringify(duplicatePaymentIntake)}$json$::jsonb,
        $json$${JSON.stringify({ eventId: "evt_tally_duplicate_payment" })}$json$::jsonb
      );`,
    ));
    assert.equal(duplicatePaymentClaim.duplicate, false);
    assert.equal(duplicatePaymentClaim.status, "blocked");

    const summary = JSON.parse(
      psql(
        containerName,
        `select json_build_object(
          'orders', (select count(*) from public.fulfillment_orders),
          'events', (select count(*) from public.webhook_events),
          'payments', (select count(*) from public.stripe_payments),
          'reviewJobs', (select count(*) from public.fulfillment_review_jobs),
          'openReviewJobs', (select count(*) from public.fulfillment_review_jobs where status = 'open'),
          'cancelledReviewJobs', (select count(*) from public.fulfillment_review_jobs where status = 'cancelled'),
          'stripeFirstStatus', (select status from public.fulfillment_orders where tally_submission_id = 'submission_001'),
          'tallyFirstStatus', (select status from public.fulfillment_orders where tally_submission_id = 'submission_002'),
          'mismatchStatus', (select status from public.fulfillment_orders where tally_submission_id = 'submission_003'),
          'duplicatePaymentEventAudited', exists(
            select 1 from public.webhook_events
            where provider = 'tally' and external_event_id = 'evt_tally_duplicate_payment'
          ),
          'duplicatePaymentConflict', (
            select payment_conflict from public.fulfillment_orders
            where tally_submission_id = 'submission_002'
          ),
          'rejectedPayloadMinimized', (
            select payload = jsonb_build_object(
              'eventId', 'evt_tally_rejected',
              'rejected', true,
              'reasonCode', 'normalization_failed',
              'payloadSha256', '${rejectedDigest}'
            )
            from public.webhook_events
            where provider = 'tally' and external_event_id = 'evt_tally_rejected'
          ),
          'tallyPayloadMinimized', (
            select payload ->> 'payloadSha256' = '${tallyDigest}'
              and not payload ? 'normalizedPayloadSha256'
            from public.webhook_events
            where provider = 'tally' and external_event_id = 'evt_tally_001'
          ),
          'stripePayloadMinimized', (
            select payload ->> 'payloadSha256' = '${stripeDigest}'
              and not payload ? 'normalizedPayloadSha256'
            from public.webhook_events
            where provider = 'stripe' and external_event_id = 'evt_stripe_001'
          )
        );`,
      ),
    );

    assert.deepEqual(summary, {
      orders: 3,
      events: 10,
      payments: 4,
      reviewJobs: 2,
      openReviewJobs: 0,
      cancelledReviewJobs: 2,
      stripeFirstStatus: "blocked",
      tallyFirstStatus: "blocked",
      mismatchStatus: "blocked",
      duplicatePaymentEventAudited: true,
      duplicatePaymentConflict: true,
      rejectedPayloadMinimized: true,
      tallyPayloadMinimized: true,
      stripePayloadMinimized: true,
    });

    const nullSafeIntake = {
      ...intake,
      requestId: "tally_submission_null_safe",
      customer: { email: "null-safe@example.com" },
      baby: { ...intake.baby, firstName: "Mina" },
    };
    psql(
      containerName,
      `select public.ingest_tally_submission_v2(
        'evt_tally_null_safe', 'submission_null_safe', 'pi_null_safe',
        $json$${JSON.stringify(nullSafeIntake)}$json$::jsonb,
        '${"d".repeat(64)}'
      );
      select public.ingest_stripe_payment_v2(
        'evt_stripe_null_safe', 'pi_null_safe', 'succeeded', 3900, 'EUR', null,
        '${"e".repeat(64)}'
      );
      update public.stripe_payments set amount_minor = null where payment_id = 'pi_null_safe';
      select public.reconcile_fulfillment_order('pi_null_safe');`,
    );
    assert.equal(
      psql(
        containerName,
        `select status from public.fulfillment_orders
         where tally_submission_id = 'submission_null_safe';`,
      ),
      "blocked",
    );
  },
);
