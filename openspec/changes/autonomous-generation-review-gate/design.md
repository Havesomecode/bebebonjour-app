# Autonomous generation review-gate design

## Current source-grounded flow

| Stage | Current implementation | Output | Current failure behavior |
|---|---|---|---|
| Paid ingress | `src/webhooks/*`, Supabase RPCs | order + open review job | fail closed; bounded audit evidence |
| Compose | `commandCompose` in `scripts/lib/commands.mjs` | private canonical page draft | selection/block via process exit 3 |
| Render | `commandRender` | canonical artifacts, public projection, static files, job | refuses drafts unless explicitly overridden |
| Narration | `commandTts` | audio, manifest, transcript timings | partial failure recorded in filesystem job |
| Deploy | `commandDeploy` | Vercel deployment + live revision | requires approved canonical revision and exact public projection |
| Send | `commandSend` | redacted console preview only | unsupported providers fail without mutation |

The ingress database and filesystem generator are not yet connected by a durable worker.

## First implemented tracer

`announce prepare-review --input <intake> --output <dir>`:

1. validates the intake;
2. resolves the submitted name without changing display spelling;
3. chooses one supported candidate or a safe unknown-name fallback;
4. stops at `needs_editorial_input` before writing output for gendered copy that is not yet safe;
5. creates a draft canonical page for currently supported copy;
6. renders only under `private-preview/` without third-party font requests;
7. writes private canonical page/transcript revisions;
8. writes `review.json` with name evidence, unapplied specific demands, review reasons, version identity, artifact paths, and warnings;
9. creates neither `deploy/` nor `job.json`.

The output is deterministic for identical input and output root. It does not call TTS, Supabase, Vercel, Stripe, Tally, email, or another external provider.

Each non-empty local review root is bound to one exact input SHA-256 digest plus one aggregate digest over selection, catalog, template, and renderer materials. Reuse with another intake, changed material, changed private-preview byte, or extra same-family route is rejected before composition. Dossier artifact references are relative and slug-scoped, existing symbolic links anywhere below the managed root are rejected before writes, and approval containment compares physical paths so a symlinked review-input alias cannot bypass the immutable-root boundary. Name evidence and the assembled dossier are runtime-validated against their JSON Schemas immediately before persistence. These local protections do not replace the immutable order/run/digest object-storage boundary required for the production worker.

`approve-review` is a separate local gate. It revalidates the dossier and current material binding, verifies that the canonical draft exactly matches the private browser projection, and recomputes a deterministic manifest digest over the complete private-preview bundle before accepting exact reason acknowledgements and a specific-demands disposition. It then writes the approved page plus an approval-time deterministic prepared-projection digest to a fresh root and authenticates the complete approval record with HMAC-SHA-256 using operator-held runtime key material that is never serialized. It neither mutates the private root nor creates deployment or delivery state. Ordinary approved render requires that sibling approval artifact, authenticates it before trusting reviewer identity or other approval fields, verifies the exact approved-page bytes, and must reproduce the approved projection before carrying the evidence into the job. Deploy and delivery dry runs repeat that authentication, recheck the original approved page and sibling approval artifact, independently regenerate the expected projection, and compare it with both mutable digest records and every actual prepared file. Later approval evidence, reviewer identity, job digest, or HTML/runtime/stylesheet/transcript/page/asset mutation therefore fails closed even when mutable records are rewritten consistently. Browser-facing page identity uses an opaque deterministic request correlation rather than the source request ID. Dry runs can then demonstrate readiness without remote side effects.

Private runtime mode is capability-inert for narration: it carries no transcript or ambient-audio URL, skips narration timing and transcript fetches, disables narration controls, and overrides narration/music URL parameters to `narration=off`. The browser should request only the local static HTML, CSS, JavaScript, and image assets needed to review visible copy.
Public projection also removes canonical operator-only TTS configuration; narration manifests expose only runtime-required language, generation time, and file timing rather than provider, model, voice, or instructions.

## Name-resolution policy

### Display and matching are separate

The exact submitted Latin and Arabic spellings remain display truth. Comparison keys are private matching aids only:

- Latin: Unicode compatibility composition, lowercase, whitespace collapse, and apostrophe/hyphen variant normalization while preserving diacritics.
- Arabic: Unicode normalization, harakat/tatweel removal, conservative alef/yaa normalization, punctuation/spacing removal.

Normalization never removes accents or establishes identity by itself. A submitted form resolves only through a canonical catalog spelling or explicit alias.

### Resolution outcomes

| Outcome | Meaning claims | Name-specific scripture | Behavior |
|---|---:|---:|---|
| exact | catalog-dependent | source-dependent | draft may be generated |
| alias | catalog-dependent | source-dependent | draft generated with `name_alias_match` review reason |
| ambiguous | forbidden | forbidden | stop for operator resolution |
| cross-script conflict | forbidden | forbidden | stop for operator resolution |
| unknown/original | forbidden | forbidden | neutral draft with `name_not_in_catalog` review reason |

A fuzzy matcher may later propose candidates, but it must return a review-required recommendation. It may never silently create a canonical identity.

### Unknown-name fallback

Unknown names may use generic welcome, love, wishes, and context-appropriate blessings. They must not claim an etymology, meaning, holy-book occurrence, or name-specific religious relationship. Empty scripture arrays must never be rendered under labels such as “God said” or “Qur’anic references.”

## Failure taxonomy for the durable worker

