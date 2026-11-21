# Delivery loop

Every request waits for an operator to read it and launch an approved generation brief, or refuse it. Public paid orders require verified payment before generation. See [operator-gated intake](docs/operator-gated-intake.md) and the [paid runbook](docs/paid-route-a-runbook.md).

The persistent worker is `scripts/run-delivery-loop-worker.mjs`. It requires an HTTPS `BEBEBONJOUR_BACKEND_URL` and a scoped `BEBEBONJOUR_DELIVERY_LOOP_TOKEN`; the production API origin is `https://api-production-c9013a1c.up.railway.app`. Its private state directory is configured with `BEBEBONJOUR_DELIVERY_LOOP_STATE_DIR`. `--help` shows worker options without starting work; `--once` can process a real stage and must not be used against production without authorization. The separate ops console uses the same backend URL.

Composition uses the locally authenticated Codex subscription. Narration and email are coordinated by backend provider actions. Narrated work waits for the voice worker readiness check; see [R1 timing](docs/r1-announcement.md). Cloudflare provider acceptance is not proof of inbox delivery. Uncertain narration and email effects stay fenced; do not blindly retry or invent receipts.

Local synthetic tests cannot establish the current hosted service state, an actual customer delivery or permission for a provider effect.
