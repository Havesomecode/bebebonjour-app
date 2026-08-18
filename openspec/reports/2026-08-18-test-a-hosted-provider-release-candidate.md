# TEST-A hosted provider release candidate

Date: 2026-08-18
Mode: provider-neutral release candidate; no provider mutation performed

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
- Every hosted `/v1/*` command also requires a separate high-entropy TEST-A access token; the landing compatibility task must collect it interactively and keep it in memory only.
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

- Convex receives `CUSTOMER_FLOW_BACKEND_TOKEN`.
- Vercel API receives Convex and Stripe test runtime variables plus the TEST-A access and token-encryption keys, but no Resend key.
- The operator delivery runtime receives Resend credentials only after the review/publication gate.
- Stripe receives exactly one test endpoint subscribing only to `checkout.session.completed`.

Environment updates must precede the Vercel deployment that is asserted to contain them.

## Controlled end-to-end proof required after independent approval

1. Provision an isolated Convex test deployment and deploy this candidate's functions.
2. Create a Vercel preview after installing the exact API variables.
3. Verify health and invalid-signature behavior directly.
4. Create exactly one Stripe test endpoint and redeploy after installing its signing secret.
5. Submit a unique synthetic order and complete Stripe test Checkout.
6. Verify Stripe delivery logs and query Convex directly: one customer job, one fulfillment job, one provider event.
7. Replay the exact event and prove no additional event or transition.
8. Run generation and record the qualified human review decision.
9. Publish only the approved artifact to a Vercel preview/stable test route.
10. In the separate operator runtime, send through Resend to `delivered@resend.dev`, then reconcile the exact message ID.
11. Re-check that no provider payload or plaintext intake token was persisted.
12. Complete Kanban task `t_b5ed0ad9` so the landing client accepts the exact approved HTTPS API origin while preserving loopback-only local mode.
13. Only an independently approved release may change the landing API base URL or open customer traffic.

## Rollback

Before customer traffic, rollback is configuration-only: restore or unset the landing API base URL, disable the single Stripe test endpoint, remove the Vercel preview alias, and revoke scoped Convex/Resend credentials. Preserve Convex records and provider logs as evidence. The prior local TEST-A and dormant Tally/Supabase code remain available until the observation window is accepted.

## Exact boundary

The app candidate is the signed commit containing this report. This task does not modify the landing repository. The required landing HTTPS-origin compatibility increment is isolated in `t_b5ed0ad9`, which is now an additional parent of the pre-created independent review/release child. No candidate is authorized for push or deployment until that child approves the exact SHAs.
