# Bébé Bonjour fulfillment architecture and editorial review policy

Date: 2026-08-06
Decision status: Recommended for operator approval; no live action is authorized by this document.

## Executive decision

Adopt one durable, database-backed fulfillment job from intake through delivery. Keep Tally as the launch intake UI, but do not use the shared, fixed Stripe Payment Link currently shown on the landing page and do not infer a payment-to-job match from email alone. Create a Stripe Checkout Session server-side for each job and bind it with explicit `project`, `product`, `environment`, and `job_id` metadata.

Use:

- Tally for intake only.
- Stripe Checkout for payment.
- Supabase Postgres as the source of truth and Supabase Storage for immutable private and public artifacts.
- One Vercel fulfillment project for webhooks, checkout, authenticated review, status APIs, and short stage workers.
- One separate Vercel public announcement router serving all approved pages from storage under stable custom-domain URLs.
- Resend for transactional email.
- The existing deterministic CLI code as the compose/render/TTS core, called by leased stage workers rather than treating local `job.json` as authoritative.
- Two mandatory approvals when narration is requested: exact content approval, then exact narration-byte approval. A job cannot publish, send, or become complete without every approval required for the exact revision being delivered.

This target preserves the verified Amal artifact model, removes the current payment-correlation ambiguity, avoids one Vercel project per baby, and supports a shared Stripe account safely.

## Scope and non-actions

This report inspected the local repositories and branch listed below. It did not read live customer data, purchase a service, change a hosted database, create provider credentials, deploy, publish, or send email.

## Current system

### Landing and purchase path

`/Users/zacariachtatar/repos/bebebonjour-landing` is a static Vite landing page. Its checked-out `feat/tally-stripe-flow` branch:

- sends order CTAs to one Tally form (`index.html:23`, `index.html:43`, `index.html:133`, and `index.html:226`);
- tells the customer that payment follows on the Tally thank-you page and by email (`index.html:109-112`);
- also exposes one fixed Stripe Payment Link to every visitor (`index.html:173-187`);
- has no application state or per-order correlation in `src/main.js`;
- builds as one Vite site through `vercel.json`.

A shared Payment Link is not enough to bind one payment to one intake. Matching later by email is ambiguous, mutable, and unsafe when one payer submits more than once.

### Fulfillment ingress

`/Users/zacariachtatar/repos/bebebonjour-app` already has strong server-side ingress foundations:

- Tally and Stripe raw-body signature verification;
- strict form ID, field-map, amount, currency, and email checks;
- idempotent webhook event records;
- redacted provider evidence rather than retained raw payloads;
- Supabase RLS and server-only RPC grants;
- payment-intent, Tally-submission, and order uniqueness constraints;
- reconciliation that creates review work only after the Stripe payment succeeds and the payment facts agree;
- bounded pull-based generation leases with a maximum of two attempts;
- order/run/input-digest-bound artifact keys.

The current Tally normalizer assumes a Tally Stripe payment block. It extracts a Stripe Payment Intent ID from a Tally field containing a Stripe dashboard link (`src/webhooks/tally.mjs:66-75` and `src/webhooks/tally.mjs:156-170`). This does not match the landing branch's separate fixed Payment Link.

The database currently models:

- `webhook_events` for Tally/Stripe idempotency;
- `stripe_payments` with reported/succeeded/failed states;
- `fulfillment_orders` with `pending_payment`, `review_required`, or `blocked`;
- `fulfillment_review_jobs` with open/completed/cancelled cycles;
- `fulfillment_generation_runs` with queued, leased, preview-ready, editorial-input, failed, or cancelled states.

The generation migration deliberately stops at a private preview. There is not yet a persistent content decision, narration decision, publication, delivery, retention, or customer-visible status lifecycle.

### Compose, render, TTS, deploy, send, and status

The CLI in `bin/announce.mjs` exposes:

1. `compose`
2. `prepare-review`
3. `approve-review`
4. `render`
5. `tts`
6. `approve-narration`
7. `deploy`
8. `send`
9. `status`

Existing safety properties to preserve:

- name ambiguity and unsupported content stop for editorial input;
- private preview output is isolated from approval output;
- the review dossier binds intake, catalog, template, renderer, page, transcript, and private preview digests;
- approval acknowledges every required reason and dispositions customer-specific requests;
- render verifies the approved page and signed approval evidence;
- TTS writes to a fresh review root and records partial failure without mutating the approved base;
- narration approval binds exact decoded media bytes and all requested languages;
- deploy and send revalidate the approval chain;
- `send --provider console` does not send or claim delivery.

