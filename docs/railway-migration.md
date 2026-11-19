# Moving the Bébé Bonjour backend from Convex to Railway

Status: staging. Convex prod (`tacit-antelope-577`) stays the production backend
until the cutover card switches it. This document covers the inventory, the target
design and the staging run. The cutover and rollback plan is added by the cutover card.

## 1. What production uses today

Production runs only the **delivery loop** (first-party `/delivery` form, operator
gate, paid Route A at 39 €, generation, publication, mail). The older lines in
`convex/` (customerFlow, fulfillment, generation, narration, ownerTrial*,
privateGeneration*, canonicalCompletion*, Tally intake) are not in the live path
and are not ported.

### Tables (all in `convex/schema.js`)

| Table | Indexes used | Written by |
|---|---|---|
| `deliveryLoopJobs` | `by_job_id`, `by_idempotency_key`, `by_status`, `by_public_token`; plain `order("desc")`, `paginate` | every delivery-loop mutation; the whole order lives in `data` (≤ 850 KB) |
| `deliveryLoopIntakeThrottle` | `by_bucket_key` | `submit` |
| `deliveryLoopPaymentEvidence` | `by_payment_id`, `by_promotion_policy` (`promotion.policyId`) | payment evidence commit |
| `deliveryLoopPaymentEvents` | `by_identity`, `by_fingerprint` | Stripe webhook receipts |
| `deliveryLoopRetainedEvidence` | `by_job_id` | data deletion / retention |
| `customerFlowOperationsLoginThrottle` | via `operations:consumeLoginAttempt` / `resetLoginThrottle` | ops console login throttle |

### Functions called from outside

| Caller | Functions |
|---|---|
| Generation worker (`scripts/run-delivery-loop-worker.mjs`, this host, Codex subscription) | `deliveryLoop:claim`, `read`, `publish`, `fail`; actions `deliveryLoopProviders:narrate`, `sendEmail` |
| Ops console (`bebebonjour-ops`, `src/server/delivery-jobs.mjs`, `login-throttle-client.mjs`) | `deliveryLoop:operatorJobs`, `operatorJob`, `operatorLaunch`, `operatorRefuse`; `operations:consumeLoginAttempt`, `resetLoginThrottle` |
| Browser via HTTP routes | see below |

All of them talk the Convex HTTP protocol (`ConvexHttpClient`: `POST /api/query`,
`/api/mutation`, `/api/action`).

### HTTP routes (`convex/http.js`, delivery-loop subset)

`GET /delivery`, `POST /delivery/intake`, `POST /delivery/checkout`,
`GET|POST /delivery/review`, `GET|POST /delivery/operator`,
`POST /delivery/data`, `GET /delivery/export`, `GET|POST /delivery/data/operator`,
`GET /delivery/terms/route-a-39-v2`, `POST /delivery/payment/webhook` (Stripe),
`GET /announcements/<token>` and `/announcements/<token>/audio/<rev>/<lang>`.

The landing (`bebebonjour-landing/vercel.json`) rewrites `/delivery`, `/delivery/*`
and `/announcements/*` to `https://tacit-antelope-577.convex.site`.

### Scheduled work

- `ctx.scheduler.runAfter(0, …)`: `deliveryLoopNotices:send` (operator and payment
  notices, sent once, never retried), `deliveryLoopDataProviders:sendClosureNotice`,
  `deliveryLoopData:sweep` continuation.
- Cron: `deliveryLoopData:sweep` hourly (no-op unless
  `BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED=true`).

### File storage (`ctx.storage`)

Narration MP3s only: `storage.store` in `deliveryLoopProviders:narrate`,
`storage.get` for `/announcements/…/audio/…` and `/delivery/export`,
`storage.delete` on erase/purge, `db.system.get` for size/content type.
Upload URLs are unsupported on Railway; `generateUploadUrl` throws `unsupported_upload_url` and `getUrl` returns null.

### Environment

