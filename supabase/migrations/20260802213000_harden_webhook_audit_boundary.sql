-- Minimize provider payload exposure at the application/database boundary and
-- preserve a redacted audit row for signed events that fail normalization.

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

create or replace function public.ingest_tally_submission_v2(
  p_event_id text,
  p_submission_id text,
  p_payment_id text,
  p_intake jsonb,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A lowercase SHA-256 payload digest is required.';
  end if;

  v_result := public.ingest_tally_submission(
    p_event_id,
    p_submission_id,
    p_payment_id,
    p_intake,
    jsonb_build_object('redactedPayloadSha256', p_payload_sha256)
  );

  update public.webhook_events
  set payload = (payload - 'normalizedPayloadSha256')
    || jsonb_build_object('payloadSha256', p_payload_sha256)
  where provider = 'tally'
    and external_event_id = p_event_id;

  return v_result;
end;
$$;

create or replace function public.ingest_stripe_payment_v2(
  p_event_id text,
  p_payment_id text,
  p_status text,
  p_amount_minor integer,
  p_currency text,
  p_email text,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A lowercase SHA-256 payload digest is required.';
  end if;

  v_result := public.ingest_stripe_payment(
    p_event_id,
    p_payment_id,
    p_status,
    p_amount_minor,
    p_currency,
    p_email,
    jsonb_build_object('redactedPayloadSha256', p_payload_sha256)
  );

  update public.webhook_events
  set payload = (payload - 'normalizedPayloadSha256')
    || jsonb_build_object('payloadSha256', p_payload_sha256)
  where provider = 'stripe'
    and external_event_id = p_event_id;

  update public.stripe_payments
  set payload = (payload - 'normalizedPayloadSha256')
    || jsonb_build_object('payloadSha256', p_payload_sha256)
  where payment_id = p_payment_id
    and latest_event_id = p_event_id;

  return v_result;
end;
$$;

create or replace function public.record_rejected_webhook_event(
  p_provider text,
  p_event_id text,
  p_reason_code text,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_row_id bigint;
begin
  if p_provider not in ('tally', 'stripe') then
    raise exception 'Unsupported webhook provider.';
  end if;
  if coalesce(trim(p_event_id), '') = '' then
    raise exception 'Webhook event ID is required.';
  end if;
  if p_reason_code not in ('invalid_json', 'normalization_failed') then
    raise exception 'Unsupported webhook rejection reason.';
  end if;
  if p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A lowercase SHA-256 payload digest is required.';
  end if;

  insert into public.webhook_events (provider, external_event_id, payload)
  values (
    p_provider,
    p_event_id,
    jsonb_build_object(
      'eventId', p_event_id,
      'rejected', true,
      'reasonCode', p_reason_code,
      'payloadSha256', p_payload_sha256
    )
  )
  on conflict (provider, external_event_id) do nothing
  returning id into v_event_row_id;

  return jsonb_build_object(
    'duplicate', v_event_row_id is null,
    'rejected', true
  );
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.reconcile_fulfillment_order(text) from public, anon, authenticated;
revoke all on function public.ingest_tally_submission(text, text, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_stripe_payment(text, text, text, integer, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_tally_submission_v2(text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.ingest_stripe_payment_v2(text, text, text, integer, text, text, text)
  from public, anon, authenticated;
revoke all on function public.record_rejected_webhook_event(text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.ingest_tally_submission_v2(text, text, text, jsonb, text)
  to service_role;
grant execute on function public.ingest_stripe_payment_v2(text, text, text, integer, text, text, text)
  to service_role;
grant execute on function public.record_rejected_webhook_event(text, text, text, text)
  to service_role;

alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
