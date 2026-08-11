# Fulfillment orchestration contract

Status: implementation contract for the TEST-A lifecycle projection and the future
Convex persistence adapter. This contract does not authorize hosted resources, live
customer data, provider calls, deployment, publication, or delivery.

## 1. Scope and authority

The existing deterministic generator remains the content and bundle implementation.
The orchestrator sequences it; it does not replace it. The canonical transition rules
are the pure functions in `src/fulfillment/job-machine.mjs`. The current durable test
projection is `src/persistence/local-test-fulfillment-store.mjs`; it accepts synthetic
`environment: "test"` jobs only. A production adapter SHALL implement the same store
methods and guards with transactional Convex mutations before any hosted use is
considered.

Three persistence classes must not be conflated:

1. The aggregate below is the sole lifecycle authority and audit projection.
2. Immutable content, approval, and artifact manifests are evidence bound by digest to
   the aggregate; they are not mutable lifecycle snapshots.
3. Provider records are external evidence referenced by immutable IDs and digests;
   they are not lifecycle authority by themselves.

This target contract has no generated `job.json`, portable job snapshot, or second
filesystem lifecycle record. `schemas/announcement-job.schema.json` and the CLI paths
that currently create or consume `job.json` are temporary local scaffolding to retire at
the adapter boundary described in section 8. Removing that scaffolding must not replace
or change the deterministic composition and rendering algorithms.

All examples and tests use synthetic data. `data/examples/amal/` is only a verified
regression reference for deterministic `page.json`, transcript, build/revision identity,
and reproducible rendering. Its example customer/reviewer fields are not a production
schema, identity, or dataset.

## 2. Persistent job schema

The persistence adapter SHALL store one aggregate per `job_id`. JavaScript uses
camelCase; the persistent field names below use snake_case. Serialization adapters must
map mechanically and must not change meaning.

| Persistent field | Type and invariant |
|---|---|
| `schema_version` | literal `1.0` |
| `authority` | `convex-target` in hosted storage; `convex-target/local-test-projection` only in TEST-A |
| `job_id` | opaque non-empty ID; primary key |
| `environment` | `test` in TEST-A; environment is also payment correlation data |
| `product` | non-empty product key; currently `announcement-page` |
| `intake_digest` | lowercase SHA-256 of the canonical private intake bytes |
| `payment_correlation` | exact `{project:"bebebonjour", product, environment, job_id, intake_digest}` |
| `narration_required` | boolean fixed for the job's current intake contract |
| `state` | one value from section 4 |
| `version` | positive monotonic integer incremented by each accepted command |
| `created_at`, `updated_at` | canonical ISO timestamps; `updated_at` never moves backward |
| `current_revision_id` | `null` before generation, then exact `r<ordinal>` |
| `published_revision_id` | `null` until publication; must equal the released current revision |
| `retry` | `null` or `{stage, available_at}` |
| `payment` | `null` or `{provider_event_id, provider_payment_id, correlation, recorded_at}` |
| `revisions[]` | immutable `{revision_id, ordinal, input_digest}`; ordinal is monotonic and `revision_id == "r" + ordinal` |
| `artifact_sets[]` | immutable records defined in section 3 |
| `review_decisions[]` | immutable records defined below |
| `stage_attempts[]` | immutable attempt identity plus mutable lease/result status defined in section 5 |
| `publication` | `null` or the exact successful publication receipt |
| `delivery_attempts[]` | provider acceptance/delivery evidence |
| `events[]` | append-only command audit records |

### Editorial decision record

Every content or narration decision SHALL persist:

- `decision_id`: deterministic ID of job, revision, decision type, outcome,
  timestamp, and reviewer ID;
- `decision_type`: `content` or `narration`;
- `revision_id`: exact current revision;
- `outcome`: `approved`, `request_changes`, or `rejected`;
- `policy_version`: exactly `bebebonjour-editorial-v1`;
- `rubric_version`: non-empty, versioned content or narration rubric;
- `reviewer`: authenticated `{id, role, competencies[]}`; an email string from a
  portable local approval is not sufficient production identity;
- `decided_at`: canonical timestamp supplied by the authenticated review command;
- `artifact_digests`: exact three-digest projection from the reviewed artifact set;
- `reasons[]`: bounded reason codes or redacted review notes.

