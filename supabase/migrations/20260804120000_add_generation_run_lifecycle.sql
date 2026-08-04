-- Add a durable, pull-based generation lifecycle downstream of paid-order
-- reconciliation. This migration does not publish, narrate, approve, or deliver.

-- A review job identifies one continuously eligible cycle. Preserve closed
-- cycles, while allowing only one current cycle for an order.
alter table public.fulfillment_review_jobs
add column cycle_number bigint not null default 1;

-- Existing rows are still one-job-per-order under the original unique
-- constraint, so the constant default safely identifies each as cycle one.
-- Future cycles must always receive an explicit per-order ordinal.
alter table public.fulfillment_review_jobs
alter column cycle_number drop default;

alter table public.fulfillment_review_jobs
add constraint fulfillment_review_jobs_cycle_number_positive
check (cycle_number > 0);

alter table public.fulfillment_review_jobs
drop constraint if exists fulfillment_review_jobs_order_id_key;

alter table public.fulfillment_review_jobs
add constraint fulfillment_review_jobs_order_cycle_number_key
unique (order_id, cycle_number);

create unique index fulfillment_review_jobs_one_open_cycle_idx
on public.fulfillment_review_jobs (order_id)
where status = 'open';

create table public.fulfillment_generation_runs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.fulfillment_orders(id) on delete restrict,
  review_job_id uuid not null references public.fulfillment_review_jobs(id) on delete restrict,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  catalog_digest text check (catalog_digest is null or catalog_digest ~ '^[0-9a-f]{64}$'),
  template_digest text check (template_digest is null or template_digest ~ '^[0-9a-f]{64}$'),
  renderer_digest text check (renderer_digest is null or renderer_digest ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued'
    check (status in (
      'queued',
      'leased',
      'preview_ready',
      'needs_editorial_input',
      'failed',
      'cancelled'
    )),
  attempt_count integer not null default 0 check (attempt_count between 0 and 2),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text
    check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'),
  artifact_key text,
  artifact_manifest_digest text
    check (
      artifact_manifest_digest is null
      or artifact_manifest_digest ~ '^[0-9a-f]{64}$'
    ),
  artifact_byte_count bigint
    check (artifact_byte_count is null or artifact_byte_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'leased')
    = (lease_token is not null and lease_expires_at is not null)
  ),
  check (
    status <> 'preview_ready'
    or (
      artifact_key is not null
      and artifact_manifest_digest is not null
      and artifact_byte_count is not null
    )
  )
);

create unique index fulfillment_generation_runs_cycle_input_idx
on public.fulfillment_generation_runs (review_job_id, input_digest);

create trigger fulfillment_generation_runs_set_updated_at
before update on public.fulfillment_generation_runs
for each row execute function public.set_updated_at();

alter table public.fulfillment_generation_runs enable row level security;
revoke all on public.fulfillment_generation_runs from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'fulfillment_generation_worker'
  ) then
    create role fulfillment_generation_worker nologin noinherit;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant fulfillment_generation_worker to authenticator';
  end if;
end;
$$;

grant usage on schema public to fulfillment_generation_worker;
revoke all on public.fulfillment_generation_runs
  from service_role, fulfillment_generation_worker;

