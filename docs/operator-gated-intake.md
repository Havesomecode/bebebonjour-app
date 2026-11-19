# Operator-gated intake, payment before generation

Owner decisions, 18/11/2026:

- "Someone can consume my subscription without paying — an operator must read the request and approve launching generation; decouple the input data from what the model receives (prompt injection, personal data)."
- The customer pays **after operator approval and before any generation**. No free preview.

## Rule

No request reaches a model until an operator has read it in the ops console (`bebebonjour-ops`, `/commandes/<jobId>`) and launched it from a **generation brief**. A public (`paid_route_a`) order also needs a verified €39 payment before the first generation. The model receives only the operator-approved brief and verified catalog reference, as JSON data in a fixed prompt template: never the customer email, the raw request, correction feedback or any other intake field. The optional meaning from the request may be prefilled for operator review.

## Lifecycle

Both order modes: `paid_route_a` (public, €39) and `complimentary` (offer password).

1. `submit` stores the intake with status `awaiting_operator`. The only email is an operator notice (`operator_new`) to `BEBEBONJOUR_OPERATOR_EMAIL` with the link `${BEBEBONJOUR_OPS_CONSOLE_URL}/commandes/<jobId>` and no customer data. Paid intake records terms (`TERMS_VERSION = "route-a-39-v2"`), publication permission and the adult/France/parental declaration at submit.
2. Operator reads the raw request and edits the brief, then:
   - **Launch** (`operatorLaunch`): stores the brief for `desiredRevision`.
     - paid, revision 1, payment not settled → `payment_pending`, plus a `customer_payment` email to the customer with their order link (`reviewUrl`). The order page has the "Payer 39 € par carte" button (Stripe Checkout, created on click, 23 h expiry).
     - otherwise (complimentary, or a paid correction, or relaunch after a failed generation) → `generation_queued`.
   - **Refuse** (`operatorRefuse`), only from `awaiting_operator` → `refused`. No email.
3. Stripe webhook (`payment_intent.succeeded`, metadata `job_id`, `revision` = `"1"`, `brief_digest`) → verified evidence → `generation_queued`. A payment for a job that is not `payment_pending` is still recorded (money was taken) and the job is left as is for the operator; no generation is started for a cancelled/refused order.
4. `generate` (worker: Codex composition from the brief → Cedar narration → render → publish at the stable public link) → `draft_email_queued` → `awaiting_review`. Same for both modes. The public link shows the draft banner until approval.
5. Customer review:
   - `request_changes` (paid: max 2 corrections; complimentary: revision limit 12) → `desiredRevision++`, feedback stored for the operator, status `awaiting_operator`, operator notice `operator_correction`. The operator rewrites the brief and launches; no new payment.
   - `approve` → `final_email_queued` → `approved_sent`. Paid: `hostingEndsAtMs` = final email + 12 months.
6. Failed generation (`failed`, `lastError.stage === "generate"`, no lease, no publication/narration/email receipt for `desiredRevision`): the operator can launch again (attempt counter reset). This replaces `retryCorrection` / `operatorRetryCorrection`.

The worker's `claim` only takes `generate` with a stored brief for `desiredRevision` and, for paid orders, `payment.status === "settled"`. Stages: `generate`, `draft_email`, `final_email` (no `finalize`).

Statuses: `awaiting_operator`, `refused`, `payment_pending`, `generation_queued`, `generation_running`, `draft_email_queued`, `draft_email_running`, `awaiting_review`, `final_email_queued`, `final_email_running`, `approved_sent`, `failed`, `reconciliation_required`, `cancelled`.

## Brief

Operator input (validated by `src/delivery-loop/brief.mjs`, shared by Convex and the worker; any violation throws `invalid_brief_<field>`):

| Field | Rule |
| --- | --- |
| `firstName` | trimmed, 1–60 chars, only letters/marks (`\p{L}\p{M}`), space, hyphen, apostrophe (`'` `’`) |
| `nameArabic` | `null` or same rule |
| `gender` | `girl` / `boy` / `neutral` |
| `birthDate` | `null` or a real calendar date `YYYY-MM-DD` |
| `religion` | `general` / `islam` (paid orders: `general` only; the paid form does not offer `islam`) |
| `tone` | `tendre` / `joyeux` / `sobre` / `poetique` |
| `nameMeaning` | optional, null or text up to 400 chars after whitespace normalization; phrase characters only, no URLs, first name or Arabic name. Suggested from the last `Sens du prénom : ` marker for operator review. |
| `phrases` | array of 0–3 strings, each trimmed 1–140 chars, only letters/marks/digits, space and `. , ; : ! ? ' ’ « » " - ( ) ، ؛ ؟` |

