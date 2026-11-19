# Paid Route A: current-loop candidate and supervision

## Boundary

The flow itself is specified in [operator-gated-intake.md](operator-gated-intake.md): request → operator reads and launches a brief → €39 Checkout link by email → verified payment → generation → corrections/approval. This runbook covers configuration, payment evidence and recovery.

Paid admission requires `BEBEBONJOUR_PAID_ROUTE_A_ENABLED=true` and an HTTPS `BEBEBONJOUR_PAID_TERMS_URL`. Operator notices need `BEBEBONJOUR_OPERATOR_EMAIL` and an HTTPS `BEBEBONJOUR_OPS_CONSOLE_URL`; without them the notice is recorded `failed` (`operator_notice_unconfigured`) and the order still waits in the console.

## Customer contract

1. €39 total, one time, French or Arabic, narration included, two customer corrections. Terms version `route-a-39-v2` is served at `GET /delivery/terms/route-a-39-v2`. Terms, publication permission and the adult/mainland-France/parental declaration are recorded at submit.
2. Nothing is generated before the operator launches and the payment is settled. The Checkout Session (created on click from the order page, 23 h expiry) binds `job_id`, `revision=1` and the revision-1 brief digest in the `preview_digest` metadata key (name kept for the webhook contract).
3. After payment the announcement is generated, narrated and published at its private link like a complimentary order; the page shows a draft banner until the customer approves. Paid speech reads exactly the displayed `introLines`, `blessingLines` and `closingLines`.
4. A correction goes back to the operator, who edits the brief for the next revision; no new payment. Approval sends the final email. Twelve calendar months of hosting start at final delivery.

## Controlled promotional successor

The ordinary price and all consent/human-review requirements below remain EUR39. The sole discounted exception is [the owner1038 five-test policy](paid-test-promotion.md): exact trusted approved-order/native Checkout/promotion/coupon binding, EUR38 reduction and EUR1 genuinely settled, maximum five lifetime receipts, disabled by default. Its explicit configuration, missing provider-read capabilities and deactivation procedure govern promotional tests; they do not count as a EUR39 first sale. No provider mutation or checkout creator is introduced.

## Supervised payment operations

`/delivery/operator` holds `BEBEBONJOUR_PAID_EDITORIAL_TOKEN` (≥32 characters, never the worker token, never mounted into the worker). It reads an order, reconciles a genuine Stripe PaymentIntent (read only: account, PaymentIntent and latest charge; EUR3900, exact metadata, mode, no refund/dispute) and cancels. Launch/refuse happen in the ops console with `BEBEBONJOUR_OPERATIONS_TOKEN`. Test evidence is `test_only` and never unlocks generation.

## Recovery and downstream privacy hooks

Email idempotency keys remain `bebe-loop:<jobId>:<revision>:<stage>`. Paid email and narration have server-side effect fences as well as the existing private local journal. A second invocation or uncertain effect cannot automatically rerun, even on a different worker with no local journal. An uncertain job retains its exact fence in `reconciliation_required`; do not clear it, invent a receipt, or blindly retry a paid effect. Existing recorded email/provider inspection can establish an exact effect. A lost narration receipt requires supervised evidence reconciliation; no automatic recovery mutation is supplied here.

The operator can cancel the exact order. Cancellation immediately denies private/public reads and downstream effects, but is NOT a refund confirmation or asset erasure. The job aggregate contains consent/customer declarations, launched briefs, payment receipt, original composition bytes, revisions, narration/email receipts, cancellation/revocation timestamps, delivered time and hosting end. `deliveryLoopPaymentEvidence` is a deduplication ledger, not another order aggregate.

Task t_66e1f464's accepted successor implements the actual private final text/audio/ZIP export, capability-authorized revocation/deletion, paginated fenced closure notices and retention scheduler. Its operational limits, separately retained financial/effect evidence and backup/import deletion procedure are authoritative in [paid-route-a-data-controls.md](paid-route-a-data-controls.md). Application source proofs do not establish deployed cron, real notice receipt or backup-provider deletion; those remain exact release checks.

