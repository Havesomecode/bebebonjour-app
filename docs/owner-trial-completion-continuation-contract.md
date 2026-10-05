# Owner-trial completion continuation (offline release candidate)

This is a separate completion authorization, not renewal or redemption of a trial ticket. The original ticket expiry and every original persisted byte remain unchanged.

## Backend-only authorization

1. An authenticated owner obtains `ownerTrialCompletionContinuation:authorizationContext` for the `OWNER_TRIAL_JOB_ID`-pinned job using **both** `operatorToken` (existing `assertOwnerTrialOperator` / Operations owner role) and `completionToken` (existing separated owner-trial completion role). This read-only query returns `expectedVersion`, `bindingDigest`, and `previousReceiptId`. It cannot release artifacts or authorize an effect.
2. The same dual-role owner invokes `ownerTrialCompletionContinuation:authorizeContinuation`, passing those inspection commitments as `expectedVersion`, `expectedBindingDigest`, `previousReceiptId`; exact `ownerSourceReference: kanban:t_4b1eb28f`; a unique `authorizationReference` matching `kanban:t_4b1eb28f:completion:<8–128 ASCII alphanumeric/underscore/hyphen characters>`; and a canonical ISO `expiresAt` strictly in the future and no more than 24 hours after server issuance time.
3. The backend derives and signs the receipt using the existing approval HMAC key. No caller scopes, booleans, provider-absence claims, signatures or arbitrary authorization bodies are accepted. A pending/running command, active stage, unexpired original ticket, active prior continuation, stale version/predecessor, or changed inspected binding rejects atomically.

The receipt commits the complete original redeemed ticket and customer job; immutable fulfillment fields including revision/artifact/review/waiver authority; completed generation/narration history; full persisted delegated review receipts and signed approvals; editorial approval; exact completion policy/actions/lease; and pinned Vercel team/project/name. Receipt history is sequence/predecessor-linked and revalidated in full. Identical current-window replay is inert even after completion progress; changed, expired or superseded issuance replay rejects. Another window requires the authenticated owner again, a new unique authorization reference and exact latest predecessor, only after the previous window expires. No endpoint updates or deletes a receipt.

## Completion seam

`ownerTrialCompletionPolicy` retains the existing closed policy for ordinary active trials and rejects expired tickets without a valid continuation. For continuations it adds `continuationReceiptId` and finite `completionExpiresAt`, derived solely from the verified stored receipt. Even restoring/mutating original ticket expiry cannot bypass receipt validation once history exists.

All existing policy consumers remain unchanged: owner-trial worker startup and capability revalidation; Operations claims, effect fences, completion/failure; aggregate replacement; scoped artifact authorization; publication recovery and allowance. Exact capability policy pinning rejects a window identity change. No generation, narration, review mutation, owner acceptance or delivered-status capability is added.

A continuation is **not** evidence of provider absence, a retry receipt, a new command, or a job replay. Failed uncertain publication stays `reconciliation_required`; the existing separately authenticated fresh complete provider census must still authorize each specific absent attempt before its normal finite allowance increases. Operations and stage effect fences remain independent and mandatory, including Vercel uploads and Resend sends. Delivery remains restricted to the original owner recipient and sanitized original origin/revision/artifacts.

## Verification boundary

All continuation tests use explicitly synthetic artifacts, provider transports and role values. Fake time expires the original ticket without modifying its bytes. Tests compare every canonical table through issuance/replay and exercise the real Convex/Operations/worker/orchestrator/recovery seams, including successive failures then owner-only send acceptance. No test claims live publication, delivery, personal acceptance or fresh live provider evidence. Release, deployment and actual issuance are left to the parent reviewer; this change does not install credentials or invoke a live backend/provider.