The required editorial fields are therefore explicit: `policy_version`, reviewer
identity, timestamp (`decided_at`), and `outcome`. A decision is accepted only while the
job is in its matching review state, for `current_revision_id`, and when all artifact
digests equal the latest matching artifact set. Approval writes evidence only; it never
publishes, queues delivery, sends, or completes the job.

### Attempts, receipts, and events

A `stage_attempt` SHALL contain `attempt_id`, `stage`, nullable `revision_id`,
`attempt_number`, `operation_number`, `idempotency_key`, `status`, nullable
`lease_token`, nullable `lease_expires_at`, `started_at`, nullable `completed_at`, and
nullable `{retryable, reason_code}` failure. Do not persist raw exception messages,
provider bodies, email addresses, or other PII in attempt diagnostics.

A publication receipt SHALL contain `provider`, `revision_id`, `stable_url`,
`artifact_manifest_digest`, `provider_receipt_id`, `idempotency_key`, and status
`published`. A delivery attempt SHALL contain `provider`, `revision_id`,
`provider_message_id`, `idempotency_key`, status `sent|delivered`, and nullable
`delivered_at`.

Each event SHALL contain deterministic `event_id`, globally job-unique `command_id`,
SHA-256 `command_digest`, event `type`, timestamp, and resulting state. Reusing a
`command_id` is a no-op only when event type and canonical payload digest match; any
rebind is a conflict.

## 3. Artifact identity and storage

### Identity

An artifact set is immutable and SHALL contain:

- `artifact_set_id = "artifacts_" + sha256(parts joined by NUL).slice(0, 24)`,
  where the ordered parts are `job_id`, `revision_id`, `kind`, `page_digest`,
  `transcript_digest`, and `asset_manifest_digest`;
- `kind`: `private_review`, `prepared_bundle`, or `narration_review`;
- `revision_id`: exact current revision;
- `page_digest`, `transcript_digest`, and `asset_manifest_digest`: lowercase SHA-256
  values;
- `manifest_ref`: private storage reference to an immutable, canonical file manifest;
- `files[]`: `{path, sha256, bytes, storage_id}` sorted by relative POSIX path.

`asset_manifest_digest` covers the canonical sorted file manifest, not a mutable
summary field or a digest copied from the aggregate. `page_digest` and
`transcript_digest` cover exact stored UTF-8 bytes. Existing local collectors may omit
`manifest_ref` and `files[]` only in TEST-A fixtures; a hosted adapter must reject their
absence. No artifact set contains or hashes a generated job snapshot.

### Storage topology

Use immutable private keys rooted by
`jobs/<job_id>/revisions/<revision_id>/<kind>/<artifact_set_id>/...`. Store intake,
private review pages/dossiers, content approvals, TTS provider evidence, narration
reviews, and unpublished bundles privately. Public routing may expose only the
allowlisted files in the approved release manifest. It must not expose intake,
customer email, reviewer identity, source paths, provider/model/voice instructions, or
private provenance.

Publication stores an atomic pointer from the stable public ID to one
`publication`/artifact set after upload and read-back digest verification. Publishing
one job must not replace another job's files. Mutable filesystem pointers such as
`artifacts/current` and one per-order Vercel deployment are local scaffolding, not the
target storage model; the target bridge must not create a root job snapshot.

Artifact meaning by stage:

| Kind | Producer and trust class | Required consumer |
|---|---|---|
| `private_review` | `prepare-review`; private page, transcript, preview, and dossier | content decision must bind all four digests |
| `prepared_bundle` | approved `render`; deterministic release projection without narration | publish when narration is not required; TTS input otherwise |
| `narration_review` | fresh TTS review artifacts plus the exact prospective narrated-projection digests | narration decision; the approval bridge materializes the final root without changing this set's identity, then narrated publication binds it |

The existing CLI creates the approved content root with `approve-review` and the final
narrated root with `approve-narration`. The orchestration adapter currently records
review decisions but does not invoke either approval command. The implementation bridge
must therefore authenticate and verify the CLI approval artifact, materialize its fresh
output root, collect the resulting immutable artifact set, and record one persistent
decision atomically with optimistic state/version checks. A bare decision payload must
not be trusted as proof that those filesystem checks ran.

