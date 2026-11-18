# Delivery-loop mail: Cloudflare only

## Candidate scope

This source-only successor starts at installed mail baseline `af0d277072eac9c3aa6c80e0b29929ab63d94f40`, not the canonical checkout's unrelated WIP. The starting report is preserved as attachment `rapport.md` on `personal-projects/t_d48dcdb6` (1611). Historical installation and transport evidence is not a current provider/configuration readback or proof of hosted announcement/closure delivery.

## New sends and admission

Announcement drafts, final announcements and closure notices use the existing Cloudflare transport exclusively. `BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER` defaults to `cloudflare`; an explicit value other than `cloudflare` refuses admission before recording a new effect. It is not a rollback switch to Resend. The retired `BEBEBONJOUR_DELIVERY_LOOP_PROVIDER_URL` cannot redirect mail or inspection to a Vercel relay.

Atomic one-shot admission precedes transport. Each effect and receipt retains its provider and operation identity; closure notices retain their separate fence. Missing credentials, provider rejection, timeout, uncertain acceptance and lost result acknowledgements never trigger Resend fallback or automatic resend. Already-fenced historical admissions are not re-admitted or relabelled. A defensive provider check also refuses a non-Cloudflare admission in either send action.

Cloudflare uses `bonjour@mail.havesomecode.io` and reply-to `contact@bebebonjour.com`. Account/zone IDs and sending credentials are required by the existing adapter. No analytics credential is required while status inspection is unavailable. This change does not alter the adapter, domain, DNS, credentials or preview-retention configuration.

## Historical receipts and inspection

Untagged historical receipts and admissions still mean Resend. Existing explicit Resend receipts, Cloudflare opaque message IDs (1–998 printable non-space ASCII characters), retained evidence, closure-notice state and support receipts remain unchanged. Old completion acknowledgements can still reconcile the exact old fenced effect; they cannot initiate transport.

Inspection first authenticates and binds the exact ID to the job's durable receipt. Mixed provider identities refuse. Resend inspection now returns `legacy_email_status_unavailable` without network access; it neither claims delivery nor calls a retired relay/API. Cloudflare inspection remains `cloudflare_status_unavailable`: sampled adaptive analytics cannot establish the latest event. See `ops/cloudflare-email-status.md`. Preserve uncertainty and reconcile separately under appropriate authority; missing status never authorizes another send. Provider acceptance is not inbox delivery.

## Support and remaining legacy code

The accepted Cloudflare forward `contact@bebebonjour.com` → `z@havesomecode.io` is external to this application's webhook and is not changed. The old Resend webhook is a body-independent HTTP 410 tombstone; its internal provider action also refuses without reads, mutations or provider calls, regardless of old flags or credentials. The identifier-only support ledger/schema is retained for historical reconciliation. See `resend-support-forwarding.md`.

Other historical customer-flow/TEST-A fulfillment adapters still reference the Resend SDK; they are not the delivery-loop runtime and are outside this bounded mail delta. Consequently the dependency remains installed. This candidate does not claim that every archived product path in this repository is Resend-free or authorize promoting the old backend tree wholesale.

## Verification and release boundary

Run the offline behavioral tests for admission defaults/refusal, exact receipt binding, historical acknowledgement, support retirement, duplicate/lost acknowledgements and scheduled closure. Run the real Convex production bundler and repository source checks without network access. Historical evidence stays immutable; the new delta has its own exact path/hash boundary and independent review.

No commit, push, deployment, actual message, fabricated hosted case/payment, customer-data operation, flag activation, DNS/secret change or purchase is authorized. Hosted announcement/closure business validation remains separate. Any future release must integrate only the reviewed mail delta into the then-current source and reconcile uncertain effects; do not deploy this historical full backend merely because local tests pass.
