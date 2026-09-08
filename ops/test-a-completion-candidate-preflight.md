# TEST-A completion worker candidate preflight

Status: release candidate only. Nothing in this packet authorizes deployment, provider mutation, command creation, publication, delivery, email, DNS, spending, or real customer data.

## Exact authority

- Job: `job_03c25b08-8476-4fe1-923b-43d73feab3ff` only.
- Identity: `environment=test`, `product=announcement-page`, current revision from the canonical fulfillment aggregate.
- Completion actions: `approve_content`, `render`, `publish`, `queue_delivery`, `deliver`, and bounded stage `retry` only. Canonical job states and versions enforce their order.
- Delivery target: Resend test sink `delivered@resend.dev` only.
- Publication: exact inspected Vercel team/project/revision and one stable HTTPS origin whose project remains access-protected. All served artifact reads use `private, no-store`.
- Convex credential: `BEBEBONJOUR_COMPLETION_WORKER_TOKEN`, distinct from operator, generation worker, rate-limit, backend, and cron credentials. Convex accepts it only for the fixed job and fixed action scope.
- Completion runtime must not mount customer backend, Stripe, Tally, checkout, DNS, or live-recipient credentials.
- Generation remains `generate`-only with Codex timeout `240000`, auth lease `290000`, and worker lease `300000` milliseconds.

## Preconditions for a separately authorized release

1. Bind the release to the signed commit, tree, changed-path allowlist, and raw diff SHA-256 in the Kanban handoff. Refuse a dirty tree or a different tree.
2. Re-run `npm test`, `npm run build`, `npm run test:integration`, `npm run test:vercel-routing`, `npm run test:production-audit`, `npm audit --omit=dev`, and `git diff --check` from that exact tree.
3. Deploy the Convex functions from the exact tree before the completion endpoint. Configure a fresh completion token and the exact `TEST_A_PUBLICATION_ORIGIN` in Convex, and configure the same fresh token in the completion project; do not reuse `BEBEBONJOUR_OPERATIONS_WORKER_TOKEN` or `CUSTOMER_FLOW_BACKEND_TOKEN`.
4. Create a separate Vercel Pro-or-higher project from `vercel.completion-worker.json`; the five-minute cron is not valid on Hobby. Its configured environment allowlist must equal `completionOperatorRuntime.environmentVariables` in the reviewed hosted-provider manifest. Do not attach customer-flow, model, payment, intake, DNS, or real-recipient credentials. Read back the plan, routes, cron, and configured variable names before enabling the alias.
5. Inspect the separate access-protected publication project with authoritative Vercel JSON. Encode only that reviewed publication inspection document as canonical base64 in `VERCEL_BUILD_INSPECTION_B64`; its team, project, deployment, build, and revision are publication identity and must not be compared with the completion worker's own Vercel system deployment id. Its revision must equal the current synthetic revision.
6. Keep provider-capable commands absent until a human has verified the signed persisted approval. Then create one command at a time against the exact current state/version: `approve_content`, `render`, `publish`, `queue_delivery`, `deliver`. Use `retry` only for the same persisted failed stage after inspecting its bounded reason code. Never bypass stale/conflicting command refusal.
7. Verify each readback from Convex. The only acceptable terminal delivery target is `delivered@resend.dev`; no real recipient is permitted.

## Observability and recovery

The endpoint response is bounded to protocol/version, worker id, synthetic job id, enabled-action count, and claimed/completed/failed/expired counts. Exceptions, provider payloads, tokens, PII, and recipient data are never returned. Expired pre-effect leases may be retried through a new exact-version command. An expired post-fence external effect remains reconciliation-required and must not be blindly replayed; inspect provider state before any separately reviewed reconciliation change.

## Rollback

1. Disable the completion-project cron and remove its worker alias; do not alter the generation project. Read back the project routes and verify `/api/operations/completion-worker` is absent before continuing.
2. Rotate or remove `BEBEBONJOUR_COMPLETION_WORKER_TOKEN` in both Convex and the completion project. Invoke only the worker health query with the retired token and require `Unauthorized`; do not run a queued command as a rollback probe.
3. Remove or restore the publication alias only under a separate rollback authorization, then read back the alias assignment and require that it no longer targets the TEST-A deployment. Disabling the worker alone does not retract an already published alias.
4. Leave unresolved fenced commands and canonical fulfillment history intact for audit. Do not delete provider records or replay an uncertain effect.
5. If Convex rollback is separately authorized, redeploy the previously signed Convex tree only after the completion endpoint is disabled, its token revoked, and the alias readback is safe.
6. Re-run `npm run test:vercel-routing`, `npm run test:production-audit`, and the completion-token rejection tests after the rollback configuration change. The safe steady state is the existing health-only generation alias plus no completion endpoint authority and no TEST-A publication alias. Rollback never sends email, republishes, mutates DNS, or touches real customer data.
