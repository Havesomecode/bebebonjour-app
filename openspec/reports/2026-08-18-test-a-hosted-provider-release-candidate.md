# TEST-A hosted provider release candidate

Date: 2026-08-18
Mode: provider-bound release candidate; no provider mutation performed

## Candidate outcome

This increment replaces the local-only persistence/payment boundary with a deployable, test-only path while preserving the existing human review, publication, and delivery gates.

The hosted path is:

1. first-party intake on the Vercel Node route;
2. atomic intake/idempotency persistence in Convex;
3. a fixed €39 EUR Stripe Checkout Session using a test key;
4. exact-raw-body verification of one `checkout.session.completed` event;
5. idempotent payment correlation into the same customer job and canonical fulfillment aggregate;
6. a persisted `generation_queued` stop, with no public approval, publication, or delivery command;
7. a separate Resend adapter for an operator runtime after human approval and publication.

The old Tally/Supabase webhook path remains dormant and unchanged as a rollback reference. It is not part of the new route and must not receive new provider subscriptions.

## Authority contract

| Datum | Authority | Correlation-only data |
|---|---|---|
| Intake | first-party `POST /api/customer-flow/v1/intakes` | browser idempotency key |
| Payment | signed Stripe test event with `livemode=false`, `amount_total=3900`, `currency=eur` | Checkout Session metadata |
| Operational state | Convex customer job + canonical fulfillment aggregate | public status projection |
| Review | existing trusted review-decision verifier | browser/client state has no authority |
| Publication | operator-approved Vercel publication receipt | preview URL before approval |
| Delivery | operator-approved Resend receipt and status | email client/browser state |

Accepted provider event: `checkout.session.completed` only. Publication, customer email, refund, live payment, and provider configuration are out of scope for this candidate.

## Security and privacy properties

- Stripe is fail-closed to `sk_test_`; live keys are rejected during runtime initialization.
- Checkout amount/currency and project/job/intake metadata are checked both when creating the Session and when consuming the signed event.
- Webhook verification receives exact raw bytes. Invalid signatures return a bounded 400 response. Signed contract-invalid events are recorded as redacted rejections and acknowledged with 200 to prevent provider retry storms; unknown storage/runtime failures remain retryable 500 responses.
- Accepted Stripe event ID + raw-payload fingerprint is atomically claimed in Convex before fulfillment effects and finalized afterward; concurrent conflicting bytes are fenced before a second effect, and a paid job rejects a new event ID even when the PaymentIntent matches.
- Customer status and checkout require the private intake bearer token; tokens are persisted only as digests.
- Idempotency replay stores the intake bearer token only as AES-256-GCM ciphertext under a Vercel-only key; Convex rejects plaintext token responses.
- Every hosted `/v1/*` command also requires a separate high-entropy TEST-A access token; the landing collects it interactively and keeps it in memory only. Its executable client accepts only `https://bebebonjour-fulfillment.vercel.app/api/customer-flow`; an equal operator-provided HTTPS/self override cannot authorize another host.
- Convex functions require a separate 32+ character backend token stored in both Convex and the Vercel API runtime.
- The public Vercel API runtime does not require or receive `RESEND_API_KEY`.
- Resend accepts only test jobs and the exact `delivered@resend.dev` sink, uses the persisted operation idempotency key, and fails closed before Resend's 24-hour idempotency retention can expire.
- The browser has no approval, publication, payment-success, or delivery command.
- Provider payloads are not persisted; only normalized data and event fingerprints/results are stored.

## Direct local evidence

The automated suite exercises:

- Convex transaction semantics for intake idempotency and immutable provider-event recording;
- compare-and-set retries for customer and fulfillment aggregates;
- one hosted intake through Stripe test Checkout creation;
- one cryptographically signed Stripe test event into Convex;
- exact duplicate replay with one durable provider-event row;
- exact signed-byte replay binding; the same event ID with different signed bytes is rejected;
- concurrent same-ID/different-byte delivery fencing before the second fulfillment effect;
- one signed wrong-amount event acknowledged only after a redacted durable rejection;
- the generation stop at `generation_queued`;
- Resend request idempotency and status mapping with an injected provider client;
- the Vercel catch-all export and hosted route prefix.

This is signed-synthetic/local evidence only. It does not claim a provider endpoint, deployed environment, provider delivery log, real Convex deployment, Vercel preview, Resend message, publication, or live payment.

## Provider migration manifest

The machine-readable ordered manifest is `ops/test-a-hosted-provider-manifest.json`. Follow it exactly. Important separation:

