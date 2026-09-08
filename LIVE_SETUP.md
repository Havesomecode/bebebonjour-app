# Bébé Bonjour live setup

This document describes the current production-boundary topology. Historical
provider reports under `openspec/reports/` are evidence only and are not runtime
instructions.

## Canonical topology

1. `https://bebebonjour.com` links to the public Tally intake form.
2. Tally sends a signed, intake-only `FORM_RESPONSE` webhook to
   `https://bebebonjour-fulfillment.vercel.app/api/webhooks/tally`.
3. The Vercel handler verifies the raw-body HMAC and exact form ID, maps stable
   question/option IDs, and creates one unpaid customer-flow job in Convex.
4. The same Convex transaction creates its canonical fulfillment aggregate and
   one PII-free work item containing only the canonical job reference.
5. A local Hermes dispatcher claims work under a bounded lease and creates one
   idempotent card on the `personal-projects` Kanban board for tenant
   `bebe-bonjour`.
6. Stripe checkout and the Stripe webhook remain a separate payment transition.
   Generation, publication, and delivery remain behind canonical payment state
   and exact human approval.

Tally is **not** a payment system in this topology. Remove every Tally payment
block before enabling the webhook. Payment fields are intentionally rejected by
the field-map contract.

## Canonical provider identity

- Convex account/team: `havesomecode`
- Convex project: `bebebonjour-test-a`
- Convex environment: `prod`
- Current deployment: resolve with
  `npx convex deployments --deployment havesomecode:bebebonjour-test-a:prod`
- Vercel project: `bebebonjour-fulfillment`
- Vercel production alias: `https://bebebonjour-fulfillment.vercel.app`
- Isolated generation worker project: `bebebonjour-generation-worker` (resolve
  and record its provider project ID before the first separately authorized deploy)

Always resolve the production alias immediately before deploy. Do not reuse a
retired preview deployment name from an old manifest.

## Convex deployment

From the exact reviewed worktree:

```bash
npx convex deploy --deployment havesomecode:bebebonjour-test-a:prod
```

Set `CUSTOMER_FLOW_BACKEND_TOKEN` and `BEBEBONJOUR_OPERATIONS_WORKER_TOKEN` on
that exact Convex production deployment. The first token is mounted only in the
fulfillment project; the second is mounted only in the isolated generation
project. The values must be distinct and neither may be printed, committed,
copied into Kanban, or exposed to browser code.

The deployed schema must include:

- `customerFlowJobs`
- `customerFlowSubmissions`
- `customerFlowProviderEvents`
- `customerFlowWorkItems`
- `customerFlowOperationsCommands` and `customerFlowOperationsLoginThrottle`
- `fulfillmentJobs` and `fulfillmentReviewApprovals`
- `fulfillmentGenerationEditorialApprovals` and
  `fulfillmentGenerationArtifactSets`; artifact bytes live in Convex `_storage`

## Vercel production variables

The fulfillment project requires these server-side names:

- `CONVEX_URL`
- `CUSTOMER_FLOW_BACKEND_TOKEN`
- `CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY`
- `CUSTOMER_FLOW_TEST_ACCESS_TOKEN`
- `CUSTOMER_FLOW_ALLOWED_ORIGINS`
- `BEBEBONJOUR_OPERATIONS_TOKEN`
- `BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN`
- `STRIPE_SECRET_KEY` (test mode until a separately approved live rollout)
- `STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET`
- `STRIPE_CHECKOUT_SUCCESS_URL`
- `STRIPE_CHECKOUT_CANCEL_URL`
- `TALLY_INTAKE_FORM_ID`
- `TALLY_INTAKE_FIELD_MAP`
- `TALLY_INTAKE_SIGNING_SECRET`

`CONVEX_URL` must point to the current production deployment returned by the
provider, not a deleted preview. List variable names with `vercel env ls`; never
print values.

