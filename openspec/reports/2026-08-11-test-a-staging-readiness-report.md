# TEST-A staging readiness report

- Validation date: 2026-08-11 15:30 CEST
- Kanban validation: `t_3ddcadd6`
- Scope: local-only TEST-A verification across `bebebonjour-app` and `bebebonjour-landing`
- Remote side effects: none; no hosted deployment, live payment, live email, DNS, publication, or production action was attempted
- Verdict: **GO for local TEST-A staging readiness.** The stale checked-in Amal approval fixture was regenerated through the authenticated review workflow, its exact prepared projection now reproduces, and the focused TEST-A plus full application suites pass. Hosted deployment, live payment, live email, DNS, publication, production data, and release remain separately gated.

## Candidate boundary

This validation ran against existing shared dirty worktrees and did not reset or discard any prior worker or user changes.

| Repository | Branch | HEAD | Git index tree |
| --- | --- | --- | --- |
| `bebebonjour-app` | `main` | `b532ab7012d3c9dd36ffd8ccfb190a7a2bf6389b` | `3e572a5cbef5445a2472ad0ba13a4d5c95bda92e` |
| `bebebonjour-landing` | `feat/tally-stripe-flow` | `feda566e46c884e5b1814a737cffc99a8c449031` | `0e73d64188fb72cc9c333a1fa990932974a55079` |

The relevant implementation and tests remain uncommitted. A later acceptance gate must bind any approval to exact reviewed bytes rather than only these HEADs or index trees.

## TEST-A end-to-end evidence

### Persisted synthetic happy path

Command:

`node --test --test-reporter=spec test/integration/fulfillment-workflow-tracer.test.mjs`

Result: **PASS** — 1 test, 1 pass, 0 fail, 0 skip, 1127 ms.

The tracer exercised one synthetic Amal order through the canonical local intake and fulfillment path, including correlated payment authority, generation, persisted review decisions, mocked TTS, exact approval bindings, publication dry-run, delivery dry-run, provider-status reconciliation, and confirmed delivery. The final job was reconstructed from the persisted local store rather than trusted from transient in-memory state.

### Deterministic persisted artifact

Command:

`node --test --test-reporter=spec --test-name-pattern='the local TEST-A job artifact is byte-deterministic for fixed inputs and dependencies' test/fulfillment/job-orchestration.test.mjs`

Result: **PASS** — 1 test, 1 pass, 0 fail, 0 skip.

Two independently created fixed-input jobs produced byte-identical durable JSON artifacts.

### Negative release-gate probes

Focused command selected the following seven release-critical tests from `test/fulfillment/job-orchestration.test.mjs`.

Result: **PASS** — 7 tests, 7 pass, 0 fail, 0 skip.

Verified failures and reconciliation boundaries:

- payment, review, publication, and delivery bindings fail closed;
- narration requires exact content and audio approvals before publication or delivery;
- command IDs cannot be replayed across operations or rebound to different payloads;
- ambiguous publication recovers without a duplicate external effect;
- ambiguous delivery acceptance is reconciled before retrying send;
- caller-asserted delivery completion is rejected without a trusted verifier;
- provider reconciliation completes only the exact delivered provider message.

Additional customer-boundary probe:

`node --test --test-reporter=spec test/customer-flow/customer-flow.test.mjs test/customer-flow/http-api.test.mjs`

Result: **PASS** — 9 tests, 9 pass, 0 fail, 0 skip. This covers one canonical lifecycle, idempotent intake/payment, opaque customer status credentials, approved-origin and bounded-body enforcement, and stable redacted errors.

## Generator and CLI regressions

### Passing command paths

- `compose` executed twice for Bayane with the same fixed input and candidate selection. Outputs were byte-identical: SHA-256 `846edb6a123210311a2f46fc5a86e26f6b9c282f766a2e74a6ad288a2b3f0cca`.
- A fresh Amal command chain using `prepare-review`, `approve-review`, `render`, `status`, `deploy --dry-run`, and `send --provider console --dry-run` completed under synthetic TEST-A approval material.
- The rendered job reported `status: rendered`, revision `r1`, no live revision, no public URL, and pending email before dry-run actions.
- `deploy --dry-run` returned `deploy_ready` without publishing.
- `send --dry-run` returned only a redacted delivery preview with `publicUrlConfigured: false`; it did not send.
- The persisted tracer above covers the remaining TTS, approval, publication, delivery, and status-reconciliation path with local/mock adapters.

### Resolved Amal fixture regression

The stale checked-in fixture initially reproduced the reported fail-closed error:

`Rendered deploy bundle does not match the approved prepared projection.`

`data/examples/amal/page.json` and `data/examples/amal/approval.json` were then regenerated using `prepare-review` with the deterministic `general-amal` selection and `approve-review` with the repository's explicitly synthetic test approval material. The review recorded the synthetic demand `Arabic-only and gentle.` as applied. The checked-in `job.json` identity and reviewer metadata were synchronized to those generated artifacts. No digest, signature, or prepared-projection check was bypassed or weakened.

Regenerated fixture bindings:

- page ID: `page_amal_f8c9e9a542747c15`;
- approved page SHA-256: `76ec5ed5ab81227365f79da8383eff23d9c9fa4e07d7f44607122fd288b0fa95`;
- prepared bundle SHA-256: `55fcbdcb9b65e18b80b58449d0352bc9f7b71224e7effcc42b9c305025e3d3ba`;
- approval artifact SHA-256: `7f326444e2cd323169a05b477709a36b9738c2ec7f149d40468fd0c21141a4de`.

