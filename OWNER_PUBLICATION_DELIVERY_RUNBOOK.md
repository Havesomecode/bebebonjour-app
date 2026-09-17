# Exact narrated owner publication and delivery runbook

## Scope and immutable release binding

This runbook is only for:

- job `job_narration_test_650a15d1-39bd-4dec-bc0d-3519ace71aa7`
- initial state/version `publish_ready` / `8`
- revision `r1`
- narration decision `review_c4c5a7589bf08d2f674671d0` with outcome `approved`
- narration manifest `182a2b2d6d99a3a1887aed9b7ae84c4dae9be3cef04b7c563122144ed8095209`
- exactly one approved MP3 of `173568` bytes whose full SHA-256 starts `48387158` and ends `58c`
- one recipient, `z@havesomecode.io`
- Vercel project name `bebebonjour-test-a-announcements`

Payment, checkout, subscriptions, customer records, DNS changes, Git push, narration generation, OpenAI calls, and every other job are outside scope. The original `TEST-A` completion worker and `delivered@resend.dev` policy remain separate and unchanged.

## Components

- Ops queues only `publish`, `queue_delivery`, and `deliver`, scoped to the exact job.
- The owner completion endpoint is `GET /api/operations/owner-completion-worker`, authenticated by a dedicated `CRON_SECRET` bearer token. `vercel.owner-completion-worker.json` intentionally declares no cron: every invocation is manual.
- One invocation claims at most one command for the exact job.
- Publication reads the approved Convex artifact bytes under the active, persisted, effect-fenced publish lease. It maps the approved `deploy/*` page files and the approved `artifacts/audio/*.mp3` into the same stable announcement URL namespace.
- Vercel reconciliation runs before mutation. Deployment metadata, inventory, alias evidence, generated publication manifest, exact index bytes, and stable URL are read back before the canonical receipt is committed.
- Delivery uses a dedicated Resend adapter fixed to `z@havesomecode.io`, a persisted delivery target digest, one provider idempotency key, and a provider-mutation lease fence.
- Any expired or uncertain external effect moves out of normal command replay. This deployment exposes no owner retry or reconciliation command.

## Required configuration

Generate dedicated random values; never reuse one secret in another variable.

### Convex deployment

Set:

- `BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN` — dedicated, at least 32 bytes
- `OWNER_APPROVED_AUDIO_SHA256` — the full 64-character SHA-256 read from the canonical `narration_review` artifact; it must start `48387158` and end `58c`

Keep all existing Operations and narration variables unchanged. Deploy the reviewed Convex source only after tests pass.

### Owner completion worker Vercel project

Deploy this endpoint from a separate worker project using `vercel.owner-completion-worker.json`. Do not use the publication project as the worker project.

Set these exact policy values:

- `BEBEBONJOUR_OWNER_COMPLETION_JOB_ID=job_narration_test_650a15d1-39bd-4dec-bc0d-3519ace71aa7`
- `BEBEBONJOUR_OWNER_COMPLETION_REVISION_ID=r1`
- `BEBEBONJOUR_OWNER_NARRATION_DECISION_ID=review_c4c5a7589bf08d2f674671d0`
- `BEBEBONJOUR_OWNER_NARRATION_MANIFEST_DIGEST=182a2b2d6d99a3a1887aed9b7ae84c4dae9be3cef04b7c563122144ed8095209`
- `BEBEBONJOUR_OWNER_DELIVERY_EMAIL=z@havesomecode.io`
- `BEBEBONJOUR_OWNER_COMPLETION_WORKER_ID=owner-completion-worker`
- `BEBEBONJOUR_OWNER_COMPLETION_WORKER_ACTIONS=publish,queue_delivery,deliver`
- `BEBEBONJOUR_OWNER_COMPLETION_WORKER_LIMIT=1`
- `BEBEBONJOUR_OWNER_COMPLETION_WORKER_LEASE_MS=300000`
- `OWNER_APPROVED_AUDIO_SHA256=<full canonical 64-character digest>`
- `OWNER_APPROVED_AUDIO_BYTES=173568`
- `OWNER_PUBLICATION_VERCEL_PROJECT_NAME=bebebonjour-test-a-announcements`

Set deployment-specific values only after reading them from the providers:

- `CONVEX_URL`
- `CONVEX_SITE_ORIGIN`
- `BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN` — same dedicated value configured in Convex
- `CRON_SECRET` — distinct from every Convex/Operations token
- `VERCEL_TOKEN`
- `OWNER_PUBLICATION_ORIGIN` — an existing exact HTTPS alias origin; do not create or modify DNS
- `OWNER_PUBLICATION_VERCEL_TEAM_ID`
- `OWNER_PUBLICATION_VERCEL_PROJECT_ID`
- `OWNER_VERCEL_BUILD_INSPECTION_B64`
- `RESEND_API_KEY`
- `OWNER_RESEND_FROM` — a verified Resend sender