The separate `bebebonjour-generation-worker` project uses
`vercel.generation-worker.json`, packages only
`generation-worker/api/worker.mjs`, and has exactly these application variables:

- `CONVEX_URL`
- `BEBEBONJOUR_OPERATIONS_WORKER_TOKEN`
- `BEBEBONJOUR_OPERATIONS_WORKER_ID`
- `BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS=generate`
- `BEBEBONJOUR_OPERATIONS_WORKER_LIMIT=5`
- `BEBEBONJOUR_OPERATIONS_WORKER_LEASE_MS=120000`
- `CRON_SECRET`

It must not contain `CUSTOMER_FLOW_BACKEND_TOKEN`, operations UI credentials,
payment, email, Tally, publication, provider-management, or model-provider
credentials. Read back variable names and the provider project ID before deploy;
never print values. The main fulfillment project must not contain any of the six
`BEBEBONJOUR_OPERATIONS_WORKER_*`/`CRON_SECRET` worker inputs.

## Tally form and webhook

Before enabling the webhook:

1. Remove the payment block and any payment-derived fields.
2. Add an explicit required consent checkbox.
3. Keep required questions for email, language, narration voice, baby first name,
   baby gender, and announcement context.
4. Record the stable question and option IDs from a synthetic response.
5. Build `TALLY_INTAKE_FIELD_MAP` with only the supported keys shown in
   `test/fixtures/tally-intake-field-map.json`.
6. Add the production webhook URL in Tally integrations.
7. Store Tally's generated signing secret as `TALLY_INTAKE_SIGNING_SECRET` in
   Vercel. Never paste it into the repository or a Kanban card.

Send one synthetic submission using an `.test` address before accepting a real
customer. Verify that Tally receives HTTP 200, Convex contains one job and one
work item, and a replay creates neither a second job nor a second card.

## Hermes intake dispatcher

Run `scripts/dispatch-intakes-to-kanban.mjs` with only these environment values:

- `CONVEX_URL`
- `CUSTOMER_FLOW_BACKEND_TOKEN`

The dispatcher:

- claims one work item per poll for a two-minute lease;
- bounds the local Hermes create call to 30 seconds;
- passes only a job reference to Kanban;
- uses `bebebonjour:intake:<job-id>` as the Hermes idempotency key;
- records the durable Kanban task ID back in Convex; and
- releases a failed claim with a bounded reason code, never a provider error or
  customer payload.

The production backend token is stored as
`BEBEBONJOUR_CUSTOMER_FLOW_BACKEND_TOKEN` in the active Hermes profile's
secret-only `.env` (`${HERMES_HOME:-$HOME/.hermes}/.env`, mode `0600`). It must
never be copied into the repository. Use the wrappers:

```bash
./scripts/dispatch-intakes-from-hermes-secrets.sh
./scripts/private-intake-status-from-hermes-secrets.sh <job_id>
```

The production scheduler should run the dispatch wrapper every minute and stay
silent when no work or failure exists. The status wrapper is the only documented
way for a Kanban worker to inspect the private canonical job; its output must not
be copied into Kanban comments or logs.

### Isolated private generation

Vercel generation uses only invocation-local `/tmp` as a private staging area.
Every completed private-review file is uploaded to Convex file storage, and the
exact job/revision/kind metadata is committed insert-once to
`fulfillmentGenerationArtifactSets` before the fulfillment stage can complete.
A cold invocation requests each file through the claim-scoped authenticated
`GET /generation/artifact` Convex HTTP action and verifies its byte length and
SHA-256 digest before replay. Each file is limited to 20 MiB and no direct
storage URL is returned. The staging
directory is removed in `finally`; no Vercel filesystem path is a durability
authority.

The human-issued job-scoped editorial approval must validate against
`schemas/job-scoped-editorial-approval.schema.json`, bind the exact `job_...`
identifier, carry the SHA-256 digest of its canonical `sourceEvidence` JSON, and
contain exactly the `unknown_name_general_wishes` policy: preserve submitted
Latin/Arabic spelling, allow generic blessings, forbid meaning and scriptural
name-association claims, and stop at `content_review_required`. Make the record
owner-readable and immutable to the invocation (`0400`); symlinks, aliases,
hardlinks, writable files, and group/world-readable files are rejected.