Current limitations:

- `deploy` runs `vercel deploy --prod` for each prepared output and records a parsed deployment URL (`scripts/lib/commands.mjs:1089-1158`);
- repeated customer deploys can replace routes or produce provider URLs that are not the durable customer contract;
- `send` supports only a redacted console preview (`scripts/lib/commands.mjs:1161-1206`);
- `status` reads local `job.json`, not the database (`scripts/lib/commands.mjs:1208-1243`);
- `announcement-job.schema.json` accepts any status and contains only a small subset of the real lifecycle;
- the Amal `job.json` contains local paths and customer email, so it is a useful local fixture but not a production persistence contract.

### Reference implementation and verified Amal fixture

`/Users/zacariachtatar/repos/happy` is the hand-built Bayane reference. It proves the visual/runtime model, bilingual routes, transcript-driven reveal, and per-section narration assets, but it is one Vite project with hard-coded customer content.

The verified Amal fixture in `data/examples/amal/` establishes the portable content contract:

- `intake.json`: request, identity, languages, voice preference, and demands;
- `page.json`: `pageId`, slug, language policy, template/renderer versions, revision, deterministic section order, identity, SEO, section copy, narration plan, review, and provenance;
- `approval.json`: exact page/revision/build and digest-bound approval;
- `job.json`: one logical job and prepared/live revision pointers.

The target architecture keeps those concepts while moving PII, lifecycle state, and storage paths into safer production records.

## Target topology and stable URLs

Use four deployment boundaries, with separate production and non-production projects/secrets:

1. **Landing** — `www.bebebonjour.fr`
   - Static marketing site.
   - CTA calls the fulfillment service's `/start` endpoint rather than opening a fixed payment link.

2. **Fulfillment and operator service** — `ops.bebebonjour.fr`
   - Tally, Stripe, and Resend webhook endpoints.
   - `/start`, Tally callback, and per-job Checkout creation.
   - Authenticated operator queue, private preview, approval, retry, refund-request, and status controls.
   - Short, idempotent stage workers invoked on enqueue and by a periodic recovery sweep.
   - Never hosts public baby pages from its project root.

3. **Public announcement router** — `annonces.bebebonjour.fr`
   - One application for every announcement.
   - Stable route: `https://annonces.bebebonjour.fr/a/<public-id>/<slug>/`.
   - `<public-id>` is at least 128 bits of random, non-sequential entropy. It prevents casual enumeration but is not authentication.
   - The route resolves `public-id` to one atomically published revision and streams only files listed in that revision's public manifest.
   - Versioned assets receive immutable cache headers. Entry HTML receives a short cache or revalidation so a pointer update or takedown is visible promptly.
   - Add `noindex, nofollow` by default and do not include announcements in a sitemap.

4. **Supabase**
   - Postgres stores authoritative state and immutable event/decision records.
   - A private Storage bucket holds intake snapshots, private previews, review evidence, narration attempts, unpublished bundles, and approved publication bundles.
   - The public router reads approved objects with a server-only, read-limited capability and applies public CDN caching only after the guarded publication lookup. Storage URLs are never customer-facing and the bucket is not publicly listable/readable.

Do not create a Vercel project per customer and do not use a Vercel deployment URL as the promised link. Publication is an object upload plus an atomic database pointer update after verification. A template fix creates a new revision; rollback changes the pointer to a previously approved immutable bundle.

## Intake and payment decision

### Recommended sequence

1. Landing calls `POST /start`.
2. The fulfillment service creates a random canonical `job_id`, random `public_id`, and short-lived signed `intake_token` with state `intake_pending`.
3. The service redirects to Tally with only the opaque token in a hidden field. Do not put baby name, email, or religious preference in a URL.
4. Tally posts a signed webhook. The service verifies its exact raw bytes, form ID, field map, token, allowed values, and schema; stores a canonical intake snapshot and digest; then moves the job to `awaiting_payment`.
5. The service creates or reuses one Stripe Checkout Session for that job. Set metadata both on the Session and under Checkout's `payment_intent_data.metadata` so the resulting Payment Intent independently carries:
   - `project=bebebonjour`
   - `product=essential_v1`
   - `environment=test|live`
   - `job_id=<uuid>`
   - `intake_digest=<sha256>`
6. The service sends the checkout URL through Resend. If Tally can safely pipe the opaque token to a custom thank-you redirect, that route may also resolve the same reusable Checkout Session; otherwise the thank-you page says that the secure link is arriving by email.
7. Stripe's signed webhook is authoritative for payment. It must match the existing job, metadata allowlist, configured Price ID, amount, currency, Stripe account, and environment before generation becomes eligible.
8. Repeated Tally, Checkout, or Stripe calls return the existing job/session/payment result. They do not create duplicate work.