`BEBEBONJOUR_DELIVERY_LOOP_TOKEN`, `BEBEBONJOUR_OPERATIONS_TOKEN`,
`BEBEBONJOUR_PAID_EDITORIAL_TOKEN`, `BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN`,
`BEBEBONJOUR_TRIAL_PASSWORD_SHA256`, `BEBEBONJOUR_DELIVERY_LOOP_ORIGIN`,
`BEBEBONJOUR_PAID_ROUTE_A_ENABLED`, `BEBEBONJOUR_PAID_TERMS_URL`,
`BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID`, `BEBEBONJOUR_PAID_STRIPE_LIVEMODE`,
`BEBEBONJOUR_PAID_STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`,
`BEBEBONJOUR_PAID_TEST_PROMO_ENABLED`, `BEBEBONJOUR_PAID_TEST_PROMO_JSON`,
`BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED`, `OPENAI_API_KEY`,
`BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID`, `BEBEBONJOUR_CLOUDFLARE_ZONE_ID`,
`BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN`, `BEBEBONJOUR_OPERATOR_EMAIL`,
`BEBEBONJOUR_OPS_CONSOLE_URL`.

## 2. Target design

One Railway project, two services:

- **`api`**: a Node service (`server/railway.mjs`) that loads the same
  `convex/deliveryLoop*.js` modules and runs them on a small Convex-compatible
  runtime (`src/railway/`) backed by PostgreSQL.
- **`Postgres`**: Railway's managed PostgreSQL.

Decisions:

- **Same business code, new runtime.** The delivery-loop rules (operator gate,
  payment binding, leases, notice fences) stay in `convex/`. The runtime provides
  `ctx.db`, `ctx.storage`, `ctx.scheduler`, `ctx.run*` and the HTTP router. Both
  backends run identical logic during the rollback window, and concurrent changes
  to `convex/` (R1 composition/render) need no porting.
- **Convex wire protocol kept.** `POST /api/query|mutation|action` speak the
  `ConvexHttpClient` format, so the worker and the ops console switch backend by
  changing one URL. Only public functions are callable; internal ones are not.
  Arguments are checked against the functions' `v` validators.
- **Documents as JSONB.** One `documents` table (`id`, `table_name`,
  `creation_time`, `doc jsonb`). Index lookups become JSONB equality filters
  ordered by the remaining schema index fields and `creation_time`. Mutations run in one transaction under a
  transaction-level advisory lock, which gives Convex's serializable behaviour at
  this volume.
- **Artifacts in PostgreSQL.** Narration MP3s (≤ 12 MB each, a few per order) go
  into a `storage` table (`bytea`, size, content type, sha256). No volume or R2
  bucket to run; backups and deletes are transactional with the order. Move to R2
  if stored audio passes a few GB.
- **Durable scheduler.** `runAfter` writes a row in `scheduled_functions` inside
  the mutation's transaction; a poller runs it after commit. A scheduled action is
  marked running before execution, then done or failed without retry; stale running work remains running.
- **Cron.** The server runs `deliveryLoopData:sweep` hourly.

The ops console reads `BEBEBONJOUR_BACKEND_URL` (falls back to `CONVEX_URL`): that
variable is the switch between Convex and Railway.

### Running locally

Set `DATABASE_URL` to an isolated PostgreSQL database and
optionally `BEBEBONJOUR_DELIVERY_LOOP_ORIGIN` to the public origin, then run `npm run start:railway`. When unset, forwarded protocol and host determine the request origin. The server defaults to port 8080.
The process creates its runtime tables on startup, polls scheduled work, and
runs the retention sweep hourly. Scheduled work is not retried after a crash or failure.

Run `npm run test:railway` for PGlite and synthetic localhost HTTP checks. These
checks do not establish hosted delivery or authorize provider calls. Production
still remains on Convex until a separately authorized cutover.

## 3. Staging

Railway project `bebebonjour-staging` (workspace "Zacaria Chtatar's Projects",
environment `production` of that project, which is the staging stack):

