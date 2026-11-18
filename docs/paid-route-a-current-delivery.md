# Supervised paid Route A in the current delivery loop

## Outcome

A new, disabled-by-default paid branch of the existing `/delivery` and `deliveryLoopJobs` journey implements the approved EUR39 offer without a second database or replacement workflow. This task builds and tests the production candidate; it does not enable live sales, change provider configuration, charge a customer, deploy or invoke paid providers.

## Evidence and decisions

Independent report: `/home/hermes/.hermes/ops/bebe-first-sale/review-1559208972618305607/report.md`. The signed local prototype passed five backend and three frontend tests; thirteen current-flow tests passed offline. Its SQLite/operator-test-payment runtime is not production acceptance. Reuse transition rules, not that runtime or whole archived files.

Owner business choices: Discord1559078824489132096, `/home/hermes/.hermes/ops/bebe-policy-batch-1559074931029966869/owner-decisions-1559078824489132096.json`. Route A, EUR39 consumer-total one-time, French OR Arabic with narration, two editorial corrections, five working days after approval AND payment, twelve-month hosting, statutory-rights-only discretionary refunds and the four grouped settings are settled. Support is contact@bebebonjour.com.

Time-to-market correction: Discord1559083511955062846 and global priority1559084345052893185. Generalized external legal/accounting certification is background work, not a prerequisite for independent implementation/review. This does not certify compliance or waive a concrete non-deferrable obligation for an actual transaction.

## Minimum implementation

1. Add an explicitly selected paid order mode beside—not instead of—the current authorized complimentary loop. Isolate legacy jobs and preserve their pre-review narration/publication/email behavior. A paid preview must stay private: no public page or final-link email before the required paid-mode gates.
2. Separate preview permission, exact-current-revision approval, terms assent and publication permission. Approval of one revision never approves a correction. Preserve safe correction/review behavior, private capabilities, bounded attempts and uncertain-effect reconciliation.
3. Require server-correlated payment evidence for this job, exact approved revision, EUR39 total and EUR currency. Expose a minimal supervised operator capability for reviewing genuine payment evidence; never accept client paid flags, synthetic receipts, a complimentary waiver or an operator assertion alone as real settlement. Test-mode evidence is visibly test-only and cannot authorize live delivery.
4. Reuse existing real-provider adapters and the current durable job lifecycle. For paid mode, final narration, public announcement and final email require the applicable customer approvals, payment evidence and genuine human editorial approval. Check eligibility both when claiming and when recording effects. Deduplicate notifications and payment evidence; do not rerun uncertain effects.
5. Reuse existing delivery/reviewer UI and show €39, included narration, pending payment, expiry/cancellation/failure and support honestly. Keep the approved twenty-four-hour preview window, one manual renewal and corrected-preview window distinct from hosted-page duration. Provide the hooks needed for downstream export, revocation and retention work; do not claim those controls operate merely because a field exists.

## Verification and handoff

Leave focused runnable regressions covering unpaid/revision-changed/wrong-amount-or-job/wrong-currency/test-or-waived/duplicate-payment/no-editorial-approval denial, a properly correlated offline paid-mode success, no pre-approval public disclosure and unchanged complimentary behavior. Exercise the actual frontend/backend contracts and repository-required checks; report inherited failures separately, never call a partial pass full acceptance.

Preserve the reviewed security successor's behavior and newer current delivery code. The source object for historical security commit876ce8be6b03c2a53f0178aa9a4174cf25b118ef was not in the reviewed canonical clone; recover durable evidence if overlap requires it. Never apply the entire older Route A package/service delta over current code.

Deliver exact signed source, focused test/build results and a concise integration/readiness report to existing reviewer t_e03b13ea. Bind that reviewer to the new immutable candidate at handoff; its old workspace is not review evidence. Parent t_19e00e28 is historical proof of the genuine provider capability, not permission to replay the owner's trial. New t_d4163412 output is the specific prerequisite for applying privacy/export/retention controls to this paid mode in t_66e1f464. No fixed interview quota, generalized legal opinion or old trial rerun is part of this implementation.