## Signed paid-event adapter (t_63d37b86)

This source successor consumes accepted `fe2e92800935c6bd65925b9c358783b4d557269f`. Only source-spec sections 3–5 and the restricted-read-key seam are in scope; [the retained original specification](paid-event-source-spec.md) includes excluded proposed checkout/UI sections 1–2. There is no checkout creator, session issuance, Price configuration, subscription, refund endpoint or automated charge in this delta. Supervised external session issuance remains a separately authorized release procedure, with the same exact metadata and consumer total; the paid-preview flag is not checkout authority.

### Authentication and receipt contract

`POST /delivery/payment/webhook` lives on the existing Convex HTTP boundary. Proposed destination is `https://tacit-antelope-577.convex.site/delivery/payment/webhook`; no destination, signing secret or subscription has been configured by this source work. Use only `payment_intent.succeeded`, never wildcard subscription or the legacy TEST-A webhook. The dedicated server-only `BEBEBONJOUR_PAID_STRIPE_WEBHOOK_SECRET` is distinct from `STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET`.

The adapter accepts uncompressed `application/json` bytes, streams at most 65536 bytes (including requests without Content-Length), bounds Stripe-Signature to 2048 characters/eight v1 signatures, and verifies HMAC-SHA256 over `<timestamp>.<exact raw bytes>` before strict UTF8/JSON decoding. Tolerance is ±300 seconds; repeated timestamps, stale/future timestamps, bad signatures, unexpected event format/type and oversized requests fail closed. Multiple v1 signatures support signing-key rotation. Transport retries must preserve the body bytes, though the current signature timestamp may change.

Only the allowlisted correlation envelope reaches the internal Node action. It reuses genuine configured-account/PaymentIntent/expanded-latest-charge inspection; browser or worker assertions cannot submit evidence. Existing restricted `rk_live_`/`rk_test_` credentials are supported with the same bounded provider retries/timeouts as `sk_` keys. Account and PaymentIntent/latest-charge read permissions are required; permission refusal or bad configuration yields retryable503, not permission expansion. Key, event, intent and charge modes must match. EUR3900, exact job/revision/digest, paid/captured settlement and no current refund/dispute remain mandatory.

`deliveryLoopPaymentEvents` is immutable and redacted: configured account, evt_ ID, event type/mode, exact raw-body SHA256, bounded optional PaymentIntent/job/revision/digest, disposition/reason and processed time. It contains no raw body, customer/billing/instrument fields, client secret, review capability or unbounded provider error. It is separate financial/replay evidence retained with `deliveryLoopPaymentEvidence`, not another order aggregate or part of customer content exports/erasure; apply the same separately governed financial-evidence retention/backup controls. Neither table is a licence to retain announcement text or instrument data.

One Convex transaction checks identity/fingerprint, the active paid order, the revision-1 brief digest, the recorded `route-a-39-v2` consent and PaymentIntent uniqueness, then commits existing settlement plus event receipt. Concurrent exact duplicates do not touch the job/version/audit or receipt and skip provider inspection once a receipt exists. Same event ID with different bytes creates a separate immutable conflict rejection without overwriting the first receipt or changing the order. Test receipts are visibly `test_only` and never authorize live final effects. A settled payment on a `payment_pending` order queues generation; it never replays narration/email/publication.

HTTP200 reports `settled`, `test_only` or `rejected` only after durable transaction success; rejection reason remains private in the ledger. Signature/format failures use400, body overflow413, and provider/configuration/datastore uncertainty503 without a success receipt. A durably rejected event is never resurrected by changing approvals or replaying it. Reconcile the exact genuine current PaymentIntent through the existing private human operator action after resolving scope; do not edit the ledger, invent a fresh event ID, or clear a final-effect fence. Wrong job, reused PaymentIntent, wrong brief digest, cancellation/deletion/expiry and signed business mismatches are durable rejections.

### Operator recovery and separately authorized refunds

