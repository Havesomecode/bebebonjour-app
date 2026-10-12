# Paid Route A: current-loop candidate and supervision

## Boundary

This is an offline implementation candidate for task t_d4163412, not a live-sale or deployment authorization. `/delivery?mode=paid_route_a` explicitly selects the EUR39 mode. Default `/delivery`, existing complimentary rows, password-waived payment, and their pre-review narration/publication/email remain unchanged. No alternate order database, SQLite runtime, legacy Route A operator, simulated editorial approval, or waived settlement is introduced.

The paid mode defaults OFF. Configuration is described in `.env.example`; admission requires `BEBEBONJOUR_PAID_ROUTE_A_ENABLED=true` and an HTTPS `BEBEBONJOUR_PAID_TERMS_URL`. Do not enable the flag merely because the candidate passes tests. The exact customer-facing terms, successor export/retention work and action-specific release/sale authority must be ready at the actions they govern. Optional general professional review is not a blanket prerequisite for offline implementation.

## Customer contract and transitions

1. Free private text preview, French OR Arabic, with final narration included in the EUR39 one-time consumer-total offer. Two customer-requested editorial corrections are counted; technical generation retries do not consume another correction. Initial paid input is restricted to general wishes until the separate religious-permission/legal-basis work is ready. Adult mainland-France/parental-permission declaration and preview permission are recorded independently of purchase/publication.
2. Preview text and its validated original composition serialization are frozen together. Each available preview gets 24 elapsed hours from the acknowledged availability email, including a corrected preview. One supervised renewal grants 24 more hours without creating an approval. Provider acceptance is not proof of inbox receipt; email inspection remains available for reconciliation.
3. Customer approves an exact revision and preview digest. A separate unchecked terms/publication form accepts `route-a-39-v1`, recording the configured terms URL and consent time for that revision. No implicit consent from expiry, silence, correction, payment, or editorial review. The approved text is locked; post-approval changes require supervised support rather than silently charging for or publishing a different revision.
4. Genuine Stripe settlement and a separately authenticated human editorial attestation must bind the same job, revision and preview digest. Only then is `finalize` claimable. The worker narrates the frozen composition, never recomposes it, and publishes the exact approved HTML. Narration, publication and final email recheck eligibility before effects and at receipt commit. Public text/audio queries also fail closed if consent/payment/editorial state changes, cancellation/revocation occurs or hosting expires.
5. Final-link email follows successful narration/publication. Twelve calendar months of hosting begin at acknowledged final delivery, not preview creation; leap-day anniversaries clamp to month end. Delivery target is five working days after approval AND confirmed payment. Support is contact@bebebonjour.com, initial response target two working days; this candidate does not provision or verify that mailbox. No automatic renewal, recurring charge or discretionary refund guarantee is implemented or implied.

## Supervised payment and editorial operations

`/delivery/operator` is a minimal private capability interface. Its distinct `BEBEBONJOUR_PAID_EDITORIAL_TOKEN` must have at least 32 characters and cannot equal the delivery worker credential. Keep it with the genuine human operator; never mount it into the autonomous generation worker. It is not saved in browser storage or placed in URLs. Read the exact private preview, personally inspect the text, and attest with the exact digest, revision and a bounded reviewer identifier. Possession of this credential is the authorization boundary, not an assertion that software can prove a human read.

Payment reconciliation is READ ONLY. The candidate does not create Checkout Sessions, PaymentIntents, charges or refunds. A supervised, separately authorized voluntary Stripe payment must carry these PaymentIntent metadata fields:

- `project=bebebonjour`, `order_mode=paid_route_a`
- `job_id=<exact current jobId>`, `revision=<approved revision as decimal string>`
- `preview_digest=<exact approved contentDigest>`

Use only the configured `BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID` and server-side `STRIPE_SECRET_KEY`. The action retrieves that account and the PaymentIntent with its expanded latest charge. It checks succeeded/captured/paid status, EUR3900 received, EUR currency, exact metadata, matching charge/intent mode and no known refund/dispute. Only the internal mutation can persist settlement. A PaymentIntent ID is globally deduplicated; wrong job/revision/digest/account/amount/currency is denied. Test evidence is visibly `test_only` and cannot authorize delivery; a different genuine live payment is required. The provider is the authority, not browser paid flags, an operator assertion, synthetic fixtures or a complimentary waiver.

