# Five controlled EUR1 tests — owner1038

## Authority and scope

Task t_34751512 starts from signed installation 4fe9296454739a135013b73b65d334c95269445f. Owner receipts1037/1038 on release t_18eae3ac authorize at most five controlled tests, a native Stripe EUR38 reduction on the EUR39 offer, EUR1 voluntarily paid, and deactivation when testing ends. These tests are not the EUR39 first sale. This implementation performs no provider mutation, credential/customer/payment read, deployment or outreach. Independent review is t_f0b0dcc0.

Ordinary EUR39 settlement, complimentary/owner-trial handling, exact text/terms/publication consent, genuine human editorial review and uncertain-effect fences remain mandatory and unchanged except for the explicit promotional amount policy below. No checkout creator or coupon engine is added.

## Trusted configuration contract

Default OFF: `BEBEBONJOUR_PAID_TEST_PROMO_ENABLED` must equal `true`. Server-only `BEBEBONJOUR_PAID_TEST_PROMO_JSON` contains:

- `policyId`: literal `owner1038-five-tests-v1` (never rotate/reset to obtain more uses).
- `providerAccountId`, boolean `livemode`, `couponId`, `promotionCodeId`, finite integer `endsAtMs`.
- `bindings`: at most five distinct `{jobId, revision, previewDigest, checkoutSessionId}` objects, prepared by the authorized operator for exact currently approved paid orders. Session IDs and jobs are unique. No customer input or PaymentIntent metadata authorizes this list.

Configure an exact binding before allowing the tester to pay; Session and PaymentIntent metadata both carry project, paid order mode, exact job/revision/digest. Copy current approval data through the authorized operator surface, not a browser assertion. The static list may be filled incrementally but never repurpose a consumed slot. No announcement text, customer identity, credentials or review capabilities belong in this policy. Expiry is checked at inspection and transactional commit.

Inspection retrieves only the bound Checkout Session, specified promotion and coupon, in the configured account. It requires a complete paid one-time Session, matching PaymentIntent/scope/mode, EUR3900 subtotal, EUR3800 discount, EUR100 total, zero shipping/tax, and exactly the specified native promotion/coupon. Coupon: amount_off3800, currency eur, percent_off null, duration once, max_redemptions5. Promotion: same coupon, max_redemptions5. Both redemption counts must be integers in1..5. Exhaustion may make active/valid false; historical settled evidence is still valid while the local policy remains enabled/unexpired. Arbitrary inactive objects do not authorize a payment without its exact settled Session.

PaymentIntent/latest charge retain genuine succeeded/paid/captured, no refund/dispute, account/live/currency and scope checks at EUR100. The signed succeeded event may pass EUR100 only for an enabled exact policy scope; provider inspection and transactional binding remain authoritative. No global price is lowered. Settlement stores only a redacted promotion receipt in the existing financial ledger/order. A policy index enforces at most five lifetime accepted receipts atomically across configuration edits, including synthetic test-mode receipts; Session reuse is denied. Duplicate receipts do not consume another use. Deleting customer content does not reset this financial ledger.

Deactivation disables new discounted inspection/commit. Already committed payments remain eligible under their immutable verified promotional receipt, subject to all normal approval/editorial/effect gates. Deactivation is not cancellation, refund or erasure. Cancellation/revocation remains the way to freeze an already settled order.

## Release-only provider setup and readback

1. Under exact release authority, create one native once-only EUR3800 coupon with max_redemptions5, bounded redeem_by, then one promotion code for that coupon with max_redemptions5 and bounded expires_at. Read back IDs, amounts, currency, duration, caps, account/mode and expiry. Do not create replacements or additional codes/coupons to extend the five-test allowance. Keep normal EUR3900 price and consumer total unchanged.
2. Supervised Session issuance uses one EUR3900 one-time item, no automatic tax/shipping uplift, the exact promotion code, matching Session/PaymentIntent metadata, no subscription or automatic charge. Read back subtotal/discount/total and native IDs. Bind its exact cs_ ID and current approval before inviting voluntary checkout. Never use a generic Payment Link shared across orders.
3. Install reviewed successor/schema (additive promotion receipt fields/index only) and disabled policy first; validate exact bindings, bounded end time and provider read capability before enabling. Required existing read paths: account, PaymentIntent/expanded charge; additional exact GET paths: `/v1/checkout/sessions/:id`, `/v1/promotion_codes/:id`, `/v1/coupons/:id`. No list/inventory or write endpoint is used by this implementation.
4. Receipt1037 says the dedicated key grants only Accounts, Payment Intents, Charges and Refunds Read; other controls are None. Therefore promotional native-object reads are a known missing production capability. Do not broaden that key or substitute dashboard assertions for provider proof. Release must obtain separately authorized capability/credential selection or leave promotion disabled. Permission/network/configuration failures remain retryable503 with no successful settlement receipt. This source PASS cannot establish live capability or E2E acceptance.
5. At test end disable the local flag first and read it back; deactivate the exact promotion via native Dashboard/API and verify active=false. Expire all still-open bound Sessions and read back expired; disabling a code alone must not be assumed to invalidate existing Sessions. Retain the coupon/promotion identities and financial receipts. Replayed committed events remain no-ops; no uncommitted discounted receipt is admitted. Preserve all journals/uncertain effects. Rollback is feature-disable on this compatible successor, not source/schema downgrade.

## Offline proof

Tests use explicitly synthetic provider transport, actual signed HTTP/Convex transactions and blocked network. Verify exact scoped success, ordinary isolation, caps (including config rotation), stale/tampered approvals/provider objects, permission failure, duplicate/concurrent receipts, expiry/deactivation, test-only refusal and unchanged owner-trial behavior. Run repository verification under Node22 plus actual offline Convex bundles. No real payment, provider state or delivery is claimed.

The source distribution must contain all Git-tracked runtime assets, specifically the dynamically loaded `schemas/codex-subscription-composition.schema.json` from signed4fe9296, SHA256 `042b96d94b7c77461e02e55a92af7a828b4619c7701aab25f9abb41d98f56914`. The earlier146-file installation subset is not a complete worker distribution. Run `node scripts/run-delivery-loop-worker.mjs --help` in a clean extracted source archive with pinned dependencies and no provider credentials before installation; this imports the worker but starts no worker loop or provider operation. Preserve the original installation manifest and recovered owner-trial hashes; `ops/promotion-candidate-pins.json` explicitly overlays only the scoped successor files and pins the dynamic asset.