1. Freeze the relevant order first: use the existing authenticated operator cancellation, or operator revocation for public removal. Read back the cancelled/revoked state and denied final claims/private-public access before any separately authorized provider refund/dispute remediation. Preserve uncertain speech/email/publication fences and recorded provider identifiers.
2. With explicit authority for that exact provider action, inspect genuine account/PaymentIntent/latest charge, known refunds/disputes and effect receipts. A cancellation/revocation is not evidence of refund. This succeeded-event adapter is not a refund/dispute event monitor and does not revoke historical settlement automatically.
3. Perform any approved refund/remediation manually with its own verified provider receipt. Keep distinct minimal financial/effect evidence and follow the accepted data-control deletion/retention procedure; never fabricate a refund receipt or delete replay evidence during rollback.
4. Keep the order frozen after refunded/disputed evidence. New inspection refuses such evidence; old signed replays cannot reopen it. A valid receipt reflects inspection at that moment, not a guarantee that future provider state cannot change. Never repeat uncertain final effects or unfreeze merely because Stripe redelivered a succeeded event.

Focused offline proof: `node --test test/convex/delivery-loop-payment-events.test.mjs test/convex/delivery-loop-paid.test.mjs test/convex/delivery-loop-reviewed-narration.test.mjs test/convex/delivery-loop-data.test.mjs test/convex/delivery-loop.test.mjs test/convex/production-bundle.test.mjs`. The inherited privacy scheduler fixture has the already accepted Convex-test/Node MockTimers wall-clock race; use the verification-only `frozen-privacy-clock.mjs` retained in the evidence packet for that fixture alone. Preserve any unfrozen failure receipt; payment and SR-01 proofs use the real clock. New fixtures exercise actual HTTP bytes, SDK reads through a synthetic transport and real internal Convex action/transaction seams; HTTP/HTTPS/fetch are hard-blocked. No checkout/session idempotency proof is claimed because checkout creation is explicitly excluded. Independent payment-delta PASS and exact production/action-specific authorization remain pending after implementation handoff.

## Prior security source reconciliation

The canonical delivered source lacked the reviewed security successor, whose original signed object `876ce8be6b03c2a53f0178aa9a4174cf25b118ef` is unavailable in this clone. The durable archive is SHA256 `77d477c99e52b19548bda831d24d5c389d4e74fb4242e95432ee1e9accd61ca4`; its release packet supplies per-file hashes and baseline `c86664a3011519b63084c976140ef9f11893ae04`.

The recovered HTTP/runtime/security source files were unchanged from that baseline, verified before each replacement. The archive's exact hashed abuse/content/recovery controls and regressions were restored selectively. Its abuse-budget table was added beside—not instead of—the newer delivery schema; no old HTTP route/schema file was copied wholesale. Reviewed dependency overrides and the Vercel CLI62.7.0 security update were merged into the current manifest, not an older Route A package/service. The recovered production-bundler regression was adapted to the current component-config-free app and expanded to verify paid isolate modules versus Node provider actions. Machine-generated historical TEST-A boundary evidence may be refreshed for this candidate; that is not independent editorial or release approval.

## Offline verification

Run under Node22: `npm ci --ignore-scripts`, `npm run verify`. Focused regressions are `node --test test/convex/delivery-loop-paid.test.mjs test/convex/delivery-loop.test.mjs test/delivery-loop/worker.test.mjs test/security/*.test.mjs test/convex/production-bundle.test.mjs`.

Paid tests cover disabled admission, preview/parental permission, independent exact customer/terms/publication decisions, wrong/missing/test/waived/duplicate/misbound settlement, missing/simulated editorial approval, correction/stale revision/expiry/renewal/cancellation boundaries, frozen serialization/digest integrity, uncertain-effect fencing, and public denial. The actual durable worker and Convex provider actions are exercised for corrected French and Arabic orders with explicitly synthetic offline provider responses. Browser scripts execute against real offline HTTP mutations; no live order, actual paid provider call, customer contact, deployment or sale is test evidence.
