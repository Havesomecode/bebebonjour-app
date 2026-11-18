# TEST-A production release blocker — corrected candidate ceb41cdc

- Task: `t_3f375e12`
- Attempt window: `2026-08-23T00:22:31Z`–`2026-08-23T00:41:24Z`
- Outcome: **BLOCKED and configuration-rolled back before any synthetic intake, payment, approval, publication, or email**

## Authorized immutable candidates

- App commit: `ceb41cdc98a28db8fff0b674f909457a33b63282`
- App tree: `b2855bf9578d306724f99e49030fcf714a8eb6f1`
- Landing commit: `1fcf3af4925151f0598db05cf28022db8de0b69f`
- Landing tree: `66e68e5c638f34856388a7995adc68960703c235`
- Both commits passed `git verify-commit` with a good signature from `Zacaria Chtatar <havesomecode@gmail.com>`.
- The exact app commit was pushed at `2026-08-23T00:22:31Z` to non-main branch `b-b-bonjour-autonomous-generation/t_3f375e12-b-b-bonjour-release-execute-controlled-r`; `git ls-remote` read-back returned exactly `ceb41cdc98a28db8fff0b674f909457a33b63282`.
- The exact landing commit was already present on `origin` at non-main branch `b-b-bonjour-autonomous-generation/t_9bd37a71-landing-canonical-origin`; no redundant landing push was performed.
- Deployment inputs were materialized with `git archive` from those exact commits. Vercel deployment metadata was supplied with the exact candidate commit and tree.

## Fresh local gates

App, exact commit `ceb41cdc…`:

- `npm test` — PASS: 201 tests, 198 passed, 3 skipped, 0 failed.
- `npm run build` — PASS.
- `npm audit --omit=dev` — PASS: 0 vulnerabilities.
- `git diff --check` — PASS.
- Final tracked state remained unchanged; only `.release-runtime/` is untracked operational evidence.

Landing, exact commit `1fcf3af4…`:

- `npm test` — PASS: 19 tests, 19 passed, 0 skipped, 0 failed.
- `VITE_FULFILLMENT_API_BASE_URL=https://bebebonjour-fulfillment.vercel.app/api/customer-flow npm run build` — PASS.
- `npm audit --omit=dev` — PASS: 0 vulnerabilities.
- `git diff --check` — PASS; worktree clean.

Non-blocking warnings: Node reported the repository's existing experimental SQLite warning in the app suite. The approved landing uses an SPA fallback, so an unknown landing path serves `index.html` with HTTP 200 rather than a transport-level 404; API 404 behavior was probed separately.

## Provider mutations and verified intermediate boundaries

- Convex project/deployment: `havesomecode/bebebonjour-test-a` / `brilliant-hawk-751` (`https://brilliant-hawk-751.convex.cloud`). Exact candidate functions deployed; deployment URL returned HTTP 200.
- Vercel API project: `prj_XJrkufo77hXAdvMuYjPn6F6AVZjn` (`bebebonjour-fulfillment`). Latest exact-candidate deployment: `dpl_DQBLWA6v1SDHifPd5QBiQa2nVtWE`, `https://bebebonjour-fulfillment-15d1pj2tp-zacaria-chtatars-projects.vercel.app`, Ready.
- API health succeeded while the exact candidate owned the canonical alias: `{ok:true,boundary:"TEST-A",persistence:"convex-hosted",payment:"stripe-test-mode",delivery:"operator-gated-resend-test"}`.
- Vercel landing project: `prj_MJTHJrEVehZIRHuQBiZ1CgAG7MuB`. Latest exact-candidate deployment: `dpl_HHMEwZcoasXArKais9fikcAVc9Mr`, `https://bebebonjour-landing-3nbirsdco-zacaria-chtatars-projects.vercel.app`, Ready.
- Canonical landing checks while active: `/` HTTP 200; `/suivi` HTTP 200; approved SPA fallback path HTTP 200.
- Stripe test account: `acct_1MKd4KGrir6mz3o7`. One endpoint was created: `we_1U7PFgGrir6mz3o7BJGzWJ66`, `livemode=false`, one event `checkout.session.completed`, canonical URL `https://bebebonjour-fulfillment.vercel.app/api/customer-flow/webhooks/stripe`.
- No live-mode key, live payment, real customer data, customer address, canonical announcement URL, Resend key, or Resend email was used.

## Reproduced production blocker

With the exact corrected app candidate Ready and assigned to the canonical API alias:

