## ADDED Requirements

### Requirement: Private review preparation is one deterministic command
The CLI SHALL expose `prepare-review` to validate, compose, and render a private review package from one intake.

#### Scenario: Supported name
- **WHEN** a synthetic intake resolves to one supported candidate
- **THEN** the command writes a canonical draft, private preview, transcript, and review dossier

#### Scenario: Safe unknown-name fallback
- **WHEN** the submitted name is unknown but a neutral fallback is available
- **THEN** the command writes a private review package with a name-review reason and no unsupported claim

### Requirement: Private preparation cannot produce a deployable bundle
The command MUST NOT create `deploy/`, a deployable `job.json`, a live revision, a public URL, or delivery state.

#### Scenario: Private preparation succeeds
- **WHEN** `prepare-review` completes
- **THEN** all rendered browser files are under `private-preview/` and deploy remains impossible without a separately approved render/deploy workflow

#### Scenario: Direct render requests private mode
- **WHEN** the ordinary `render` command receives private-review/input-digest flags or an importer supplies a second private-options argument
- **THEN** it fails before writing because private rendering is available only through `prepare-review`

### Requirement: Private preparation is idempotent
The command SHALL produce equivalent review evidence and static output when replayed with identical intake, catalog, template, and output root.

#### Scenario: Identical replay
- **WHEN** the same preparation is run twice
- **THEN** the dossier and page artifacts remain byte-equivalent and no duplicate operational job is created

#### Scenario: Existing private bundle changed before replay
- **WHEN** any prior private-preview byte or same-family route differs from the dossier-bound bundle
- **THEN** replay fails before overwriting or accepting the changed inventory

### Requirement: One private output root belongs to one exact generation input
The command SHALL bind a non-empty output root to the SHA-256 digest of the exact intake snapshot and an aggregate digest over selection, catalog, template, and renderer materials used for composition.

#### Scenario: Different intake reuses an existing root
- **WHEN** a second intake targets a root containing another intake's review dossier
- **THEN** preparation fails before writing and instructs the operator to use a fresh output root

#### Scenario: Material input changes during replay
- **WHEN** identical intake targets an existing root but the selection, catalog, template, or renderer material digest differs
- **THEN** preparation fails before writing and instructs the operator to use a fresh output root

#### Scenario: Dossier advertises preview scope
- **WHEN** private preparation succeeds
- **THEN** dossier artifact paths are relative, `privatePreviewRoot` identifies only the current slug, and a digest binds every file under the shared private-preview bundle

#### Scenario: Matching root contains stale or operational entries
- **WHEN** an otherwise matching private root also contains another preview family, `deploy/`, `job.json`, or any unexpected top-level entry
- **THEN** replay fails before writing and preserves the contaminated root for explicit operator handling

### Requirement: Review evidence is runtime schema validated
The command MUST validate name-resolution evidence and the assembled dossier against their draft-2020 JSON Schemas immediately before writing `review.json`.

#### Scenario: Assembled evidence drifts from its schema
- **WHEN** any required field, enum, nested shape, or additional-property rule is violated
- **THEN** private preparation fails before writing the dossier

### Requirement: Local approval binds to the exact reviewed projection
The CLI SHALL expose `approve-review` as a separate local command that writes an approved page and approval record outside the immutable private review root.

#### Scenario: Operator approves an unchanged reviewed preview
- **WHEN** dossier/material digests match, canonical and private projections match, all review reasons are acknowledged, and specific demands are dispositioned
- **THEN** the command writes a digest-bound approved page to a fresh approval root without creating deploy or delivery state

#### Scenario: Approval output reaches the review root through an alias
- **WHEN** lexical paths differ but physical path resolution places approval output inside a symlink-aliased private review root
- **THEN** approval fails before writing

#### Scenario: Canonical content changed after preview
- **WHEN** the canonical draft no longer projects exactly to the reviewed private page
- **THEN** approval fails and writes no approval output

#### Scenario: Rendered private preview changed after dossier creation
- **WHEN** any private HTML, page, transcript, runtime, stylesheet, or asset byte changes after `review.json` is written
- **THEN** approval fails because the private-preview bundle digest no longer matches the dossier

#### Scenario: Approved page changed after approval
- **WHEN** ordinary render receives an approved page whose bytes or identity no longer match its sibling approval artifact
- **THEN** render fails before writing prepared output

#### Scenario: Prepared deploy asset changed after render
- **WHEN** any prepared HTML, runtime, stylesheet, transcript, page, or asset byte changes after ordinary approved render
- **THEN** deploy and delivery-readiness dry runs fail because the complete prepared bundle no longer matches the independently regenerated approved projection

#### Scenario: Prepared asset and mutable digest records are rewritten together
- **WHEN** a deployable asset plus approval and job prepared-digest records are changed consistently after approval
- **THEN** deploy and delivery-readiness dry runs still fail against the deterministic projection regenerated from the original approved page

#### Scenario: Approval evidence changed after render
- **WHEN** the original approved page, sibling approval artifact, or approval fields carried by the prepared job change after render
- **THEN** deploy and delivery-readiness dry runs fail before publication, sending, or job mutation

#### Scenario: Reviewer authority is rewritten consistently
- **WHEN** reviewer metadata, approved page state, approval digests, canonical prepared state, and job bindings are rewritten together without the operator-held approval key
- **THEN** render, deploy, and delivery readiness fail approval authentication before trusting reviewer identity or approval fields
- **AND** the operator-held key is never serialized into private, approval, prepared, public, or job artifacts

