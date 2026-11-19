# Moving the Bébé Bonjour backend from Convex to Railway

Status: staging done; cutover planned (§4). Convex prod (`tacit-antelope-577`) stays the production backend
until the cutover card switches it. This document covers the inventory, the target
design, the staging run, and the cutover and rollback plan.

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

For an isolated, empty PostgreSQL target, `node scripts/railway-import-convex-snapshot.mjs import <export-dir>` imports runtime documents and referenced storage and compares them. `compare <export-dir>` verifies an existing target; `diff <before-dir> <after-dir>` checks snapshots for changes; `check <origin>` checks announcement routes without printing tokens. The database commands require `DATABASE_URL`. Quiesce writes separately before any authorized cutover; this tool does not migrate scheduled functions, deploy services, or authorize live effects. Snapshot directories and database backups contain private customer data.

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

## 4. Production cutover and rollback

Scope: move the live delivery loop (orders, payments, generation, publication,
mail) from Convex `tacit-antelope-577` to a Railway production project. Customer
URLs do not change: everything public is served under `https://www.bebebonjour.com`
through the landing's Vercel rewrites, and every Convex `_id` (job, storage) is kept.
State on 19/11: 9 jobs, one real order in `payment_pending`, audio in Convex storage.

### What changes and what does not

| Piece | Today | After |
|---|---|---|
| Backend | Convex prod | Railway project `bebebonjour-production`: `api` (this repo, `Dockerfile`) + `Postgres` |
| Public routes | landing rewrites `/delivery`, `/delivery/*`, `/announcements/*` → `tacit-antelope-577.convex.site` | same rewrites → the Railway `api` domain |
| Stripe live webhook | `we_1UdEfEGrir6mz3o7Gwbqmkqm` → `https://www.bebebonjour.com/delivery/payment/webhook` | **unchanged in Stripe**: it follows the rewrite. Railway gets the same `BEBEBONJOUR_PAID_STRIPE_WEBHOOK_SECRET` |
| Ops console | Vercel `bebebonjour-ops`, `CONVEX_URL` | same app, `BEBEBONJOUR_BACKEND_URL=<Railway api>` (ops main `ae83e57`+) |
| Generation worker | systemd `bebebonjour-delivery-loop`, `CONVEX_URL` in `~/.config/bebebonjour-delivery-loop/runtime.env` | same unit and runtime, `CONVEX_URL=<Railway api>` |
| Mail | Cloudflare Email, `bonjour@mail.havesomecode.io` | same, same variables on Railway |
| DNS | none | none |

Railway `api` variables: the §1 environment list with the **production** values,
copied from `npx convex env get` straight into `railway variables --set` (never
printed or written to disk), plus `DATABASE_URL=${{Postgres.DATABASE_URL}}` and
`BEBEBONJOUR_DELIVERY_LOOP_ORIGIN=https://www.bebebonjour.com`.
`BEBEBONJOUR_PAID_STRIPE_LIVEMODE` stays unset (live). Tokens are the same values as
Convex prod, so the worker and the ops console only change one URL.

### Data copy

`scripts/railway-import-convex-snapshot.mjs` (tested offline in
`test/railway/import-snapshot.test.mjs`, rehearsed on a local PostgreSQL with the dev
export):

- `import <dir>`: from an unzipped `npx convex export --include-file-storage`, copies
  the six runtime tables with their `_id` and `_creationTime`, and the narration files
  referenced by a `storageId` (size and sha256 checked against the export). One
  transaction; refuses a non-empty target. Then runs `compare`.
- `compare <dir>`: per table, snapshot vs database ids both ways (missing, extra,
  changed docs) and storage (referenced, imported, sha mismatch). Exit 1 unless equal.
- `diff <dirA> <dirB>`: compares two Convex exports (proves Convex took no write
  after the copy).
- `check <origin>`: requests every announcement page and audio file and prints status
  counts per job, without tokens.

Exports hold customer data: they go in a `chmod 700` scratch directory and are deleted
when the rollback window closes.

### Cutover steps

Prepared before the window (no customer effect):

1. Create `bebebonjour-production` (Postgres + `api`), deploy the merged main commit
   with `git archive` + `railway up -s api --ci`, generate a domain. Set the variables.
2. On the empty database: `/version` 200, `GET /delivery` 200 on the Railway domain.
3. Baseline on today's Convex: take a fresh export, import it into a local throwaway
   PostgreSQL, run `check https://www.bebebonjour.com` and keep the per-job codes.
   Delete the throwaway database.

Window (about 15 minutes, form and payment page unavailable while Convex is paused):

4. Stop the worker: `sudo systemctl stop bebebonjour-delivery-loop`.
5. Check the Convex dashboard has no pending scheduled function (notices run at once),
   then **pause** Convex prod (dashboard → Settings → Pause deployment, or the
   deployment API `pause_deployment`). New calls now fail; Stripe retries its webhook
   for up to 3 days, so a payment made during the window settles on Railway later.
6. `npx convex export --include-file-storage` → `export-A`, unzip. If the export is
   refused while paused: resume, export `export-A`, do step 8 first (the rewrites carry
   all public traffic), export `export-B`, and require `diff export-A export-B` to be
   empty before going on (otherwise import `export-B`).
