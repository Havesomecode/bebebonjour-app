# Bébé Bonjour

Bébé Bonjour is an operator-controlled birth-announcement workflow with a privacy-conscious fulfillment ingress.

The repository currently contains three connected but deliberately separated parts:

- a structured CLI workflow for composing, rendering, narrating, and deploying reviewed announcement pages;
- signed Tally and Stripe webhook ingress that durably reconciles a paid order in Supabase/Postgres.
- a TEST-A first-party customer-flow contract for synthetic local validation.

## Safety boundary

The fulfillment ingress stops after persisting a durable `review_required` job
and queuing one inert generation run for the exact canonical intake digest. It
does **not** automatically compose content, generate narration, upload a preview,
publish a page, email a customer, issue a refund, or deliver an order.

Each open review job represents one continuous eligibility cycle. Provider
replays reuse that cycle; an eligibility regression or canonical-intake change
closes it, and a later eligible state receives a fresh review-job/run identity.
Terminal generation runs remain immutable history and are never restarted by
reconciliation.

Internal claim, complete, and fail RPCs define bounded leases, immutable
generator-material identities, eligibility rechecks, and digest-bound private
artifact metadata. The RPC adapter exists, but no worker or private artifact
upload path is deployed; the queued run is therefore inert. The adapter requires
an injected client with an `rpc` method. It neither creates that client nor can
it introspect the client's credentials or database role. PostgreSQL function
grants are the authorization boundary: the dedicated
`fulfillment_generation_worker` role may call the generation RPCs, while calls
made as `service_role` fail at the database boundary. The claim RPC also
allowlists generation fields instead of returning the customer email or any
future intake fields by default.

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

## Synthetic fulfillment tracer

The TEST-A fulfillment tracer is the canonical local proof of the complete
workflow contract. It uses one synthetic `.test` order, the file-backed
local-only store, deterministic workspace manifests, an in-process no-network
TTS response, and dry-run publication and delivery commands. It never contacts
Stripe, Convex, Vercel, Resend, or OpenAI and does not authorize a hosted
migration, deployment, URL, email, or other provider effect.

Requirements are Node.js 22, installed dependencies, and `ffprobe` from FFmpeg.
The test installs a synthetic approval key and TTS adapter inside its isolated
process; do not add real provider credentials. Run the focused proof and the
representative Amal generator check with:

```bash
node --test test/integration/fulfillment-workflow-tracer.test.mjs
npm run compose:bayane
```

The durable state flow exercised by the tracer is:

```text
awaiting_payment
  -> generation_queued -> generating -> content_review_required
  -> render_queued -> rendering -> tts_queued -> tts_generating
  -> narration_review_required -> publish_ready -> publishing -> published
  -> delivery_queued -> sending -> sent -> complete
```

`retry_wait` is a bounded side branch from an interrupted stage. A retry is
available only after its persisted backoff, is capped by the stage policy, and
reuses the same persisted idempotency key for the same logical effect. The test
simulates an interrupted `prepare_review`, reopens the file-backed store, and
proves that the exact job, retry, artifact manifests, decisions, and handoffs
survive restart.

There are three explicit human checkpoints in the contract:

1. A qualified reviewer approves the exact private content-review artifact
   digests under `bebebonjour-editorial-v1`; until then, render and publication
   do not run.
2. When narration is required, a qualified reviewer listens to and approves the
   exact narration-review artifact digests; content approval alone cannot publish.
3. Delivery becomes `complete` only after a trusted verifier confirms the exact
   persisted provider message. A caller assertion or mismatched message is rejected.

The integration test executes those decisions programmatically with synthetic
reviewer identities so it is repeatable. For a manual local checkpoint, use the
`prepare-review`, `approve-review`, `render`, `tts`, and `approve-narration`
commands in the next section, inspect every private artifact before approval,
and keep `deploy --dry-run` plus `send --provider console --dry-run`. Removing a
dry-run flag, configuring a non-console delivery provider, applying hosted
migrations, provisioning provider credentials, publishing, or sending remain
separate operator-authorized operations and are not part of TEST-A.

## First-party TEST-A customer flow

The local customer-flow server creates the canonical job and opaque intake token,
keeps the intake private in memory, records the canonical lifecycle projection in
a process-scoped local file, and exposes only customer intake, status, and
checkout-session routes. Payment authority, exact-revision editorial approval,
publication, and delivery remain server-side commands and cannot be reached from
the customer HTTP API.

```bash
npm run dev:customer-flow
```

It listens only on `http://127.0.0.1:8787`. The local payment adapter makes no
provider calls, the intake accepts only synthetic `.test` addresses, and the
server removes its canonical state file on shutdown. In a second terminal, run the landing repository
with `npm run dev:local`. This is not a deployable production persistence adapter;
Convex, Stripe test mode, Resend test mode, hosted URLs, and production remain
behind their recorded authorization gates.

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

# Narration requires ffprobe before any paid provider request. Install FFmpeg
# (for example, `brew install ffmpeg`) and verify it locally:
ffprobe -version

node ./bin/announce.mjs approve-review \
  --review out/review-bayane/review.json \
  --output out/approved-bayane \
  --reviewer operator-demo \
  --demands not_applied

node ./bin/announce.mjs render \
  --input out/approved-bayane/page.json \
  --approval out/approved-bayane/approval.json \
  --output out/prepared-bayane-base

# This is the only paid/provider step. It writes a fresh private review root and
# leaves the content-approved prepared base byte-identical.
node ./bin/announce.mjs tts \
  --input out/approved-bayane/page.json \
  --approval out/approved-bayane/approval.json \
  --prepared out/prepared-bayane-base \
  --output out/narration-review-bayane \
  --lang all

# Run only after listening to every generated language.
node ./bin/announce.mjs approve-narration \
  --review out/narration-review-bayane/review.json \
  --prepared out/prepared-bayane-base \
  --output out/prepared-bayane \
  --reviewer operator-demo \
  --acknowledge ar,fr

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
TTS never mutates the content-approved prepared base. It writes audio,
browser-only manifests, updated timing data, and private provider evidence to a
fresh narration-review root. `approve-narration` requires exact language
acknowledgement, validates the complete managed media inventory and cumulative
timeline against durations decoded by `ffprobe`, and creates a
fresh final prepared root with an HMAC-authenticated narration approval bound to
the original content approval and exact media bytes. Deploy and send independently
reconstruct that narrated projection and reject missing, added, or changed media,
rewritten mutable digests, malformed manifests, or unauthenticated approval data.

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
- `supabase/migrations/` — durable reconciliation and generation leases, RLS, and RPC permissions
- `schemas/` — intake, page, job, transcript, and narration contracts
- `bin/` and `scripts/` — operator CLI
- `template/` — deterministic announcement-page runtime
- `test/` — unit and PostgreSQL integration coverage
- `openspec/` — design history and behavioral specifications

## Configuration and operations

Copy `.env.example` to `.env.local` for local configuration. Never commit provider credentials, Supabase service-role keys, customer submissions, live customer URLs, or local provider-link metadata.

See [`LIVE_SETUP.md`](./LIVE_SETUP.md) for the controlled provider and infrastructure workflow. Production identifiers and secrets must remain in the approved secret stores, not in this repository.