#### Scenario: Approved render lacks approval evidence
- **WHEN** ordinary render receives an approved page without `--approval` bound to that exact page
- **THEN** render fails even if draft override flags are supplied

#### Scenario: Local delivery readiness dry-run
- **WHEN** an approved page has been ordinarily rendered into a prepared public bundle
- **THEN** deploy and console-delivery dry runs verify the approved page and every prepared deployable file without publishing, requiring a public URL, sending, or mutating the job
- **AND** a normal console-delivery preview performs the same verification before accepting a deployed public URL

### Requirement: Nondeterministic narration has a separate authenticated approval gate
The CLI SHALL stage generated narration outside the content-approved prepared root
and SHALL require explicit operator approval of exact media bytes before narrated
content is eligible for deploy or delivery readiness.

#### Scenario: Narration is generated from an approved prepared base
- **WHEN** `tts` receives the exact approved page, approval artifact, and unchanged prepared base
- **THEN** it verifies `ffprobe` is available before any paid provider request
- **AND** it writes audio, browser-only manifests, updated transcript timing, and private generation evidence to a fresh narration-review root
- **AND** every byte in the prepared base remains unchanged

#### Scenario: Narration generation partially fails
- **WHEN** any requested language fails provider generation or media decoding
- **THEN** the fresh review root records `narration_generation_failed` plus redacted per-language results
- **AND** the partial root cannot pass narration approval

#### Scenario: Operator approves unchanged narration
- **WHEN** the private media schema and complete inventory are valid, every cumulative timeline offset matches decoded media duration, its content-approval identity matches, and the operator acknowledges exactly the generated languages
- **THEN** `approve-narration` creates a fresh complete prepared root and an HMAC-authenticated narration approval bound to the exact review record, media bytes, reviewer, timestamp, and complete narrated projection
- **AND** neither the prepared base nor narration-review root changes

#### Scenario: Narration output aliases an immutable input
- **WHEN** TTS or narration-approval output physically resolves inside or around an immutable page, approval, prepared, or narration-review input
- **THEN** the command fails before writing any output or changing an input byte

#### Scenario: Unmanaged media is added and the unsigned review digest is rebound
- **WHEN** an extra media artifact is added and mutable review digest fields are recomputed consistently
- **THEN** narration approval fails managed-inventory validation before creating or signing a final bundle

#### Scenario: Narrated media changes after approval
- **WHEN** approved audio, transcript, manifest, review evidence, narration approval, or mutable job bindings change
- **THEN** deploy and delivery-readiness dry runs fail against the authenticated media approval and independently reconstructed narrated projection

#### Scenario: Public narration metadata is projected
- **WHEN** a narration manifest is generated for browser playback
- **THEN** it validates against a strict allowlist containing only language, generation time, segment timing, section identity, and relative media paths
- **AND** provider, model, voice, instructions, credentials, request IDs, and raw provider responses are absent

### Requirement: Managed output paths cannot be symbolic links
The command MUST reject an existing output-root ancestor, output root, or descendant containing an untrusted symbolic link before writing any private artifact.

#### Scenario: Private preview or artifacts path is symlinked
- **WHEN** `private-preview`, `artifacts`, or another existing descendant resolves through a symbolic link
- **THEN** preparation fails before any file is written through that link

#### Scenario: Nonexistent output has a symlinked ancestor
- **WHEN** the requested output root does not exist but one of its existing ancestors is a symbolic link outside the trusted platform temporary-root alias
- **THEN** preparation fails before creating the output root or writing into the link target

### Requirement: Unsafe copy stops before artifact creation
The command MUST fail closed when the current composer cannot produce correct grammar for an intake.

#### Scenario: Unsupported gendered copy
- **WHEN** `prepare-review` receives a boy or neutral intake before those copy paths are corrected
- **THEN** it returns `needs_editorial_input` with `unsupported_gender_copy` and writes no output artifacts

### Requirement: Operator requests remain private and explicit
The private dossier SHALL show submitted specific demands without claiming they were applied.

#### Scenario: Specific demands await evaluation
- **WHEN** an intake contains `notes.specificDemands`
- **THEN** `review.json` includes the exact request with `applicationStatus: not_evaluated`, while browser/public projection files omit it

#### Scenario: Browser projection receives an internal request identifier
- **WHEN** a page is composed from an intake request
- **THEN** browser/private-preview page identity uses a deterministic opaque correlation suffix and does not expose the source request identifier

#### Scenario: Public projection receives operator-only TTS configuration
- **WHEN** a public page or narration manifest is projected from canonical material
- **THEN** provider, model, voice, and instruction metadata are omitted while runtime-required narration file timing remains available

### Requirement: Private preview does not contact third-party font services
The private HTML SHALL render with local/system font fallbacks and no Google Fonts request.

#### Scenario: Private HTML is generated
- **WHEN** `prepare-review` renders either language
- **THEN** its HTML contains no `fonts.googleapis.com` or `fonts.gstatic.com` reference

### Requirement: Private preview has no narration capability
The private runtime MUST expose readable static content without requesting narration manifests, transcripts, audio, or playback activation.

#### Scenario: URL requests narration or music
- **WHEN** a private preview opens with narration or music URL parameters enabled
- **THEN** runtime state normalizes narration off, exposes no narration control or start overlay, and requests no transcript or audio resource
