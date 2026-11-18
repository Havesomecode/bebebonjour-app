## 1. Schema And Artifact Foundations

- [x] 1.1 Define the `customer-intake.json`, `announcement-page.json`, and `announcement-job.json` schemas with validation rules for supported languages, section ids, review state, template versioning, and page revisioning
- [x] 1.2 Create example intake, page, and job documents that cover Arabic-only, French-only, and bilingual cases
- [x] 1.3 Define the generated `transcript.json` and narration manifest formats so render and TTS steps share the same artifact contract

## 2. Template Extraction

- [x] 2.1 Extract the reusable page structure, runtime behavior, and styling from `../happy` into a template app in this repository
- [x] 2.2 Replace Bayane-specific hard-coded content with data-driven rendering from `announcement-page.json`
- [x] 2.3 Implement `sectionOrder` handling for the supported section ids and fail validation on unsupported or duplicate section ids
- [x] 2.4 Add support for declared template variants or feature flags without introducing ad hoc customer-specific template edits
- [x] 2.5 Ensure the rendered page remains functional when narration assets are missing or autoplay is blocked

## 3. Compose Workflow

- [x] 3.1 Implement intake validation and normalization into a compose-ready internal model
- [x] 3.2 Implement reference and meaning discovery for religion-aware and non-religious compose flows
- [x] 3.3 Implement blocked compose outcomes when suitable references or meanings cannot be found with sufficient confidence
- [x] 3.4 Implement operator-selectable compose output that produces draft `announcement-page.json` content instead of silently publishing final prose

## 4. Render And Narration Pipeline

- [x] 4.1 Implement the `render` command to generate deterministic static output from an approved page document
- [x] 4.2 Emit initial page artifacts in the output directory, including copied page data and generated transcript scaffolding
- [x] 4.3 Implement the `tts` command to generate narration audio, per-language manifests, and exact transcript timings from narration text
- [x] 4.4 Handle partial TTS success by preserving successful outputs and surfacing a partial completion state

## 5. Deployment And Revision Tracking

- [x] 5.1 Implement job-state updates that track current live revision, template/runtime version, deployment metadata, and email delivery state
- [x] 5.2 Implement the initial `deploy` command for Vercel using immutable build outputs pinned to template/runtime version and page revision
- [x] 5.3 Implement explicit redeploy behavior for approved customer tweaks so a new page revision can go live without mutating unrelated deployments
- [x] 5.4 Implement moderate job retention so operators can inspect support-critical metadata without duplicating full source documents

## 6. Codex Skill Layer

- [x] 6.1 Create Codex skills for compose, render, narration generation, deploy, and status workflows on top of the CLI
- [x] 6.2 Ensure Codex skills surface blocked compose states, approval gates, and redeploy decisions explicitly instead of bypassing them
- [x] 6.3 Ensure Codex skills present template/runtime version and page revision as separate concepts during inspection and operational workflows

## 7. Validation And Reference Migrations

- [x] 7.1 Recreate the existing Bayane page from structured data and verify parity with the prototype behavior
- [x] 7.2 Generate at least one second sample page with a different content mix and a different supported language set
- [x] 7.3 Verify that changing the template for a new generation does not mutate a previously deployed page without an explicit redeploy
- [x] 7.4 Verify that customer-specific content tweaks create a new approved page revision without requiring template changes
