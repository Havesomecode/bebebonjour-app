-- Keep a second Tally submission from claiming a Stripe payment already bound
-- to another order. The event remains audited and the existing order is blocked.
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
set search_path = public, extensions
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

revoke all on function public.ingest_tally_submission(text, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_tally_submission(text, text, text, jsonb, jsonb)
  to service_role;