- `GET https://bebebonjour-fulfillment.vercel.app/api/customer-flow/health` returned HTTP 200 from the Hono handler.
- `GET https://bebebonjour-fulfillment.vercel.app/api/customer-flow/__unknown__` returned the application's canonical JSON 404.
- `POST https://bebebonjour-fulfillment.vercel.app/api/customer-flow/v1/intakes` returned Vercel's platform-level HTTP 404 (`The page could not be found`, request id `cdg1::snpjg-1787445322718-727a607dbc97`) before the application could authenticate or process the synthetic request.

This proves the corrected Node response/raw-body adapter fixed the prior timeout, but the deployed Vercel filesystem route still does not match the critical nested `v1/intakes` path. The local regression exercises one-segment `health` and `webhooks/stripe` paths only, so all 201 local tests remained green while the production intake journey was unreachable.

Because intake failed before durable creation, the following required gates did not run and are **not claimed**: Stripe Checkout creation/completion, real provider delivery log, duplicate replay, one-job/one-event durable assertions, private review generation, persisted approval, publication, Resend test-sink email, message reconciliation, or customer journey completion.

## Configuration-only rollback and read-back verification

Rollback completed at `2026-08-23T00:38:45Z` while preserving deployments, the disabled Stripe endpoint, and provider receipts:

- Restored all API aliases to prior Ready deployment `dpl_AbvoqhckzzS79f3QyN4sCYujG4MJ` (`bebebonjour-fulfillment-aca39xhj3-zacaria-chtatars-projects.vercel.app`).
- Restored all landing/custom-domain aliases to prior Ready deployment `dpl_HrPfUiAnCarEfEKkiktvhWF7Kkwn` (`bebebonjour-landing-bu9ecg2aj-zacaria-chtatars-projects.vercel.app`).
- Disabled Stripe endpoint `we_1U7PFgGrir6mz3o7BJGzWJ66`; exact read-back reports `status=disabled`, `livemode=false`, one allowed event, and the canonical URL.
- Removed all nine TEST-A variables from the Vercel API production scope; read-back inventory is empty.
- Removed `VITE_FULFILLMENT_API_BASE_URL` from the landing production scope; read-back inventory is empty.
- Removed `CUSTOMER_FLOW_BACKEND_TOKEN` from Convex preview deployment `brilliant-hawk-751`; read-back inventory is empty.
- Restored the Vercel API project's output-directory setting to automatic (`public` if present, otherwise `.`).
- Deleted temporary Convex deploy keys through `finally` cleanup.
- Revoked one Vercel automation-bypass token; subsequent inventory found zero.
- Canonical landing read-back after rollback: `/`, `/demo`, and `/suivi` each returned HTTP 200.
- `https://baby-announce-bayane.vercel.app` still resolved through HTTPS and returned HTTP 404; no mutation targeted that deployment. Exact sage-femme/adversarial URLs were not available in the executable manifest, so those HTTP boundaries remain unverified; no mutation targeted their project.

## Evidence artifacts

- Redacted provider receipt: `.release-runtime/provider-proof-ceb41cdc.json`
  - SHA-256: `851f61f342efe5f86a8096329fee94eed41487337e7b24c55b80aabde39be2d3`
- Final app TAP log: `.release-runtime/app-test-final.tap`
  - SHA-256: `be52c10f1b17371d00795f54a09b08a58573c337f0bdb2c939ea0b265d6be91e`
- No secret value, access token, intake token, payload, or customer PII is included in this report or the provider receipt.

## Exact remediation and release decision required

1. Replace or configure the Vercel API filesystem route so the exact nested customer command paths—at minimum `POST /api/customer-flow/v1/intakes`, `POST /api/customer-flow/v1/jobs/:id/checkout`, and `GET /api/customer-flow/v1/jobs/:id/status`—reach the Hono handler on an immutable deployment.
2. Add an executable deployed-adapter regression that exercises a nested `v1/intakes` request and fails if Vercel returns its platform 404. A one-segment health check is insufficient.
3. Run the full app gates and obtain independent PASS review for the new exact commit/tree.
4. Obtain new explicit release authorization bound to that replacement SHA/tree. The current authorization must not be extended to changed bytes.
5. Rerun the bounded provider release from an empty env inventory and the retained disabled endpoint decision. Decide explicitly whether to reuse/rotate or replace `we_1U7PFgGrir6mz3o7BJGzWJ66`; its signing secret is no longer present in runtime configuration.