## 4. Allowed states and transitions

The table is normative for v1. `runNext` is allowed only for queued states. Terminal
`failed`, `rejected`, and `complete` states have no automatic outgoing transition.

| From | Command/stage and guard | To | Existing capability |
|---|---|---|---|
| create | create one job; exact payment correlation | `awaiting_payment` | `createCustomerFlowService.submitIntake` -> `orchestrator.createJob` |
| `awaiting_payment` | record one correlated provider success | `generation_queued` | `recordPaymentSucceeded` -> `orchestrator.recordPayment` |
| `generation_queued` | claim `prepare_review` with lease | `generating` | `runNext`; `commandPrepareReview` adapter |
| `generating` | complete with next monotonic revision and `private_review` set | `content_review_required` | `prepare-review`/artifact collector |
| `content_review_required` | content outcome `approved`, exact policy/revision/digests | `render_queued` | persistent `recordReviewDecision`; local evidence from `approve-review` |
| `content_review_required` | content outcome `request_changes` | `generation_queued` | next run must create `r(n+1)`, never overwrite |
| `content_review_required` | content outcome `rejected` | `rejected` | persistent review decision |
| `render_queued` | claim `render_approved` | `rendering` | `runNext`; `commandRender` adapter |
| `rendering` | exact approved content + `prepared_bundle` | `tts_queued` if narration required, otherwise `publish_ready` | approved `render` and artifact collector |
| `tts_queued` | claim `generate_tts` | `tts_generating` | `runNext`; explicitly injected TTS adapter |
| `tts_generating` | complete validated `narration_review` set | `narration_review_required` | `commandTts`; fresh private review root |
| `narration_review_required` | narration outcome `approved`, exact policy/revision/digests | `publish_ready` | persistent decision; local evidence from `approve-narration` |
| `narration_review_required` | narration outcome `request_changes` | `tts_queued` | same revision, new logical operation and new media bytes |
| `narration_review_required` | narration outcome `rejected` | `rejected` | persistent review decision |
| `publish_ready` | claim `publish` only after `assertReleaseEligible` | `publishing` | `runNext`; local `commandDeploy --dry-run` adapter |
| `publishing` | verified receipt binds current revision and approved release manifest | `published` | publication adapter; TEST-A records only local/`.invalid` dry-run evidence |
| `published` | explicit queue command; published revision equals current revision and eligibility revalidates | `delivery_queued` | `orchestrator.queueDelivery` |
| `delivery_queued` | claim `deliver` | `sending` | `runNext`; local `commandSend --provider console --dry-run` adapter |
| `sending` | provider acceptance binds current published revision | `sent` | delivery adapter; TEST-A console receipt only |
| `sent` | signed/reconciled outcome `delivered` matches provider message ID | `complete` | `orchestrator.confirmDelivery` |
| any running stage | retryable failure with attempts remaining | `retry_wait` | `failStage`; redacted reason code |
| `retry_wait` | `available_at` reached | original queued state | `resumeRetry`, then `runNext` |
| any running stage | non-retryable failure or exhausted attempts | `failed` | `failStage` |

No v1 transition exists for cancellation, retirement, refunds, bounce handling, manual
unblock, or post-publication revision. Those require a separately specified extension;
they must not be represented by direct state mutation.

## 5. Failure, lease, and retry semantics

1. Lease duration, maximum attempts, and backoff schedule are explicit positive
   per-stage configuration. Missing values fail before work starts.
2. Claim is compare-and-set on the queued state. Concurrent claims yield one winner.
   A provider call occurs only after the claim transaction commits.
3. Completion requires the current exact lease token and a completion timestamp before
   lease expiry. Late output cannot commit.
4. An expired running lease is recorded as retryable `lease_expired`; it is never
   silently reclaimed.
5. Retry only when the handler classifies the error `retryable: true` and attempts
   remain. Transport/rate-limit/unknown-provider-outcome failures may qualify.
   Configuration, schema, signature, correlation, policy, invalid input, or digest
   mismatch failures are terminal.
