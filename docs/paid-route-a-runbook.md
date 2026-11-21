# Paid Route A: supervision

## Boundary

The flow itself is specified in [operator-gated-intake.md](operator-gated-intake.md): request → operator reads and launches a brief → €39 Checkout link by email → verified payment → generation → corrections/approval. This runbook covers configuration, payment evidence and recovery.

Paid admission requires `BEBEBONJOUR_PAID_ROUTE_A_ENABLED=true` and an HTTPS `BEBEBONJOUR_PAID_TERMS_URL`. Operator notices need `BEBEBONJOUR_OPERATOR_EMAIL` and an HTTPS `BEBEBONJOUR_OPS_CONSOLE_URL`; without them the notice is recorded `failed` (`operator_notice_unconfigured`) and the order still waits in the console.

## Customer contract

1. €39 total, one time, French or Arabic, narration included, two customer corrections. Terms version `route-a-39-v2` is served at `GET /delivery/terms/route-a-39-v2`. Terms, publication permission and the adult/mainland-France/parental declaration are recorded at submit.
2. Nothing is generated before the operator launches and the payment is settled. The Checkout Session (created on click from the order page, 23 h expiry) binds `job_id`, `revision=1` and the revision-1 brief digest in the `preview_digest` metadata key (name kept for the webhook contract).
3. After payment the announcement is generated, narrated and published at its private link like a complimentary order; the page shows a draft banner until the customer approves. Paid speech reads exactly the displayed `introLines`, `blessingLines` and `closingLines`.
4. A correction goes back to the operator, who edits the brief for the next revision; no new payment. Approval sends the final email. Twelve calendar months of hosting start at final delivery.

## Controlled promotional successor

The ordinary price and all consent/human-review requirements below remain EUR39. The sole discounted exception is [the owner1038 five-test policy](paid-test-promotion.md): exact trusted approved-order/native Checkout/promotion/coupon binding, EUR38 reduction and EUR1 genuinely settled, maximum five lifetime receipts, disabled by default. Its explicit configuration, missing provider-read capabilities and deactivation procedure govern promotional tests; they do not count as a EUR39 first sale. The customer can initiate Checkout from the order page; provider changes require separate authorization.

## Supervised payment operations

`/delivery/operator` holds `BEBEBONJOUR_PAID_EDITORIAL_TOKEN` (≥32 characters, never the worker token, never mounted into the worker). It reads an order, reconciles a genuine Stripe PaymentIntent (read only: account, PaymentIntent and latest charge; EUR3900, exact metadata, mode, no refund/dispute) and cancels. Launch/refuse happen in the ops console with `BEBEBONJOUR_OPERATIONS_TOKEN`. Test evidence is `test_only` and never unlocks generation.

## Recovery and downstream privacy hooks

Email idempotency keys remain `bebe-loop:<jobId>:<revision>:<stage>`. Paid email and narration have server-side effect fences as well as the existing private local journal. A second invocation or uncertain effect cannot automatically rerun, even on a different worker with no local journal. An uncertain job retains its exact fence in `reconciliation_required`; do not clear it, invent a receipt, or blindly retry a paid effect. Existing recorded email/provider inspection can establish an exact effect. A lost narration receipt requires supervised evidence reconciliation; no automatic recovery mutation is supplied here.

The operator can cancel the exact order. Cancellation immediately denies private/public reads and downstream effects, but is NOT a refund confirmation or asset erasure. The job aggregate contains consent/customer declarations, launched briefs, payment receipt, original composition bytes, revisions, narration/email receipts, cancellation/revocation timestamps, delivered time and hosting end. `deliveryLoopPaymentEvidence` is a deduplication ledger, not another order aggregate.

The backend implements the actual private final text/audio/ZIP export, capability-authorized revocation/deletion, paginated fenced closure notices and retention scheduler. Its operational limits, separately retained financial/effect evidence and backup limitations are authoritative in [paid-route-a-data-controls.md](paid-route-a-data-controls.md). Application source proofs do not establish deployed cron, real notice receipt or backup-provider deletion; those remain exact release checks.

## Payment events and recovery

`POST /delivery/payment/webhook` is implemented at the Railway backend. It verifies Stripe signatures over bounded raw bytes and inspects the configured account and PaymentIntent before recording settlement and a redacted event receipt. Exact duplicates are fenced; a conflicting event identity cannot overwrite the first receipt. See [payment event contract](paid-event-source-spec.md).

Use the protected operator interface to inspect or reconcile the exact order. Cancellation is not a refund. Freeze the relevant order and preserve effect evidence before any separately authorized refund or dispute remediation. Do not repeat an uncertain effect, fabricate receipts or clear fences to make a retry work.

## Offline verification

Run `node --test test/backend/delivery-loop-payment-events.test.mjs test/backend/delivery-loop-paid.test.mjs test/backend/delivery-loop-data.test.mjs test/backend/delivery-loop.test.mjs`. Synthetic fixtures do not establish real payment, hosted operation or customer delivery.