### Why not the alternatives

- **Fixed Payment Link plus email matching:** reject. It cannot safely bind repeated submissions and does not satisfy explicit project/product correlation.
- **Tally's embedded Stripe block:** viable for a very fast launch and close to the current normalizer, but Tally does not support Stripe test cards in payment forms and the Payment Intent cannot be relied on to contain Bébé Bonjour's internal job metadata. Keep it only as a fallback plan requiring an operator-approved real-payment/refund smoke test.
- **First-party form immediately:** best long-term control, but unnecessary before validating demand. The intake JSON contract lets Tally be replaced later without changing downstream stages.

## Test and live payment separation

Use complete environment separation:

- separate Vercel production and non-production projects with separate webhook URLs; do not rely only on preview-environment variables inside one production project;
- separate Supabase projects for production and non-production;
- Stripe test keys, test Price ID, and test webhook secret only in non-production;
- Stripe live restricted key, live Price ID, and live webhook secret only in production;
- separate Tally form IDs and signing secrets where practical, or synthetic signed fixtures for automated tests;
- separate Resend API keys and sending behavior; non-production recipients must be allowlisted;
- `environment` and `stripe_livemode` are immutable database fields and must agree.

A webhook from the shared Stripe account is ignored or redacted as `out_of_scope` unless all explicit correlation fields match. Amount and email are consistency checks, not identity. Never accept an account-wide `payment_intent.succeeded` merely because it is EUR 39.

Required pre-live evidence:

1. Unit and database integration tests with synthetic PII.
2. Stripe CLI or Dashboard test-mode Checkout from start through verified webhook and one queued job.
3. Replay of every webhook with unchanged row and attempt counts.
4. Wrong project, product, job, Price ID, amount, currency, account, and livemode cases fail closed.
5. One separately authorized live smoke payment and refund only if the selected Tally/payment path cannot be exercised in test mode. This report does not authorize it.

## Persistent model

Keep `fulfillment_orders.id` as the canonical `job_id` to minimize migration. Treat “order” and “job” as one business aggregate in APIs. Add an immutable event log and normalized records rather than expanding one JSON column indefinitely.

### Existing tables to retain and evolve

- `webhook_events`
  - Add environment, endpoint version, normalized outcome, and correlation reason.
  - Keep only redacted facts and exact-byte digest.
- `stripe_payments`
  - Add Checkout Session ID, account ID, livemode, project, product, Price ID, job ID, status history, refund/dispute state, and provider timestamps.
- `fulfillment_orders`
  - Canonical `job_id`.
  - Add public ID, environment, product, state/version, intake digest, current revision ID, published revision ID, retention timestamps, and redacted terminal reason code.
  - Encrypt or isolate plaintext email and intake fields; do not duplicate them in event tables.
- `fulfillment_review_jobs`
  - Existing rows represent paid eligibility/generation cycles, not editorial decisions. Rename logically to generation cycles or add a compatibility view during migration.
- `fulfillment_generation_runs`
  - Preserve lease, bounded attempts, material digests, and order/run/manifest-bound artifact keys.

### New tables

- `fulfillment_revisions`
  - `(id, job_id, ordinal, input_digest, page_digest, transcript_digest, requirements, state, created_at)`.
  - Unique `(job_id, ordinal)`. A changed approved artifact always means a new revision.
- `artifact_sets`
  - `(id, job_id, revision_id, stage, manifest_digest, storage_prefix, byte_count, visibility, created_by_attempt_id)`.
  - Immutable after insertion.
- `review_decisions`
  - Exact policy and artifact binding described in the editorial section.
  - Immutable; a superseding decision links to, but never updates, the prior record.
- `stage_attempts`
  - `(id, job_id, revision_id, stage, attempt_number, lease_token, lease_expiry, status, reason_code, provider_request_id, usage, started_at, finished_at)`.
  - Unique idempotency key per logical stage/revision.
- `publications`
  - `(id, job_id, revision_id, artifact_set_id, stable_url, status, verified_at, published_at, retired_at)`.
- `delivery_attempts`
  - `(id, job_id, revision_id, publication_id, kind, idempotency_key, provider_message_id, status, accepted_at, delivered_at, failure_code)`.
- `job_events`
  - Append-only state transition audit with actor kind/id, command ID, prior/new state, reason code, and timestamp. No raw PII.

