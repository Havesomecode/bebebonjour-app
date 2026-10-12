# Offline paid-event support diagnostics

## Run the first synthetic failure

From the candidate checkout, with Node 22:

```sh
node scripts/diagnose-paid-support.mjs test/fixtures/paid-support/inspection-retry.json
node scripts/diagnose-paid-support.mjs test/fixtures/paid-support/final-effect-uncertain.json
node scripts/diagnose-paid-support.mjs test/fixtures/paid-support/duplicate-noop.json
node --test test/delivery-loop/support-diagnostics.test.mjs
```

This is offline, read-only advice for t_6e212d76, split from t_533a42b3. It adds no
runtime route, database, monitoring service, worker transition or recovery mutation.
Reports explicitly say `authorizesEffects: false` and `provesProviderState: false`.
All shipped fixtures are synthetic, including fields labelled live/settled: those
labels exercise diagnosis, never establish a genuine payment or provider receipt.

## Input and privacy boundary

The CLI accepts one JSON file or `-` for stdin, at most 65536 bytes, strict UTF8.
Exit 0 means a valid diagnostic report, **not** healthy payment/fulfillment. Exit 2
means invalid input; the error never echoes input, a path, a stack or provider error.
No environment credential is read. There are no network, provider or datastore
calls. Output goes to stdout; the CLI does not persist input or execute advice.

Use `schemaVersion: 1` and `source: synthetic` or `redacted_snapshot`. A later
separately authorized operator may prepare a minimal redacted snapshot; this card
has not read customer/payment records or certified a live projection/export path.
Never feed raw order records or webhook bodies into this tool. Whitelists reject
unknown fields; arbitrary identifiers are hashed before output, even if they pass
syntax checks. Hashes are correlation pseudonyms, **not anonymization**: keep reports
private, access-limited and under the existing evidence-retention rules.

Supported top-level keys are `schemaVersion`, `source`, `http`, `request`, `receipt`,
`order`. The fixtures are executable schema examples:

- `http`: existing webhook status and sanitized code only (200 disposition,
  400 signature/format, 413 size, 503 `payment_event_retry`).
- `request`: allowlisted account/event/raw-byte fingerprint and optional
  PaymentIntent/job/revision/preview digest, using the existing event field names.
  This is correlation, not a signed body or authentication claim.
- `receipt`: exact `deliveryLoopPaymentEvents` projection, without Convex `_id`
  or `_creationTime`; retain only request fields plus `type`, `livemode`,
  `disposition`, allowlisted `reason`, `processedAtMs`.
- `order`: `jobId`, `status`, `orderMode`, `paymentStatus`, `cancelled`, `revoked`,
  `previewExpired` from existing safe status, plus `uncertainEffect` and
  `narrationEffects` projected from the protected aggregate or separately retained
  evidence. `deliveryLoopData:inspect` exposes `retainedEvidence` when retained;
  it is not a new live-order export API. Omit the uncertain effect's
  `emailIdempotencyKey`; retain only stage/revision/startedAtMs in uncertainEffect.
  Narration entries retain revision/language/textDigest/status/startedAtMs only.
  Native narration statuses are `inflight` and `complete`.
  Native frozen statuses include `revoked` and `data_deleted`. For a deleted
  tombstone without retained payment state, use `paymentStatus: null`; this means
  unknown in the projection, never pending, settled or refunded. Omitted current
  effects must not be treated as proof that separately retained fences are absent.

Never include prose/composition, email addresses, metadata bags, instrument/billing
information, review/worker/editorial tokens, signatures, keys or unbounded errors.
The exact identifiers/fence records remain in the existing protected system for
supervised reconciliation, not in this report. A missing receipt/order in supplied
input does not prove that no durable receipt/order exists.

## Operator recovery examples

1. **Inspection/commit uncertainty:** `inspection-retry.json` produces
   `payment_event_retry_unknown`, assigned to `release_operator`. A 503 is neither
   a durable rejection nor proof of no charge/commit. Look up the exact native
   account/event/fingerprint receipt first. Resolve only the specific custody,
   configured account, read-permission, datastore or transport issue under its
   existing authority. Do not expand key permissions. Separately authorized signed
   transport redelivery may preserve exact bytes with a current signature; it is
   not narration/email/payment/refund replay. If a receipt was committed despite
   the 503, diagnosis instead reports `retry_response_receipt_observed`.
2. **Lost final-effect receipt:** `final-effect-uncertain.json` produces critical
   `final_effect_uncertain`, assigned to `support_operator`, even with settled
   payment. Preserve the lease and narration/email fences. The accountable human
   inspects exact recorded provider identifiers and genuine effect evidence under
   separate authority. Lost narration receipt has no automatic recovery mutation;
   do not clear a fence, restart work or resend an uncertain effect. This harness
   diagnoses the hold; it does not pretend to recover it.
3. **Exact duplicate:** `duplicate-noop.json` produces `exact_receipt_noop` and
   `settlement_receipt_observed`. Full supplied request correlation must match the
   immutable receipt; changed account, bytes, scope or order produces a critical
   mismatch instead. Existing adapter replay is a no-op; diagnosis itself performs
   none. Test-only evidence stays non-live. Durable rejected receipts also stay
   rejected/no-op, including after approvals change. Resolve scope with the human
   operator and, only if separately authorized, use existing `reconcilePaidPayment`
   for genuine current inspection; never edit the ledger or invent an event ID.
4. **Cancellation/refund support:** `order_frozen` and closed-scope rejections
   preserve the existing freeze-first path. The support operator owns case triage;
   the separately authorized provider-action operator owns any refund/remediation.
   Use existing authenticated cancellation or data-operator revocation as applicable,
   then read back frozen state and denied final access **before** an approved
   provider action. Cancelled is not refunded. Verify the genuine refund receipt,
   retain financial/effect evidence, and keep the order frozen. No refund endpoint,
   provider write or refund guarantee is added by these diagnostics.

Role labels are escalation responsibilities, not proof a person/mailbox/on-call
rotation is provisioned. The existing lane must name actual accountable operators
and exercise live alert/inbox/refund/monitoring acceptance; this offline split does
not close t_533a42b3 or its payment-cutover dependency.

## Accepted source and evidence consumed

Baseline signed commit `f64d2f8030ee8a574f87491db5aa1368194b52cf`, tree
`03a507428ff34d1a35b38835ba896794d7bd710b`; retain the scoped payment-delta PASS
on t_c3bcce11 attachments 935–937. This diagnostics delta does not re-certify that
runtime or override [paid-route-a-runbook.md](paid-route-a-runbook.md), especially
“Authentication and receipt contract” and “Operator recovery and separately
authorized refunds”; data controls remain in
[paid-route-a-data-controls.md](paid-route-a-data-controls.md).

Consumed t_18eae3ac readiness receipt attachment 940,
`redacted-readiness-receipts.json.gz`, SHA256
`d859af30afcc0f7cd5cbd9c54f87bc0fe4b4571971aa52726b63227bc34937f6`.
That snapshot reported missing designated restricted account-read custody, absent
paid configuration and an active host worker different from the reviewed candidate.
These are historical readiness observations, not current provider proof or this
harness's synthetic failure output. No live request, credential setup, worker swap,
activation, deployment, charge/refund or customer contact is authorized here.