6. A retry resumes the exact stage after `available_at` and reuses the same logical
   operation idempotency key. A human `request_changes` decision is not a retry: it
   starts a new logical generation/TTS operation, and content changes require a new
   revision.
7. Before retrying an ambiguous publish or delivery result, the adapter SHALL reconcile
   by idempotency key/provider receipt. It must not issue a second unkeyed effect.
8. Stage completion persists the receipt/artifact identity and state change in one
   mutation after the external call. Never hold a database transaction across a
   provider call.

## 6. Idempotency boundaries for external effects

| Effect | Stable boundary and behavior |
|---|---|
| intake creation | customer idempotency key + canonical intake digest; same key/different digest conflicts |
| checkout creation | `checkout:<job_id>:<intake_digest>`; one provider session per job/intake |
| payment webhook | signed provider event ID plus canonical event fingerprint; replay is read-only |
| deterministic compose/render | immutable job/revision/material inputs and artifact digests; rerun may reproduce bytes but never overwrite an existing revision/set |
| TTS | stage key from `(job_id, revision_id, generate_tts, operation_number)`; automatic retry reuses it, reviewer-requested regeneration increments operation |
| publication | stage key from `(job_id, revision_id, publish, operation_number)` and exact release `asset_manifest_digest`; reconcile unknown outcomes before retry |
| delivery send | stage key from `(job_id, revision_id, deliver, operation_number)` plus publication receipt; provider acceptance ID is persisted |
| delivery confirmation | provider message ID + signed event ID/fingerprint; only `delivered` completes |
| status | read-only projection; no provider refresh or mutation |

`stageIdempotencyKey` in `job-machine.mjs` is the compatibility algorithm. It is stable
across automatic retries because `operation_number` counts completed logical operations,
not failed attempts. The same key must be forwarded to the eventual Vercel/storage and
Resend adapters; storing it only locally is insufficient.

## 7. Non-bypassable review and authorization gates

The following transitions are forbidden unless the stated review succeeds for the
exact current revision and exact artifact digests:

- `content_review_required -> render_queued`: forbidden without authenticated content
  decision `approved` under `bebebonjour-editorial-v1`;
- `rendering -> publish_ready`: forbidden without the approved content decision and
  exact prepared bundle;
- `narration_review_required -> publish_ready`: forbidden without a separate
  authenticated narration decision `approved` when narration is required;
- `publish_ready -> publishing` and publication completion: forbidden if content,
  prepared, narration (when required), release manifest, or revision bindings fail;
- `published -> delivery_queued`, `delivery_queued -> sending`, and `sent -> complete`:
  forbidden unless publication and delivery remain bound to that same eligible revision,
  and completion also matches the exact provider message.

A reviewer, UI, worker, or operator must never bypass these guards by editing `state`,
`current_revision_id`, digests, manifests, or any derived filesystem metadata. Approval
does not itself invoke publication or delivery.

There is also a stricter current authorization boundary: TEST-A permits local source,
schemas, deterministic commands, static analysis, tests, and synthetic fixtures only.
Even after local review succeeds, remote TTS, non-dry-run `commandDeploy`, hosted
publication, real provider delivery, customer email, live data, DNS, account mutation,
or spend remain forbidden until their separate recorded gates are approved.

## 8. Existing extension points and compatibility constraints

- `createFulfillmentOrchestrator({store, handlers, clock, tokenFactory, retryPolicy})` is
  the dependency boundary. A Convex store must preserve command replay, optimistic
  state/version checks, append-only evidence, lease fencing, and exact transition
  errors.
- Stage handlers receive immutable job status, stage, attempt identity, lease token,
  and idempotency key. Production handlers must return the shapes already validated by
  `completeStageTransition`.
- `createLocalCommandStageHandlers` maps current generator functions but is deliberately
  TEST-A-only. It requires an injected no-network TTS implementation, forces deploy and
  send dry runs, and rejects remotely reachable URLs. Its current `jobPath` arguments
  and `legacyStatus` method are scaffolding, not production interfaces.
- The local customer-flow server has no stage handlers and empty retry tables, so it
  cannot autonomously cross `generation_queued`. This is an intentional inert boundary,
  not production worker configuration.