All mutating operations go through narrow transactional RPCs or equivalent server functions with optimistic state/version checks. Browser code never receives a Supabase secret/service-role key.

## Lifecycle and transitions

`job_state` is a validated projection. Payment, review, attempt, publication, and delivery rows remain the evidence. Only database functions may advance the projection.

| State | Entered when | Allowed next states and guard |
|---|---|---|
| `intake_pending` | `/start` issued an opaque job token | `awaiting_payment` after one valid signed Tally intake; `cancelled` after expiry |
| `awaiting_payment` | canonical intake and digest stored | `paid` after correlated Stripe success; `payment_failed`; `blocked` on mismatch; `cancelled` on expiry |
| `payment_failed` | Checkout/Payment Intent failed or expired | `awaiting_payment` with a new payment attempt; `cancelled` |
| `paid` | exact payment guard passed | `generation_queued` in the same transaction |
| `generation_queued` | one eligible generation attempt exists | `generating`; `retry_wait`; `blocked`; `cancelled` |
| `generating` | current lease claimed | `content_review_required` after a verified private manifest; `revision_required`; `retry_wait`; `failed` |
| `content_review_required` | private page/transcript preview ready | `tts_queued` after exact content approval when narration is required; `publish_ready` after approval when it is not; `revision_required`; `rejected` |
| `revision_required` | reviewer requests changes or generator needs bounded editorial input | `generation_queued` only for a new revision; `rejected`; `cancelled` |
| `tts_queued` | content approval is valid for the revision | `tts_generating`; `retry_wait`; `failed` |
| `tts_generating` | current TTS lease claimed | `narration_review_required` after every requested language succeeds and media validates; `retry_wait`; `failed` |
| `narration_review_required` | exact audio bytes and transcript timing are ready | `publish_ready` after exact narration approval; `revision_required`; `rejected` |
| `publish_ready` | all policy-required approvals exist for one exact public manifest | `publishing`; `revision_required`; `cancelled` |
| `publishing` | publication attempt leased | `published` only after upload, manifest verification, route resolution, and health check; `retry_wait`; `failed` |
| `published` | stable URL resolves the exact approved manifest | `delivery_queued`; `revision_required`; `retired` |
| `delivery_queued` | one idempotent delivery attempt exists | `sending`; `retry_wait`; `failed` |
| `sending` | Resend accepted attempt lease | `sent` on provider acceptance; `retry_wait`; `failed` |
| `sent` | provider accepted the message | `delivered` on provider delivery webhook; `delivery_failed` on bounce/rejection |
| `delivered` | exact approved publication was delivered | `revision_required` for post-delivery correction; `retired`; `refunded` as a separate payment outcome |
| `retry_wait` | retryable stage error with attempts remaining | resume the recorded prior stage after `available_at`; `failed`; `blocked` |
| `blocked` | configuration, correlation, privacy, or policy intervention is required | resume only through an operator command that records the reason and target state; `cancelled` |
| `failed` | bounded attempts exhausted or terminal technical error | operator-created new attempt/revision; `cancelled`; `refunded` |
| `rejected` | editorial policy rejects the requested content/job | `revision_required` only if the reviewer permits a corrected request; `cancelled`; `refunded` |
| `retired` | retention expiry or operator takedown | terminal, except auditable restoration from an approved retained bundle |
| `cancelled` | customer/operator cancellation before completion | terminal; payment refund state tracked separately |

`refunded` and `disputed` are payment outcomes, not proof that a public page was removed. A compensating workflow must also retire the publication and suppress pending delivery where policy requires it.

### Retry policy

- Webhook ingestion: provider replay plus permanent idempotency key; no application retry that invents a new event ID.
- Deterministic compose/render: two automatic attempts, then `failed` or `revision_required` by reason code.
- TTS: two automatic attempts only for transport/rate-limit failures. A new successful attempt has new audio bytes and requires review; never reuse an approval from another attempt.
- Publish and email: exponential backoff with bounded attempts and a stable idempotency key.
- Configuration, schema, signature, correlation, policy, and unsupported-name failures never retry automatically.
- Leases expire and can be reclaimed, but completion requires the exact current lease token, job state, input digest, revision, and material digests.

## Orchestration

Use the database queue pattern already implemented for generation across every side-effecting stage:

1. A transaction advances state and inserts one eligible `stage_attempt`.
2. A short worker claims one attempt with `FOR UPDATE SKIP LOCKED`, a lease token, and a bounded lease.
3. The worker performs one stage only.
4. Completion verifies current eligibility and exact digests before committing output/evidence.
5. A periodic recovery sweep requeues expired retryable leases and marks exhausted attempts failed.

