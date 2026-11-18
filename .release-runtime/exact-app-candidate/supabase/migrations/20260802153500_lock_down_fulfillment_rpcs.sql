revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.reconcile_fulfillment_order(text) from public, anon, authenticated;
revoke all on function public.ingest_tally_submission(text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_stripe_payment(text, text, text, integer, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.ingest_tally_submission(text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.ingest_stripe_payment(text, text, text, integer, text, text, jsonb) to service_role;

alter default privileges in schema public
  revoke all on functions from anon, authenticated;