Unknown keys are rejected. Convex adds `languages` (copied from the intake, not editable) and stores `{ revision, brief, briefDigest, launchedAtMs }` in `data.briefs`. `briefDigest` = sha256 of the sorted-key JSON of the stored brief. The paid Checkout and webhook bind the revision-1 `briefDigest`.

Model prompt: fixed template + `JSON.stringify({ schemaVersion: "3.0", brief, nameReference })`; `nameMeaning` takes priority; `nameReference` (verified catalog meaning) is sent only when `nameMeaning` is empty. `operatorJob` returns `catalogMeaning` (`{ fr, ar }` or null) for the console. The template treats values as data, uses the tone, optionally weaves in phrases unchanged, mentions `birthDate` only if set, invents nothing and returns only the schema JSON.

## Ops console contract (Convex, operator token `BEBEBONJOUR_OPERATIONS_TOKEN`)

- `deliveryLoop:operatorJobs({ operatorToken })` → newest 30: `{ jobId, status, orderMode, paymentStatus, createdAtMs, fictional, babyName, customerEmail, languages, desiredRevision, latestRevision, revisions:[{revision, publishedAtMs}], publicUrl, lastError }`.
- `deliveryLoop:operatorJob({ operatorToken, jobId })` → `{ jobId, status, orderMode, paymentStatus, createdAtMs, fictional, desiredRevision, latestRevision, intake: { email, babyName, nameArabic, gender, languages, religion, birthDate, request, voiceEnabled }, feedback, correctionsUsed, brief, suggestedBrief, publicUrl, orderUrl, notices:[{kind, revision, status, atMs}], lastError, canLaunch, canRefuse, revisions, options: { tones, genders, religions } }`. `brief` = stored brief for `desiredRevision` or `null`; `suggestedBrief` = previous revision's brief, else built from the intake (`firstName` = intake name, `tone` = `tendre`, `phrases` = []). Never returns review/public tokens except inside `orderUrl`/`publicUrl`.
- `deliveryLoop:operatorLaunch({ operatorToken, jobId, expectedRevision, brief })` → same shape as `operatorJob`. Errors: `stale_revision`, `launch_unavailable`, `invalid_brief_<field>`, `paid_route_unavailable`.
- `deliveryLoop:operatorRefuse({ operatorToken, jobId, expectedRevision })` → same shape. Errors: `stale_revision`, `refuse_unavailable`.

Console capabilities (`BEBEBONJOUR_OPS_ENABLED_ACTIONS`): `launch_generation`, `refuse_request` (`retry_correction` removed).

## Emails (Convex action, Cloudflare Email, at most once per `kind` + `revision`, recorded in `data.notices`; a failed send is recorded and never retried automatically)

- `operator_new` — to `BEBEBONJOUR_OPERATOR_EMAIL`. Subject: `Nouvelle demande Bébé Bonjour à relire`. Body: `Une nouvelle demande attend votre relecture : <link>`.
- `operator_correction` — same recipient. Subject: `Correction Bébé Bonjour à relire`. Body: `Une demande de correction attend votre relecture : <link>`.
- `customer_payment` — to the customer. Subject: `<brief firstName> — votre demande est acceptée`. Body: `Nous avons lu votre demande. Le faire-part de <firstName> sera créé dès réception du paiement de 39 €.` + `Payer et suivre votre commande : <reviewUrl>` + `Bébé Bonjour · contact@bebebonjour.com`.

## Removed

- Automatic generation at intake and the free paid preview (`/delivery/preview`, `preview`, preview expiry/renewal, `previewConsent`).
- Correction feedback and previous composition sent to the model; the exact-closing-sentence check; `retryCorrection` / `operatorRetryCorrection`.
- Post-payment approvals: `paidApproval`, `paidPermissions` (now accepted at intake), `paidEditorial` / `editorialApproval`, the `finalize` stage and `finalPublication` (paid orders publish revisions like complimentary ones).
- `/delivery/operator` keeps only cancellation and manual payment reconciliation.
