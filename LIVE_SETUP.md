# Live TTS And Deploy

> **Authorization status:** This file documents operator preparation only. No
> live TTS generation, deployment, hosted database migration, database-role
> credential provisioning, provider change, or compensating migration has been
> approved. Each live operation requires separate, explicit human authorization
> before an operator executes it.

## Credentials

Copy `.env.example` to `.env.local` and set:

- `OPENAI_API_KEY` for live narration generation
- `BEBEBONJOUR_APPROVAL_HMAC_KEY` with at least 32 bytes of high-entropy secret material for content and narration approval evidence
- `VERCEL_TOKEN` for live deployment
- `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` if this repo is not already linked to a Vercel project

Shell environment variables still win over `.env.local`.

## Media Validation Prerequisite

Narration generation, approval, deploy, and send require the `ffprobe`
executable supplied by FFmpeg. Install it before authorizing any paid TTS call
(on macOS: `brew install ffmpeg`) and verify:

```bash
ffprobe -version
```

The TTS command checks this prerequisite before contacting the provider. Every
later gate probes each segment again and reconstructs cumulative timing from the
decoded media durations.

## Render The Content-Approved Base

```bash
node ./bin/announce.mjs render \
  --input out/approved-bayane/page.json \
  --approval out/approved-bayane/approval.json \
  --output out/bayane-base
```

## Generate Narration Into A Fresh Review Root

```bash
node ./bin/announce.mjs tts \
  --input out/approved-bayane/page.json \
  --approval out/approved-bayane/approval.json \
  --prepared out/bayane-base \
  --output out/bayane-narration-review \
  --lang all
```

This is a paid external-provider operation and requires separate explicit
authorization. It leaves `out/bayane-base` unchanged. Listen to every generated
language from the private narration-review root before approving it.

If any language fails generation or media decoding, the command records
`narration_generation_failed` and exits with code `9`. Treat the entire review
root as failed evidence: inspect the recorded per-language error, discard that
root, correct the provider/media problem, and generate again into a fresh root.
Never run `approve-narration` against a failed or partial generation.
The private `review.json` stores each requested language's status and either its
segment count or a redacted error category; raw provider responses are not
persisted.

## Approve Exact Narration Bytes

```bash
node ./bin/announce.mjs approve-narration \
  --review out/bayane-narration-review/review.json \
  --prepared out/bayane-base \
  --output out/bayane \
  --reviewer <operator-id> \
  --acknowledge ar,fr
```

The same `BEBEBONJOUR_APPROVAL_HMAC_KEY` used for content approval is required.
This creates a fresh final prepared root and signs a separate narration approval;
it does not deploy, publish, email, or deliver.

## Deploy Live

```bash
node ./bin/announce.mjs deploy --input out/bayane
```

Deploy and send revalidate both the original content approval and the exact
narration review/approval chain before any remote or delivery action.

If `.vercel/project.json` is missing and both `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are present, the deploy command will create the local Vercel link automatically before deploying.

## Notion-Free Fulfillment Ingress

The fulfillment ingress stops at one durable `review_required` job and one
queued generation run for the exact intake digest. It does not compose,
narrate, publish, upload a preview, or email a customer until a separate worker
is implemented and explicitly deployed.

An open review job is one continuous eligibility cycle. Idempotent provider
replays reuse it. An eligibility regression or canonical-intake change closes
the cycle; a later eligible state creates a fresh review-job/run identity while
terminal runs remain immutable historical evidence.

### Isolation

Deploy the two functions in `api/webhooks/` to a dedicated Vercel project such
as `bebebonjour-fulfillment`. Do not deploy this repository root through the
existing linked customer-site project: a deployment can replace previously
published baby routes.

### Database

All database work below is **unapproved operator preparation**. Before requesting
live authorization, review the exact candidate forward migration and prepare,
review, and test a separate compensating forward migration against a disposable
local database. Neither the forward migration nor any compensating migration may
be applied to a hosted project without explicit human authorization for that
specific operation and project.

After that authorization, apply every file in `supabase/migrations/` to the
approved Supabase project in timestamp order, preferably with `supabase db push`.
Together they create the private, RLS-enabled tables for redacted webhook audit
events, Stripe payments, orders, review jobs, and leased generation runs; lock
the transactional RPC functions to explicit server roles; and support Supabase's
hosted `pgcrypto` schema layout. Webhook ingestion remains service-role only.
Generation claim, complete, and fail RPCs are available only to the dedicated
`fulfillment_generation_worker` database role, not the service role. The adapter
only requires an injected client with an `rpc` method and cannot inspect its
credentials or role; PostgreSQL grants enforce this boundary, so a service-role
call fails at the database.

Provisioning a worker-role credential is a separate, unapproved live operation.
Only after explicit human authorization, provision a separately issued credential
that assumes only `fulfillment_generation_worker`; never put a service-role key
or a JWT signing key in the generation worker. These operations use bounded
lease-token compare-and-set transitions; completion rechecks the paid order and
open review job before accepting an order/run/digest-bound private artifact
record. Claim responses expose an explicit generation-only intake projection and
omit the customer email and submission timestamp. Provider audit payloads retain
only identifiers, payment facts, and an exact-raw-byte SHA-256 fingerprint.
Stripe email matching uses a normalized SHA-256 digest; provider tables do not
duplicate plaintext names or email. Signed events that fail normalization are
acknowledged only after an idempotent redacted audit row is stored. The
application sends exact-byte SHA-256 evidence to v2 RPCs instead of sending raw
provider payloads across the persistence boundary.

If both operations are separately authorized, apply the database migrations before
deploying application code that calls the v2 RPCs. The new code intentionally
fails closed if those RPCs are unavailable. No such hosted migration or
deployment is authorized by this document.

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
   payment, one order, one review job with status `review_required`, and one
   queued generation run.
7. Replay both provider events and verify every count remains unchanged.
8. Only after that verification, disable the Zapier workflow and retire the
   Notion board from the fulfillment path.

### Local Verification

Docker Desktop must be running for the PostgreSQL integration test.

```bash
node --test test/integration/fulfillment-workflow-tracer.test.mjs
npm run compose:bayane
npm run verify
```

The focused fulfillment tracer is local TEST-A evidence only. It uses an
in-process no-network TTS adapter and dry-run publication/delivery, exercises
both editorial review gates plus trusted delivery confirmation, and persists one
simulated retry across a store restart. It must run without real Stripe, Convex,
Vercel, Resend, or OpenAI credentials. A hosted migration or deployment, a real
URL, removal of a dry-run flag, or any provider send still requires a separate
explicit authorization for that exact target and operation.

The integration harness uses an ephemeral Postgres 16 container from Quay and
removes it after the test. No customer data is used.

## Delivery Preview

`announce send --provider console` is intentionally non-mutating. It reports
only whether a recipient and public URL are configured, without printing either
value or recording a successful delivery. A real delivery provider must persist
success only after the provider confirms acceptance.