`OWNER_VERCEL_BUILD_INSPECTION_B64` is canonical base64 of UTF-8 JSON with exactly these keys:

```json
{
  "schemaVersion": "1.0",
  "source": "vercel inspect --format=json",
  "deploymentId": "<inspected deployment id>",
  "buildId": "<inspected build id>",
  "teamId": "<inspected team id>",
  "projectId": "<inspected project id>",
  "projectName": "bebebonjour-test-a-announcements",
  "revisionId": "r1"
}
```

Build this record only from a fresh authoritative inspection of the actual target project. Confirm its ID, team, name, baseline deployment/build, and existing alias. If the project, alias, or inspection cannot be proven, stop; do not create a project, alias, or DNS record under this authorization.

### Ops Vercel project

Keep the existing private Ops configuration and set:

- `BEBEBONJOUR_OPS_ENABLED_ACTIONS=publish,queue_delivery,deliver` (or include these in the existing allowlist)
- `BEBEBONJOUR_OPS_OWNER_COMPLETION_JOB_ID=job_narration_test_650a15d1-39bd-4dec-bc0d-3519ace71aa7`

The server rejects startup when completion controls are enabled without that exact job scope. Other jobs show these actions as disabled even when their canonical state would otherwise offer them.

## Offline release gates

Run from the application worktree:

```sh
npm ci
node --test test/operations/owner-completion-boundary.test.mjs
npm test
npm run build
node --check owner-completion-worker/api/worker.mjs
node --check src/operations/owner-completion-policy.mjs
node --check src/operations/production-owner-completion-worker.mjs
node --check src/fulfillment/owner-completion-capabilities.mjs
node --check src/fulfillment/resend-owner-delivery-adapter.mjs
```

Run from the Ops worktree:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Do not continue on any failure.

## Live operator sequence

These are future authorized operator steps. None were executed while preparing this change.

1. In Ops, open the exact job and read back state `publish_ready`, version `8`, revision `r1`, approved decision ID, manifest digest, and the full one-file MP3 digest/size. Stop on any mismatch.
2. Inspect the existing Vercel publication project and alias. Prepare the exact inspection JSON/base64 above. Stop rather than provisioning or changing DNS.
3. Configure and deploy the reviewed Convex source, the isolated owner completion worker, and Ops. A worker deployment is inert because the config has no cron.
4. Open the exact job in Ops. Confirm the only completion action offered is **Publier cette révision** and its rendered precondition binds revision `r1`, version `8`, and the exact manifest. Confirm the action once.
5. Invoke the worker exactly once:

   ```sh
   curl --fail-with-body --silent --show-error \
     -H "Authorization: Bearer ${CRON_SECRET}" \
     "${OWNER_COMPLETION_WORKER_ORIGIN}/api/operations/owner-completion-worker"
   ```

6. Refresh Ops. Require canonical state `published`. In **Reçu canonique**, record the stable HTTPS URL, Vercel provider receipt/deployment ID, exact manifest, revision, and publication idempotency key. Open the URL and verify the approved page and its published audio path before proceeding.
7. Confirm **Préparer l’envoi** once. Invoke the worker exactly once with the same authenticated GET. Refresh and require state `delivery_queued`. This step performs no provider mutation.
8. Reconfirm the stable URL, publication receipt, manifest, revision, and recipient `z@havesomecode.io`. Confirm **Envoyer au parent** once. Invoke the worker exactly once.
9. Refresh Ops. Require canonical state `sent` and exactly one delivery attempt. Record the Resend message ID, target reference, and delivery idempotency key from **Reçu canonique**. Read the provider message status by its recorded ID if delivery confirmation is needed; never send a replacement to infer status.
10. Stop. Do not enqueue or invoke anything else.

## Uncertain-effect stop rule

If publish or deliver returns an error after its provider-effect fence, times out, loses its lease, or shows `reconciliation_required`, stop immediately:

- do not click retry;
- do not enqueue another publish or deliver command;
- do not invoke the worker again for that command;
- read the canonical Ops command history and receipt fields;
- inspect Vercel by the exact idempotency metadata or Resend by the recorded provider message ID;
- require a separately reviewed recovery change if canonical state cannot be reconciled without another external effect.

The owner worker intentionally has no `retry` or `reconcile` capability, and Resend has no lookup by idempotency key. This is the final replay fence against a second uncertain email.
