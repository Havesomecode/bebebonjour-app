# Bébé Bonjour

Bébé Bonjour is an operator-controlled birth-announcement workflow with a privacy-conscious fulfillment ingress.

The repository currently contains two connected but deliberately separated parts:

- a structured CLI workflow for composing, rendering, narrating, and deploying reviewed announcement pages;
- signed Tally and Stripe webhook ingress that durably reconciles a paid order in Supabase/Postgres.

## Safety boundary

The fulfillment ingress stops at a durable `review_required` job. It does **not** automatically compose content, generate narration, publish a page, email a customer, issue a refund, or deliver an order.

The local review tracer can validate a synthetic intake, apply the catalog-backed
name policy, produce a deterministic private preview, and record an explicit
operator approval in a separate local directory. It is not connected to
production jobs, and private preparation deliberately creates no deploy bundle
or deployable job state.

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

## Prepare a private review bundle

```bash
node ./bin/announce.mjs prepare-review \
  --input data/examples/bayane/intake.json \
  --output out/review-bayane \
  --select religious-bayane
```

The command writes private canonical artifacts, a browser preview under
`private-preview/`, and a bounded `review.json` dossier. It does not write
`deploy/` or `job.json`, call an external provider, approve the revision, or
publish anything.

A non-empty review output root is bound to the exact intake-file digest, selection,
catalog digest, template digest, renderer digest, and current preview slug; use a
fresh root when any material input changes. The assembled name evidence and
dossier are validated against their draft-2020 JSON Schemas before `review.json`
is written. Existing symbolic links below the root are rejected before writing.
The dossier also records a deterministic digest over every private-preview bundle
file, so HTML, CSS, JavaScript, page, transcript, and asset changes invalidate
approval. Browser-facing page IDs use an opaque deterministic correlation suffix
rather than exposing the source request identifier.
Private preview artifact paths are relative and slug-scoped, and private runtime
mode disables narration even when narration or music is requested through URL
parameters. It does not request transcript, audio, or third-party font resources.

## Complete local approval-gated workflow

After reviewing both languages in the browser, approve only the exact rendered
preview into a fresh directory:

```bash
# Local demonstration only. Production must load the same value from an
# operator-controlled secret manager for approval and later verification.
export BEBEBONJOUR_APPROVAL_HMAC_KEY="$(openssl rand -hex 32)"

node ./bin/announce.mjs approve-review \
  --review out/review-bayane/review.json \
  --output out/approved-bayane \
  --reviewer operator-demo \
  --demands not_applied

node ./bin/announce.mjs render \
  --input out/approved-bayane/page.json \
  --approval out/approved-bayane/approval.json \
  --output out/prepared-bayane

node ./bin/announce.mjs deploy \
  --input out/prepared-bayane \
  --dry-run

node ./bin/announce.mjs send \
  --job out/prepared-bayane/job.json \
  --provider console \
  --dry-run
```

If `review.requiredReasons` is non-empty, `approve-review` also requires
`--acknowledge <reason,...>` with the exact reason set. If specific demands were
submitted, `--demands applied|not_applied` is mandatory. Approval verifies the
dossier schema, current material digests, canonical draft, and every byte of the
private preview bundle, then writes a digest-bound approved page plus its
deterministic prepared-projection digest outside the immutable review root.
The complete approval record is authenticated with HMAC-SHA-256 using
`BEBEBONJOUR_APPROVAL_HMAC_KEY` (minimum 32 bytes). The key is required again by
render, deploy, and send, is never serialized, and missing, short, or mismatched
key material fails closed before approval fields are trusted.
Ordinary approved rendering must reproduce that projection and rejects any later
page edit before writing prepared output. Physical path comparison prevents a symlink alias from placing approval
output back inside the immutable root, and replay rejects changed preview bytes
or extra same-family routes. A policy-aware edit/regenerate flow remains a later slice.

The two dry runs first authenticate the operator approval, then independently regenerate the approved public projection from the
original approved page and compare it with the approval, job, and every deployable
file. Coordinated mutation of assets and mutable digest records is rejected without
deploying, creating a public URL, sending email, or mutating delivery state. Normal delivery
preview still requires a real deployed `publicUrl`.
The dry runs also revalidate the original approved page and sibling
`approval.json` against the regenerated projection, so changed approval evidence fails closed.
Public page data and deployable narration manifests omit operator-only TTS
provider, model, voice, and instruction metadata.

Name matching preserves the submitted display spelling. Alternate
orthographies resolve only through explicit aliases. Ambiguous or conflicting
Latin/Arabic forms stop for review, while original or unknown names receive a
neutral draft that does not invent a meaning, etymology, or scriptural
association. Catalog meaning text is also claim-disabled until it has dedicated
meaning-source keys; scripture references do not implicitly prove etymology.

All committed files under `data/examples/` are synthetic fixtures. They do not
contain customer submissions or identify a live customer deployment.

The current `announce send --provider console` command is a redacted,
non-mutating delivery preview. `--dry-run` verifies a prepared approved bundle
without requiring a public URL. Neither mode sends email or marks a job delivered.

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
