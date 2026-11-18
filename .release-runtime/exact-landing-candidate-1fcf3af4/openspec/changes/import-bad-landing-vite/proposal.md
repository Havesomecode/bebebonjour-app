## Why

The current landing implementation is isolated in `bad-implem/` and not integrated into a clean project root workflow. We need a production-ready, deployable Vite app that preserves useful work from commit `2cccc8b` while aligning the final page content and structure to `SPEC.md`.

## What Changes

- Create a root-level Vite application as the canonical project structure.
- Import and adapt the landing page implementation from `bad-implem` (commit `2cccc8b`) into the Vite app.
- Ensure page copy and sections match `SPEC.md` for hero, benefits, process, offers, FAQ, and final CTA.
- Remove the obsolete `bad-implem/` folder once migration is complete.
- Initialize a Git repository at the current workspace root.
- Keep deployment compatibility for Vercel and domain usage (`bebebonjour.com`).

## Capabilities

### New Capabilities
- `birth-announcement-landing-vite`: A Vite-based landing page implementation with required marketing sections and content defined in `SPEC.md`, ready for Vercel deployment.

### Modified Capabilities
- None.

## Impact

- Affected code: new root Vite app files and migrated landing assets/components.
- Removed code: `bad-implem/` legacy isolated implementation.
- Deployment: Vercel build/output conventions for Vite SPA.
- Repository setup: new Git initialization at workspace root.