Do not run compose, TTS, publish, and send as one request. Do not hold a database transaction while calling Stripe, OpenAI, Vercel, Storage, or Resend.

Recommended stage mapping:

- `compose_preview`: existing `prepare-review` core; private storage output.
- `record_content_decision`: authenticated operator command; no model call.
- `render_approved_base`: existing approved render core.
- `generate_narration`: existing `tts` core with pinned model snapshot and usage capture.
- `record_narration_decision`: authenticated operator command.
- `materialize_public_bundle`: exact approved page, transcript, runtime, static assets, and approved narration.
- `publish_bundle`: storage upload, read-back digest verification, atomic current-publication pointer.
- `send_delivery`: Resend with one idempotency key.
- `refresh_delivery_status`: signed Resend webhooks and reconciliation sweep.

An AI worker may compose drafts and flag problems. Under this policy it cannot approve its own output. Future agent approval requires a separately approved policy version, qualification evidence for Arabic/religious review, independent execution identity, and sampled human audit.

## Deterministic artifact contract

### Canonical bytes and identifiers

- JSON artifacts use UTF-8, normalized line endings, two-space indentation, stable property order defined by schema serialization, and one trailing newline. Hash exact stored bytes with SHA-256.
- `job_id` and `public_id` are random identifiers, never hashes of names or emails.
- Revisions are monotonic `r1`, `r2`, and so on within a job.
- Preserve the current Amal-compatible `pageId`, `pageRevision`, `templateFamily`, `templateVersion`, `rendererVersion`, `sectionOrder`, and `buildId` concepts.
- Slug is display-only and need not be globally unique because the random public ID is in the route.
- Page and transcript bytes are deterministic functions of canonical intake, selected catalog entry, template/renderer versions, and revision input.
- TTS bytes are not deterministic. They are immutable outputs identified by provider model snapshot, voice/instructions, attempt ID, media digest, and per-file digests.
- Timestamps and reviewer identities belong in evidence/decision artifacts, not in inputs used to claim deterministic page generation.

### Storage layout

```text
jobs/<job-id>/
  intake/v1/intake.json
  revisions/r1/
    source/page.json
    source/transcript.json
    private/<private-manifest-digest>/...
    reviews/content/<decision-id>.json
    narration/<attempt-id>/
      review.json
      ar/*.mp3
      fr/*.mp3
      manifest.json
    reviews/narration/<decision-id>.json
    public/<public-manifest-digest>/
      <slug>/page.json
      <slug>/transcript.json
      <slug>/ar/index.html
      <slug>/fr/index.html
      <slug>/_assets/<build-id>/...
      manifest.json
  snapshots/<event-sequence>/job.json
```

Every manifest records schema version, job/revision/stage, source digests, build/material versions, path, media type, byte count, SHA-256, visibility, and creation attempt. Paths are relative, normalized, and reject traversal or symbolic links. The manifest digest is computed from canonical manifest bytes and is bound to the job, revision, and generating attempt.

### Amal compatibility

For the verified Amal fixture:

- `req_amal_001` maps to the canonical intake source reference;
- `page_amal_f8c9e9a542747c15`, slug `amal`, revision `r1`, and build `blessed-arrival-1-0-0-r1` are the current deterministic fixture identifiers;
- section order and Arabic transcript derive from the same page content;
- the content approval continues to bind page, dossier, material, and prepared-bundle digests;
- a production job snapshot replaces local paths with artifact-set IDs/digests and removes customer email from the portable snapshot;
- the public `page.json` excludes customer email, internal source paths, private notes, reviewer email, and unneeded provenance.

`data/examples/amal/` remains a regression fixture. Production IDs and reviewer records must not use its example addresses.

## Editorial review policy

Policy version: `bebebonjour-editorial-v1`.

### Roles and separation

- The generator may draft and render.
- A content reviewer approves or requests changes for copy, identity, sources, language, and customer demands.
- A narration reviewer listens to every requested language and approves exact audio bytes.
- One human may hold both reviewer roles only if their record declares the required competencies; each decision remains separate.
- A reviewer must not approve by editing a digest or database state directly. Approval is an authenticated command that writes an immutable decision.

### Required content review

For every language and every revision, the reviewer must verify:

