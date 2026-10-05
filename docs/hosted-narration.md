# Hosted narration: implementation and live verification handoff

This path uses canonical jobs, queued operator commands, leases, effect fences and job-machine transitions. No deployment or provider calls were made while implementing it. Offline tests use a labelled generated tone, not claimed provider output. Release review remains a separate gate; historical consolidated evidence was not refreshed or declared passing.

## Runtime configuration (parent/operator only)

Convex backend:
- `BEBEBONJOUR_NARRATION_WORKER_TOKEN`: an independent narration-control secret for the operator-requested content decisions and render transition. It cannot claim `generate_narration`.
- `BEBEBONJOUR_TTS_WORKER_TOKEN`: a second independent >=32-character secret for the isolated narration project. Its Convex scope is exactly `generate_narration`; it cannot review, render, publish, deliver or process another operations action.
- Existing `BEBEBONJOUR_OPERATIONS_TOKEN` remains the operator reader/command credential.
- Optional, default OFF: `BEBEBONJOUR_NARRATION_TESTS_ENABLED=true` enables **new fictional operator-authored test creation only**. Disable after creating the test.

Ops server:
- `CONVEX_URL` exact HTTPS cloud origin; `CONVEX_SITE_URL` corresponding exact HTTPS HTTP-actions origin.
- Narration-control token only; existing operator/session/access/rate-limit configuration. Do not configure `OPENAI_API_KEY` or the TTS worker token here.
- `BEBEBONJOUR_OPS_ENABLED_ACTIONS=approve_content,request_content_changes,reject_content,render,generate_narration,approve_narration,request_narration_changes,reject_narration` (merge deliberately with existing allowed actions; this feature does not enable publication/email).

Isolated `bebebonjour-narration-worker` project:
- Configure only `CONVEX_URL`, `CONVEX_SITE_URL`, `BEBEBONJOUR_TTS_WORKER_TOKEN`, `OPENAI_API_KEY`, and a distinct `CRON_SECRET`. Generation, completion, operator, Resend, Stripe, Vercel and backend credentials are forbidden by the reviewed manifest.
- `OPENAI_API_KEY` is used only for one-attempt `POST /v1/audio/speech` requests with model `gpt-4o-mini-tts`, voice `cedar`, MP3 output, deterministic command/clip idempotency keys and the warm intimate male delivery instructions. It is not configured on customer-flow, generation, completion or Ops projects.
- Route: `GET /api/operations/narration-worker`, protected by `CRON_SECRET`, scheduled every five minutes. Node 22 and `maxDuration=300` require hosting plan support. Work deadline is 210 seconds, queue/stage leases are 300 seconds, and HTTP RPCs are bounded at 20 seconds. MP3 validation uses packaged `mpg123-decoder` WASM; release tests independently confirm valid and truncated samples with ffprobe.

## One real fictional narration check, without payment or aggregate rewriting

After independently reviewed source is deployed/configured by the parent:

1. Put short, clearly fictional human-authored French text in a local file. Export the **operator** token and Convex origin securely; do not print them or pass secrets as CLI arguments.
2. Run `node scripts/create-fictional-narration-test.mjs --acknowledge-fictional fr /path/to/fictional-text.txt` in the App checkout. `--help` is safe and makes no network calls. The backend returns a **new** `job_narration_test_<uuid>` in `content_review_required`, narration required, real stored source/HTML artifacts, `payment=null`, customer payment `not_applicable`, explicit operator-authored provenance. No existing historical job is changed, no Codex generation or payment is claimed. Test jobs cannot queue publish/deliver/generate/checkout.
3. Open Ops `/jobs/<returned-jobId>`, read the source text and explicitly approve content. The queued decision is recorded against exact revision + all artifact commitments, not a fabricated TEST-A reviewer.
4. Click Render. The exact approved private HTML/assets are promoted to a durable `prepared_bundle`; approved bytes are preserved and the changed path inventory gets a new manifest commitment.
5. Click Generate narration. The operator request queues only `generate_narration`; the isolated worker claims and fences one command, loads the exact approved page, makes one TTS request per section/language, actually decodes MP3, uploads typed MP3/transcript/review objects, validates durable storage metadata plus the source private-review and prepared-bundle commitments, then completes the canonical stage. An uncertain provider or upload outcome is redacted, non-retryable and never marked complete.
6. Read back `/jobs/<id>`. In `narration_review_required`, play every clip, inspect its text, then approve narration. Audio remains visible/playable in `publish_ready`; no publishing/email happens. GET `/api/operations/jobs/<id>/narration?revision=r1&path=artifacts/audio/fr/intro.mp3` is session-protected, no-store and single-range capable. No public storage URL or worker secret is sent to a browser.
7. Record actual HTTP statuses, storage-backed readback, digest, decoded duration and human listening outcome. The existing separate provider smoke is not proof of this canonical integration. This check is not full Codex/customer-generation proof.

Already queued but unprocessed work can be handled by the panel's **Traiter une action déjà en attente** button (same-origin CSRF-protected POST narration route). It never invents approval or automatically replays an uncertain provider effect. Provider/transport failures are redacted and non-retryable; use existing reconciliation practices after uncertain spend. A new request_narration_changes operator decision intentionally authorizes a fresh generation.

## Test commands and known boundaries

From App, Node 22:
```
node --test test/convex/narration*.test.mjs
BEBEBONJOUR_OPS_WORKTREE=/absolute/path/to/ops-narration node --test test/convex/hosted-narration-contract.test.mjs
node --test test/narration/narration-media.test.mjs test/operations/production-narration-worker.test.mjs test/config/narration-worker-isolation.test.mjs
node --test test/convex/*.test.mjs
```
From Ops: `npm test`, `npm run build`, then `npm run test:narration-routes` (starts a local production Next server; checks playback authentication and mutation CSRF without any provider calls).

Logs live in each owned checkout's `out/narration-*.log`. The cross-worktree contract test uses the actual Ops worker/media module, canonical Convex functions and durable test storage, with only provider transport substituted by a locally encoded sine-tone MP3. This is regression proof, not live acceptance.

Known boundaries: full customer content generation remains the user's Codex workflow; this worker does not handle content re-generation following content changes. Uncommitted blobs from an interrupted upload can remain orphaned and need a separate retention/cleanup policy. Publication packaging/email is deliberately not implemented here. The new narrated review inventory preserves prepared files and adds private audio/transcript/review metadata; do not assume it exercises the legacy CLI publication path. Full App tests require ffprobe for existing CLI tests, and the prior consolidated review boundary naturally rejects modified source; neither is bypassed by this change.
