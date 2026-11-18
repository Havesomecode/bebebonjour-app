-- Hosted Supabase installs pgcrypto functions in the protected extensions schema.
-- The original security-definer functions used search_path = public, so their
-- unqualified digest() calls could not resolve at runtime.
alter function public.reconcile_fulfillment_order(text)
  set search_path = public, extensions;

alter function public.ingest_tally_submission(text, text, text, jsonb, jsonb)
  set search_path = public, extensions;

alter function public.ingest_stripe_payment(text, text, text, integer, text, text, jsonb)
  set search_path = public, extensions;