| Service | URL | Source |
|---|---|---|
| `api` | https://api-production-0caba555.up.railway.app | this repo, `Dockerfile` |
| `ops` | https://ops-production-e1d2e329.up.railway.app | `bebebonjour-ops`, Nixpacks |
| `Postgres` | private network | Railway PostgreSQL template |

Deploy: `git archive <commit>` into a scratch folder linked to the project, then
`railway up -s api --ci` (same for `ops` from the ops repo). The lockfile must
install with the image's npm 10 (`npx npm@10 install --package-lock-only`).

`api` variables (names only): `DATABASE_URL` (`${{Postgres.DATABASE_URL}}`),
`BEBEBONJOUR_DELIVERY_LOOP_ORIGIN`, `BEBEBONJOUR_DELIVERY_LOOP_TOKEN`,
`BEBEBONJOUR_OPERATIONS_TOKEN`, `BEBEBONJOUR_PAID_EDITORIAL_TOKEN`,
`BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN`, `BEBEBONJOUR_PAID_ROUTE_A_ENABLED=true`,
`BEBEBONJOUR_PAID_STRIPE_LIVEMODE=false`, `BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID`,
`BEBEBONJOUR_PAID_TERMS_URL`, `STRIPE_SECRET_KEY` (restricted `rk_test_` key, same
as the Convex dev deployment), `OPENAI_API_KEY`, `BEBEBONJOUR_CLOUDFLARE_*`,
`BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER=cloudflare`,
`BEBEBONJOUR_OPERATOR_EMAIL`, `BEBEBONJOUR_OPS_CONSOLE_URL` (the staging `ops`).
Staging tokens are fresh random values, never the production ones.

`ops` variables: `BEBEBONJOUR_BACKEND_URL` (the staging `api`),
`BEBEBONJOUR_OPERATIONS_TOKEN`, `BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN`,
`BEBEBONJOUR_OPS_ACCESS_KEY`, `BEBEBONJOUR_OPS_SESSION_SECRET`,
`BEBEBONJOUR_OPS_ORIGIN`, `BEBEBONJOUR_OPS_ENABLED_ACTIONS=launch_generation,refuse_request`.

No Stripe webhook points at staging. After a test payment, settle it from `/delivery/operator`
(`reconcile_payment` with the PaymentIntent id), which runs the same evidence
check as the webhook. The cutover card adds the webhook for the real switch.

The generation worker is the existing one on this host, pointed at staging:
`CONVEX_URL=<api url> BEBEBONJOUR_DELIVERY_LOOP_TOKEN=<staging token>
BEBEBONJOUR_DELIVERY_LOOP_STATE_DIR=<private dir> node scripts/run-delivery-loop-worker.mjs --once`.

### Recorded synthetic run (19/11/2026)

Synthetic orders only, customer address on a mail.tm inbox we control, Stripe
test mode.

1. `/delivery` paid form (Lina) → `awaiting_operator`.
2. Staging ops console login (login throttle served by the Railway backend),
   `/commandes` lists the order, launch from a brief → `payment_pending`;
   "Lina — votre demande est acceptée" received.
3. Order page → "Payer 39 € par carte" → Stripe Checkout (test, 39,00 €),
   Bancontact "Authorize Test Payment" → PaymentIntent `succeeded`;
   `reconcile_payment` → `generation_queued`, payment `settled`.
4. Worker `generate` (Codex subscription + Cedar narration) → published;
   `/announcements/<token>` 200, audio served from PostgreSQL (`audio/mpeg`).
5. Worker `draft_email` → "Lina — votre faire-part est prêt" received.
6. Customer approves on the order page; worker `final_email` → `approved_sent`;
   "Lina — votre faire-part est approuvé" received.

Repeated after rebasing on the R1 changes (Noé): chapter slideshow renders, CSP
hash matches, audio answers byte ranges (206), screens follow the voice to the
name reveal, order ends `approved_sent`.
