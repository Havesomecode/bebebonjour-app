# Railway backend architecture

The backend moved from Convex to Railway on 19/11/2026; the Convex deployments were deleted on 21/11/2026. Legacy tables never ported (`customerFlow`, `fulfillment`, `ownerTrial*`) are lost.

Railway project `bebebonjour-production` runs the Node `api` service at `https://api-production-c9013a1c.up.railway.app` with PostgreSQL. `server/railway.mjs` starts `src/backend/runtime.mjs` and the HTTP router. The worker and separate ops console use `BEBEBONJOUR_BACKEND_URL`.

## Runtime

`src/backend/functions.mjs` registers functions and validators; `src/backend/schema.js` lists indexes. PostgreSQL stores documents in `documents`, file bytes in `storage` and scheduled work in `scheduled_functions`. Mutations use transactions and an advisory lock. The scheduler polls due jobs, marks each running before execution and records done or failed; failed or interrupted running jobs are not automatically retried. The server invokes the paid-data sweep hourly; it does nothing unless `BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED=true`.

`POST /api/query`, `/api/mutation` and `/api/action` accept JSON `{ "path": "module:name", "args": [ {} ] }`; only public registered functions are exposed and their arguments are validated. Routes in `src/backend/routes.js` serve `/delivery`, review, operator, checkout, payment webhook, data controls, terms and `/announcements/*`. The server also serves `/interest/*` and `GET /version`.

## Local execution and deployment

Set `DATABASE_URL` to an isolated PostgreSQL database and run `npm run start:railway`; startup creates tables. `BEBEBONJOUR_DELIVERY_LOOP_ORIGIN` optionally sets the public origin; `PORT` defaults to 8080. `npm run test:backend` uses isolated fixtures and does not verify a hosted deployment. Follow [live setup](../LIVE_SETUP.md) for separately authorized deployment from a clean main archive. Backups and restoration must be independently verified; do not assume application deletion removes provider backups.