| Category | Examples | Automatic action |
|---|---|---|
| `retryable` | TTS/provider timeout, temporary storage/network error | bounded retry with backoff and same idempotency key |
| `fallback_capable` | unknown name, narration unavailable for one language | produce bounded fallback/private preview and add warning |
| `review_required` | alias, ambiguous match, cross-script conflict, weak source evidence, partial media | stop at review with evidence |
| `terminal_input` | invalid schema, unsupported language, unsafe slug/request identifier | do not retry; request corrected input |
| `terminal_policy` | unsupported factual/religious claim, public projection contains private fields | block and require code/content correction |
| `configuration` | missing provider credential, missing field map | fail closed; operator intervention |
| `conflict` | duplicate public identity, stale approval, concurrent claim/revision | preserve evidence; no overwrite |

Every attempt should persist stage, reason code, retry count, input revision digest, output digest, elapsed time, and redacted provider metadata. Raw customer/provider payloads must not be copied into generation logs.

## Known gaps and blind spots

1. **Same-name collisions:** `slugify(firstName)` means unrelated babies with the same name can target the same route. Public identity must include a non-guessable or customer-approved stable suffix independent of display name.
2. **Global filesystem pointers:** one output root has one `artifacts/current` and one `job.json`; rendering another page overwrites operational pointers even if slug directories coexist.
3. **Independent deploy roots:** deploying one isolated per-order root can remove routes from earlier deployments. A shared aggregate bundle or stable storage-backed router is required.
4. **Gendered copy:** the general composer still contains unsafe boy/neutral grammar; the autonomous tracer now stops those inputs at `needs_editorial_input` before writing artifacts.
5. **Meaning provenance:** catalog meanings are curated but lack external source keys. The tracer now keeps `meaningAllowed` false and composes neutral wording until dedicated `meaningSourceKeys` are added; source curation remains outstanding.
6. **Private narration:** TTS currently assumes the ordinary render/deploy-root layout; private-preview narration needs a separate safe mode.
7. **Production approval:** the local approval command now binds actor, timestamp, dossier, material, page, and reviewed projection, but production still needs authenticated durable actors, revision persistence, and optimistic concurrency.
8. **Cost accounting:** no provider usage or artifact-byte manifest is persisted yet.
9. **Queue multiplicity:** there is no generation claim lease, priority/SLA policy, capacity view, dead-letter state, or stale-job recovery.
10. **Review quality:** there is no versioned rubric, disagreement log, abstention model, or shadow-agent evidence.

## Durable preview worker target

The production bridge SHALL be a pull-based worker downstream of durable `review_required` state. It MUST NOT execute synchronously in either webhook or infer eligibility from webhook response shape.

Add a separate generation-run lifecycle rather than overloading `fulfillment_review_jobs`:

- states: `queued`, `leased`, `preview_ready`, `needs_editorial_input`, `failed`, `cancelled`;
- immutable `order_id`, `generation_run_id`, input/catalog/template digests, attempts, lease token/expiry, safe error code, artifact manifest digest, and timestamps;
- at most one active run for the same order and input digest;
- `claim_next_preview_run` using `FOR UPDATE SKIP LOCKED` and least-privilege service access;
- `complete_preview_run` using compare-and-set by lease token and transactionally rechecking that the parent order is still `review_required` with an open review job;
- `fail_preview_run` applying bounded retry or terminal editorial/failure classification with redacted diagnostics.

One invocation processes one leased order in an isolated temporary root keyed by order and run identifiers. It invokes only deterministic composition and static private rendering. Its environment allowlist excludes TTS, deployment, payment, email, and delivery credentials.

The private artifact boundary SHALL:

- upload only an allowlisted sanitized preview subtree, never the whole working directory;
- use immutable `<order-id>/<run-id>/<artifact-digest>/…` keys;
- hash every file and bind one manifest digest over all rendered bytes;
- scan for exact synthetic PII markers before upload;
- remain private and expose only short-lived authenticated review access;
- revoke or hide artifacts if eligibility regresses before completion.

Operator review binds the exact generation run and manifest digest. It shows the original `specificDemands` with an explicit applied/not-applied evaluation state. Approval remains separate from publication and delivery.

## Shared application target

Use one application/router with:

- stable generation ID distinct from display slug;
- immutable revision ID and content/artifact digest;
- private preview authorization;
- approved/public revision pointer;
- allowlisted public projection;
- object-storage prefix per generation/revision/build;
- aggregate/static bundle generation or a storage-backed route resolver;
- collision detection before publication.

Publishing generation B must not remove or mutate generation A. Acceptance tests must cover two equal display names, at least two slugs, and multiple revisions.

## Review decision model

An operator decision must bind:

- generation ID;
- revision ID and digest;
- reviewer identity;
- rubric version;
- decision and reason codes;
- timestamp;
- warnings explicitly accepted;
- previous decision/version for optimistic concurrency.

Approval makes a revision eligible for a separate shipping command. Approval itself must not publish or deliver.

## Shadow agent review

Agent review begins only as a recommendation. It records rubric version, confidence, evidence, abstention, and reasons. It cannot modify approval, public, delivery, refund, or customer-contact state. Human disagreement and false-accept severity are retained for evaluation. Any future authority requires a separate explicit decision and evidence threshold.

## Retention and economics

Treat separately:

- customer PII/intake;
- operational/audit evidence;
- payment/accounting facts;
- private generated revisions;
- purchased/public artifacts.

The provisional one-year PII window is configurable and subject to legal/product review. Artifact availability follows the customer promise, not merely the PII window. Record bytes, provider cost, regeneration count, revenue, estimated storage, and estimated egress per generation without exposing customer PII in financial reporting.
