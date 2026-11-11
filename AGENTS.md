# Bébé Bonjour

Operator-controlled birth-announcement fulfillment, with signed intake, payment, private generation, publication and delivery. Node.js 22; npm; ES modules.

## Layout

- `api/`, `convex/`, and `src/customer-flow/` handle hosted intake and canonical state; `src/fulfillment/`, `src/operations/`, and `src/persistence/` implement workflows and adapters.
- `src/delivery-loop/` and `convex/` contain the separate first-party delivery loop; worker entry points live in the `*-worker/` directories and `scripts/`.
- `bin/`, `template/`, `schemas/`, and `data/examples/` support the announcement CLI, rendering, contracts, and synthetic fixtures. `test/` contains unit and integration coverage.

## Development and checks

- `npm ci`; `npm test`; `npm run build` (syntax and related checks).
- `npm run test:integration` runs the synthetic fulfillment tracer; it requires `ffprobe`. `npm run verify` also runs routing, production-boundary and npm dependency audits; the audit can access the network.
- `npm run dev:customer-flow` starts the loopback synthetic customer-flow server. `npm run compose:bayane` and `npm run render:bayane` use example fixtures and write to `out/`.
- Read the relevant README and operational contract before running commands: some invoke providers or mutate hosted state.

## Boundaries and conventions

Keep customer and baby data, private artifacts, credentials, customer URLs and provider metadata out of Git, logs and Kanban; dispatch carries only a private job reference. Verify provider signatures against raw bytes and preserve idempotency and effect fences. Tally intake is unpaid and does not itself authorize payment or fulfillment. For the canonical paid flow, preserve payment-state and exact-artifact review gates; narration has its own approval. Never infer delivery from provider acceptance.

`DELIVERY_LOOP.md` describes a distinct password-waived first-party path and its scoped mandate, including first-version publication before review and simulated acceptance decisions. Do not apply the older TEST-A review sequence to that path or generalize either document's authority. Check current scope before provider spend, deployment, publication, email, payment changes or production access. For uncertain external effects, stop and reconcile rather than replaying blindly. `OWNER_PUBLICATION_DELIVERY_RUNBOOK.md` is scoped to its exact job and revision.

## Shared building rules

Read the shared file below before changing this project. Its development rules apply only if the project has no real users yet; confirm that status before applying them. Existing project-specific security, data-preservation, and release requirements still apply.

@/home/hermes/repos/prompts-lib/AGENTS_BUILDING.md

Record project-specific corrections in this project's `## Lessons` section, not in the shared file.

## Lessons

Record project-specific lessons here as they are established.
