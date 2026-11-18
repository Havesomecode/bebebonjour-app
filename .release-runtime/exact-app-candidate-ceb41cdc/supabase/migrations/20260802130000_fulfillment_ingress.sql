create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('tally', 'stripe')),
  external_event_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (provider, external_event_id)
);

create table public.stripe_payments (
  payment_id text primary key,
  latest_event_id text,
  status text not null check (status in ('reported_by_tally', 'succeeded', 'failed')),
  amount_minor integer check (amount_minor is null or amount_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  customer_email_digest text
    check (customer_email_digest is null or customer_email_digest ~ '^[0-9a-f]{64}$'),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.fulfillment_orders (
  id uuid primary key default gen_random_uuid(),
  tally_submission_id text not null unique,
  stripe_payment_id text not null unique references public.stripe_payments(payment_id),
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'review_required', 'blocked')),
  payment_conflict boolean not null default false,
  expected_amount_minor integer not null default 3900 check (expected_amount_minor >= 0),
  expected_currency text not null default 'EUR' check (expected_currency ~ '^[A-Z]{3}$'),
  intake jsonb not null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.fulfillment_review_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.fulfillment_orders(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger stripe_payments_set_updated_at
before update on public.stripe_payments
for each row execute function public.set_updated_at();

create trigger fulfillment_orders_set_updated_at
before update on public.fulfillment_orders
for each row execute function public.set_updated_at();

create trigger fulfillment_review_jobs_set_updated_at
before update on public.fulfillment_review_jobs
for each row execute function public.set_updated_at();

create or replace function public.reconcile_fulfillment_order(p_payment_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_status text;
  v_error text;
begin
  select
    orders.id,
    case
      when orders.payment_conflict then 'blocked'
      when payments.status <> 'succeeded' then 'pending_payment'
      when payments.amount_minor <> orders.expected_amount_minor then 'blocked'
      when payments.currency <> orders.expected_currency then 'blocked'
      when coalesce(payments.customer_email_digest, '') <> encode(
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
      when payments.status <> 'succeeded' then null
      when payments.amount_minor <> orders.expected_amount_minor then 'Stripe amount does not match the order.'
      when payments.currency <> orders.expected_currency then 'Stripe currency does not match the order.'
      when coalesce(payments.customer_email_digest, '') <> encode(
        extensions.digest(
          convert_to(lower(trim(orders.intake #>> '{customer,email}')), 'UTF8'),
          'sha256'
        ),
        'hex'
      ) then 'Stripe email does not match the Tally submission.'
      else null
    end
  into v_order_id, v_status, v_error
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
    insert into public.fulfillment_review_jobs (order_id)
    values (v_order_id)
    on conflict (order_id) do update
    set status = 'open'
    where public.fulfillment_review_jobs.status = 'cancelled';
  else
    update public.fulfillment_review_jobs
    set status = 'cancelled'
    where order_id = v_order_id
      and status = 'open';
  end if;
end;
$$;

create or replace function public.ingest_tally_submission(
  p_event_id text,
  p_submission_id text,
  p_payment_id text,
  p_intake jsonb,
  p_raw_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_row_id bigint;
  v_order public.fulfillment_orders%rowtype;
begin
  if coalesce(p_event_id, '') = ''
    or coalesce(p_submission_id, '') = ''
    or coalesce(p_payment_id, '') = '' then
    raise exception 'Tally event, submission, and payment IDs are required.';
  end if;
  if coalesce(p_intake #>> '{customer,email}', '') = '' then
    raise exception 'Canonical intake customer email is required.';
  end if;

  insert into public.webhook_events (provider, external_event_id, payload)
  values (
    'tally',
    p_event_id,
    jsonb_build_object(
      'eventId', p_event_id,
      'submissionId', p_submission_id,
      'paymentId', p_payment_id,
      'normalizedPayloadSha256', encode(
        extensions.digest(convert_to(p_raw_event::text, 'UTF8'), 'sha256'),
        'hex'
      )
    )
  )
  on conflict (provider, external_event_id) do nothing
  returning id into v_event_row_id;

  if v_event_row_id is null then
    select * into v_order
    from public.fulfillment_orders
    where tally_submission_id = p_submission_id;
    return jsonb_build_object(
      'duplicate', true,
      'orderId', v_order.id,
      'status', v_order.status
    );
  end if;

  insert into public.stripe_payments (
    payment_id,
    status,
    customer_email_digest
  ) values (
    p_payment_id,
    'reported_by_tally',
    encode(
      extensions.digest(
        convert_to(lower(trim(p_intake #>> '{customer,email}')), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ) on conflict (payment_id) do update
  set customer_email_digest = coalesce(
    public.stripe_payments.customer_email_digest,
    excluded.customer_email_digest
  );

  select * into v_order
  from public.fulfillment_orders
  where tally_submission_id = p_submission_id
  for update;

  if found and v_order.stripe_payment_id <> p_payment_id then
    update public.fulfillment_orders
    set status = 'blocked',
        payment_conflict = true,
        last_error = 'Tally submission was replayed with a different Stripe payment ID.'
    where id = v_order.id
    returning * into v_order;
  elsif not found then
    select * into v_order
    from public.fulfillment_orders
    where stripe_payment_id = p_payment_id
    for update;

    if found then
      update public.fulfillment_orders
      set status = 'blocked',
          payment_conflict = true,
          last_error = 'Stripe payment ID was claimed by multiple Tally submissions.'
      where id = v_order.id
      returning * into v_order;
    else
      insert into public.fulfillment_orders (
        tally_submission_id,
        stripe_payment_id,
        intake
      ) values (
        p_submission_id,
        p_payment_id,
        p_intake
      )
      returning * into v_order;
    end if;
  end if;

  perform public.reconcile_fulfillment_order(v_order.stripe_payment_id);
  select * into v_order from public.fulfillment_orders where id = v_order.id;

  return jsonb_build_object(
    'duplicate', false,
    'orderId', v_order.id,
    'status', v_order.status
  );
end;
$$;

create or replace function public.ingest_stripe_payment(
  p_event_id text,
  p_payment_id text,
  p_status text,
  p_amount_minor integer,
  p_currency text,
  p_email text,
  p_raw_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_row_id bigint;
  v_payment public.stripe_payments%rowtype;
begin
  if coalesce(p_event_id, '') = '' or coalesce(p_payment_id, '') = '' then
    raise exception 'Stripe event and payment IDs are required.';
  end if;
  if p_status not in ('succeeded', 'failed') then
    raise exception 'Unsupported Stripe payment status.';
  end if;

  insert into public.webhook_events (provider, external_event_id, payload)
  values (
    'stripe',
    p_event_id,
    jsonb_build_object(
      'eventId', p_event_id,
      'paymentId', p_payment_id,
      'status', p_status,
      'amountMinor', p_amount_minor,
      'currency', upper(p_currency),
      'normalizedPayloadSha256', encode(
        extensions.digest(convert_to(p_raw_event::text, 'UTF8'), 'sha256'),
        'hex'
      )
    )
  )
  on conflict (provider, external_event_id) do nothing
  returning id into v_event_row_id;

  if v_event_row_id is null then
    select * into v_payment
    from public.stripe_payments
    where payment_id = p_payment_id;
    return jsonb_build_object(
      'duplicate', true,
      'paymentId', v_payment.payment_id,
      'status', v_payment.status
    );
  end if;

  insert into public.stripe_payments (
    payment_id,
    latest_event_id,
    status,
    amount_minor,
    currency,
    customer_email_digest,
    payload
  ) values (
    p_payment_id,
    p_event_id,
    p_status,
    p_amount_minor,
    upper(p_currency),
    case
      when coalesce(trim(p_email), '') = '' then null
      else encode(
        extensions.digest(convert_to(lower(trim(p_email)), 'UTF8'), 'sha256'),
        'hex'
      )
    end,
    jsonb_build_object(
      'eventId', p_event_id,
      'paymentId', p_payment_id,
      'status', p_status,
      'amountMinor', p_amount_minor,
      'currency', upper(p_currency),
      'normalizedPayloadSha256', encode(
        extensions.digest(convert_to(p_raw_event::text, 'UTF8'), 'sha256'),
        'hex'
      )
    )
  )
  on conflict (payment_id) do update
  set latest_event_id = excluded.latest_event_id,
      status = excluded.status,
      amount_minor = excluded.amount_minor,
      currency = excluded.currency,
      customer_email_digest = coalesce(
        excluded.customer_email_digest,
        public.stripe_payments.customer_email_digest
      ),
      payload = excluded.payload;

  perform public.reconcile_fulfillment_order(p_payment_id);
  select * into v_payment
  from public.stripe_payments
  where payment_id = p_payment_id;

  return jsonb_build_object(
    'duplicate', false,
    'paymentId', v_payment.payment_id,
    'status', v_payment.status
  );
end;
$$;

alter table public.webhook_events enable row level security;
alter table public.stripe_payments enable row level security;
alter table public.fulfillment_orders enable row level security;
alter table public.fulfillment_review_jobs enable row level security;

revoke all on public.webhook_events from anon, authenticated;
revoke all on public.stripe_payments from anon, authenticated;
revoke all on public.fulfillment_orders from anon, authenticated;
revoke all on public.fulfillment_review_jobs from anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.reconcile_fulfillment_order(text) from public, anon, authenticated;
revoke all on function public.ingest_tally_submission(text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_stripe_payment(text, text, text, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_tally_submission(text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.ingest_stripe_payment(text, text, text, integer, text, text, jsonb) to service_role;

alter default privileges in schema public
  revoke all on functions from anon, authenticated;
