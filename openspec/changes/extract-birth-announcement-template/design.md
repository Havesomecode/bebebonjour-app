## Context

The current reference implementation lives in the sibling `../happy` project and already demonstrates the desired experience: a cinematic static page with Arabic/French language switching, narration state in the URL, transcript-driven reveal timing, and generated TTS assets. Its main limitation is that both the structure and content are Bayane-specific, with most copy embedded directly in `index.html` and generated assets tied to that one page.

This change introduces a reusable generation system inside this repository. The system needs to support:

- a stable template/runtime derived from `../happy`
- canonical JSON contracts for intake, page content, and job state
- a CLI that generates, renders, enriches, and deploys pages
- Codex skills that orchestrate those CLI commands for the primary operator workflow

Constraints:

- most operator interaction will happen through Codex CLI, not a custom GUI
- religious references and multilingual prose require human review before publication
- the generated page must still work when narration assets are absent or autoplay is blocked
- V1 should optimize for correctness and repeatability, not full automation

## Goals / Non-Goals

**Goals:**

- Extract the reusable visual and runtime parts of `../happy` into a stable template app.
- Define `announcement-page.json` as the canonical content contract for rendering and narration generation.
- Keep authored content separate from generated artifacts such as transcript timings and audio manifests.
- Ensure deployed customer pages are immutable unless an explicit redeploy or upgrade action is requested.
- Provide a deterministic CLI workflow for compose, render, TTS generation, deploy, and status tracking.
- Define Codex skills as task-oriented wrappers around the CLI so operators can run the system through Codex without bypassing the underlying contracts.
- Preserve a human review gate before deploy.

**Non-Goals:**

- Building a customer-facing backoffice or self-serve admin UI.
- Fully automating theological validation or name interpretation.
- Supporting arbitrary page layouts or custom section ordering in V1.
- Replacing the CLI with Codex-only implicit behavior.
- Solving bulk multi-tenant hosting concerns beyond predictable per-slug deployment.

## Decisions

### 1. Use one canonical content document: `announcement-page.json`

The renderer, TTS pipeline, deployment logic, and Codex skill layer will all consume the same canonical page document. Intake and job files remain separate:

- `customer-intake.json`: raw customer submission plus minimal normalization
- `announcement-page.json`: approved, renderable content truth
- `announcement-job.json`: operational state and delivery metadata

Rationale:

- keeps authored truth separate from operational noise
- avoids coupling rendering to raw form input
- allows human review to happen on the same object that production uses

Alternatives considered:

- Use intake JSON as the render source.
  - Rejected because raw intake is incomplete and not editorially safe.
- Use job JSON as the top-level source of truth.
  - Rejected because operational status should not own content.

### 1a. Separate template versioning from page revisioning

The system should track two independent version axes:

- template/runtime version
  - which template family and renderer build produced the page
- page revision
  - which approved customer content revision is currently live

These answer different operational questions:

- `templateVersion`: did a renderer/template change cause this behavior?
- `pageRevision`: which customer-specific content edit is deployed?

Rationale:

- allows minor customer tweaks without changing the shared template
- allows template evolution for future pages without mutating prior deployments
- makes support and rollback more precise

Alternatives considered:

- One combined version number for both template and content.
  - Rejected because it obscures whether a change came from content revision or template evolution.

### 2. Keep timings and manifests generated, not authored

The canonical page file will include section-level narration text, but exact narration timestamps will be emitted into generated `transcript.json` and per-language `manifest.json` files during the TTS step.

Rationale:

- exact timing is downstream of audio generation
- avoids duplicated truth between content and audio assets
- lets render happen before narration exists

Alternatives considered:

- Store timestamps directly in `announcement-page.json`.
  - Rejected because timings drift when narration text or voice changes.

### 3. Extract one stable template app instead of cloning per customer

The codebase will keep a single template app whose content is materialized from structured data at generation time. Customer pages will be output as build artifacts under per-slug directories.

Rationale:

- template fixes apply to all future pages
- testing is simpler against one runtime
- generated output remains deterministic and disposable

Alternatives considered:

- Copy the full app for every customer.
  - Rejected because maintenance and bug-fix propagation would degrade quickly.

### 4. Keep the section model fixed in V1

The template will preserve the story structure proven in `../happy`, but the canonical content model should carry explicit section order so a page can intentionally reorder supported sections when needed.

The allowed section ids remain:

- `intro`
- `dua`
- `meaning`
- `reveal`
- `verses`
- `closing`