- Generated `job.json`, `schemas/announcement-job.schema.json`, and the corresponding
  `--job` CLI contract are explicitly retired from the target. Before hosted use, the
  adapter seams SHALL be changed so render returns an immutable output root plus its
  canonical manifest; publish receives that root, manifest, and persisted aggregate
  context; delivery receives the persisted publication receipt and a private recipient
  projection; and status reads the aggregate store. No debug or disaster-recovery job
  snapshot is emitted. This is an accepted compatibility break in orchestration I/O,
  not a replacement of the deterministic generator.
- The legacy `commandDeploy` performs a direct Vercel production deployment and mutates
  the retired local snapshot; it does not implement the approved single stable
  router/pointer topology and must not be used as the hosted publication adapter.
- `commandSend` supports only a redacted console preview and `commandStatus` reads the
  retired snapshot. A Resend adapter, aggregate-backed status path, and signed delivery
  webhook/reconciliation path do not yet exist.
- CLI content and narration approvals contain strong HMAC/digest checks, but their
  portable reviewer strings do not satisfy the persistent authenticated reviewer
  object by themselves. The approval bridge described in section 3 is required.
- The current TEST-A machine and fixtures still require `jobArtifactDigest`. Implementing
  this contract SHALL remove that field from `DIGEST_KEYS`, artifact collection, review
  payloads, and tests so the three authoritative digests above are used end to end.
  Production file manifests, immutable Convex storage references, read-back
  verification, and public-pointer mutation remain adapter work.
- The old Supabase ingress and the earlier Supabase-oriented architecture report are
  compatibility/history only. The approved target persistence is Convex; filesystem or
  Supabase state must not become a second lifecycle authority.

## 9. Relationship to `happy`

`/Users/zacariachtatar/repos/happy` is a visual/runtime and narration precedent, not an
orchestration implementation. It builds one Vite site, reads a mutable public transcript,
and writes generated per-language audio and manifests directly under `public/`; those
manifests include provider/model/voice/instruction/timestamp metadata. It has no durable
job, exact-revision content decision, separate narration-byte decision, lease/retry,
publication pointer, or delivery lifecycle.

Bébé Bonjour may preserve compatible section ordering, transcript playback, and visual
behavior from that repository, while keeping provider metadata private and retaining the
existing deterministic generator and approval gates. No behavior from `happy` weakens
this contract or justifies replacing the generator.

## 10. Source map

- aggregate/state/stage constants and creation: `src/fulfillment/job-machine.mjs:4-74`
- payment, claims, completion fencing, failure, and retry:
  `src/fulfillment/job-machine.mjs:76-223`
- review decisions and delivery gates: `src/fulfillment/job-machine.mjs:225-309`
- status, idempotency, artifact identity, and release eligibility:
  `src/fulfillment/job-machine.mjs:312-485`
- command replay/audit canonicalization: `src/fulfillment/job-machine.mjs:498-558`
- orchestration, lease expiry, retry classification, handler boundary:
  `src/fulfillment/job-orchestrator.mjs:9-190`
- TEST-A command mapping and local-effect restrictions:
  `src/fulfillment/local-command-stage-handlers.mjs:17-160`
- atomic TEST-A persistence: `src/persistence/local-test-fulfillment-store.mjs:19-200`
- customer intake/payment/status bridge: `src/customer-flow/service.mjs:1-285`
- command surface: `bin/announce.mjs:17-79`
- deterministic composition/private review/content approval:
  `scripts/lib/commands.mjs:74-349`
- narration generation and approval: `scripts/lib/commands.mjs:839-1086`
- deployment, console preview, and legacy status:
  `scripts/lib/commands.mjs:1089-1243`
- executable behavior coverage: `test/fulfillment/job-orchestration.test.mjs`,
  `test/fulfillment/local-command-stage-handlers.test.mjs`,
  `test/generator-safety.test.mjs`, and `test/private-review.test.mjs`
- approved architecture and TEST-A boundary:
  `openspec/reports/2026-08-10-architecture-release-approval-record-v1.md`
- determinism-only fixture: `data/examples/amal/`
- predecessor comparison: `/Users/zacariachtatar/repos/happy/README.md`,
  `/Users/zacariachtatar/repos/happy/scripts/generate-tts.mjs`