create or replace function public.reconcile_fulfillment_order(p_payment_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_review_job_id uuid;
  v_previous_status text;
  v_status text;
  v_error text;
  v_input_digest text;
  v_latest_input_digest text;
begin
  -- Payment ingress already serializes on this row. Lock payment first, then
  -- acquire/re-read the order in a later statement so eligibility never mixes
  -- a pre-wait payment snapshot with a post-wait order tuple.
  perform 1
  from public.stripe_payments
  where payment_id = p_payment_id
  for update;

  if not found then
    return;
  end if;

  select
    orders.id,
    orders.status,
    case
      when orders.payment_conflict then 'blocked'
      when payments.status is distinct from 'succeeded' then 'pending_payment'
      when payments.amount_minor is distinct from orders.expected_amount_minor then 'blocked'
      when payments.currency is distinct from orders.expected_currency then 'blocked'
      when payments.customer_email_digest is distinct from encode(
        extensions.digest(
          convert_to(lower(trim(orders.intake #>> '{customer,email}')), 'UTF8'),
          'sha256'
        ),
        'hex'
      ) then 'blocked'
      else 'review_required'
    end,
    case
      when orders.payment_conflict then coalesce(
        orders.last_error,
        'Tally submission has a conflicting Stripe payment ID.'
      )
      when payments.status is distinct from 'succeeded' then null
      when payments.amount_minor is distinct from orders.expected_amount_minor then
        'Stripe amount does not match the order.'
      when payments.currency is distinct from orders.expected_currency then
        'Stripe currency does not match the order.'
      when payments.customer_email_digest is distinct from encode(
        extensions.digest(
          convert_to(lower(trim(orders.intake #>> '{customer,email}')), 'UTF8'),
          'sha256'
        ),
        'hex'
      ) then 'Stripe email does not match the Tally submission.'
      else null
    end,
    encode(
      extensions.digest(convert_to(orders.intake::text, 'UTF8'), 'sha256'),
      'hex'
    )
  into v_order_id, v_previous_status, v_status, v_error, v_input_digest
  from public.fulfillment_orders as orders
  join public.stripe_payments as payments
    on payments.payment_id = orders.stripe_payment_id
  where orders.stripe_payment_id = p_payment_id
  for update of orders;

  if v_order_id is null then
    return;
  end if;

  update public.fulfillment_orders
  set status = v_status,
      last_error = v_error
  where id = v_order_id;

  if v_status = 'review_required' then
    select id into v_review_job_id
    from public.fulfillment_review_jobs
    where order_id = v_order_id
      and status = 'open';

    if v_review_job_id is not null and exists (
      select 1
      from public.fulfillment_generation_runs
      where review_job_id = v_review_job_id
        and input_digest <> v_input_digest
    ) then
      update public.fulfillment_review_jobs
      set status = 'cancelled'
      where id = v_review_job_id;

      update public.fulfillment_generation_runs
      set status = 'cancelled',
          lease_token = null,
          lease_expires_at = null,
          last_error_code = 'input_changed'
      where review_job_id = v_review_job_id
        and status in ('queued', 'leased');

      v_review_job_id := null;
    end if;

    if v_review_job_id is null then
      select runs.input_digest into v_latest_input_digest
      from public.fulfillment_review_jobs as review_jobs
      join public.fulfillment_generation_runs as runs
        on runs.review_job_id = review_jobs.id
      where review_jobs.order_id = v_order_id
      order by review_jobs.cycle_number desc
      limit 1;

      if v_previous_status <> 'review_required'
        or v_latest_input_digest is null
        or v_latest_input_digest <> v_input_digest then
        insert into public.fulfillment_review_jobs (order_id, cycle_number)
        select v_order_id, coalesce(max(cycle_number), 0) + 1
        from public.fulfillment_review_jobs
        where order_id = v_order_id
        returning id into v_review_job_id;
      end if;
    end if;

    insert into public.fulfillment_generation_runs (
      order_id,
      review_job_id,
      input_digest
    )
    select
      orders.id,
      v_review_job_id,
      encode(
        extensions.digest(convert_to(orders.intake::text, 'UTF8'), 'sha256'),
        'hex'
      )
    from public.fulfillment_orders as orders
    join public.fulfillment_review_jobs as review_jobs
      on review_jobs.id = v_review_job_id
     and review_jobs.status = 'open'
    where orders.id = v_order_id
    on conflict (review_job_id, input_digest) do nothing;
  else
    update public.fulfillment_review_jobs
    set status = 'cancelled'
    where order_id = v_order_id
      and status = 'open';

    update public.fulfillment_generation_runs
    set status = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        last_error_code = 'eligibility_regressed'
    where order_id = v_order_id
      and status in ('queued', 'leased');
  end if;
end;
$$;

-- Backfill an eligible run for orders reconciled before this migration.
insert into public.fulfillment_generation_runs (
  order_id,
  review_job_id,
  input_digest
)
select
  orders.id,
  review_jobs.id,
  encode(
    extensions.digest(convert_to(orders.intake::text, 'UTF8'), 'sha256'),
    'hex'
  )
from public.fulfillment_orders as orders
join public.fulfillment_review_jobs as review_jobs
  on review_jobs.order_id = orders.id
where orders.status = 'review_required'
  and review_jobs.status = 'open'
on conflict (review_job_id, input_digest) do nothing;

create or replace function public.claim_next_preview_run(
  p_catalog_digest text,
  p_template_digest text,
  p_renderer_digest text,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_order_id uuid;
  v_lease_token uuid;
  v_result jsonb;
begin
  if p_catalog_digest is null
    or p_catalog_digest !~ '^[0-9a-f]{64}$'
    or p_template_digest is null
    or p_template_digest !~ '^[0-9a-f]{64}$'
    or p_renderer_digest is null
    or p_renderer_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Lowercase SHA-256 generation material digests are required.';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'Generation lease duration must be between 30 and 900 seconds.';
  end if;

  update public.fulfillment_generation_runs as runs
  set status = 'failed',
      lease_token = null,
      lease_expires_at = null,
      last_error_code = 'lease_exhausted',
      updated_at = now()
  from (
    select maintenance.id
    from public.fulfillment_generation_runs as maintenance
    where maintenance.status = 'leased'
      and maintenance.attempt_count >= 2
      and maintenance.lease_expires_at <= clock_timestamp()
    order by maintenance.lease_expires_at, maintenance.id
    for update skip locked
    limit 16
  ) as exhausted
  where runs.id = exhausted.id;

  select runs.id, orders.id into v_run_id, v_order_id
  from public.fulfillment_generation_runs as runs
  join public.fulfillment_orders as orders
    on orders.id = runs.order_id
  join public.fulfillment_review_jobs as review_jobs
    on review_jobs.id = runs.review_job_id
  where orders.status = 'review_required'
    and review_jobs.status = 'open'
    and runs.input_digest = encode(
      extensions.digest(convert_to(orders.intake::text, 'UTF8'), 'sha256'),
      'hex'
    )
    and runs.attempt_count < 2
    and (
      runs.status = 'queued'
      or (runs.status = 'leased' and runs.lease_expires_at <= clock_timestamp())
    )
    and (runs.catalog_digest is null or runs.catalog_digest = p_catalog_digest)
    and (runs.template_digest is null or runs.template_digest = p_template_digest)
    and (runs.renderer_digest is null or runs.renderer_digest = p_renderer_digest)
  order by runs.created_at, runs.id
  for update of orders, runs skip locked
  limit 1;

  if v_run_id is null then
    return null;
  end if;

  v_lease_token := gen_random_uuid();
  update public.fulfillment_generation_runs
  set status = 'leased',
      attempt_count = attempt_count + 1,
      lease_token = v_lease_token,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      catalog_digest = coalesce(catalog_digest, p_catalog_digest),
      template_digest = coalesce(template_digest, p_template_digest),
      renderer_digest = coalesce(renderer_digest, p_renderer_digest),
      last_error_code = null
  where id = v_run_id;

  select jsonb_build_object(
    'runId', runs.id,
    'orderId', runs.order_id,
    'reviewJobId', runs.review_job_id,
    'status', runs.status,
    'attemptCount', runs.attempt_count,
    'leaseToken', runs.lease_token,
    'leaseExpiresAt', runs.lease_expires_at,
    'inputDigest', runs.input_digest,
    'input', jsonb_build_object(
      'schemaVersion', orders.intake -> 'schemaVersion',
      'requestId', orders.intake -> 'requestId',
      'baby', jsonb_build_object(
        'firstName', orders.intake #> '{baby,firstName}',
        'nameArabic', orders.intake #> '{baby,nameArabic}',
        'gender', orders.intake #> '{baby,gender}'
      ),
      'languages', orders.intake -> 'languages',
      'voicePreference', jsonb_build_object(
        'gender', orders.intake #> '{voicePreference,gender}'
      ),
      'context', jsonb_build_object(
        'religion', orders.intake #> '{context,religion}'
      ),
      'notes', jsonb_build_object(
        'specificDemands', orders.intake #> '{notes,specificDemands}',
        'religiousReferencesHint', orders.intake #> '{notes,religiousReferencesHint}'
      )
    )
  ) into v_result
  from public.fulfillment_generation_runs as runs
  join public.fulfillment_orders as orders
    on orders.id = runs.order_id
  where runs.id = v_run_id;

  return v_result;
end;
$$;

revoke all on function public.claim_next_preview_run(text, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_next_preview_run(text, text, text, integer)
  to fulfillment_generation_worker;

create or replace function public.complete_preview_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_artifact_key text,
  p_artifact_manifest_digest text,
  p_artifact_byte_count bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_review_job_id uuid;
  v_order_status text;
  v_review_status text;
  v_current_input_digest text;
  v_run public.fulfillment_generation_runs%rowtype;
begin
  if p_artifact_manifest_digest is null
    or p_artifact_manifest_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'A lowercase SHA-256 artifact manifest digest is required.';
  end if;
  if p_artifact_byte_count is null or p_artifact_byte_count < 0 then
    raise exception 'A non-negative artifact byte count is required.';
  end if;

  select order_id, review_job_id
  into v_order_id, v_review_job_id
  from public.fulfillment_generation_runs
  where id = p_run_id;

  if v_order_id is null then
    return jsonb_build_object(
      'accepted', false,
      'status', 'missing',
      'reason', 'run_not_found'
    );
  end if;

  select
    orders.status,
    review_jobs.status,
    encode(
      extensions.digest(convert_to(orders.intake::text, 'UTF8'), 'sha256'),
      'hex'
    )
  into v_order_status, v_review_status, v_current_input_digest
  from public.fulfillment_orders as orders
  join public.fulfillment_review_jobs as review_jobs
    on review_jobs.id = v_review_job_id
  where orders.id = v_order_id
  for update of orders, review_jobs;

  select * into v_run
  from public.fulfillment_generation_runs
  where id = p_run_id
  for update;

  if v_run.status <> 'leased'
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object(
      'accepted', false,
      'runId', v_run.id,
      'status', v_run.status,
      'reason', 'lease_not_current'
    );
  end if;

  if v_run.input_digest <> v_current_input_digest then
    update public.fulfillment_review_jobs
    set status = 'cancelled'
    where id = v_review_job_id
      and status = 'open';

    update public.fulfillment_generation_runs
    set status = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        last_error_code = 'input_changed'
    where review_job_id = v_review_job_id
      and status in ('queued', 'leased');
    return jsonb_build_object(
      'accepted', false,
      'runId', v_run.id,
      'status', 'cancelled',
      'reason', 'input_changed'
    );
  end if;

  if v_order_status <> 'review_required' or v_review_status <> 'open' then
    update public.fulfillment_review_jobs
    set status = 'cancelled'
    where id = v_review_job_id
      and status = 'open';

    update public.fulfillment_generation_runs
    set status = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        last_error_code = 'eligibility_regressed'
    where review_job_id = v_review_job_id
      and status in ('queued', 'leased');
    return jsonb_build_object(
      'accepted', false,
      'runId', v_run.id,
      'status', 'cancelled',
      'reason', 'eligibility_regressed'
    );
  end if;

  if p_artifact_key is null or p_artifact_key <> concat(
    v_run.order_id::text,
    '/',
    v_run.id::text,
    '/',
    p_artifact_manifest_digest
  ) then
    raise exception 'Artifact key must be bound to the order, run, and manifest digest.';
  end if;

  update public.fulfillment_generation_runs
  set status = 'preview_ready',
      lease_token = null,
      lease_expires_at = null,
      artifact_key = p_artifact_key,
      artifact_manifest_digest = p_artifact_manifest_digest,
      artifact_byte_count = p_artifact_byte_count,
      last_error_code = null
  where id = v_run.id;

  return jsonb_build_object(
    'accepted', true,
    'runId', v_run.id,
    'status', 'preview_ready'
  );
end;
$$;

revoke all on function public.complete_preview_run(uuid, uuid, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_preview_run(uuid, uuid, text, text, bigint)
  to fulfillment_generation_worker;

create or replace function public.fail_preview_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_failure_kind text,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_review_job_id uuid;
  v_order_status text;
  v_review_status text;
  v_current_input_digest text;
  v_run public.fulfillment_generation_runs%rowtype;
  v_next_status text;
begin
  if p_failure_kind is null or p_failure_kind not in (
    'retryable',
    'review_required',
    'terminal',
    'configuration'
  ) then
    raise exception 'Unsupported generation failure kind.';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'A bounded generation reason code is required.';
  end if;

  select order_id, review_job_id
  into v_order_id, v_review_job_id
  from public.fulfillment_generation_runs
  where id = p_run_id;

  if v_order_id is null then
    return jsonb_build_object(
      'accepted', false,
      'status', 'missing',
      'reason', 'run_not_found'
    );
  end if;

  select
    orders.status,
    review_jobs.status,
    encode(
      extensions.digest(convert_to(orders.intake::text, 'UTF8'), 'sha256'),
      'hex'
    )
  into v_order_status, v_review_status, v_current_input_digest
  from public.fulfillment_orders as orders
  join public.fulfillment_review_jobs as review_jobs
    on review_jobs.id = v_review_job_id
  where orders.id = v_order_id
  for update of orders, review_jobs;

  select * into v_run
  from public.fulfillment_generation_runs
  where id = p_run_id
  for update;

  if v_run.status <> 'leased'
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object(
      'accepted', false,
      'runId', v_run.id,
      'status', v_run.status,
      'reason', 'lease_not_current'
    );
  end if;

  if v_run.input_digest <> v_current_input_digest then
    update public.fulfillment_review_jobs
    set status = 'cancelled'
    where id = v_review_job_id
      and status = 'open';

    update public.fulfillment_generation_runs
    set status = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        last_error_code = 'input_changed'
    where review_job_id = v_review_job_id
      and status in ('queued', 'leased');
    return jsonb_build_object(
      'accepted', false,
      'runId', v_run.id,
      'status', 'cancelled',
      'reason', 'input_changed'
    );
  end if;

  if v_order_status <> 'review_required' or v_review_status <> 'open' then
    update public.fulfillment_review_jobs
    set status = 'cancelled'
    where id = v_review_job_id
      and status = 'open';

    update public.fulfillment_generation_runs
    set status = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        last_error_code = 'eligibility_regressed'
    where review_job_id = v_review_job_id
      and status in ('queued', 'leased');

    return jsonb_build_object(
      'accepted', false,
      'runId', v_run.id,
      'status', 'cancelled',
      'reason', 'eligibility_regressed'
    );
  end if;

  v_next_status := case
    when p_failure_kind = 'retryable' and v_run.attempt_count < 2 then 'queued'
    when p_failure_kind = 'review_required' then 'needs_editorial_input'
    else 'failed'
  end;

  update public.fulfillment_generation_runs
  set status = v_next_status,
      lease_token = null,
      lease_expires_at = null,
      last_error_code = p_reason_code
  where id = v_run.id;

  return jsonb_build_object(
    'accepted', true,
    'runId', v_run.id,
    'status', v_next_status
  );
end;
$$;

revoke all on function public.fail_preview_run(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_preview_run(uuid, uuid, text, text)
  to fulfillment_generation_worker;