The page document should include a sequence such as:

- `sectionOrder`: `["intro", "dua", "meaning", "reveal", "verses", "closing"]`

Rationale:

- aligns with the current narrative and animation logic
- supports agreed customer-specific ordering without custom template code
- keeps variation constrained to known section types
- makes CLI rendering and transcript generation straightforward

Alternatives considered:

- Fully dynamic section lists.
  - Rejected for V1 because it complicates rendering, animations, and review without proving product value first.
- Hard-code one permanent section order.
  - Rejected because it makes legitimate customer-specific ordering requests require code changes or template forks.

### 5. Separate display text from narration text

Each supported language in each section will store render-oriented line arrays and TTS-oriented narration text separately.

Rationale:

- good on-screen phrasing is not always good spoken phrasing
- allows visual line breaks without contaminating narration
- avoids HTML fragments in the content layer

Alternatives considered:

- One text field reused for both rendering and narration.
  - Rejected because it over-constrains editorial quality.

### 6. Deploy one host with per-slug language routes

The routing contract will be:

- `/<slug>/ar`
- `/<slug>/fr`

Narration mode stays query-driven:

- `?narration=on|off`

Rationale:

- preserves the good parts of the existing URL model
- avoids subdomain management and separate project sprawl
- works naturally with static hosting

Alternatives considered:

- one deployment per customer
  - Rejected for operational overhead
- one route with only query-string language
  - Rejected because path-based language is clearer and already proven in the prototype

### 6a. Make deployments immutable and template-versioned

Each deployed page should be pinned to the exact template/runtime version used to generate it. A deployed customer page must not change when the shared template evolves unless an explicit upgrade or redeploy action is requested.

The canonical and operational records should carry version metadata such as:

- `templateFamily`
- `templateVersion`
- `rendererVersion`
- `pageRevision`
- deployed build identifier

Generated output should be self-contained and should not depend on mutable shared assets that can silently change old pages.

Rationale:

- protects already-live customer pages from accidental regressions
- allows template improvements for future pages without mutating previous deliveries
- makes support and rollback tractable because each deployed page maps to one known build

Alternatives considered:

- Old pages always read the latest shared template/runtime.
  - Rejected because it would make template changes retroactively affect deployed customer pages.
- Ad hoc manual exceptions for some customers.
  - Rejected because it creates unclear operational behavior and support risk.

### 7. Codex skills are orchestration layers, not alternate business logic

Codex skills will call and sequence the CLI commands. They will not reimplement validation, rendering, or deployment logic themselves.

Rationale:

- keeps behavior consistent between direct CLI use and Codex-driven use
- prevents drift between skill prompts and product logic
- makes the CLI the true operational API of the system

Alternatives considered:

- Put generation logic directly inside skills.
  - Rejected because it would make behavior less testable and harder to maintain.

### 8. Human review is required before deploy

The canonical page document will carry review state, and deploy must refuse pages not marked `approved`.

Rationale:

- protects against incorrect religious references and low-quality multilingual copy
- creates a clear editorial gate in an otherwise automatable pipeline

Alternatives considered:

- Allow deploy from draft content.
  - Rejected because quality failures are too costly for this product.

### 9. Build the system as a staged pipeline

The CLI will expose separate commands for:

- compose
- render
- tts
- deploy
- send
- status

Each stage consumes stable inputs and produces explicit artifacts.

Rationale:

- makes failures diagnosable
- supports partial success, especially for TTS
- lets Codex skills compose higher-level workflows from stable primitives

Alternatives considered:

- One `generate-everything` command only.
  - Rejected because it hides failure boundaries and makes review awkward.

### 9a. Make `compose` an assisted editorial discovery step

In V1, `compose` should not silently generate final publishable prose from the intake alone. Instead, it should act as an assisted editorial step that:

- reads intake data
- searches for relevant references, meanings, and naming context
- proposes candidate content directions
- lets the operator choose or edit before approval
- stops and asks what to do when no good reference or wording basis is found

Expected branching:

- if religion is specified:
  - search for religious references connected to the name
  - propose religious phrasing, including duaa-style sections where appropriate
- if no religion is specified:
  - search for general meaning, etymology, and neutral well-wishing language
  - prefer wishes and blessings rather than religious duaa framing
- if references are weak, ambiguous, or absent:
  - return options or a blocked state rather than fabricating authority

Rationale:

- matches the operator workflow more closely than either full manual entry or fully automatic writing
- reduces the chance of publishing incorrect or low-confidence references
- keeps editorial control while still making Codex/CLI genuinely useful

