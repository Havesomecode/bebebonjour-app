# Live TTS And Deploy

## Credentials

Copy `.env.example` to `.env.local` and set:

- `OPENAI_API_KEY` for live narration generation
- `VERCEL_TOKEN` for live deployment
- `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` if this repo is not already linked to a Vercel project

Shell environment variables still win over `.env.local`.

## Render First

```bash
node ./bin/announce.mjs render --input data/examples/bayane/page.json --output out/bayane
```

## Generate Live Narration

```bash
node ./bin/announce.mjs tts --input data/examples/bayane/page.json --output out/bayane --lang all
```

## Deploy Live

```bash
node ./bin/announce.mjs deploy --input out/bayane
```

If `.vercel/project.json` is missing and both `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are present, the deploy command will create the local Vercel link automatically before deploying.

## Notion-Free Fulfillment Ingress

The first fulfillment slice stops at one durable `review_required` job. It does
not compose, narrate, publish, or email a customer.

### Isolation

Deploy the two functions in `api/webhooks/` to a dedicated Vercel project such
as `bebebonjour-fulfillment`. Do not deploy this repository root through the
existing linked customer-site project: a deployment can replace previously
published baby routes.

### Database

Apply every file in `supabase/migrations/` to the approved Supabase project in
timestamp order, preferably with `supabase db push`. Together they create the
private, RLS-enabled tables for redacted webhook audit events, Stripe payments,
orders, and review jobs; lock the transactional RPC functions to the Supabase
service role; and support Supabase's hosted `pgcrypto` schema layout. Provider
audit payloads retain only identifiers, payment facts, and an exact-raw-byte
SHA-256 fingerprint. Stripe email matching uses a normalized SHA-256 digest;
provider tables do not duplicate plaintext names or email. Signed events that
fail normalization are acknowledged only after an idempotent redacted audit row
is stored. The application sends exact-byte SHA-256 evidence to v2 RPCs instead
instead of sending raw provider payloads across the persistence boundary.

Apply the database migrations before deploying application code that calls the
v2 RPCs. The new code intentionally fails closed if those RPCs are unavailable.

The canonical `fulfillment_orders.intake` still contains the customer data
needed to generate an announcement. Before accepting live customer data, define
the deletion window for abandoned, delivered, and blocked orders; this first
ingress slice does not automate that lifecycle yet.

### Server Environment

Configure every fulfillment variable from `.env.example` in the dedicated
Vercel project. `TALLY_FIELD_MAP_JSON` must come from a synthetic Tally test
submission after the final form fields and options exist. Production code fails
closed if a field key, option ID, form ID, configured product price/currency, or
secret differs. A signed Stripe event with mismatched payment facts is still
recorded idempotently and moves its order to `blocked` for investigation.

### Provider Configuration

1. Add the required baby gender, conditional Arabic spelling, context, and
   EUR 39 payment block to Tally.
2. Connect the payment block to the existing Stripe account.
3. Capture one synthetic Tally webhook and map its stable `question_*` keys and
   option IDs into `TALLY_FIELD_MAP_JSON`.
4. Configure Tally to POST to `/api/webhooks/tally` and copy its signing secret
   to `TALLY_WEBHOOK_SECRET`.
5. Configure a Stripe endpoint for `payment_intent.succeeded` at
   `/api/webhooks/stripe` and copy its signing secret to
   `STRIPE_WEBHOOK_SECRET`.
6. Submit one synthetic paid order and verify exactly two webhook events, one
   payment, one order, and one review job with status `review_required`.
7. Replay both provider events and verify all four counts remain unchanged.
8. Only after that verification, disable the Zapier workflow and retire the
   Notion board from the fulfillment path.

### Local Verification

Docker Desktop must be running for the PostgreSQL integration test.

```bash
npm run verify
```

The integration harness uses an ephemeral Postgres 16 container from Quay and
removes it after the test. No customer data is used.

## Delivery Preview

`announce send --provider console` is intentionally non-mutating. It reports
only whether a recipient and public URL are configured, without printing either
value or recording a successful delivery. A real delivery provider must persist
success only after the provider confirms acceptance.