Post-remediation results:

- the direct render into a fresh operating-system temporary directory: **PASS**;
- `npm run render:amal` from a clean ignored `out/amal` output root: **PASS**;
- new regression `checked-in Amal approval fixture reproduces its approved projection`: **PASS**;
- exact HMAC signature, page digest, material digest, dossier digest, and prepared-bundle digest enforcement remain active.

An initial convenience-script retry against an old ignored `out/amal` tree still contained obsolete `blessed-arrival-100-r1` assets and correctly failed the exact directory digest. Removing that local generated output and rerendering from a clean output root passed; no tracked artifact or approval check was removed to accommodate stale deploy bytes.

## Repository regression matrix

### `bebebonjour-app`

- `npm test`: **PASS after fixture regeneration** — 158 tests, 155 pass, 0 fail, 3 skip, 6.49 s.
- Skipped tests are the three opt-in provider/database integration cases:
  - same-transaction eligibility cycles use a monotonic per-order ordinal;
  - provider ordering and retries create one review job and generation run per valid order;
  - a synthetic paid order reaches `review_required` through both webhook handlers.
- They were not forced with `RUN_DB_TESTS=1` because TEST-A forbids unapproved remote/provider side effects and no isolated local database target was established for this card.
- `npm run build`: **PASS**.
- `npm audit`: **PASS**, 0 vulnerabilities.
- `npm audit --omit=dev`: **PASS**, 0 vulnerabilities.
- `git diff --check`: **PASS**.

Fresh pre-push verification at `2026-08-11 22:19 CEST` additionally ran
`npm run test:integration` against the harness-managed ephemeral local
PostgreSQL 16 container: **PASS** — 160 tests, 160 pass, 0 fail, 0 skip. This
supersedes the deferred-database-evidence risk for the tested local bytes only;
it does not authorize or provide evidence for a hosted database, provider
account, customer data, deployment, publication, payment, or delivery.

The pre-push hardening review also required two fail-closed controls now covered
by regression tests: review decisions cannot mutate lifecycle state without an
injected trusted verifier, and artifact collection validates every generated
stage and manifest path before any manifest write or cleanup mutation.

Resolved direct versions:

- `@hono/node-server` 2.1.0
- `@supabase/supabase-js` 2.111.0
- `ajv` 8.20.0
- `convex` 1.43.0
- `hono` 4.13.1
- `stripe` 22.4.0

`npm outdated` reports newer patch releases for Supabase (`2.112.3`) and Stripe (`22.5.0`). They are not audit findings and should be upgraded only through a separate tested dependency change.

### `bebebonjour-landing`

- `npm test`: **PASS** — 6 tests, 6 pass, 0 fail, 0 skip.
- `npm run build`: **PASS** with Vite 6.4.3; 5 modules transformed.
- Production output: HTML 11.25 kB, CSS 11.68 kB, JS 7.69 kB before gzip.
- Local preview smoke: **PASS** — HTML, CSS, and JS all returned HTTP 200; the first-party `intake-form` was present; no `buy.stripe.com` or `tally.so` URL was present.
- `npm audit`: **PASS**, 0 vulnerabilities.
- `npm audit --omit=dev`: **PASS**, 0 vulnerabilities.
- `git diff --check`: **PASS**.

Exact resolved toolchain:

- Vite 6.4.3
- esbuild 0.25.12
- PostCSS 8.5.26

Registry checks confirmed that 6.4.3 is the latest Vite 6 release, 0.25.12 is the latest esbuild 0.25 release, and 8.5.26 is the latest PostCSS 8 release. `npm outdated` reports Vite 8.2.1 as the latest major, but the approved architecture deliberately constrains this candidate to narrow Vite 6; no unreviewed major upgrade was performed.

### Runtime

- Node.js: 22.23.2
- npm: 10.9.8

## Unresolved risks and required next actions

1. **Acceptance-boundary risk — shared dirty worktrees.** The candidate spans many modified and untracked paths in both repositories. Final acceptance must capture an exact path allowlist and hashes after all writers stop; current HEAD and index tree alone do not identify the tested bytes.
2. **Hosted provider/database evidence remains deferred.** The three opt-in database integration tests now pass against the harness-managed ephemeral local PostgreSQL 16 container. No test targeted a hosted database or provider account, so hosted integration evidence remains separately gated.
3. **No real-provider evidence.** TTS, deployment, email, payment, DNS, and hosted persistence were mocked, dry-run, or untouched as required by TEST-A. This report gives no authorization for those actions.
4. **Operational policies remain provisional.** The 30-day private/PII cleanup period, 365-day public-bundle availability, and future agent-review boundaries remain policy decisions rather than verified production controls.
5. **Patch updates available.** Supabase and Stripe have later patch releases. Current versions are audit-clean, but the updates should be evaluated separately with full regression evidence.

## Explicitly gated actions

This report does **not** authorize:

- hosted or production deployment;
- live Stripe checkout, webhook, refund, or payment activity;
- live TTS/provider API calls or spend;
- live email or family delivery;
- DNS or domain changes;
- publication of a baby announcement or private review artifact;
- use of real customer, family, or baby PII;
- commit, push, merge, or release;
- weakening, bypassing, or reusing stale editorial/narration approval evidence.

Only synthetic local TEST-A validation and dry-run/mock effects were exercised.
