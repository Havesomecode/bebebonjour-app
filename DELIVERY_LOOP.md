# Delivery loop — current delivery mandate

## Outcome and authority

The owner explicitly authorizes closing the complete live loop on October 4, 2026:

1. Intake accepted with explicit consent and a password-authorized complimentary payment waiver.
2. Real automatic content generation, narration, live first-version publication and link email **before** human revision.
3. A clearly labeled simulated human correction request, real correction generation and updated live publication.
4. Clearly labeled simulated approval and a final link email.

The first draft must not wait for editorial or narration approval. The owner delegates the simulated review for this acceptance exercise; do not represent it as the owner's personal listening or editorial acceptance. Ordinary reviewers can subsequently request changes or approve through the review link. No fake payment/provider records. No automatic customer charge.

This mandate replaces earlier one-job trial restrictions for the new delivery-loop path. Existing historical jobs and evidence remain untouched. Dependency warnings, unrelated polish, historical review graphs and speculative audits are not new gates. Security, consent, secret handling, email idempotency and truthful delivery evidence remain necessary.

## Implementation boundary

The additive `deliveryLoop` Convex lifecycle is the authority for new password-waived first-party intakes. The first-party hosted intake, reviewer UI and unguessable public announcement links use HTTP routes. Content uses the existing Codex ChatGPT subscription; OpenAI API is for Cedar narration only; Resend delivers real messages.

The worker must be supervised independently of this conversation. Every generated revision and provider receipt persists. Correction republishes the stable announcement link while retaining earlier revisions. The live acceptance exercise uses fictional baby data and the owner's inbox, `z@havesomecode.io`.

Before using any inherited deployment credential, verify its exact project: the inherited `CONVEX_DEPLOY_KEY` is not assumed to belong to Bébé Bonjour.

## Acceptance evidence

Verified on October 5, 2026 through **final provider send acceptance**, not independent inbox delivery confirmation:

1. The fictional Amal intake persists with explicit consent and `payment.status = waived`; no charge or fabricated payment record.
2. Revision one was composed through the actual Codex subscription, narrated through OpenAI Cedar, published anonymously, and accepted by Resend before any review. The pre-review snapshot records zero reviews.
3. An explicitly `simulated_human` correction produced revision two on the same shareable URL. Its final displayed and narrated sentence is exactly `Bienvenue Amal, notre petite lumière.`. The corrected MP3 is different, decodes as MP3 (17.256 seconds, 276096 bytes), and its text digest matches the corrected narration. The original revision-one audio remains byte-identical and reachable.
4. Explicitly `simulated_human` approval led automatically to `approved_sent`. There are two immutable revisions, two durable narration receipts and three distinct Resend send IDs: initial draft, corrected draft and final approved link. Read-back timestamps prove that ordering. The final public response is revision two/approved, removes both draft markers and does not expose the private review token or customer email.

**Delivery limitation:** the hosted Resend credential is sending-scoped. Read-only inspection of the exact first/final message returns `email_inspection_http_401` (bridge HTTP 502). Send acceptance and durable IDs are verified; delivered/bounced events, actual inbox receipt and owner listening are not. No resend was attempted to compensate for that denial. Do not report actual human approval or inbox delivery from these receipts.

## Runtime and recovery

- Correct backend: `https://tacit-antelope-577.convex.cloud`, selected explicitly as `havesomecode:bebebonjour-test-a:prod`.
- Hosted first-party intake: `https://tacit-antelope-577.convex.site/delivery`.
- Email bridge: `https://bebebonjour-owner-completion-worker.vercel.app/api/delivery-loop/provider`.
- Persistent worker: `bebebonjour-delivery-loop.service`, enabled/active, `Restart=always`, runs `scripts/run-delivery-loop-worker.mjs` independently of chat. Private environment: `/home/hermes/.config/bebebonjour-delivery-loop/runtime.env`; state: `/home/hermes/.local/share/bebebonjour-delivery-loop`.
- Semantically unapplied corrections have a finite three-attempt generation budget; uncertain narration/email effects remain fenced against replay. Authenticated `deliveryLoop:retryCorrection` can resume only a failed `correction_not_applied` generation with no narration, publication or email receipt for that revision. It preserves attempt/review/history records and refuses exhausted or downstream-effect states. The recovered acceptance used its original correction/job, not a new intake.

Protected, mode-0600 acceptance evidence (contains recipient/shareable URLs; do not upload with source):

- `/home/hermes/.config/bebebonjour-delivery-loop/first-delivery-evidence.json`
- `/home/hermes/.config/bebebonjour-delivery-loop/correction-delivery-evidence.json`
- `/home/hermes/.config/bebebonjour-delivery-loop/final-delivery-evidence.json`
- `/home/hermes/.config/bebebonjour-delivery-loop/public-entrypoint-evidence.json`

Verification: 55 focused backend/worker/composer/provider tests pass, `npm run build` passes, and deployment plus anonymous page/audio readback pass. Canonical `npm test` returned 642 tests: 639 pass, one existing frozen TEST-A exact-source-boundary audit fails, two skipped. The historical evidence boundary was already stale and is not rewritten to invent a fresh review. This new delivery-loop mandate excludes that historical review graph; do not call the full suite green.

## Public entry point — verified live

`https://www.bebebonjour.com/delivery` responds with a temporary HTTP 307 redirect to the correct Convex intake, which returns HTTP 200 with the actual consent/password form and first-version-before-review notice. All four marketing CTAs now target `/delivery`; the landing copy states automatic initial publication/email before review. No additional intake or provider effect was created during this read-only route verification.

Vercel deployment `dpl_73az3x1osxdxkTASWRrPPZqPvswa` is `READY`, target `production`, in the exact owned project `prj_MJTHJrEVehZIRHuQBiZ1CgAG7MuB`. The provider alias lookup binds `www.bebebonjour.com` to that exact deployment. Anonymous live HTML hashes identically to the independently built landing candidate; the original CSP remains unchanged. Landing tests: 31/31 pass; its build passes. The isolated candidate worktree remains uncommitted; no source branch was pushed.
