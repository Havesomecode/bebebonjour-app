# Vercel Operations worker: health-only candidate

## Boundary

The isolated Vercel route `GET /api/operations/worker` remains authenticated by
`CRON_SECRET` and queries only `operations:workerHealth`. Its bundle imports no
Operations command runtime, queue mutation, generation runner, Codex runtime, or
artifact writer. A successful response preserves the existing bounded status
shape with zero enabled actions and zero claimed, completed, and failed commands.

The Operations console remains independent of this execution boundary. For a
prepared `generation_queued` job it still exposes `generate` and can enqueue an
exact state/version-bound pending command. The Vercel endpoint cannot claim that
command; execution belongs to a separately reviewed worker candidate.

## Configuration assumptions

Before any separately approved deployment, the isolated
`bebebonjour-generation-worker` Vercel project must have only these application
variables:

- `CONVEX_URL`: the exact reviewed HTTPS Convex origin.
- `BEBEBONJOUR_OPERATIONS_WORKER_TOKEN`: the existing worker-scoped token, at
  least 32 bytes.
- `BEBEBONJOUR_OPERATIONS_WORKER_ID`: a 3-64 character identifier matching
  `[A-Za-z0-9][A-Za-z0-9_-]*`.
- `BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS`: exactly the empty string. Any missing
  or non-empty value, including `generate`, fails closed before Convex access.
- `CRON_SECRET`: the existing Vercel cron bearer secret, at least 32 bytes and
  distinct from the worker token.

Remove the former limit, lease, Codex subscription, Codex auth, model, and model
provider variables from this Vercel project. The candidate neither reads nor
packages them. Never print environment values while checking the inventory.
No environment or cloud change is part of this candidate.

## Verification

Run from the exact candidate worktree without provider credentials:

```sh
node --test \
  test/operations/operations-worker-health.test.mjs \
  test/http/operations-worker-handler.test.mjs \
  test/config/generation-worker-isolation.test.mjs \
  test/config/test-a-operator-isolation.test.mjs \
  test/convex/operations.test.mjs
npm test
npm run build
npm run test:vercel-routing
npm run test:production-audit
npm audit --omit=dev
git diff --check
```

The focused assertions prove that health performs one query and no mutation,
all executable action scopes fail before Convex access, the generated worker
bundle has no generation capability graph, and Operations can still enqueue a
pending `generate` command for the prepared job.

## Rollback

Do not partially roll back configuration and code. After approval, revert the
exact candidate commit with `git revert <candidate-commit>` and redeploy that
revert only under a separate release authorization. Restore
`BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS=generate`, generation-specific variables,
and any packaged Codex runtime only together with the previously reviewed
generation-capable revision. Until that coordinated rollback is approved, leave
the Vercel project health-only; pending Generate commands remain durable in
Convex for the separately reviewed worker.
