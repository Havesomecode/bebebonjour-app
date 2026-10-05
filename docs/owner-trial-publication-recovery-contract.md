# Owner-trial publication-absence recovery (backend contract)

This is a publication-only recovery, not an HTTP endpoint and not live absence evidence.

## Required backend configuration

- `BEBEBONJOUR_OWNER_TRIAL_ENABLED=true`
- `OWNER_TRIAL_JOB_ID`: exact immutable owner-trial job identifier.
- `OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID`, `OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID`, `OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME`: all mandatory, no fallback.
- `BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN`: dedicated role credential (at least 32 characters); distinct from completion, invocation, ordinary worker/operator/backend, review-signing and cron roles.
- Existing completion token, active redeemed owner-bound ticket, and authentic signed delegated content/narration approvals remain required. Origin is pinned to the persisted approved ticket policy, never caller/provider URL data.

The deployed trusted ingress must produce a **new complete GET-only pinned Vercel census** itself. It must not accept HTTP caller proofs, absence booleans, provider scope overrides, or historical diagnostics as authority. Existing/ambiguous matches, page errors, incomplete pagination or identity drift must fail before signing. No provider mutation belongs in census/recovery.

## Atomic mutation

`ownerTrialPublicationRecovery:recoverPublicationAbsence`

Arguments: `completionToken`, `recoveryToken`, all binding fields below, and `proof`.

```js
const binding = {
  jobId, expectedVersion, sourceCommandId, attemptId, revisionId,
  artifactManifestDigest, idempotencyKey, teamId, projectId, projectName, origin,
};
const unsigned = {
  schemaVersion: "1.0",
  kind: "owner_trial_publication_absence",
  binding,
  observedAt: "<canonical UTC ISO timestamp at completed observation>",
  census: {
    complete: true,
    pageCount: <positive safe integer>,
    deploymentCount: <nonnegative safe integer>,
    digest: "<lowercase SHA-256 of canonical full census transcript>",
    exactMatchCount: 0,
    ambiguousMatchCount: 0,
    errorCount: 0,
    terminalCursor: null,
  },
};
```

Use `signPublicationAbsenceProof(unsigned, recoveryRoleToken)` exported from
`src/fulfillment/owner-trial-publication-recovery-proof.mjs`. It returns the exact
unsigned object plus `signature` (lowercase HMAC-SHA256 hex). HMAC input is UTF-8
`owner_trial_publication_absence` + NUL + `stablePrivateValue(unsigned)` (recursive
canonical sorted-key JSON). `publicationAbsenceBinding`, binding field constants,
`publicationRecoveryDigest`, and verification/freshness constants are also exported.
The census digest is an attested digest, not a backend re-fetch: the ingress must hash
its **full** pinned census transcript, e.g. canonical `{teamId, projectId,
projectName, pages: [all complete response bodies in traversal order]}`, using
`publicationRecoveryDigest`, not just matching results or the final page. Keep raw
provider responses private; only the digest/counts/completeness belong in the proof.

The backend requires `observedAt` no more than 60,000 ms old, never in the future,
and not before the failed attempt completion. Exact proof/binding/census key sets
are enforced. The signature covers every binding field and the complete census
attestation. Both exact and ambiguous match counts must be zero.

The mutation validates the exact current version and sole latest unresolved publish
attempt, its persisted effect fence, original same publish command and approved
release, null publish operation binding and no concurrent pending/running command.
Every earlier publish attempt must be absent with its own verified immutable receipt.
It appends one immutable receipt per failed attempt using the existing job/revision
index and receipt format, containing the full minimal-safe proof, digests, original
attempt and original command, and the recovery audit event. Existing first-receipt
bytes are neither rewritten nor migrated; no job, command or counter is reset.
It changes only the failed attempt status to `reconciled_absent`, appends one digest
bound audit event, advances aggregate version once into `publish_ready`, and rebases
and requeues **the same** source command. Payload, request identity, attempt count,
original failure, historical events/effect timestamp and all other attempt fields
are preserved; original command pre-rebase bytes are retained in the receipt.

Response: `{recovered: true|false, receiptId, recoveredVersion}`. Identical authenticated
receipt replay is inert even after progression (stored signature/provenance is
revalidated without applying freshness to an already accepted receipt). Changed
binding/proof replay rejects without writes. Concurrent callers cannot mint another
receipt/version increment for the same attempt; an OCC loser may need an identical
retry. Each newly failed attempt requires its own freshly signed complete absence
proof, bound to that attempt and current version. Unknown/incomplete provider
evidence stays blocked. Older accepted proofs never authorize another recovery.

## Exactly one subsequent publish claim per verified receipt

`ownerTrialPublicationRecovery:recoveryAllowance` is a completion-token query bound
to `jobId`. It returns `null` or backend-verified
`{receiptId, jobId, revisionId, sourceCommandId, idempotencyKey,
reconciledAttemptIds:[...orderedAbsentAttemptIds], maxAttempts:receiptCount+1}`.
The full contiguous receipt chain, stored signed proofs, historical attempts/events,
original command identities/payloads and current rebased command are checked.
Ordinal attempt IDs/numbers, claim digests, command attempt counters and event
versions must agree. Gaps, duplicates and altered history fail closed. Historical
`originalCommand.expectedVersion` binds its preceding rebase, not the latest rebase;
the current source must exactly bind the newest recovered version and counter.

Owner-trial capabilities fetch this query themselves. Only a verified stored
allowance raises publish's finite attempt limit to verified receipt count plus one;
all other stages remain at 1. There is no arbitrary recovery ceiling or Infinity.
`ownerTrialCompletion:replaceJob` independently checks the stored receipt before
accepting the next exact claim and validates its digest with that derived maxAttempts.
Each receipt authorizes only the next ordinal claim; claim N+1 without receipt N,
an aggregate event/status alone, or arbitrary maxAttempts is not authority.
The orchestrator's explicit `ownerTrialPublicationRecovery` option
is supplied only by those capabilities from this backend query. It removes only
the receipt-bound absent attempts from reconciliation-only selection, retains their
historical effect cursor, and still runs normal reconcile-before-publish plus dual
command/stage fences. It does not make ordinary workflow retries less strict.

No signing-review, create/reset-job, HTTP ingress, provider deployment, generic
reconciliation bypass, or automatic retry is implemented by this scope.