7. `DATABASE_URL='<Railway public Postgres URL>?sslmode=no-verify' node scripts/railway-import-convex-snapshot.mjs import export-A`
   → must print `ok: true` with counts equal to the export. Always add `sslmode=no-verify`
   (or `sslmode=require&uselibpqcompat=true`) to the public URL, for `compare` too: `pg`
   connects without TLS by default, which would send customer data and the password in clear.
8. Landing: change the three Convex rewrites in `bebebonjour-landing/vercel.json` to the
   Railway domain, push `main` (Vercel deploys production), wait for the deployment.
9. Ops: `vercel env add BEBEBONJOUR_BACKEND_URL production --force` with the Railway URL,
   redeploy ops from `ae83e57`+ (`git archive` into scratch, see builder lessons).
10. Worker: set `CONVEX_URL=<Railway api>` in `runtime.env`, `sudo systemctl start bebebonjour-delivery-loop`.

Verify:

11. `check https://www.bebebonjour.com` against Railway: every job that answered 200 in
    the baseline answers 200 (pages and audio).
12. One real request end to end on production: `/delivery` paid form → `awaiting_operator`,
    operator email received, ops console lists it, launch → payment-link email received,
    Stripe live Checkout opens at 39 €. A real payment (owner's card), if made, proves the
    webhook path through the rewrite.
13. Stripe dashboard: the live webhook shows 2xx deliveries after the switch.

### Switch record (19/11/2026)

- Railway `bebebonjour-production` (`864d1ac5-…`): `api` from main `d4573de`, domain
  https://api-production-c9013a1c.up.railway.app; production variables copied from
  `convex env get` through the Railway API without printing them.
- Baseline on Convex before the window: 9 announcement pages 200, 3 audio files 200.
- Window 15:44–15:49 UTC: worker stopped, Convex paused with the deployment API
  (`POST https://tacit-antelope-577.convex.cloud/api/v1/pause_deployment`,
  `Authorization: Convex <access token from ~/.convex/config.json>`). Export works while
  paused, so `export-A` was taken after the pause and `diff baseline export-A` was empty.
- Import over TLS (TLSv1.3 checked) through a temporary TCP proxy, deleted afterwards:
  `ok: true`; jobs 9/9, intake throttle 4/4, login throttle 2/2, payment tables 0/0,
  3/3 audio files with sha256. Legacy Convex tables (customerFlow, fulfillment,
  ownerTrial*) are not served by any public route and stay in the paused deployment.
- Landing `dd4e5eb` (rewrites → Railway), ops `ae83e57` with `BEBEBONJOUR_BACKEND_URL`,
  worker `CONVEX_URL` → Railway (backup `runtime.env.convex.bak`).
- After: the same 9 pages and 3 audio files answer 200 on www.bebebonjour.com through
  Railway. A synthetic paid request on the production form reached `awaiting_operator`,
  the operator notice was sent, launch → `payment_pending`, the customer received
  "votre demande est acceptée" with the order link, and "Payer 39 € par carte" opened a
  live Stripe Checkout (`cs_live_`) at 39,00 € (not paid). Ops login throttle calls
  reach Railway. The unsigned webhook probe answers 400 (signature check on Railway);
  the first signed live delivery is still to be seen on the next real payment.
- To reach the database again (rollback listing, `compare`): recreate a TCP proxy on
  `Postgres` port 5432, use `?sslmode=no-verify`, delete the proxy afterwards.

### Rollback (open until the owner closes it)

Convex stays **paused, not deleted**: its data is exactly `export-A`.

1. Revert the landing rewrites to `tacit-antelope-577.convex.site` (revert commit, push).
2. Ops: remove `BEBEBONJOUR_BACKEND_URL` (falls back to `CONVEX_URL`), redeploy.
3. Worker: `cp ~/.config/bebebonjour-delivery-loop/runtime.env.convex.bak ~/.config/bebebonjour-delivery-loop/runtime.env`, restart.
4. Resume Convex (dashboard or `POST …/api/v1/unpause_deployment`, same auth as the pause).
5. Orders written on Railway after the switch are not copied back automatically:
   list them (`SELECT id, doc->>'status' FROM documents WHERE table_name='deliveryLoopJobs' AND creation_time > <cutover ms>`)
   and replay them by hand on Convex; at today's volume that is a handful of rows.
   A replayed order gets a new Convex `_id`, while its Stripe metadata `job_id` keeps the
   Railway id, so `reconcile_payment` refuses it. **Never send a new payment link for an
   order already paid on Railway**: mark it settled by hand or refund it in Stripe,
   otherwise the customer pays twice.

Close the window once Railway has run real orders for a week without a rollback
reason: the owner confirms, Convex prod is shut down and the exports are deleted.
Then remove what only Convex used: the Convex deploy config and scripts, the lines not
in the delivery loop (customerFlow, fulfillment, generation, ownerTrial*, narration and
completion workers), and the Convex deploy notes in `docs/STATE.md`. The delivery-loop
modules in `convex/` and `convex/http.js` stay: the Railway runtime loads them.
