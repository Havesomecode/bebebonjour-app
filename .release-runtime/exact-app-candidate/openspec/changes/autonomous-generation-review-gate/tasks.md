# Implementation tasks

## Completed first tracer

- [x] Add explicit canonical-name and alias metadata to the reference catalog.
- [x] Implement deterministic Latin and Arabic comparison keys while preserving submitted display spelling.
- [x] Escalate ambiguous aliases and cross-script conflicts instead of silently matching.
- [x] Generate a claim-free fallback for original/unknown names.
- [x] Prevent empty fallback references from being presented as scripture.
- [x] Persist bounded name-resolution evidence in private page provenance.
- [x] Add `prepare-review` for deterministic local private preview generation.
- [x] Ensure private preparation creates neither `deploy/` nor a deployable `job.json`.
- [x] Add focused tests for name policy and private-preview replay.
- [x] Require explicit aliases for diacritic-bearing alternate spellings and preserve exact reveal spelling.
- [x] Stop unsupported gendered copy before private artifacts are written.
- [x] Include specific demands only in the private review dossier and mark them `not_evaluated`.
- [x] Remove third-party font requests from private review HTML.
- [x] Reject supplied Arabic forms that normalize to empty before enabling claims.
- [x] Filter every scripture item without source evidence before composition.
- [x] Bind private output-root reuse to the exact intake digest and current slug.
- [x] Reject symbolic links in existing managed output paths before writing.
- [x] Make private runtime narration-inert even when URL parameters request playback.
- [x] Reject direct `render` attempts to bypass private-review preflight.
- [x] Keep catalog meaning claims disabled until dedicated meaning provenance exists.
- [x] Reject contaminated matching roots containing stale preview or operational entries.
- [x] Reject nonexistent outputs beneath untrusted symlinked ancestors.
- [x] Stop per-script ambiguity before cross-script intersection can narrow it.
- [x] Keep private rendering behind an unexported internal entry point.
- [x] Derive verse narration only from source-filtered items.
- [x] Keep the evidence schema enum aligned with invalid-orthography outcomes.
- [x] Validate assembled review evidence against both JSON Schemas before writing.
- [x] Bind root reuse to selection, catalog, template, and renderer material digests.
- [x] Add a separate dossier-bound local operator approval command.
- [x] Add a non-mutating delivery-readiness dry run for an approved prepared bundle.
- [x] Bind every prepared deployable file to the approval-bearing job and reject post-render asset tampering.
- [x] Enforce physical approval-output containment, exact private-bundle replay, and post-render source approval revalidation.
- [x] Remove operator-only TTS provider metadata from public pages and deployable narration manifests.
- [x] Bind and independently regenerate the approval-time prepared projection so coordinated asset and digest rewrites fail closed.
- [x] Authenticate complete operator approval evidence with non-serialized runtime key material so coordinated reviewer/evidence rewrites fail closed.
- [x] Stage TTS in a fresh private review root without mutating content-approved prepared bytes.
- [x] Add explicit HMAC-authenticated narration approval bound to exact reviewed media and content approval.
- [x] Make deploy and send independently reconstruct and verify the complete narrated projection.
- [x] Runtime-validate public narration manifests, private media review evidence, and narration approvals against strict JSON Schemas.

## Next implementation slices

- [ ] Replace name-only public slugs with collision-safe generation identities while preserving customer-facing display names.
- [ ] Build an aggregate/shared-app artifact manifest that retains multiple generations and immutable revisions.
- [ ] Add two-generation, same-name, and multi-revision coexistence tests.
- [ ] Add provider-neutral artifact byte accounting.
- [ ] Add a dedicated narration-review player/rubric with bounded retry controls and segment-level disposition evidence.
- [x] Locally implement the generation-run lifecycle and least-privilege claim/complete/fail RPCs in a candidate forward-only database migration; no hosted migration or deployment has been performed.
- [ ] Connect one paid `review_required` order to the generation worker using synthetic integration tests.
- [ ] Make the worker pull-based, one-order-per-invocation, lease-bound, and independent of webhook response ordering.
- [ ] Upload only a sanitized private subtree under immutable order/run/digest keys with a full-file manifest digest.
- [ ] Add private authenticated short-lived preview access, expiry, revocation, and eligibility-regression handling.
- [ ] Add parallel-claim, crash/lease-expiry, webhook-order/replay, same-name isolation, and exact-artifact-binding tests.
- [ ] Implement revision-bound operator decisions with optimistic concurrency.
- [ ] Add queue ownership, priority/SLA, stale-claim recovery, and dead-letter visibility.
- [ ] Define and implement PII/artifact retention tiers and dry-run lifecycle plans.
- [ ] Add shadow agent-review recommendation records and disagreement metrics without approval authority.
- [ ] Run security/privacy review, full integration verification, and final epic acceptance before any publication decision.

## Explicit gates

- No production database migration until its SQL, permission boundary, rollback posture, and integration tests are reviewed.
- No new external provider or paid service without approval.
- No live customer data, publication, email, delivery, refund, or delegated agent approval in this change.
