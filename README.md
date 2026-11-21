# Bébé Bonjour

Bébé Bonjour provides an operator-gated birth-announcement workflow. The Railway backend serves the intake, review and announcement routes; the separately run delivery-loop worker generates content and coordinates narration and email.

## Repository map

- `server/railway.mjs` and `src/backend/`: Node HTTP server, functions and PostgreSQL runtime.
- `src/delivery-loop/` and `scripts/run-delivery-loop-worker.mjs`: delivery workflow and worker.
- `src/interest/`: interest-list service.
- `bin/announce.mjs`, `schemas/`, `template/` and `data/`: announcement CLI, schemas, template and synthetic examples.
- `test/backend/`: isolated backend tests.

## Local verification

Node.js 22 and npm are required. Inspect `package.json` before running commands. With dependencies installed, `npm run test:backend` runs isolated backend tests and `npm run build` checks JavaScript syntax. `npm test` runs the wider suite. `npm run verify` also runs an npm audit, which contacts the registry. Local tests do not prove hosted delivery or authorize provider effects.

For a local backend, set `DATABASE_URL` to an isolated PostgreSQL database and run `npm run start:railway`; startup creates tables in that database. Never point local tests at production. `npm run render:bayane` and `npm run render:amal` render synthetic fixtures to `out/`.

## Operations

See [live setup](LIVE_SETUP.md), [backend architecture](docs/railway-migration.md), [delivery loop](DELIVERY_LOOP.md), [paid runbook](docs/paid-route-a-runbook.md) and [support email routing](docs/support-email-routing.md). `.env.example` lists configuration names, not real values. Never commit credentials, customer submissions, private links or production logs. Deployment and customer/provider effects require separate action-specific authorization.