- Convex team/project/deployment is fixed to `havesomecode:bebebonjour-test-a:preview/test-a-t_3f375e12`; only its preview secret store receives `CUSTOMER_FLOW_BACKEND_TOKEN`.
- Vercel production is fixed to project `bebebonjour-fulfillment` in scope `zacaria-chtatars-projects`, project ID `prj_XJrkufo77hXAdvMuYjPn6F6AVZjn`, and canonical alias `https://bebebonjour-fulfillment.vercel.app`. It receives exactly the listed Convex and Stripe test runtime variables plus the TEST-A access and token-encryption keys, but no Resend key.
- Stripe test account `acct_1MKd4KGrir6mz3o7` receives exactly one endpoint subscribed only to `checkout.session.completed`; it is created against an immutable bootstrap deployment, retargeted to the final immutable deployment for proof, then retargeted once more to `https://bebebonjour-fulfillment.vercel.app/api/customer-flow/webhooks/stripe` after that alias serves the proven app deployment.
- The operator delivery runtime receives Resend credentials only after the review/publication gate.
- The landing build receives only the non-secret canonical API base; the retired approved-origin override and every provider secret are forbidden.

The first deployment uses a generated high-entropy bootstrap webhook value held only in the Vercel secret store. The Stripe endpoint is then created against that immutable bootstrap URL so its one-time signing secret can replace the bootstrap value. The same signed app candidate is redeployed after that update, the one endpoint is retargeted to the final immutable URL, and that final deployment is probed before the canonical alias moves. The endpoint is retargeted to the canonical URL and the landing is activated only after alias health succeeds. Both Vercel receipts must prove their deployment occurred after their respective secret update.

## Pinned landing boundary

On 2026-08-19, the public landing boundary was observed at `https://www.bebebonjour.com`: `https://bebebonjour.com` returned an HTTPS redirect to that `www` origin, which returned the active Vercel landing page. The hosted TEST-A candidate therefore pins CORS and Stripe Checkout callbacks to the exact active origin:

```dotenv
CUSTOMER_FLOW_ALLOWED_ORIGINS=["https://www.bebebonjour.com"]
STRIPE_CHECKOUT_SUCCESS_URL=https://www.bebebonjour.com/suivi?checkout=success
STRIPE_CHECKOUT_CANCEL_URL=https://www.bebebonjour.com/suivi?checkout=cancel
```

These are deterministic candidate values in `.env.example` and the provider migration manifest, not evidence that any Vercel or Stripe environment was changed. The API origin, test access token, provider credentials, deployment, publication, customer email, and live payment remain separately gated.

## Controlled end-to-end proof required after independent approval

1. Verify the signed app and landing commit identities and exact path allowlists.
2. Provision the exact seven-day Convex preview, install only its backend token, then deploy this candidate's functions.
3. Install the complete allowed Vercel production inventory with an unrecorded generated bootstrap webhook secret, prove every forbidden variable absent, and deploy the signed app candidate to an immutable bootstrap URL without moving the alias.
4. In the exact Stripe test account, create the one endpoint against that bootstrap URL and replace the Vercel bootstrap value directly with its signing secret without exposing either value in a command, file, or transcript.
5. Redeploy the same signed app candidate after the real webhook-secret update, retarget the one endpoint to this final immutable URL, and verify health and invalid-signature behavior there.
6. Assign the canonical fulfillment alias to that final deployment, retarget the same endpoint to the canonical webhook URL, then build/deploy the signed landing candidate with only the exact non-secret API base.
7. Submit a unique synthetic €39 EUR order, complete one Stripe test Checkout event, and replay the exact event.
8. Verify Stripe delivery logs and query Convex directly: one customer job, one fulfillment job, one provider event, and no replay transition.
9. Run generation and persist the qualified human review decision for the exact revision.
10. Install Resend credentials only in the separate operator runtime, publish only the approved test artifact, send only to `delivered@resend.dev`, and reconcile the exact message ID/status.
11. Re-check that no provider payload, plaintext intake token, forbidden secret, real payment, or customer email crossed the boundary.

## Rollback

Before customer traffic, rollback is configuration-only: restore the prior signed landing and canonical-alias targets (or unset the landing API base), disable the exact Stripe test endpoint, and revoke scoped Convex, Vercel-runtime, Stripe-webhook, TEST-A, encryption, and Resend credentials. Do not delete either Vercel deployment, Convex records, Stripe delivery logs, approval/publication receipts, or Resend receipts. The prior local TEST-A and dormant Tally/Supabase code remain available until the observation window is accepted.

## Exact boundary

The candidate is bound by the signed app commit containing this report plus the signed landing commit that pins the canonical hosted API base in executable source. The release handoff must record both signed app and landing commit identities, verify each commit's exact path allowlist, and reject mixed/stale commit framing. No candidate is authorized for push or deployment until the pre-created review/release chain approves those exact identities.