Alternatives considered:

- `compose` only normalizes already-authored content.
  - Rejected because it leaves too much of the research and suggestion workflow outside the system.
- `compose` writes the page autonomously from intake.
  - Rejected because it is too risky for references, tone, and multilingual quality in V1.

### 10. Treat template customization as declared variants, not one-off code edits

When customers request behavior or presentation beyond content-only changes, the system should support named template variants or explicit feature flags rather than ad hoc per-customer template modifications.

Examples:

- `templateFamily: blessed-arrival`
- `templateVersion: 1.2.0`
- `featureFlags: ["photo-intro", "extended-verses"]`

Rationale:

- keeps customizations discoverable and testable
- prevents untracked divergence between customer pages
- avoids accidentally changing one customer deployment while improving another

Alternatives considered:

- Hand-edit customer-specific template code for each request.
  - Rejected because it does not scale and makes regressions likely.

### 11. Keep moderate operational retention in `announcement-job.json`

`announcement-job.json` should keep pointers to the source artifacts and a moderate set of operational metadata, rather than a full duplicated audit snapshot of every input and output document.

Recommended retained fields include:

- intake file path
- current page file path
- current live revision id
- customer email
- baby names used for support context
- requested languages
- approval metadata
- deployed public URL
- deployment timestamps
- email send status
- lightweight revision history

The full intake and full page content should remain in their own files under a stable directory layout.

Rationale:

- avoids duplicating the entire source-of-truth data in multiple places
- keeps the job file readable and operationally useful
- still preserves enough context for support, redeploys, and customer tweak handling

Alternatives considered:

- Store the full original intake and all content snapshots inside `announcement-job.json`.
  - Rejected because it increases duplication, privacy exposure, and drift risk.
- Store only pointers and no copied support metadata.
  - Rejected because it makes common operational inspection too expensive.

## Risks / Trade-offs

- [Religious references may be misclassified or overinterpreted] -> Require structured source metadata and human approval before deploy.
- [Arabic and French prose may diverge in quality if generated too automatically] -> Keep `compose` reviewable and separate display text from narration text.
- [Template extraction from `../happy` may carry prototype assumptions that do not generalize] -> Preserve the visual/runtime core first and defer layout extensibility.
- [Shared template changes could unintentionally mutate already-deployed pages] -> Pin every deployment to an explicit template/runtime version and deploy immutable build artifacts.
- [Customer tweaks may be confused with template changes] -> Track page revision separately from template/runtime version and require explicit redeploy for each approved revision.
- [Codex skill ergonomics could drift from CLI behavior] -> Keep skills as thin wrappers over documented CLI contracts.
- [TTS may partially fail by language or section] -> Treat partial completion as a first-class outcome and preserve successful outputs.
- [Customer-specific feature requests could fragment the template] -> Funnel non-content customization into named variants or explicit feature flags.
- [Routing and static hosting details may constrain deployment later] -> Standardize on per-slug output now and keep hosting integration behind the deploy command.

## Migration Plan

1. Define the schema files and example documents that represent intake, canonical page content, and job state.
2. Extract the reusable template/runtime from `../happy` into this repository without changing the core interaction model.
3. Implement render-time data loading so the template is driven by `announcement-page.json`.
4. Implement CLI commands in pipeline order, starting with `compose` and `render`, then `tts`, then deployment/status tooling.
5. Add Codex skills that call the CLI for common operator tasks.
6. Validate the system by regenerating the existing Bayane page from structured data and then generating at least one second sample page using the same template contract.
7. Roll out deployment and delivery workflow only after the page generation path is stable.

Operational revision flow:

1. initial intake produces a draft page document
2. operator reviews and approves page revision `r1`
3. deploy publishes revision `r1` built with a pinned template/runtime version
4. if the customer requests minor tweaks, create page revision `r2`
5. review and explicitly redeploy `r2`
6. previous customer pages and unrelated slugs remain unchanged

Rollback strategy:

- keep the current `../happy` page as the production reference during development
- if the new generator path is not ready, continue serving existing pages from the prototype deployment model
- because generated output is static, rollback is done by redeploying the previous build artifact

## Open Questions

- The initial deployment target will be Vercel.
- OG image generation should be deferred until the main content/template pipeline is stable, but the model should leave room for future customer photo support.
- Job retention will use a moderate model: pointers to source artifacts plus enough copied operational metadata for support and redeploy workflows.