1. Baby name, Arabic spelling, Latin display, gendered grammar, languages, and reveal wording match the intake.
2. No unsupported transliteration or canonicalization silently replaces the customer's submitted display form.
3. Meaning/etymology claims are supported by the selected catalog evidence and are phrased no more strongly than that evidence permits.
4. Customer-specific demands are marked `applied`, `not_applied`, or `needs_clarification`, with a reason.
5. SEO and public metadata do not expose parent email, internal notes, or private evidence.
6. The complete private preview is readable on mobile and desktop, with correct RTL/LTR behavior and a complete no-audio experience.
7. Every generated warning and required reason is explicitly acknowledged or resolved.

### Religious-content rules

- Classify every item as Quran quotation, hadith, du'a, general blessing, name meaning, or interpretive association.
- Quran text must come byte-for-byte from an approved source catalog entry, with surah and ayah identifiers. The displayed translation must identify its approved translation source/version.
- Do not claim that a name occurs in scripture when only a root, derivative, homograph, or interpretive concept occurs. State the narrower relationship explicitly or omit it.
- Do not generate hadith quotations in V1 unless the exact Arabic, collection, numbering, grading, and approved translation are present in the curated catalog and reviewed. The safer default is no hadith.
- Du'a must be labeled as du'a rather than scripture unless it is an exact sourced quotation.
- Never promise divine outcomes, imply religious authority, or present interpretation as consensus.
- For non-scriptural, original, unsupported, or ambiguous names, use neutral celebration and customer-confirmed spelling. Do not invent an Arabic form, etymology, or religious association.
- If the customer's context is general/nonreligious, religious material is excluded even if the name has a scriptural association.

### Arabic rules

The Arabic-competent reviewer checks:

- submitted spelling and intended pronunciation;
- hamza/alif/ya/ta marbuta and optional diacritics;
- gender, agreement, case, pronouns, and idiomatic register;
- punctuation, line breaks, Unicode directionality, and mixed-script rendering;
- exact Quran orthography when quoted;
- consistency between display lines and narration text;
- TTS pronunciation, pacing, pauses, clipping, substitutions, and skipped words.

A Latin/Arabic conflict, ambiguous alias, or uncertain pronunciation requires clarification or revision. The system must not choose one silently.

### Narration review

After content approval and TTS generation, the reviewer must listen to every segment in every requested language and compare it with the exact approved transcript. Approval acknowledges all languages and binds:

- content approval digest;
- base prepared-bundle digest;
- narration review digest;
- aggregate media digest;
- every file digest/duration;
- final prepared-bundle digest;
- provider model snapshot, voice, and instructions.

Any regenerated segment invalidates the narration decision for the entire affected language. Any transcript/content change creates a new page revision and invalidates both content and narration approvals.

### Decision records

Every decision records:

- decision ID, job ID, revision ID, and decision type;
- `approve`, `request_changes`, `reject`, or `abstain`;
- reviewer account ID and immutable display identifier;
- reviewer role and declared competencies (`fr`, `ar`, `religious_sources`, `narration`);
- policy/rubric versions;
- intake, page, transcript, material, private/public manifest, content approval, and media digests as applicable;
- required and acknowledged reason codes;
- source catalog keys and citation disposition;
- customer-demand disposition;
- language acknowledgements;
- structured reason codes and bounded comments;
- decision timestamp, authentication method, and server signature/HMAC;
- superseded decision ID when applicable.

Do not use a free-text reviewer email as the sole identity. Reviewer comments must not repeat unnecessary PII.

### Rejection and revision behavior

- `request_changes` freezes the reviewed revision and creates `rN+1`; it never edits approved/reviewed bytes in place.
- The reviewer specifies reason codes and whether customer clarification is required.
- `reject` closes the revision and blocks publication. A job-level rejection records whether a corrected request is permitted.
- Previous decisions remain immutable audit evidence but cannot authorize a new revision.
- Payment refund is a separate operator/policy action. Rejection does not silently mark payment refunded, and refund does not silently claim publication removal.

### Non-bypassable completion invariant

The database publication function must reject unless all of these are true in one transaction:

1. payment is succeeded, correlated, in the same environment, and not disputed/refunded;
2. the candidate revision is current;
3. an `approve` content decision matches the exact page, transcript, material, and private-review digests;
4. if narration is required, an `approve` narration decision matches the exact content approval and media/public-bundle digests for every requested language;
5. the candidate public manifest was read back and verified;
6. no later `request_changes`, `reject`, cancellation, privacy takedown, or payment regression exists.

The delivery function must additionally require a verified `published` record for that exact revision and stable URL. `sent` means Resend accepted the message; `delivered` means a signed provider webhook confirmed delivery. `complete` is a derived label allowed only when the exact approved revision is published and delivery reached the configured terminal success state. UI buttons, CLI flags, service-role access, or manual row edits are not valid substitutes.

