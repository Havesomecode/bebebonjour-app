# Bébé Bonjour application

This `main` branch contains the Node application, Convex backend, and generation, narration, and completion workers. Read `README.md`, `package.json`, `LIVE_SETUP.md`, and the relevant `docs/` and `openspec/` documents before changing the corresponding flow. Confirm the assigned source and current project state rather than treating another worktree as the implicit base.

Inspect the scripts in this branch's `package.json` before installing dependencies or running checks. It defines `test`, `test:integration`, `build`, and `verify`; some worker and operator commands may contact live services. Use synthetic fixtures and the existing isolated verification path. A local test result does not prove hosted delivery, provider behavior, or a completed customer journey.

Preserve existing customer-data, payment, publication, email, and provider boundaries. Do not commit credentials, customer details, private links, or production logs. Follow the current action-specific authorization and runbook before any live operation; committing these instructions is not authorization to deploy or replay customer effects.

## Shared workspace rules

Read and follow the shared workspace policy for every project, including projects with real users.

@/home/hermes/repos/prompts-lib/AGENTS_WORKSPACE.md

## Shared building rules

Read the shared file below before changing this project. Its development rules apply only if the project has no real users yet; confirm that status before applying them. Existing project-specific security, data-preservation, and release requirements still apply.

@/home/hermes/repos/prompts-lib/AGENTS_BUILDING.md

Record project-specific corrections in this project's `## Lessons` section, not in the shared file.

## Lessons

- When adding a catalog verse, cut the Arabic quote from `data/quran-verses.json` (Tanzil text), never retype it: Tanzil orders diacritics differently (shadda before fatha), so a typed quote fails the verbatim check.
- When adding a new email kind, extend the idempotency-key allowlist in `src/fulfillment/cloudflare-email-transport.mjs` and test the real payload through the real transport (mocked fetch only): otherwise every send fails `cloudflare_input_invalid` in prod while unit tests with a fake transport pass.
