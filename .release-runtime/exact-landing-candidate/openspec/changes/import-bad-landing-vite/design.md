## Context

The current implementation lives inside `bad-implem/` as a standalone static project with assets and scripts that are not organized as the root production app. The requested end state is a root-level Vite project that embeds the landing page and matches the exact copy and section structure in `SPEC.md`, while remaining deployable on Vercel under `bebebonjour.com`.

## Goals / Non-Goals

**Goals:**
- Create a root Vite app and migrate useful landing implementation from `bad-implem` into it.
- Preserve existing media assets where relevant.
- Align rendered content and section order with `SPEC.md`.
- Remove legacy `bad-implem/` after migration.
- Initialize Git in the workspace root.

**Non-Goals:**
- Building a CMS or dynamic backend for content management.
- Implementing checkout/payment flows for offers.
- Configuring DNS records directly from this repository.

## Decisions

1. Build the final landing as a Vite vanilla app at repository root.
Reason: The imported implementation is plain HTML/CSS/JS and can be integrated quickly without adding framework overhead.
Alternative considered: React template. Rejected because it adds migration overhead with no requirement for component/state complexity.

2. Copy content from `SPEC.md` as the source of truth for marketing copy and section structure.
Reason: The user requested conformance to `SPEC.md`, so existing `bad-implem` copy is treated as secondary.
Alternative considered: Preserve existing copy and patch minimally. Rejected because it risks drift from required text.

3. Reuse static assets from `bad-implem/public` where useful and host them in the Vite `public/` directory.
Reason: This keeps existing media and avoids unnecessary regeneration.
Alternative considered: Remove all legacy assets and recreate new ones. Rejected due to time and value trade-off.

4. Keep deployment setup simple with a Vercel config tuned for Vite static output.
Reason: Ensures predictable build/output behavior for production deploys.
Alternative considered: Zero-config Vercel only. Rejected to avoid ambiguity in build command/output directory.

## Risks / Trade-offs

- [Risk] Some `bad-implem` assets may be unused after migration.
  -> Mitigation: Keep asset folder but only reference needed files; further pruning can be a follow-up.
- [Risk] Exact wording mismatches with `SPEC.md` may slip in during migration.
  -> Mitigation: Explicitly rewrite page sections from `SPEC.md` and review final HTML.
- [Risk] Vercel SPA routing behavior may differ if deep links are later introduced.
  -> Mitigation: Include SPA rewrite rule in `vercel.json`.

## Migration Plan

1. Initialize a Vite app at repository root.
2. Copy/adapt landing implementation and assets from `bad-implem` into Vite structure.
3. Rewrite page content and section order to match `SPEC.md`.
4. Validate local production build.
5. Remove `bad-implem/` and keep root as single source of truth.
6. Initialize Git repository if absent.

## Open Questions

- Should the pricing CTAs link to a checkout/contact URL now, or remain button placeholders in V1?