## Publish, send, and status operations

### Publish

Replace per-customer `vercel deploy --prod` with:

1. materialize public bundle in a fresh local/temp root;
2. validate schemas, links, no secret/private fields, audio decode/durations, and manifest;
3. upload under immutable manifest-digest prefix;
4. read back each object and verify byte digest/count;
5. resolve the candidate URL privately and run HTML/asset health checks;
6. call the guarded publication RPC to set the current revision pointer;
7. verify the stable public URL resolves the same manifest before recording `published`.

### Send

Use Resend with a verified sending subdomain such as `updates.bebebonjour.fr`. Keep the customer-facing sender stable. Email subject should avoid the baby's name by default. The body contains the stable custom-domain URL, support/takedown instructions, and the announced retention period.

Use `job_id:revision_id:delivery` as the application idempotency key. Store provider message ID and redacted event evidence. Never log recipient address, URL token, baby details, or provider payload. Bounce/complaint events suppress automatic resend and require operator review.

### Status

Make database status authoritative. `announce status --job-id <uuid>` and the operator UI should show:

- current state/version and last transition time;
- payment correlation/status without card data;
- current revision and exact stage attempt;
- content/narration approval presence and policy version;
- retry count, next retry time, and bounded reason code;
- publication revision, verification, and stable URL presence without printing it in shared logs;
- delivery accepted/delivered/failed state;
- retention and takedown timestamps.

Keep portable `job.json` as a generated redacted snapshot for debugging and disaster recovery, never as the write authority.

## Credentials and access

Server-only production credentials:

- Tally webhook signing secret;
- Stripe restricted secret key, webhook secret, account/Price allowlists;
- Supabase backend secret/service key for ingress/publish APIs;
- a separately issued least-privilege generation-worker database credential;
- OpenAI API key restricted to the project where supported;
- approval HMAC/signing key;
- Resend restricted/domain-scoped API key and webhook secret;
- Vercel project/org identifiers and deployment credentials only where runtime deployment actually remains necessary.

Rules:

- separate test and live credentials;
- separate ingress, worker, review, and publication capabilities;
- no service-role or approval key in browser code or the generation worker;
- least-privilege Vercel project membership and MFA;
- rotate on exposure and record credential version, never secret value;
- environment changes apply through reviewed deployment, not runtime database edits;
- never persist raw provider responses when identifiers, status, usage, and digests suffice.

## Privacy and retention

Treat parent email, baby identity, voice, free-text demands, and inferred religious preference as sensitive. A public unlisted URL is still public processing.

Recommended launch retention:

- incomplete/abandoned intake: delete plaintext PII after 30 days;
- blocked/failed jobs: delete plaintext PII and private artifacts after 30 days unless an active support/refund case requires a documented extension;
- delivered job: remove parent email and full intake from operational generation access after 30 days, retaining only the minimum delivery/support link under stricter access;
- private previews and rejected attempts: delete after 30 days;
- public approved bundle: retain for the customer-promised 365 days after delivery, then retire and delete unless the customer renews or requests earlier deletion;
- redacted event, digest, cost, and review audit: retain for 365 days, then aggregate or delete;
- payment/tax records: rely on Stripe and retain only what legal/accounting advice requires.

Before launch, state the public-page duration, deletion process, processors, and noindex limitation in the customer notice. Obtain intentional consent to publish the baby's submitted identity. Provide an authenticated takedown path. Tally Free requires manual deletion discipline; use Tally Business only if automatic provider-side retention controls justify its price.

## Cost envelope

Public prices reviewed on 2026-08-06 are detailed in `openspec/reports/2026-08-06-provider-cost-operational-facts.md`.

Recommended low-volume production baseline:

- Supabase Pro: $25/month to avoid paused production database behavior and obtain paid allowances.
- Vercel Pro: $20/month because a revenue-generating site is commercial; included usage/credit applies before overage.
- Tally Free: $0/month at launch; Pro is optional for custom domain/branding, Business for automatic retention controls.
- Resend Free: $0/month within 3,000 emails/month and 100/day; move to Pro only when limits or support require it.
- Stripe: no fixed standard fee; standard EEA card pricing was 1.5% + €0.25. On a €39 charge this is approximately €0.84, leaving €38.16 before VAT, refunds, disputes, hosting, TTS, and labor.
- OpenAI `gpt-4o-mini-tts`: $0.60 per million input text tokens and $12 per million output audio tokens. Record real usage per job because length and retries vary.
- Domain, taxes, refund/dispute costs, backup exports, monitoring, and reviewer labor are additional.

