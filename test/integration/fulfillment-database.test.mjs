import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

function psqlResult(containerName, sql) {
  return spawnSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-h", "127.0.0.1", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "bebebonjour", "-At"],
    { encoding: "utf8", input: sql },
  );
}

function psqlAsRole(containerName, role, sql) {
  return psql(containerName, `set role ${role};\n${sql}`)
    .split("\n")
    .at(-1);
}

function openPsqlSession(containerName) {
  const child = spawn(
    "docker",
    ["exec", "-i", containerName, "psql", "-h", "127.0.0.1", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "bebebonjour", "-At"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve(() => stdout.trim());
      else reject(new Error(`psql session failed\n${stdout}${stderr}`));
    });
  });
  return {
    completed,
    end(sql = "") { child.stdin.end(sql); },
    write(sql) { child.stdin.write(sql); },
    async waitForOutput(marker) {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (stdout.includes(marker)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${marker}.\n${stdout}${stderr}`);
    },
  };
}

async function waitForDatabaseCondition(containerName, sql) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (psql(containerName, sql) === "t") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for database condition: ${sql}`);
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
  "same-transaction eligibility cycles use a monotonic per-order ordinal",
  { skip: !runDatabaseTests, timeout: 120_000 },
  async (t) => {
    const migrations = await readMigrations();
    const containerName = `bebebonjour-postgres-cycle-test-${process.pid}`;

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

    const intake = {
      schemaVersion: "1.0",
      requestId: "same_transaction_cycle_regression",
      submittedAt: "2026-08-04T12:00:00.000Z",
      customer: { email: "cycle-regression@example.com" },
      baby: { firstName: "Cycle-A", nameArabic: "أمل", gender: "girl" },
      languages: ["fr", "ar"],
      voicePreference: { gender: "female" },
      context: { religion: null },
      notes: { specificDemands: "", religiousReferencesHint: [] },
    };

    psql(
      containerName,
      `create sequence public.review_cycle_test_uuid_seq;
       create function public.next_review_cycle_test_uuid()
       returns uuid
       language sql
       volatile
       set search_path = public
       as $function$
         select (
           '00000000-0000-0000-0000-'
           || lpad(to_hex(4096 - nextval('public.review_cycle_test_uuid_seq')), 12, '0')
         )::uuid
       $function$;
       alter table public.fulfillment_review_jobs
         alter column id set default public.next_review_cycle_test_uuid();`,
    );

    const transactionOutput = psql(
      containerName,
      `begin;

       select public.ingest_stripe_payment(
         'evt_stripe_same_transaction_cycles',
         'pi_same_transaction_cycles',
         'succeeded',
         3900,
         'EUR',
         null,
         '{"id":"evt_stripe_same_transaction_cycles"}'::jsonb
       );
       select public.ingest_tally_submission(
         'evt_tally_same_transaction_cycles',
         'submission_same_transaction_cycles',
         'pi_same_transaction_cycles',
         $json$${JSON.stringify(intake)}$json$::jsonb,
         '{"eventId":"evt_tally_same_transaction_cycles"}'::jsonb
       );

       create temp table cycle_observations (
         observation_number integer generated always as identity,
         label text not null,
         review_jobs bigint not null,
         generation_runs bigint not null,
         open_review_jobs bigint not null,
         open_generation_runs bigint not null
       ) on commit drop;

       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'initial',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;

       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'initial-replay',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;

       update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"Cycle-B"'::jsonb)
       where stripe_payment_id = 'pi_same_transaction_cycles';
       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'transition-b',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;
       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'transition-b-replay',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;

       update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"Cycle-C"'::jsonb)
       where stripe_payment_id = 'pi_same_transaction_cycles';
       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'transition-c',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;
       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'transition-c-replay',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;

       update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"Cycle-D"'::jsonb)
       where stripe_payment_id = 'pi_same_transaction_cycles';
       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'transition-d',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;
       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'transition-d-replay',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;

       create temp table prior_terminal_review_jobs on commit drop as
       select id, to_jsonb(review_jobs) as snapshot
       from public.fulfillment_review_jobs as review_jobs
       where status = 'cancelled';
       create temp table prior_terminal_generation_runs on commit drop as
       select id, to_jsonb(runs) as snapshot
       from public.fulfillment_generation_runs as runs
       where status = 'cancelled';

       update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"Cycle-A"'::jsonb)
       where stripe_payment_id = 'pi_same_transaction_cycles';
       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'revert-to-highest-uuid-history',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;
       select public.reconcile_fulfillment_order('pi_same_transaction_cycles');
       insert into cycle_observations (
         label, review_jobs, generation_runs, open_review_jobs, open_generation_runs
       )
       select
         'revert-replay',
         count(distinct review_jobs.id),
         count(distinct runs.id),
         count(distinct review_jobs.id) filter (where review_jobs.status = 'open'),
         count(distinct runs.id) filter (where runs.status = 'queued')
       from public.fulfillment_review_jobs as review_jobs
       join public.fulfillment_generation_runs as runs on runs.review_job_id = review_jobs.id;

       select json_build_object(
         'observations', (
           select json_agg(json_build_object(
             'label', label,
             'reviewJobs', review_jobs,
             'generationRuns', generation_runs,
             'openReviewJobs', open_review_jobs,
             'openGenerationRuns', open_generation_runs
           ) order by observation_number)
           from cycle_observations
         ),
         'allCreatedAtTied', (
           select count(distinct created_at) = 1 from public.fulfillment_review_jobs
         ),
         'initialCycleHasHighestUuid', exists (
           select 1
           from public.fulfillment_review_jobs
           where id = '00000000-0000-0000-0000-000000000fff'::uuid
             and id = (
               select id from public.fulfillment_review_jobs order by id desc limit 1
             )
         ),
         'priorTerminalReviewJobsImmutable', not exists (
           select 1
           from prior_terminal_review_jobs as snapshots
           join public.fulfillment_review_jobs as review_jobs using (id)
           where to_jsonb(review_jobs) is distinct from snapshots.snapshot
         ),
         'priorTerminalGenerationRunsImmutable', not exists (
           select 1
           from prior_terminal_generation_runs as snapshots
           join public.fulfillment_generation_runs as runs using (id)
           where to_jsonb(runs) is distinct from snapshots.snapshot
         )
       );
       commit;`,
    );
    const transactionResult = JSON.parse(
      transactionOutput.split("\n").findLast((line) => line.startsWith("{")),
    );
    assert.deepEqual(transactionResult, {
      observations: [
        { label: "initial", reviewJobs: 1, generationRuns: 1, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "initial-replay", reviewJobs: 1, generationRuns: 1, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "transition-b", reviewJobs: 2, generationRuns: 2, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "transition-b-replay", reviewJobs: 2, generationRuns: 2, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "transition-c", reviewJobs: 3, generationRuns: 3, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "transition-c-replay", reviewJobs: 3, generationRuns: 3, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "transition-d", reviewJobs: 4, generationRuns: 4, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "transition-d-replay", reviewJobs: 4, generationRuns: 4, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "revert-to-highest-uuid-history", reviewJobs: 5, generationRuns: 5, openReviewJobs: 1, openGenerationRuns: 1 },
        { label: "revert-replay", reviewJobs: 5, generationRuns: 5, openReviewJobs: 1, openGenerationRuns: 1 },
      ],
      allCreatedAtTied: true,
      initialCycleHasHighestUuid: true,
      priorTerminalReviewJobsImmutable: true,
      priorTerminalGenerationRunsImmutable: true,
    });

    assert.deepEqual(
      JSON.parse(psql(
        containerName,
        `select json_build_object(
          'positive', bool_and(cycle_number > 0),
          'uniquePerOrder', count(*) = count(distinct cycle_number),
          'numbers', json_agg(cycle_number order by cycle_number)
         )
         from public.fulfillment_review_jobs
         where order_id = (
           select id from public.fulfillment_orders
           where stripe_payment_id = 'pi_same_transaction_cycles'
         );`,
      )),
      { positive: true, uniquePerOrder: true, numbers: [1, 2, 3, 4, 5] },
    );
  },
);

test(
  "provider ordering and retries create one review job and generation run per valid order",
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

    const nullDigestClaim = spawnSync(
      "docker",
      [
        "exec", "-i", containerName,
        "psql", "-h", "127.0.0.1", "-v", "ON_ERROR_STOP=1",
        "-U", "postgres", "-d", "bebebonjour", "-At",
      ],
      {
        encoding: "utf8",
        input: `select public.claim_next_preview_run(
          null,
          '${"2".repeat(64)}',
          '${"3".repeat(64)}',
          300
        );`,
      },
    );
    assert.notEqual(nullDigestClaim.status, 0);
    assert.match(nullDigestClaim.stderr, /material digests are required/i);

    const permissions = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'anonLegacyRpc', has_function_privilege('anon', 'public.ingest_tally_submission(text,text,text,jsonb,jsonb)', 'EXECUTE'),
        'authenticatedLegacyRpc', has_function_privilege('authenticated', 'public.ingest_tally_submission(text,text,text,jsonb,jsonb)', 'EXECUTE'),
        'serviceLegacyRpc', has_function_privilege('service_role', 'public.ingest_tally_submission(text,text,text,jsonb,jsonb)', 'EXECUTE'),
        'anonV2Rpc', has_function_privilege('anon', 'public.ingest_tally_submission_v2(text,text,text,jsonb,text)', 'EXECUTE'),
        'serviceV2Rpc', has_function_privilege('service_role', 'public.ingest_tally_submission_v2(text,text,text,jsonb,text)', 'EXECUTE'),
        'serviceRejectRpc', has_function_privilege('service_role', 'public.record_rejected_webhook_event(text,text,text,text)', 'EXECUTE'),
        'anonOrdersSelect', has_table_privilege('anon', 'public.fulfillment_orders', 'SELECT'),
        'anonGenerationSelect', has_table_privilege('anon', 'public.fulfillment_generation_runs', 'SELECT'),
        'anonGenerationClaim', has_function_privilege('anon', 'public.claim_next_preview_run(text,text,text,integer)', 'EXECUTE'),
        'authenticatedGenerationClaim', has_function_privilege('authenticated', 'public.claim_next_preview_run(text,text,text,integer)', 'EXECUTE'),
        'serviceGenerationClaim', has_function_privilege('service_role', 'public.claim_next_preview_run(text,text,text,integer)', 'EXECUTE'),
        'workerRoleExists', exists(select 1 from pg_roles where rolname = 'fulfillment_generation_worker'),
        'workerGenerationClaim', case
          when exists(select 1 from pg_roles where rolname = 'fulfillment_generation_worker')
          then has_function_privilege('fulfillment_generation_worker', 'public.claim_next_preview_run(text,text,text,integer)', 'EXECUTE')
          else false
        end,
        'workerGenerationComplete', case
          when exists(select 1 from pg_roles where rolname = 'fulfillment_generation_worker')
          then has_function_privilege('fulfillment_generation_worker', 'public.complete_preview_run(uuid,uuid,text,text,bigint)', 'EXECUTE')
          else false
        end,
        'workerGenerationFail', case
          when exists(select 1 from pg_roles where rolname = 'fulfillment_generation_worker')
          then has_function_privilege('fulfillment_generation_worker', 'public.fail_preview_run(uuid,uuid,text,text)', 'EXECUTE')
          else false
        end
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
      anonGenerationSelect: false,
      anonGenerationClaim: false,
      authenticatedGenerationClaim: false,
      serviceGenerationClaim: false,
      workerRoleExists: true,
      workerGenerationClaim: true,
      workerGenerationComplete: true,
      workerGenerationFail: true,
    });

    const deniedRoleStatements = [
      `set role fulfillment_generation_worker;
       select * from public.fulfillment_generation_runs;`,
      `set role fulfillment_generation_worker;
       update public.fulfillment_generation_runs set status = status;`,
      `set role fulfillment_generation_worker;
       select public.reconcile_fulfillment_order('pi_forbidden');`,
      `set role fulfillment_generation_worker;
       select public.ingest_tally_submission_v2(null, null, null, null, null);`,
      `set role fulfillment_generation_worker;
       select public.ingest_stripe_payment_v2(null, null, null, null, null, null, null);`,
      `set role service_role;
       select public.claim_next_preview_run(null, null, null, null);`,
      `set role service_role;
       select public.complete_preview_run(null, null, null, null, null);`,
      `set role service_role;
       select public.fail_preview_run(null, null, null, null);`,
    ];
    for (const statement of deniedRoleStatements) {
      const denied = psqlResult(containerName, statement);
      assert.notEqual(denied.status, 0, statement);
      assert.match(denied.stderr, /permission denied for (function|table)/i, statement);
    }

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
      customer: { email: "parent@example.com", internalPhone: "+33000000000" },
      baby: {
        firstName: "Amal",
        nameArabic: "أمل",
        gender: "girl",
        internalMedicalNote: "must-not-cross-worker-boundary",
      },
      languages: ["fr", "ar"],
      voicePreference: { gender: "female" },
      context: { religion: null, internalSegment: "must-not-cross-worker-boundary" },
      notes: {
        specificDemands: "",
        religiousReferencesHint: [],
        internalOperatorNote: "must-not-cross-worker-boundary",
      },
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

    const reconciliationBlocker = openPsqlSession(containerName);
    reconciliationBlocker.write(`
      begin;
      update public.fulfillment_orders
      set status = status
      where stripe_payment_id = 'pi_test_001';
      update public.stripe_payments
      set amount_minor = 1
      where payment_id = 'pi_test_001';
      select 'reconciliation_inputs_locked';
    `);
    await reconciliationBlocker.waitForOutput("reconciliation_inputs_locked");
    const reconciliationWaiter = openPsqlSession(containerName);
    reconciliationWaiter.end(`
      set application_name = 'generation_reconciliation_waiter';
      select public.reconcile_fulfillment_order('pi_test_001');
    `);
    await waitForDatabaseCondition(
      containerName,
      `select exists (
        select 1 from pg_stat_activity
        where application_name = 'generation_reconciliation_waiter'
          and wait_event_type = 'Lock'
      );`,
    );
    reconciliationBlocker.end("commit;\n");
    await Promise.all([reconciliationBlocker.completed, reconciliationWaiter.completed]);
    assert.equal(
      psql(
        containerName,
        `select status from public.fulfillment_orders
         where stripe_payment_id = 'pi_test_001';`,
      ),
      "blocked",
    );
    psql(
      containerName,
      `update public.stripe_payments
       set amount_minor = 3900
       where payment_id = 'pi_test_001';
       select public.reconcile_fulfillment_order('pi_test_001');`,
    );

    const firstGenerationRun = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'runs', (select count(*) from public.fulfillment_generation_runs),
        'queued', (select count(*) from public.fulfillment_generation_runs where status = 'queued'),
        'cancelled', (select count(*) from public.fulfillment_generation_runs where status = 'cancelled'),
        'reviewJobs', (select count(*) from public.fulfillment_review_jobs),
        'openReviewJobs', (select count(*) from public.fulfillment_review_jobs where status = 'open'),
        'cancelledReviewJobs', (select count(*) from public.fulfillment_review_jobs where status = 'cancelled'),
        'inputDigestValid', (
          select input_digest ~ '^[0-9a-f]{64}$'
          from public.fulfillment_generation_runs
          limit 1
        )
      );`,
    ));
    assert.deepEqual(firstGenerationRun, {
      runs: 2,
      queued: 1,
      cancelled: 1,
      reviewJobs: 2,
      openReviewJobs: 1,
      cancelledReviewJobs: 1,
      inputDigestValid: true,
    });

    const supersededInputRun = JSON.parse(psql(
      containerName,
      `select json_build_object(
         'id', id,
         'reviewJobId', review_job_id,
         'inputDigest', input_digest
       )
       from public.fulfillment_generation_runs
       where status = 'queued';`,
    ));
    psql(
      containerName,
      `update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"Amalia"'::jsonb)
       where stripe_payment_id = 'pi_test_001';
       select public.reconcile_fulfillment_order('pi_test_001');`,
    );
    const reconciledInputRuns = JSON.parse(psql(
      containerName,
      `select json_agg(json_build_object(
         'id', id,
         'reviewJobId', review_job_id,
         'inputDigest', input_digest,
         'status', status,
         'lastErrorCode', last_error_code
       ) order by created_at, id)
       from public.fulfillment_generation_runs
       where order_id = (
         select id from public.fulfillment_orders
         where stripe_payment_id = 'pi_test_001'
       );`,
    ));
    assert.equal(reconciledInputRuns.length, 3);
    assert.deepEqual(
      reconciledInputRuns.find((run) => run.id === supersededInputRun.id),
      {
        id: supersededInputRun.id,
        reviewJobId: supersededInputRun.reviewJobId,
        inputDigest: supersededInputRun.inputDigest,
        status: "cancelled",
        lastErrorCode: "input_changed",
      },
    );
    const currentInputRun = reconciledInputRuns.find((run) => run.status === "queued");
    assert.notEqual(currentInputRun.id, supersededInputRun.id);
    assert.notEqual(currentInputRun.reviewJobId, supersededInputRun.reviewJobId);
    assert.notEqual(currentInputRun.inputDigest, supersededInputRun.inputDigest);
    assert.equal(
      psql(
        containerName,
        `select
           (select status = 'cancelled' from public.fulfillment_review_jobs
            where id = '${supersededInputRun.reviewJobId}'::uuid)
           and
           (select status = 'open' from public.fulfillment_review_jobs
            where id = '${currentInputRun.reviewJobId}'::uuid);`,
      ),
      "t",
    );

    psql(
      containerName,
      `update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"Amalie"'::jsonb)
       where stripe_payment_id = 'pi_test_001';`,
    );
    assert.equal(
      psql(
        containerName,
        `select public.claim_next_preview_run(
          '${"1".repeat(64)}',
          '${"2".repeat(64)}',
          '${"3".repeat(64)}',
          300
        ) is null;`,
      ),
      "t",
    );
    assert.equal(
      psql(
        containerName,
        `select status = 'queued' and last_error_code is null
         from public.fulfillment_generation_runs
         where id = '${currentInputRun.id}'::uuid;`,
      ),
      "t",
    );
    psql(
      containerName,
      `select public.reconcile_fulfillment_order('pi_test_001');
       select public.reconcile_fulfillment_order('pi_test_001');`,
    );
    assert.equal(
      psql(
        containerName,
        `select
           (select status = 'cancelled' and last_error_code = 'input_changed'
            from public.fulfillment_generation_runs
            where id = '${currentInputRun.id}'::uuid)
           and
           (select status = 'cancelled'
            from public.fulfillment_review_jobs
            where id = '${currentInputRun.reviewJobId}'::uuid)
           and
           (select count(*) = 1
            from public.fulfillment_review_jobs
            where order_id = (
              select order_id from public.fulfillment_generation_runs
              where id = '${currentInputRun.id}'::uuid
            ) and status = 'open');`,
      ),
      "t",
    );

    const claimSessionA = openPsqlSession(containerName);
    let claimSessionAEnded = false;
    let claimSessionB;
    let claimedGenerationRun;
    try {
      claimSessionA.write(`
        begin;
        set role fulfillment_generation_worker;
        select public.claim_next_preview_run(
          '${"1".repeat(64)}',
          '${"2".repeat(64)}',
          '${"3".repeat(64)}',
          300
        );
        select 'claim_session_a_holds_lock';
      `);
      await claimSessionA.waitForOutput("claim_session_a_holds_lock");

      claimSessionB = openPsqlSession(containerName);
      claimSessionB.end(`
        set statement_timeout = '5s';
        set role fulfillment_generation_worker;
        select public.claim_next_preview_run(
          '${"1".repeat(64)}',
          '${"2".repeat(64)}',
          '${"3".repeat(64)}',
          300
        ) is null;
      `);
      const claimSessionBOutput = (await claimSessionB.completed)();
      assert.equal(claimSessionBOutput.split("\n").at(-1), "t");

      claimSessionA.end("commit;\n");
      claimSessionAEnded = true;
      const claimSessionAOutput = (await claimSessionA.completed)();
      claimedGenerationRun = JSON.parse(
        claimSessionAOutput.split("\n").find((line) => line.startsWith("{")),
      );
    } finally {
      if (!claimSessionAEnded) {
        claimSessionA.end("rollback;\n");
        claimSessionAEnded = true;
      }
      await Promise.allSettled([
        claimSessionA.completed,
        ...(claimSessionB ? [claimSessionB.completed] : []),
      ]);
    }
    assert.equal(claimedGenerationRun.status, "leased");
    assert.equal(claimedGenerationRun.attemptCount, 1);
    assert.equal(claimedGenerationRun.input.requestId, intake.requestId);
    assert.equal(claimedGenerationRun.input.customer, undefined);
    assert.equal(claimedGenerationRun.input.baby.internalMedicalNote, undefined);
    assert.equal(claimedGenerationRun.input.context.internalSegment, undefined);
    assert.equal(claimedGenerationRun.input.notes.internalOperatorNote, undefined);
    assert.deepEqual(Object.keys(claimedGenerationRun.input).sort(), [
      "baby",
      "context",
      "languages",
      "notes",
      "requestId",
      "schemaVersion",
      "voicePreference",
    ]);
    assert.match(claimedGenerationRun.runId, /^[0-9a-f-]{36}$/);
    assert.match(claimedGenerationRun.leaseToken, /^[0-9a-f-]{36}$/);

    const artifactManifestDigest = "4".repeat(64);
    const leasedRunBeforeInvalidArtifactKeys = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'status', status,
        'attemptCount', attempt_count,
        'leaseToken', lease_token,
        'leaseExpiresAt', lease_expires_at,
        'artifactKey', artifact_key,
        'artifactManifestDigest', artifact_manifest_digest,
        'artifactByteCount', artifact_byte_count,
        'lastErrorCode', last_error_code
       )
       from public.fulfillment_generation_runs
       where id = '${claimedGenerationRun.runId}'::uuid;`,
    ));
    const invalidArtifactKeys = [
      {
        label: "wrong order ID",
        key: `00000000-0000-0000-0000-000000000001/${claimedGenerationRun.runId}/${artifactManifestDigest}`,
      },
      {
        label: "wrong run ID",
        key: `${claimedGenerationRun.orderId}/00000000-0000-0000-0000-000000000002/${artifactManifestDigest}`,
      },
      {
        label: "wrong manifest digest",
        key: `${claimedGenerationRun.orderId}/${claimedGenerationRun.runId}/${"5".repeat(64)}`,
      },
      {
        label: "extra namespace path",
        key: `previews/${claimedGenerationRun.orderId}/${claimedGenerationRun.runId}/${artifactManifestDigest}`,
      },
    ];
    for (const { label, key } of invalidArtifactKeys) {
      const invalidCompletion = psqlResult(
        containerName,
        `set role fulfillment_generation_worker;
         select public.complete_preview_run(
           '${claimedGenerationRun.runId}'::uuid,
           '${claimedGenerationRun.leaseToken}'::uuid,
           '${key}',
           '${artifactManifestDigest}',
           12345
         );`,
      );
      assert.notEqual(invalidCompletion.status, 0, label);
      assert.match(
        invalidCompletion.stderr,
        /Artifact key must be bound to the order, run, and manifest digest/i,
        label,
      );
      assert.deepEqual(
        JSON.parse(psql(
          containerName,
          `select json_build_object(
            'status', status,
            'attemptCount', attempt_count,
            'leaseToken', lease_token,
            'leaseExpiresAt', lease_expires_at,
            'artifactKey', artifact_key,
            'artifactManifestDigest', artifact_manifest_digest,
            'artifactByteCount', artifact_byte_count,
            'lastErrorCode', last_error_code
           )
           from public.fulfillment_generation_runs
           where id = '${claimedGenerationRun.runId}'::uuid;`,
        )),
        leasedRunBeforeInvalidArtifactKeys,
        label,
      );
    }
    const completedGenerationRun = JSON.parse(psqlAsRole(
      containerName,
      "fulfillment_generation_worker",
      `select public.complete_preview_run(
        '${claimedGenerationRun.runId}'::uuid,
        '${claimedGenerationRun.leaseToken}'::uuid,
        '${claimedGenerationRun.orderId}/${claimedGenerationRun.runId}/${artifactManifestDigest}',
        '${artifactManifestDigest}',
        12345
      );`,
    ));
    assert.deepEqual(completedGenerationRun, {
      accepted: true,
      runId: claimedGenerationRun.runId,
      status: "preview_ready",
    });
    assert.equal(
      psql(
        containerName,
        `select artifact_byte_count from public.fulfillment_generation_runs
         where id = '${claimedGenerationRun.runId}'::uuid;`,
      ),
      "12345",
    );
    const completedRunSnapshot = JSON.parse(psql(
      containerName,
      `select to_jsonb(runs)
       from public.fulfillment_generation_runs as runs
       where runs.id = '${claimedGenerationRun.runId}'::uuid;`,
    ));
    psql(containerName, `
      select public.reconcile_fulfillment_order('pi_test_001');
      select public.reconcile_fulfillment_order('pi_test_001');
    `);
    assert.deepEqual(
      JSON.parse(psql(
        containerName,
        `select json_build_object(
          'run', (
            select to_jsonb(runs)
            from public.fulfillment_generation_runs as runs
            where runs.id = '${claimedGenerationRun.runId}'::uuid
          ),
          'cycleRuns', (
            select count(*) from public.fulfillment_generation_runs
            where review_job_id = '${claimedGenerationRun.reviewJobId}'::uuid
          ),
          'openCycles', (
            select count(*) from public.fulfillment_review_jobs
            where order_id = '${claimedGenerationRun.orderId}'::uuid
              and status = 'open'
          )
        );`,
      )),
      { run: completedRunSnapshot, cycleRuns: 1, openCycles: 1 },
    );
    psql(
      containerName,
      `update public.fulfillment_review_jobs
       set status = 'completed'
       where id = '${claimedGenerationRun.reviewJobId}'::uuid;
       select public.reconcile_fulfillment_order('pi_test_001');
       select public.reconcile_fulfillment_order('pi_test_001');`,
    );
    assert.deepEqual(
      JSON.parse(psql(
        containerName,
        `select json_build_object(
          'completedCycleStatus', (
            select status from public.fulfillment_review_jobs
            where id = '${claimedGenerationRun.reviewJobId}'::uuid
          ),
          'cycles', (
            select count(*) from public.fulfillment_review_jobs
            where order_id = '${claimedGenerationRun.orderId}'::uuid
          ),
          'runs', (
            select count(*) from public.fulfillment_generation_runs
            where order_id = '${claimedGenerationRun.orderId}'::uuid
          ),
          'openCycles', (
            select count(*) from public.fulfillment_review_jobs
            where order_id = '${claimedGenerationRun.orderId}'::uuid
              and status = 'open'
          )
        );`,
      )),
      { completedCycleStatus: "completed", cycles: 4, runs: 4, openCycles: 0 },
    );

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

    let editorialGenerationRun = JSON.parse(psql(
      containerName,
      `select public.claim_next_preview_run(
        '${"1".repeat(64)}',
        '${"2".repeat(64)}',
        '${"3".repeat(64)}',
        300
      );`,
    ));
    const staleInputManifestDigest = "7".repeat(64);
    psql(
      containerName,
      `update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"Nour"'::jsonb)
       where id = '${editorialGenerationRun.orderId}'::uuid;`,
    );
    assert.deepEqual(
      JSON.parse(psql(
        containerName,
        `select public.complete_preview_run(
          '${editorialGenerationRun.runId}'::uuid,
          '${editorialGenerationRun.leaseToken}'::uuid,
          '${editorialGenerationRun.orderId}/${editorialGenerationRun.runId}/${staleInputManifestDigest}',
          '${staleInputManifestDigest}',
          1
        );`,
      )),
      {
        accepted: false,
        runId: editorialGenerationRun.runId,
        status: "cancelled",
        reason: "input_changed",
      },
    );
    psql(containerName, `select public.reconcile_fulfillment_order('pi_test_002');`);
    editorialGenerationRun = JSON.parse(psql(
      containerName,
      `select public.claim_next_preview_run(
        '${"1".repeat(64)}',
        '${"2".repeat(64)}',
        '${"3".repeat(64)}',
        300
      );`,
    ));
    psql(
      containerName,
      `update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"Noura"'::jsonb)
       where id = '${editorialGenerationRun.orderId}'::uuid;`,
    );
    assert.deepEqual(
      JSON.parse(psql(
        containerName,
        `select public.fail_preview_run(
          '${editorialGenerationRun.runId}'::uuid,
          '${editorialGenerationRun.leaseToken}'::uuid,
          'review_required',
          'ambiguous_name'
        );`,
      )),
      {
        accepted: false,
        runId: editorialGenerationRun.runId,
        status: "cancelled",
        reason: "input_changed",
      },
    );
    psql(containerName, `select public.reconcile_fulfillment_order('pi_test_002');`);
    editorialGenerationRun = JSON.parse(psql(
      containerName,
      `select public.claim_next_preview_run(
        '${"1".repeat(64)}',
        '${"2".repeat(64)}',
        '${"3".repeat(64)}',
        300
      );`,
    ));
    const editorialFailure = JSON.parse(psqlAsRole(
      containerName,
      "fulfillment_generation_worker",
      `select public.fail_preview_run(
        '${editorialGenerationRun.runId}'::uuid,
        '${editorialGenerationRun.leaseToken}'::uuid,
        'review_required',
        'ambiguous_name'
      );`,
    ));
    assert.deepEqual(editorialFailure, {
      accepted: true,
      runId: editorialGenerationRun.runId,
      status: "needs_editorial_input",
    });
    assert.equal(
      psql(
        containerName,
        `select artifact_key is null and artifact_manifest_digest is null
         from public.fulfillment_generation_runs
         where id = '${editorialGenerationRun.runId}'::uuid;`,
      ),
      "t",
    );

    const editorialRunSnapshot = JSON.parse(psql(
      containerName,
      `select to_jsonb(runs)
       from public.fulfillment_generation_runs as runs
       where runs.id = '${editorialGenerationRun.runId}'::uuid;`,
    ));
    psql(containerName, `
      select public.reconcile_fulfillment_order('pi_test_002');
      select public.reconcile_fulfillment_order('pi_test_002');
    `);
    assert.deepEqual(
      JSON.parse(psql(
        containerName,
        `select json_build_object(
          'run', (
            select to_jsonb(runs)
            from public.fulfillment_generation_runs as runs
            where runs.id = '${editorialGenerationRun.runId}'::uuid
          ),
          'cycleRuns', (
            select count(*) from public.fulfillment_generation_runs
            where review_job_id = '${editorialGenerationRun.reviewJobId}'::uuid
          )
        );`,
      )),
      { run: editorialRunSnapshot, cycleRuns: 1 },
    );

    psql(
      containerName,
      `update public.stripe_payments
       set amount_minor = 1
       where payment_id = 'pi_test_002';
       select public.reconcile_fulfillment_order('pi_test_002');`,
    );
    assert.equal(
      psql(
        containerName,
        `select runs.status = 'needs_editorial_input'
           and review_jobs.status = 'cancelled'
           and runs.last_error_code = 'ambiguous_name'
         from public.fulfillment_generation_runs as runs
         join public.fulfillment_review_jobs as review_jobs
           on review_jobs.id = runs.review_job_id
         where runs.id = '${editorialGenerationRun.runId}'::uuid;`,
      ),
      "t",
    );
    psql(
      containerName,
      `update public.stripe_payments
       set amount_minor = 3900
       where payment_id = 'pi_test_002';
       select public.reconcile_fulfillment_order('pi_test_002');
       select public.reconcile_fulfillment_order('pi_test_002');`,
    );
    const recoveredEditorialCycle = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'openReviewJobId', review_jobs.id,
        'openCycles', (
          select count(*) from public.fulfillment_review_jobs
          where order_id = review_jobs.order_id and status = 'open'
        ),
        'cycleRuns', (
          select count(*) from public.fulfillment_generation_runs
          where review_job_id = review_jobs.id
        )
       )
       from public.fulfillment_review_jobs as review_jobs
       where review_jobs.order_id = '${editorialGenerationRun.orderId}'::uuid
         and review_jobs.status = 'open';`,
    ));
    assert.notEqual(recoveredEditorialCycle.openReviewJobId, editorialGenerationRun.reviewJobId);
    assert.equal(recoveredEditorialCycle.openCycles, 1);
    assert.equal(recoveredEditorialCycle.cycleRuns, 1);
    const regressionRaceLease = JSON.parse(psql(
      containerName,
      `select public.claim_next_preview_run(
        '${"1".repeat(64)}',
        '${"2".repeat(64)}',
        '${"3".repeat(64)}',
        60
      );`,
    ));
    const wallClockManifestDigest = "6".repeat(64);
    psql(
      containerName,
      `update public.fulfillment_generation_runs
       set lease_expires_at = clock_timestamp() + interval '1 second'
       where id = '${regressionRaceLease.runId}'::uuid;`,
    );
    const wallClockCompletionOutput = psql(
      containerName,
      `begin;
       select pg_sleep(1.2);
       select public.complete_preview_run(
         '${regressionRaceLease.runId}'::uuid,
         '${regressionRaceLease.leaseToken}'::uuid,
         '${regressionRaceLease.orderId}/${regressionRaceLease.runId}/${wallClockManifestDigest}',
         '${wallClockManifestDigest}',
         1
       );
       commit;`,
    );
    assert.deepEqual(
      JSON.parse(wallClockCompletionOutput.split("\n").find((line) => line.startsWith("{"))),
      {
        accepted: false,
        runId: regressionRaceLease.runId,
        status: "leased",
        reason: "lease_not_current",
      },
    );
    psql(
      containerName,
      `update public.fulfillment_generation_runs
       set lease_expires_at = clock_timestamp() + interval '60 seconds'
       where id = '${regressionRaceLease.runId}'::uuid;`,
    );
    psql(
      containerName,
      `update public.fulfillment_orders
       set status = 'blocked'
       where id = '${regressionRaceLease.orderId}'::uuid;`,
    );
    assert.deepEqual(
      JSON.parse(psql(
        containerName,
        `select public.fail_preview_run(
          '${regressionRaceLease.runId}'::uuid,
          '${regressionRaceLease.leaseToken}'::uuid,
          'review_required',
          'ambiguous_name'
        );`,
      )),
      {
        accepted: false,
        runId: regressionRaceLease.runId,
        status: "cancelled",
        reason: "eligibility_regressed",
      },
    );
    assert.equal(
      psql(
        containerName,
        `select status from public.fulfillment_review_jobs
         where id = '${regressionRaceLease.reviewJobId}'::uuid;`,
      ),
      "cancelled",
    );

    psql(
      containerName,
      `select public.reconcile_fulfillment_order('pi_test_002');`,
    );
    const expiredLease = JSON.parse(psql(
      containerName,
      `select public.claim_next_preview_run(
        '${"1".repeat(64)}',
        '${"2".repeat(64)}',
        '${"3".repeat(64)}',
        60
      );`,
    ));
    psql(
      containerName,
      `update public.fulfillment_generation_runs
       set lease_expires_at = clock_timestamp() - interval '1 second'
       where id = '${expiredLease.runId}'::uuid;`,
    );
    const reclaimedLease = JSON.parse(psql(
      containerName,
      `select public.claim_next_preview_run(
        '${"1".repeat(64)}',
        '${"2".repeat(64)}',
        '${"3".repeat(64)}',
        60
      );`,
    ));
    assert.equal(reclaimedLease.runId, expiredLease.runId);
    assert.equal(reclaimedLease.attemptCount, 2);
    assert.notEqual(reclaimedLease.leaseToken, expiredLease.leaseToken);

    const staleCompletionDigest = "5".repeat(64);
    assert.deepEqual(
      JSON.parse(psql(
        containerName,
        `select public.complete_preview_run(
          '${expiredLease.runId}'::uuid,
          '${expiredLease.leaseToken}'::uuid,
          '${expiredLease.orderId}/${expiredLease.runId}/${staleCompletionDigest}',
          '${staleCompletionDigest}',
          1
        );`,
      )),
      {
        accepted: false,
        runId: expiredLease.runId,
        status: "leased",
        reason: "lease_not_current",
      },
    );

    psql(
      containerName,
      `update public.fulfillment_generation_runs
       set lease_expires_at = clock_timestamp() - interval '1 second'
       where id = '${reclaimedLease.runId}'::uuid;`,
    );
    assert.equal(
      psql(
        containerName,
        `select public.claim_next_preview_run(
          '${"1".repeat(64)}',
          '${"2".repeat(64)}',
          '${"3".repeat(64)}',
          60
        ) is null;`,
      ),
      "t",
    );
    assert.equal(
      psql(
        containerName,
        `select status = 'failed'
          and attempt_count = 2
          and lease_token is null
          and lease_expires_at is null
          and last_error_code = 'lease_exhausted'
         from public.fulfillment_generation_runs
         where id = '${reclaimedLease.runId}'::uuid;`,
      ),
      "t",
    );
    const failedRunSnapshot = JSON.parse(psql(
      containerName,
      `select to_jsonb(runs)
       from public.fulfillment_generation_runs as runs
       where runs.id = '${reclaimedLease.runId}'::uuid;`,
    ));
    psql(containerName, `
      select public.reconcile_fulfillment_order('pi_test_002');
      select public.reconcile_fulfillment_order('pi_test_002');
    `);
    const failedRunAfterReconciliation = JSON.parse(psql(
      containerName,
      `select to_jsonb(runs)
       from public.fulfillment_generation_runs as runs
       where runs.id = '${reclaimedLease.runId}'::uuid;`,
    ));
    assert.deepEqual(failedRunAfterReconciliation, failedRunSnapshot);
    const failedRunReconciliation = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'old', (
          select json_build_object(
            'id', id,
            'status', status,
            'attemptCount', attempt_count,
            'catalogDigest', catalog_digest,
            'templateDigest', template_digest,
            'rendererDigest', renderer_digest,
            'artifactKey', artifact_key,
            'artifactManifestDigest', artifact_manifest_digest,
            'artifactByteCount', artifact_byte_count,
            'lastErrorCode', last_error_code
          )
          from public.fulfillment_generation_runs
          where id = '${reclaimedLease.runId}'::uuid
        ),
        'cycleRuns', (
          select count(*) from public.fulfillment_generation_runs
          where review_job_id = '${reclaimedLease.reviewJobId}'::uuid
        ),
        'openReviewJobId', (
          select id from public.fulfillment_review_jobs
          where order_id = '${reclaimedLease.orderId}'::uuid
            and status = 'open'
        )
      );`,
    ));
    assert.deepEqual(failedRunReconciliation.old, {
      id: reclaimedLease.runId,
      status: "failed",
      attemptCount: reclaimedLease.attemptCount,
      catalogDigest: "1".repeat(64),
      templateDigest: "2".repeat(64),
      rendererDigest: "3".repeat(64),
      artifactKey: null,
      artifactManifestDigest: null,
      artifactByteCount: null,
      lastErrorCode: "lease_exhausted",
    });
    assert.equal(failedRunReconciliation.cycleRuns, 1);
    assert.equal(failedRunReconciliation.openReviewJobId, reclaimedLease.reviewJobId);

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
          'completedReviewJobs', (select count(*) from public.fulfillment_review_jobs where status = 'completed'),
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
      reviewJobs: 9,
      openReviewJobs: 0,
      cancelledReviewJobs: 8,
      completedReviewJobs: 1,
      stripeFirstStatus: "blocked",
      tallyFirstStatus: "blocked",
      mismatchStatus: "blocked",
      duplicatePaymentEventAudited: true,
      duplicatePaymentConflict: true,
      rejectedPayloadMinimized: true,
      tallyPayloadMinimized: true,
      stripePayloadMinimized: true,
    });

    psql(
      containerName,
      `update public.fulfillment_orders
       set payment_conflict = false, last_error = null
       where id = '${claimedGenerationRun.orderId}'::uuid;
       select public.reconcile_fulfillment_order('pi_test_001');`,
    );
    const reeligibleRuns = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'old', (
          select json_build_object(
            'id', runs.id,
            'status', runs.status,
            'attemptCount', runs.attempt_count,
            'catalogDigest', runs.catalog_digest,
            'templateDigest', runs.template_digest,
            'rendererDigest', runs.renderer_digest,
            'artifactKey', runs.artifact_key,
            'artifactManifestDigest', runs.artifact_manifest_digest,
            'artifactByteCount', runs.artifact_byte_count,
            'lastErrorCode', runs.last_error_code
          )
          from public.fulfillment_generation_runs as runs
          where runs.id = '${claimedGenerationRun.runId}'::uuid
        ),
        'new', (
          select json_build_object(
            'id', runs.id,
            'status', runs.status,
            'attemptCount', runs.attempt_count,
            'catalogDigest', runs.catalog_digest,
            'artifactKey', runs.artifact_key
          )
          from public.fulfillment_generation_runs as runs
          where runs.order_id = '${claimedGenerationRun.orderId}'::uuid
            and runs.input_digest = '${claimedGenerationRun.inputDigest}'
            and runs.status = 'queued'
        ),
        'reviewStatus', (
          select status from public.fulfillment_review_jobs
          where id = '${claimedGenerationRun.reviewJobId}'::uuid
        )
      );`,
    ));
    assert.deepEqual(reeligibleRuns.old, {
      id: claimedGenerationRun.runId,
      status: "preview_ready",
      attemptCount: 1,
      catalogDigest: "1".repeat(64),
      templateDigest: "2".repeat(64),
      rendererDigest: "3".repeat(64),
      artifactKey: `${claimedGenerationRun.orderId}/${claimedGenerationRun.runId}/${artifactManifestDigest}`,
      artifactManifestDigest,
      artifactByteCount: 12345,
      lastErrorCode: null,
    });
    assert.equal(reeligibleRuns.reviewStatus, "completed");
    assert.equal(reeligibleRuns.new.status, "queued");
    assert.equal(reeligibleRuns.new.attemptCount, 0);
    assert.equal(reeligibleRuns.new.catalogDigest, null);
    assert.equal(reeligibleRuns.new.artifactKey, null);
    assert.notEqual(reeligibleRuns.new.id, claimedGenerationRun.runId);

    const maintenanceIntake = {
      ...intake,
      requestId: "tally_submission_maintenance_lock",
      customer: { email: "maintenance-lock@example.com" },
      baby: { ...intake.baby, firstName: "QueueLock" },
    };
    psql(
      containerName,
      `select public.ingest_tally_submission(
         'evt_tally_maintenance_lock',
         'submission_maintenance_lock',
         'pi_maintenance_lock',
         $json$${JSON.stringify(maintenanceIntake)}$json$::jsonb,
         $json$${JSON.stringify({ eventId: "evt_tally_maintenance_lock" })}$json$::jsonb
       );
       select public.ingest_stripe_payment(
         'evt_stripe_maintenance_lock',
         'pi_maintenance_lock',
         'succeeded',
         3900,
         'EUR',
         null,
         $json$${JSON.stringify({ id: "evt_stripe_maintenance_lock" })}$json$::jsonb
       );`,
    );
    const maintenanceRun = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'runId', runs.id,
        'orderId', runs.order_id,
        'reviewJobId', runs.review_job_id
       )
       from public.fulfillment_generation_runs as runs
       join public.fulfillment_orders as orders on orders.id = runs.order_id
       where orders.stripe_payment_id = 'pi_maintenance_lock';`,
    ));
    psql(
      containerName,
      `update public.fulfillment_generation_runs
       set status = 'leased',
           attempt_count = 2,
           lease_token = '00000000-0000-0000-0000-0000000000aa'::uuid,
           lease_expires_at = clock_timestamp() - interval '1 second',
           catalog_digest = '${"1".repeat(64)}',
           template_digest = '${"2".repeat(64)}',
           renderer_digest = '${"3".repeat(64)}',
           last_error_code = null
       where id = '${maintenanceRun.runId}'::uuid;`,
    );
    const maintenanceBlocker = openPsqlSession(containerName);
    let maintenanceBlockerEnded = false;
    let unrelatedClaimSession;
    try {
      maintenanceBlocker.write(`
        begin;
        select id
        from public.fulfillment_generation_runs
        where id = '${maintenanceRun.runId}'::uuid
        for update;
        select 'expired_attempt_two_run_locked';
      `);
      await maintenanceBlocker.waitForOutput("expired_attempt_two_run_locked");

      unrelatedClaimSession = openPsqlSession(containerName);
      unrelatedClaimSession.end(`
        set statement_timeout = '1s';
        set role fulfillment_generation_worker;
        select public.claim_next_preview_run(
          '${"1".repeat(64)}',
          '${"2".repeat(64)}',
          '${"3".repeat(64)}',
          60
        );
      `);
      const unrelatedClaimOutput = (await unrelatedClaimSession.completed)();
      const unrelatedClaim = JSON.parse(
        unrelatedClaimOutput.split("\n").find((line) => line.startsWith("{")),
      );
      assert.equal(unrelatedClaim.orderId, claimedGenerationRun.orderId);
      assert.notEqual(unrelatedClaim.runId, maintenanceRun.runId);
    } finally {
      if (!maintenanceBlockerEnded) {
        maintenanceBlocker.end("commit;\n");
        maintenanceBlockerEnded = true;
      }
      await Promise.allSettled([
        maintenanceBlocker.completed,
        ...(unrelatedClaimSession ? [unrelatedClaimSession.completed] : []),
      ]);
    }
    assert.equal(
      psql(
        containerName,
        `select public.claim_next_preview_run(
          '${"1".repeat(64)}',
          '${"2".repeat(64)}',
          '${"3".repeat(64)}',
          60
        ) is null;`,
      ),
      "t",
    );
    assert.equal(
      psql(
        containerName,
        `select status = 'failed'
           and last_error_code = 'lease_exhausted'
           and lease_token is null
           and lease_expires_at is null
         from public.fulfillment_generation_runs
         where id = '${maintenanceRun.runId}'::uuid;`,
      ),
      "t",
    );
    const exhaustedRunBeforeNewCycle = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'status', status,
        'attemptCount', attempt_count,
        'catalogDigest', catalog_digest,
        'templateDigest', template_digest,
        'rendererDigest', renderer_digest,
        'artifactKey', artifact_key,
        'artifactManifestDigest', artifact_manifest_digest,
        'artifactByteCount', artifact_byte_count,
        'lastErrorCode', last_error_code
       )
       from public.fulfillment_generation_runs
       where id = '${maintenanceRun.runId}'::uuid;`,
    ));
    psql(
      containerName,
      `update public.fulfillment_orders
       set intake = jsonb_set(intake, '{baby,firstName}', '"QueueLock-final"'::jsonb)
       where id = '${maintenanceRun.orderId}'::uuid;
       select public.reconcile_fulfillment_order('pi_maintenance_lock');
       select public.reconcile_fulfillment_order('pi_maintenance_lock');`,
    );
    const postFailureInputCycle = JSON.parse(psql(
      containerName,
      `select json_build_object(
        'oldRun', (
          select json_build_object(
            'status', status,
            'attemptCount', attempt_count,
            'catalogDigest', catalog_digest,
            'templateDigest', template_digest,
            'rendererDigest', renderer_digest,
            'artifactKey', artifact_key,
            'artifactManifestDigest', artifact_manifest_digest,
            'artifactByteCount', artifact_byte_count,
            'lastErrorCode', last_error_code
          )
          from public.fulfillment_generation_runs
          where id = '${maintenanceRun.runId}'::uuid
        ),
        'oldCycleStatus', (
          select status from public.fulfillment_review_jobs
          where id = '${maintenanceRun.reviewJobId}'::uuid
        ),
        'openCycleId', (
          select id from public.fulfillment_review_jobs
          where order_id = '${maintenanceRun.orderId}'::uuid and status = 'open'
        ),
        'openCycleRuns', (
          select count(*)
          from public.fulfillment_generation_runs as runs
          join public.fulfillment_review_jobs as review_jobs
            on review_jobs.id = runs.review_job_id
          where review_jobs.order_id = '${maintenanceRun.orderId}'::uuid
            and review_jobs.status = 'open'
        )
      );`,
    ));
    assert.deepEqual(postFailureInputCycle.oldRun, exhaustedRunBeforeNewCycle);
    assert.equal(postFailureInputCycle.oldCycleStatus, "cancelled");
    assert.notEqual(postFailureInputCycle.openCycleId, maintenanceRun.reviewJobId);
    assert.equal(postFailureInputCycle.openCycleRuns, 1);

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
