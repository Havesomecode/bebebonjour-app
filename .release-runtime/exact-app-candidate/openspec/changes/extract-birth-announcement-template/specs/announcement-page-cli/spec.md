## ADDED Requirements

### Requirement: Compose assists editorial discovery from intake data
The `compose` command SHALL analyze intake data, search for relevant references and meanings, and propose candidate content directions for operator review instead of silently publishing final prose.

#### Scenario: Compose from a religiously scoped intake
- **WHEN** the intake specifies a religion and a baby name
- **THEN** `compose` searches for relevant religious references tied to that name and proposes candidate sections that the operator can review or edit

### Requirement: Compose falls back to neutral meaning and wishes when religion is absent
The `compose` command SHALL prefer general meaning, etymology, and neutral well-wishing content when no religion is specified in the intake.

#### Scenario: Compose from a non-religious intake
- **WHEN** the intake omits religion information
- **THEN** `compose` proposes name meanings and general wishes instead of duaa-specific language

### Requirement: Compose blocks on low-confidence reference discovery
The `compose` command MUST stop and ask the operator how to proceed when it cannot find suitable references or cannot determine a confident content direction.

#### Scenario: No reliable references found
- **WHEN** `compose` cannot find relevant references or meanings with sufficient confidence
- **THEN** it returns a blocked result that asks the operator what to do next instead of fabricating unsupported content

### Requirement: Render produces deterministic static output from canonical page data
The `render` command SHALL generate a deterministic static page build from an approved page document, including the configured section order and language presentation.

#### Scenario: Render the same page twice
- **WHEN** `render` is run twice with the same approved page document and template/runtime version
- **THEN** it produces equivalent static output for the same customer page revision

### Requirement: TTS generation emits narration artifacts and transcript timings
The `tts` command SHALL generate section narration assets, per-language manifests, and exact transcript timings from the canonical page document's narration text.

#### Scenario: Generate narration for one page revision
- **WHEN** `tts` runs successfully for a page revision
- **THEN** it writes audio files, manifest metadata, and transcript timing data that correspond to that approved revision

### Requirement: Deploy publishes immutable Vercel builds
The initial `deploy` command SHALL target Vercel and SHALL publish immutable builds pinned to the template/runtime version and approved page revision used to generate them.

#### Scenario: Deploy a customer revision
- **WHEN** `deploy` publishes a reviewed page revision to Vercel
- **THEN** the live deployment records the template/runtime version and page revision used for that build and does not change unless a later explicit redeploy occurs

### Requirement: CLI tracks revision-aware job state
The CLI SHALL update job metadata so operators can see the current live revision, deployment status, and delivery state for a customer page.

#### Scenario: Redeploy a minor customer tweak
- **WHEN** an approved customer tweak creates a new page revision and is redeployed
- **THEN** the job state reflects the new live revision without implying that the shared template changed