Payment instructions/collection remain supervised through support, not an automated customer checkout. Metadata reconciliation proves the provider's current record, not an immutable history of changes to Stripe metadata; restrict provider-dashboard access accordingly. This is a deliberate minimal Route A boundary, not a payment platform.

## Recovery and downstream privacy hooks

Email idempotency keys remain `bebe-loop:<jobId>:<revision>:<stage>`. Paid email and narration have server-side effect fences as well as the existing private local journal. A second invocation or uncertain effect cannot automatically rerun, even on a different worker with no local journal. An uncertain job retains its exact fence in `reconciliation_required`; do not clear it, invent a receipt, or blindly retry a paid effect. Existing recorded email/provider inspection can establish an exact effect. A lost narration receipt requires supervised evidence reconciliation; no automatic recovery mutation is supplied here.

The operator can renew a preview once or cancel the exact order. Cancellation immediately denies private/public reads and downstream effects, but is NOT a refund confirmation or asset erasure. The existing job aggregate contains preview deadlines, consent/customer declarations, editorial attestation, payment receipt, original composition bytes, revisions, narration/email receipts, cancellation/revocation timestamps, delivered time and hosting end. `deliveryLoopPaymentEvidence` is a deduplication ledger, not another order aggregate.

Task t_66e1f464 consumes this immutable candidate to implement verified export, retention/erasure, supplier/data controls and pre-closure notices. A `revokedAtMs` field alone is not a customer revocation tool. Thirty-day closure notice, final text/audio/page-archive export, seven-day abandoned-draft retention, thirty-day working-revision cleanup and documented backup deletion do NOT operate merely because dates/fields exist; no scheduler or erasure/export implementation is claimed here. Keep paid sales disabled until those action-specific requirements are implemented and verified.

## Prior security source reconciliation

The canonical delivered source lacked the reviewed security successor, whose original signed object `876ce8be6b03c2a53f0178aa9a4174cf25b118ef` is unavailable in this clone. The durable archive is SHA256 `77d477c99e52b19548bda831d24d5c389d4e74fb4242e95432ee1e9accd61ca4`; its release packet supplies per-file hashes and baseline `c86664a3011519b63084c976140ef9f11893ae04`.

The recovered HTTP/runtime/security source files were unchanged from that baseline, verified before each replacement. The archive's exact hashed abuse/content/recovery controls and regressions were restored selectively. Its abuse-budget table was added beside—not instead of—the newer delivery schema; no old HTTP route/schema file was copied wholesale. Reviewed dependency overrides and the Vercel CLI62.7.0 security update were merged into the current manifest, not an older Route A package/service. The recovered production-bundler regression was adapted to the current component-config-free app and expanded to verify paid isolate modules versus Node provider actions. Machine-generated historical TEST-A boundary evidence may be refreshed for this candidate; that is not independent editorial or release approval.

## Offline verification

Run under Node22: `npm ci --ignore-scripts`, `npm run verify`. Focused regressions are `node --test test/convex/delivery-loop-paid.test.mjs test/convex/delivery-loop.test.mjs test/delivery-loop/worker.test.mjs test/security/*.test.mjs test/convex/production-bundle.test.mjs`.

Paid tests cover disabled admission, preview/parental permission, independent exact customer/terms/publication decisions, wrong/missing/test/waived/duplicate/misbound settlement, missing/simulated editorial approval, correction/stale revision/expiry/renewal/cancellation boundaries, frozen serialization/digest integrity, uncertain-effect fencing, and public denial. The actual durable worker and Convex provider actions are exercised for corrected French and Arabic orders with explicitly synthetic offline provider responses. Browser scripts execute against real offline HTTP mutations; no live order, actual paid provider call, customer contact, deployment or sale is test evidence.
