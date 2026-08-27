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

Always resolve the production alias immediately before deploy. Do not reuse a
retired preview deployment name from an old manifest.

## Convex deployment

From the exact reviewed worktree:

```bash
npx convex deploy --deployment havesomecode:bebebonjour-test-a:prod
```

Set `CUSTOMER_FLOW_BACKEND_TOKEN` on that exact Convex production deployment.
The token must match the server-side Vercel value and must never be printed,
committed, copied into Kanban, or exposed to browser code.

The deployed schema must include:

- `customerFlowJobs`
- `customerFlowSubmissions`
- `customerFlowProviderEvents`
- `customerFlowWorkItems`
- the fulfillment tables

## Vercel production variables

The fulfillment project requires these server-side names:

- `CONVEX_URL`
- `CUSTOMER_FLOW_BACKEND_TOKEN`
- `CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY`
- `CUSTOMER_FLOW_TEST_ACCESS_TOKEN`
- `CUSTOMER_FLOW_ALLOWED_ORIGINS`
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
