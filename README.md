# Bébé Bonjour

Bébé Bonjour is an operator-controlled birth-announcement workflow with a privacy-conscious fulfillment ingress.

The repository currently contains two connected but deliberately separated parts:

- a structured CLI workflow for composing, rendering, narrating, and deploying reviewed announcement pages;
- signed Tally and Stripe webhook ingress that durably reconciles a paid order in Supabase/Postgres.

## Safety boundary

The fulfillment ingress stops at a durable `review_required` job. It does **not** automatically compose content, generate narration, publish a page, email a customer, issue a refund, or deliver an order.

Stripe `payment_intent.succeeded` is the authoritative payment signal. The economic contract is fixed at **€39 EUR**. Provider events are signature-verified from their exact raw request bytes and processed idempotently.

## Requirements

- Node.js 22
- npm
- Docker Desktop for PostgreSQL integration tests

## Install and verify

```bash
npm ci
npm run verify
```

The verification command runs the unit suite, Docker-backed PostgreSQL integration tests, and the production dependency audit.

## Render an example

```bash
npm run render:amal
npm run render:bayane
```

Generated output is written under `out/` and is intentionally ignored by Git.

All committed files under `data/examples/` are synthetic fixtures. They do not
contain customer submissions or identify a live customer deployment.

The current `announce send --provider console` command is a redacted,
non-mutating delivery preview. It does not send email or mark a job as delivered.

## Repository map

- `api/webhooks/` — Vercel Node webhook entrypoints
- `src/webhooks/` — signature verification and provider normalization
- `src/persistence/` — Supabase RPC boundary
- `supabase/migrations/` — durable reconciliation, RLS, and RPC permissions
- `schemas/` — intake, page, job, transcript, and narration contracts
- `bin/` and `scripts/` — operator CLI
- `template/` — deterministic announcement-page runtime
- `test/` — unit and PostgreSQL integration coverage
- `openspec/` — design history and behavioral specifications

## Configuration and operations

Copy `.env.example` to `.env.local` for local configuration. Never commit provider credentials, Supabase service-role keys, customer submissions, live customer URLs, or local provider-link metadata.

See [`LIVE_SETUP.md`](./LIVE_SETUP.md) for the controlled provider and infrastructure workflow. Production identifiers and secrets must remain in the approved secret stores, not in this repository.