```bash
mkdir -m 700 /absolute/private/path/bebebonjour-generation
mkdir -m 700 /absolute/private/path/bebebonjour-generation/approvals
# A human decision authority writes and validates this JSON before generation.
chmod 400 /absolute/private/path/bebebonjour-generation/approvals/job_...json
CONVEX_URL=https://the-reviewed-deployment.convex.cloud \
CUSTOMER_FLOW_BACKEND_TOKEN=... \
  node ops/persist-test-a-generation-approval.mjs \
    <job_id> /absolute/private/path/bebebonjour-generation \
    /absolute/private/path/bebebonjour-generation/approvals/job_...json
```

The private provisioning command validates the root isolation, immutable file,
closed JSON schema, exact job binding, exact non-broadening policy, and evidence
digests before the approval can be inserted. Repeating the exact approval is
idempotent; a conflicting record for the same job is rejected.

The isolated Vercel cron endpoint authenticates `CRON_SECRET`, health-checks the
exact worker protocol, and claims only the configured `generate` action. Every
Convex read, transition, upload URL, commit, and byte read binds the worker token,
command ID, worker ID, lease token, exact job, active lease, and `generate`
action. The worker reads the canonical customer/fulfillment records plus the persisted approval,
rejects unpaid, mismatched, or ineligible jobs before artifact upload, crosses
the Operations effect fence once, advances only `prepare_review`, persists the
complete private artifact set in Convex, and stops at `content_review_required`.
Replay after successful generation returns `already_generated`; a bounded
prepare-review retry resumes only that same stage. Output is a PII-free status
projection and must never be augmented with intake, email, names, notes, page
content, or raw artifact bytes.

If the Operations effect fence rejects an exact persisted `prepare_review`
claim before any effect starts, the fence mutation atomically fails the
Operations command and closes the stage attempt. An attempt remaining within
the current bound enters `retry_wait`; after its persisted backoff, an operator
must run `retry` and then request a fresh `generate` command at the resulting
job version. The worker must not compose, upload, or issue a client-side
compensating fulfillment write on this path.
Expired-command discovery in the next worker poll applies the same atomic
closure if a worker exits after the stage claim and before the effect fence.

The generated private dossier binds the editorial approval record digest, source
digest, exact job, and exact policy into `generationMaterials` and therefore the
dossier `materialDigest`. The policy applies only when the ordinary resolver
returns `unknown`; exact, alias, ambiguous, cross-script-conflict, and invalid
orthography outcomes remain rejected. The submitted name is never rewritten to
obtain a fallback, and the approved path always uses the general-wishes fallback.

This entrypoint has only canonical Convex reads/writes and Convex private-file
storage. It has no persisted content-approval, TTS, render-after-approval,
publication, delivery, Vercel management, Resend, Stripe mutation, or generic
run-next capability. Do not replace it with
`ops/run-test-a-operator.mjs run-next` and do not add provider credentials to
its environment.

## Verification gates

Run from the exact candidate:

```bash
npm run verify
npm run test:vercel-routing
npm audit --omit=dev
```

Then verify the deployed alias:

- `GET /api/customer-flow/health` returns the reviewed health contract.
- `POST /api/webhooks/tally` without a valid signature returns 401 and creates no
  state.
- a signed synthetic Tally fixture creates one unpaid Convex job and one work
  item;
- replay is idempotent;
- the dispatcher creates one PII-free Kanban task and records its ID;
- no live payment, publication, email delivery, or customer-data migration occurs
  during verification.

Do not declare the bridge live until the exact deployed Vercel alias, exact
Convex production deployment, Tally integration, and Hermes scheduler have all
been read back after mutation.
