# Bébé Bonjour live setup

The production Railway project is `bebebonjour-production`; service `api` runs `server/railway.mjs` with PostgreSQL. Its API origin is `https://api-production-c9013a1c.up.railway.app`. The worker and the separate `bebebonjour-ops` console use `BEBEBONJOUR_BACKEND_URL` to reach it. Public intake, review and announcement routes are documented in [backend architecture](docs/railway-migration.md).

## Configuration

Configure the `api` service using Railway variables, selecting the exact project, environment and service first. Consult `.env.example` for names and [the delivery-loop guide](DELIVERY_LOOP.md) for worker settings. `DATABASE_URL` must identify the intended PostgreSQL service; keep secrets in the approved private store and never print or commit them. Worker and operator credentials have distinct scopes. Configuration changes and restarts require separate authorization.

## Deployment

After explicit deployment authorization and review of the exact main commit, deploy a clean `git archive` of that commit, linked to project `bebebonjour-production`, with `railway up --service api`; the repository `Dockerfile` defines the image build. Do not deploy from a mutable worktree. Verify the deployed revision and appropriate non-destructive routes separately. This document does not authorize a deployment or customer/provider effects.

## Verification and recovery

Run `npm run test:backend` and `npm run build` locally with synthetic fixtures before release. Verify service health, customer routes, payment, mail, scheduled work and backup/restore separately under current authorization; local tests are not evidence of hosted delivery. Preserve uncertain provider-effect fences and reconcile them before retrying. See [security and recovery](docs/security-abuse-recovery.md).
