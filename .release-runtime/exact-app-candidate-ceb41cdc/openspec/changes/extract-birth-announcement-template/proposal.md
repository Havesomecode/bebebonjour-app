## Why

The current `../happy` project proves the visual and narrative direction for a premium birth-announcement page, but it is still a one-off page with hard-coded Bayane-specific content. We need to turn that prototype into a repeatable product so new pages can be generated, reviewed, deployed, and delivered to customers without rebuilding the experience from scratch each time.

## What Changes

- Extract the existing cinematic birth-announcement page into a reusable template that supports Arabic, French, and bilingual variants.
- Introduce a canonical structured content format for customer intake, approved page content, and generated operational artifacts.
- Add a CLI workflow to compose page content, render a static page, generate narration assets, deploy the output, and track delivery status.
- Add Codex skills that wrap and orchestrate the CLI workflow so the project can be operated efficiently through Codex CLI.
- Standardize routing, narration behavior, and generated asset layout so every customer page is produced from the same contract.
- Preserve human review in the content pipeline so religious references, name meanings, and multilingual prose are approved before deployment.

## Capabilities

### New Capabilities
- `announcement-page-template`: A reusable cinematic page experience that renders structured birth-announcement content into Arabic, French, or bilingual customer pages.
- `announcement-page-schema`: Canonical JSON contracts for intake, renderable page content, transcript generation, and operational job state.
- `announcement-page-cli`: A CLI workflow that validates inputs, builds announcement pages from the template, generates narration artifacts, and supports deployment and delivery handoff.
- `announcement-page-codex-skills`: Codex skills that expose the page-generation workflow through task-oriented prompts built on top of the CLI commands.

### Modified Capabilities

None.

## Impact

- New application code for the reusable template, renderer, and CLI.
- New Codex skills that leverage the CLI for composing, rendering, narration generation, deployment, and operational handoff.
- Extraction and reuse of design/runtime patterns currently proven in `../happy`.
- New generated artifacts including page configs, transcripts, narration manifests, audio assets, and job metadata.
- Integration points for TTS generation, static hosting/deployment, and customer email delivery.
