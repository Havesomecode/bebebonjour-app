# Five controlled EUR1 tests — owner1038

The scoped five-test policy is separate from the ordinary EUR39 offer. Source configuration alone does not authorize a payment or provider change.

## Trusted configuration contract

Default OFF: `BEBEBONJOUR_PAID_TEST_PROMO_ENABLED` must equal `true`. Server-only `BEBEBONJOUR_PAID_TEST_PROMO_JSON` contains:

- `policyId`: literal `owner1038-five-tests-v1` (never rotate/reset to obtain more uses).
- `providerAccountId`, boolean `livemode`, `couponId`, `promotionCodeId`, finite integer `endsAtMs`.
- `bindings`: at most five distinct `{jobId, revision, previewDigest, checkoutSessionId}` objects, prepared by the authorized operator for exact currently approved paid orders. Session IDs and jobs are unique. No customer input or PaymentIntent metadata authorizes this list.

Configure an exact binding before allowing the tester to pay; Session and PaymentIntent metadata both carry project, paid order mode, exact job/revision/digest. Copy current approval data through the authorized operator surface, not a browser assertion. The static list may be filled incrementally but never repurpose a consumed slot. No announcement text, customer identity, credentials or review capabilities belong in this policy. Expiry is checked at inspection and transactional commit.

Inspection retrieves only the bound Checkout Session, specified promotion and coupon, in the configured account. It requires a complete paid one-time Session, matching PaymentIntent/scope/mode, EUR3900 subtotal, EUR3800 discount, EUR100 total, zero shipping/tax, and exactly the specified native promotion/coupon. Coupon: amount_off3800, currency eur, percent_off null, duration once, max_redemptions5. Promotion: same coupon, max_redemptions5. Both redemption counts must be integers in1..5. Exhaustion may make active/valid false; historical settled evidence is still valid while the local policy remains enabled/unexpired. Arbitrary inactive objects do not authorize a payment without its exact settled Session.

PaymentIntent/latest charge retain genuine succeeded/paid/captured, no refund/dispute, account/live/currency and scope checks at EUR100. The signed succeeded event may pass EUR100 only for an enabled exact policy scope; provider inspection and transactional binding remain authoritative. No global price is lowered. Settlement stores only a redacted promotion receipt in the existing financial ledger/order. A policy index enforces at most five lifetime accepted receipts atomically across configuration edits, including synthetic test-mode receipts; Session reuse is denied. Duplicate receipts do not consume another use. Deleting customer content does not reset this financial ledger.

Deactivation disables new discounted inspection/commit. Already committed payments remain eligible under their immutable verified promotional receipt, subject to all normal approval/editorial/effect gates. Deactivation is not cancellation, refund or erasure. Cancellation/revocation remains the way to freeze an already settled order.

## Operations and verification

The policy requires exact provider read access and bound sessions; never broaden credentials or create provider resources without separate authorization. Deactivate the flag when testing ends and verify provider-side sessions and promotion state under appropriate authority. Keep financial receipts and uncertain-effect fences. See `src/delivery-loop/test-promotion.mjs` and `test/backend/delivery-loop-paid.test.mjs`; local tests do not establish provider configuration or a real payment.