The fixed dependable baseline is about $45/month plus usage. A temporary cheaper pre-live setup may use Supabase Free, but inactivity pauses and backup limitations make it a poor paid-order source of truth. Editorial review time is likely a larger per-order cost than infrastructure and must be measured.

Record per job: Stripe fee/refund/dispute, OpenAI usage/cost, storage bytes, function duration, email count, review minutes, revision count, and gross/net contribution. Do not put customer identity in cost analytics.

## Alternatives and migration impact

### Provider alternatives

- **Custom Next.js form instead of Tally:** removes a processor and supports direct checkout creation, but adds validation, accessibility, spam, analytics, and UX work. Migrate later behind the same intake schema.
- **Tally embedded payment:** least code change, but weaker test-mode and metadata control. Accept only as a time-boxed launch fallback.
- **Trigger.dev/Inngest or a container queue:** stronger long-running orchestration and observability, but adds cost and another trust boundary. The existing Postgres lease model is sufficient at expected launch volume.
- **Vercel Blob/S3 instead of Supabase Storage:** valid if routing/CDN behavior is materially better. Supabase Storage minimizes vendors and keeps authorization close to Postgres.
- **One aggregate static Vercel deploy:** simpler serving but every publication rebuilds all pages, risks replacing routes, grows with retention, and complicates rollback. Reject.
- **One Vercel project per customer:** operationally expensive and produces unstable/provider-owned URLs. Reject.
- **SMTP directly:** cheaper in isolation but weaker deliverability/telemetry and more operations. Resend is the recommended launch provider.

### Migration sequence

No step below is authorized merely because it is documented.

1. Approve this architecture, URL names, one-year public retention promise, and editorial policy.
2. Add schema v2 for canonical job/revision/artifact/decision/attempt/publication/delivery records; write and test a compensating forward migration.
3. Preserve current tables and IDs. Backfill existing synthetic rows only; do not copy live customer data into development.
4. Change Tally ingestion from “paid submission required” to intake-only token binding while retaining the old v1 endpoint during a bounded transition.
5. Add `/start`, Checkout Session creation, explicit Stripe metadata/Price allowlists, and test/live segregation.
6. Add artifact Storage adapters and persist private generation manifests from the existing leased generation worker.
7. Add authenticated content and narration decision APIs that reuse current digest/signature verification.
8. Replace CLI deploy with upload/read-back/publish-pointer logic and implement the shared public router.
9. Add Resend send/webhook reconciliation and database-backed status.
10. Add retention/takedown jobs and operator dashboards for blocked, retry, review, and delivery queues.
11. Run synthetic end-to-end tests, security review, accessibility/browser checks, and approved staging tests.
12. Update landing CTAs and copy; remove the fixed Stripe Payment Link only when the per-job checkout path is verified.
13. With separate authorization, apply production migrations, deploy isolated projects, configure providers, and run the controlled go-live checklist.
14. Disable any prior Zapier/Notion or v1 webhook path only after duplicate/replay and rollback evidence is accepted.

## Approval checklist

The operator should explicitly decide:

- [ ] Tally intake-only plus per-job Stripe Checkout is approved.
- [ ] `annonces.bebebonjour.fr/a/<public-id>/<slug>/` is the stable URL contract, or replacement names are supplied.
- [ ] Supabase Postgres/Storage, Vercel Pro, and Resend are approved launch providers.
- [ ] The $45/month fixed baseline plus usage is acceptable when accepting paid orders.
- [ ] The 30-day private/PII and 365-day public retention policy is acceptable and will be reflected in customer copy.
- [ ] `bebebonjour-editorial-v1` is approved, including human-only approval at launch and the no-hadith-by-default rule.
- [ ] Content and narration approvals are separate and both bind exact bytes.
- [ ] Database-enforced no-publish/no-deliver-before-approval invariants are mandatory.
- [ ] A future agent reviewer requires a separate approval/evaluation change.

## Recommendation

Approve the target architecture before taking live orders. The current generator and database ingress already contain most of the difficult integrity primitives. The unsafe seam is the product flow around them: a fixed Payment Link, incomplete persistent lifecycle, per-output Vercel deployment, and no durable email/status records. Resolve that seam by making the existing order UUID the canonical job, issuing per-job Checkout Sessions with explicit project/product metadata, persisting immutable revision/review artifacts, and serving one storage-backed public application with a stable URL.
