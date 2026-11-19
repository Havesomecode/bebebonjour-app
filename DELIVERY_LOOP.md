# Delivery loop

## Current flow (18/11/2026)

Every request waits in `awaiting_operator` until an operator reads it in the ops console (`/commandes/<jobId>`) and launches generation from a brief, or refuses it. The model only receives the brief. Public orders (€39) pay after the launch and before any generation. Full contract: [docs/operator-gated-intake.md](docs/operator-gated-intake.md).

Narration speaks the page's screens (`buildAnnouncementChapters`), synthesized phrase by phrase and concatenated with frame-rounded 0.5 s pauses within a chapter and 1.0 s between chapters. Narration receipts and publication `audioFiles` carry `phraseStarts` (seconds, one per screen, from 0, strictly increasing); the page switches screens on them. Contract: `docs/r1-announcement.md` § Timing.

The October 2026 mandate below published a first version automatically before review; that path no longer exists. Its acceptance evidence is historical.

# October 2026 mandate (historical)

## Outcome and authority

The owner explicitly authorizes closing the complete live loop on October 4, 2026:

1. Intake accepted with explicit consent and a password-authorized complimentary payment waiver.
2. Real automatic content generation, narration, live first-version publication and link email **before** human revision.
3. A clearly labeled simulated human correction request, real correction generation and updated live publication.
4. Clearly labeled simulated approval and a final link email.

The first draft must not wait for editorial or narration approval. The owner delegates the simulated review for this acceptance exercise; do not represent it as the owner's personal listening or editorial acceptance. Ordinary reviewers can subsequently request changes or approve through the review link. No fake payment/provider records. No automatic customer charge.

This mandate replaces earlier one-job trial restrictions for the new delivery-loop path. Existing historical jobs and evidence remain untouched. Dependency warnings, unrelated polish, historical review graphs and speculative audits are not new gates. Security, consent, secret handling, email idempotency and truthful delivery evidence remain necessary.

## Implementation boundary

The additive `deliveryLoop` Convex lifecycle is the authority for new password-waived first-party intakes. The first-party hosted intake, reviewer UI and unguessable public announcement links use HTTP routes. Content uses the existing Codex ChatGPT subscription; narration uses the VoxCPM2 voice worker (`pere`/`mere`), configured with `BEBEBONJOUR_VOICE_WORKER_URL` and `BEBEBONJOUR_VOICE_WORKER_TOKEN`; The current source uses Cloudflare Email for outgoing messages; activation requires a separately authorized deployment.

The worker must be supervised independently of this conversation. Every generated revision and provider receipt persists. Correction republishes the stable announcement link while retaining earlier revisions. The live acceptance exercise uses fictional baby data and the owner's inbox, `z@havesomecode.io`.

Before using any inherited deployment credential, verify its exact project: the inherited `CONVEX_DEPLOY_KEY` is not assumed to belong to Bébé Bonjour.

## Acceptance evidence

Verified on October 5, 2026 through **final provider send acceptance**, not independent inbox delivery confirmation:

1. The fictional Amal intake persists with explicit consent and `payment.status = waived`; no charge or fabricated payment record.
2. Revision one was composed through the actual Codex subscription, narrated through OpenAI Cedar, published anonymously, and accepted by the then-configured email provider before any review. The pre-review snapshot records zero reviews.
3. An explicitly `simulated_human` correction produced revision two on the same shareable URL. Its final displayed and narrated sentence is exactly `Bienvenue Amal, notre petite lumière.`. The corrected MP3 is different, decodes as MP3 (17.256 seconds, 276096 bytes), and its text digest matches the corrected narration. The original revision-one audio remains byte-identical and reachable.
4. Explicitly `simulated_human` approval led automatically to `approved_sent`. There are two immutable revisions, two durable narration receipts and three distinct provider send IDs: initial draft, corrected draft and final approved link. Read-back timestamps prove that ordering. The final public response is revision two/approved, removes both draft markers and does not expose the private review token or customer email.

**Delivery limitation:** the then-hosted email credential was sending-scoped. Read-only inspection of the exact first/final message returns `email_inspection_http_401` (bridge HTTP 502). Send acceptance and durable IDs are verified; delivered/bounced events, actual inbox receipt and owner listening are not. No repeat send was attempted to compensate for that denial. Do not report actual human approval or inbox delivery from these receipts.

## Runtime and recovery

- Correct backend: `https://tacit-antelope-577.convex.cloud`, selected explicitly as `havesomecode:bebebonjour-test-a:prod`.
- Hosted first-party intake: `https://tacit-antelope-577.convex.site/delivery`.
- Email bridge: `https://bebebonjour-owner-completion-worker.vercel.app/api/delivery-loop/provider`.
- Persistent worker: `bebebonjour-delivery-loop.service`, enabled/active, `Restart=always`, runs `scripts/run-delivery-loop-worker.mjs` independently of chat. Since 19/11 the systemd drop-in `20-approved-runtime.conf` points at `~/.local/share/bebebonjour-delivery-loop-runtime/<main commit>` (a `git archive` of main with `convex data ops package.json package-lock.json schemas scripts src`, `node_modules` linked to the previous runtime; the worker reads `data/reference-catalog.json` at import). Upgrade it whenever `work()`/claim shapes change: the Nov 9 worker read `claim.intake.baby` and would have failed every brief-only generation. Private environment: `/home/hermes/.config/bebebonjour-delivery-loop/runtime.env`; state: `/home/hermes/.local/share/bebebonjour-delivery-loop`.
- Uncertain narration/email effects remain fenced against replay. A generation that failed three times shows in the ops console; the operator can relaunch it with the same or an edited brief.

Protected, mode-0600 acceptance evidence (contains recipient/shareable URLs; do not upload with source):

- `/home/hermes/.config/bebebonjour-delivery-loop/first-delivery-evidence.json`
- `/home/hermes/.config/bebebonjour-delivery-loop/correction-delivery-evidence.json`
- `/home/hermes/.config/bebebonjour-delivery-loop/final-delivery-evidence.json`
- `/home/hermes/.config/bebebonjour-delivery-loop/public-entrypoint-evidence.json`

Verification: 55 focused backend/worker/composer/provider tests pass, `npm run build` passes, and deployment plus anonymous page/audio readback pass. Canonical `npm test` returned 642 tests: 639 pass, one existing frozen TEST-A exact-source-boundary audit fails, two skipped. The historical evidence boundary was already stale and is not rewritten to invent a fresh review. This new delivery-loop mandate excludes that historical review graph; do not call the full suite green.

## Public entry point — verified live

`https://www.bebebonjour.com/delivery` responds with a temporary HTTP 307 redirect to the correct Convex intake, which returns HTTP 200 with the actual consent/password form and first-version-before-review notice. All four marketing CTAs now target `/delivery`; the landing copy states automatic initial publication/email before review. No additional intake or provider effect was created during this read-only route verification.

Vercel deployment `dpl_73az3x1osxdxkTASWRrPPZqPvswa` is `READY`, target `production`, in the exact owned project `prj_MJTHJrEVehZIRHuQBiZ1CgAG7MuB`. The provider alias lookup binds `www.bebebonjour.com` to that exact deployment. Anonymous live HTML hashes identically to the independently built landing candidate; the original CSP remains unchanged. Landing tests: 31/31 pass; its build passes. The isolated candidate worktree remains uncommitted; no source branch was pushed.
