# Bébé Bonjour architecture and release decision packet

- **Packet ID:** `BB-ARCH-RELEASE-2026-08-06-v3.0`
- **Prepared:** 2026-08-06T16:36:31Z
- **Status:** Pending explicit written dispositions
- **Intended decision-maker:** Bébé Bonjour accountable owner/operator (the dashboard operator; the response must state the decision-maker's personal name or accountable role)
- **Supersedes:** the original Tally + Supabase recommendation and the informal v2/v2.1 checklist for purposes of the next decision
- **Decision rule:** Silence, acknowledgement, “looks good,” or an unversioned approval is not consent. Each area below requires one written `APPROVE`, `REJECT`, or `REVISE` disposition tied to this Packet ID.

## Executive recommendation

Adopt a first-party intake form, Convex as the durable database/job-state/scheduler and initial file store, per-job Stripe Checkout, Vercel-hosted operator and public-router applications, Resend email, and `bebebonjour-editorial-v1`. Preserve immutable revision and approval boundaries from the verified local pipeline. Before any public release, choose and test a safe runtime for TTS/media validation, remediate the landing build vulnerabilities, and obtain separate production authorization.

This packet authorizes nothing by itself. It is a written decision request.

## Evidence reviewed

- `openspec/reports/2026-08-06-fulfillment-architecture-and-editorial-policy.md`
- `openspec/reports/2026-08-06-provider-cost-operational-facts.md`
- `openspec/changes/autonomous-generation-review-gate/design.md`
- `openspec/changes/autonomous-generation-review-gate/specs/private-review/spec.md`
- `openspec/changes/autonomous-generation-review-gate/specs/generation-worker/spec.md`
- `openspec/changes/autonomous-generation-review-gate/specs/shared-generation-app/spec.md`
- `openspec/changes/autonomous-generation-review-gate/specs/name-resolution/spec.md`
- Kanban task `t_3b2ef124` vulnerability audit and task `t_676a4802` revision record

Current provider prices and limits were reviewed on 2026-08-06 and can change. Account-region checkout prices control.

---

## A. Intake and forms

**Recommended choice**

Build a first-party accessible form in the web application. Create a canonical `job_id`, opaque intake token, and private server-side intake record before payment. Keep Tally only as a bounded rollback path until the first-party flow passes authorized tests; do not use Tally as the target architecture.

**Material alternatives**

- Tally for intake only: quickest fallback, but retains another processor and provider field mapping.
- Tally payment block: reject for the target; it weakens test-mode coverage and per-job Stripe metadata control.
- Fixed Stripe Payment Link plus email matching: reject; it cannot unambiguously bind repeated submissions to one job.

**Rationale**

A first-party form gives direct schema validation, accessibility control, explicit job correlation, and removal of one personal-data processor. It also implements the decision-maker's recorded revision away from Tally.

**Known costs**

No separate form subscription. Engineering, accessibility, abuse prevention, and monitoring remain costs. Tally remains a material fallback at Free, with paid plans shown separately on its pricing page.[11]

**Required accounts**

Vercel, Convex, Stripe test mode, and later the production counterparts if separately authorized. Tally is not required for the target.

**Operational constraints**

Server-side schema validation; idempotent submission; mobile and keyboard accessibility; bounded free text; rate limiting; anti-automation; no baby name, email, religious preference, or token in a durable URL; consent text before persistence.

**Security/compliance implications**

Treat parent email, child identity, Arabic/Latin spellings, free-text requests, and religious context as sensitive. Apply data minimization, CSRF/origin protection, redacted logs, retention enforcement, and a documented deletion path.

**Open questions**

- `A1`: Which anti-bot/rate-limit mechanism is acceptable, and may it add another processor?
- `A2`: What exact fields and consent wording ship at launch?
- `A3`: How long is the Tally rollback path retained, if at all?

**Decision — choose exactly one:**

- `APPROVE A` — approve the recommendation and record `A1-A3` as implementation-gate questions.
- `REJECT A` — reject the recommendation and name the selected alternative.
- `REVISE A: <exact changes and constraints>`.

---

## B. Database, job-state storage, scheduler, and artifacts

**Recommended choice**

Use Convex as the durable source of truth for jobs, payment correlation, immutable revisions, artifact metadata, review decisions, stage attempts, publication pointers, delivery attempts, and append-only events. Use Convex scheduled functions for wake-up/recovery orchestration. Use Convex file storage initially only where private/public access and complete-bundle verification can be enforced.

**Material alternatives**

- Supabase Postgres + Storage: technically proven in the repository and priced similarly, but superseded by the decision-maker's Convex revision.[12]
- Convex database plus a separate object store: acceptable if private/public bundle serving, size, cache, or read-back requirements cannot be met safely with Convex file storage.
- Local `job.json` or filesystem state: reject as production authority.

**Rationale**

One durable service reduces queue/database integration work while preserving the required state machine. The portable `job.json` remains a redacted snapshot, never the write authority. Convex currently includes database, file storage, webhooks, scheduled functions, auth integration, and preview deployments across its Free/Starter and Professional plans.[1][2]

**Known costs**

Convex Free/Starter is `$0/month` with pay-as-you-go options; Professional is `$25 per developer/month`. The currently displayed included allowances are 0.5 GB database and 1 GB file storage on Free/Starter, and 50 GB database and 100 GB file storage on Professional, with metered overage.[1]

**Required accounts**

One Convex organization with separate development/test and production deployments; production billing only after separate purchase authorization. An operator identity provider may be required but is not selected.

**Operational constraints**

Database mutations must enforce valid transitions and optimistic versions. Every worker attempt needs immutable job/revision identity, logical idempotency key, bounded attempts, lease/fencing semantics where applicable, retry target, and redacted failure code. Convex scheduling is the wake-up mechanism, not an HTTP request kept open.[2]

For artifacts, manifests bind all exact bytes. Public delivery must pass a guarded approved-publication lookup; direct storage URLs must not bypass approval, takedown, or rollback. Convex supports generated file URLs and custom HTTP serving, but the final serving shape must be verified against bundle size and access-control requirements.[3]

**Security/compliance implications**

Separate test/live deployments, credentials, data, and webhook endpoints. Browser code receives no admin authority. Use function-level authorization, least-privilege operator/worker identities, redacted logs, encrypted transport, backup/export drills, processor disclosures, and deletion propagation. Select an EU deployment region if it satisfies the production requirements and document the choice.[4]

**Open questions**

- `B1`: Free/Starter for authorized test work or Professional immediately for backups/support?
- `B2`: Which EU region, DPA, backup/export, recovery, and deletion evidence is required?
- `B3`: Convex-only files or a separate approved object store for public bundles?
- `B4`: Which operator identity provider and authorization model?
- `B5`: Can the scheduled-function/runtime model satisfy lease, concurrency, and retry invariants under failure?

**Decision — choose exactly one:**

- `APPROVE B` — approve Convex and record `B1-B5` as implementation-gate questions.
- `REJECT B` — reject Convex and name the selected database/scheduler/storage alternative.
- `REVISE B: <exact changes and constraints>`.

---

## C. Payment

**Recommended choice**

Use server-created Stripe Checkout Sessions, one reusable session per canonical job/payment attempt. Put `project=bebebonjour`, `product=<approved product>`, `environment=test|live`, `job_id`, and `intake_digest` metadata on the Checkout Session and explicitly on `payment_intent_data.metadata`. Treat the signed Stripe webhook as payment authority.

**Material alternatives**

- Fixed Payment Link plus email matching: reject.
- Tally-embedded payment: fallback only if separately approved with an explicit real-payment/refund test because the intended path cannot be fully exercised there in test mode.
- Another payment provider: no evidence currently justifies the migration cost.

**Rationale**

Explicit metadata and database uniqueness bind the shared Stripe account's payment to one project, product, environment, intake, and job. Amount and email are consistency checks, not identity.

**Known costs**

Stripe standard pricing advertises no fixed setup/monthly fee; the France page lists standard EEA cards at `1.5% + €0.25` per successful charge, with other card, conversion, refund, and dispute costs varying.[6]

**Required accounts**

The existing shared Stripe account; separate test and live keys, Price IDs, restricted secret keys, and endpoint-specific webhook secrets. Publishable keys are client-safe; secret/restricted keys remain server-only.[7]

**Operational constraints**

Handle success, asynchronous success/failure, expiry, refund, dispute, replay, duplicates, and out-of-order events. Verify the unmodified raw body before processing.[8] Production enablement requires exact account, Price, amount, currency, livemode, project, product, job, and intake-digest checks.

**Security/compliance implications**

Use hosted Checkout so card data does not enter the application. Restrict keys, redact payloads, store no card details, and ignore out-of-scope account events. Refund/dispute status does not silently retire a publication; a compensating workflow must do so.

**Open questions**

- `C1`: Confirm product ID/Price ID, launch price, currency, VAT treatment, and refund/dispute policy.
- `C2`: Confirm the restricted-key permission set and shared-account allowlists.
- `C3`: Is any separately authorized live smoke payment/refund acceptable before launch? Default is no.

**Decision — choose exactly one:**

- `APPROVE C` — approve per-job Stripe Checkout and record `C1-C3` as release-gate questions.
- `REJECT C` — reject Stripe Checkout and name the selected alternative.
- `REVISE C: <exact changes and constraints>`.

---

## D. Deployment and stable URLs

**Recommended choice**

Use Vercel Pro for commercial web surfaces: landing/first-party intake, authenticated operator/API service, and one public announcement router. Use separate non-production and production projects/secrets. Serve all approved announcements from one stable route contract such as `https://annonces.bebebonjour.fr/a/<128-bit-public-id>/<slug>/`; publication changes an approved immutable-revision pointer, not a per-customer Vercel deployment.

Convex owns durable state and scheduling. Vercel handles web/API/router requests and short handlers. Do not assume either runtime can safely run the existing native `ffprobe`/media workflow until an authorized packaging and duration test passes; use a separate bounded worker/container if required.

**Material alternatives**

- One Vercel project/deployment per customer: reject; unstable provider URLs and high operational overhead.
- Rebuild one aggregate static site on every publication: reject; route-loss, growth, and rollback risk.
- Another commercial host/router: viable only if it improves native-worker feasibility, cost, or guarded file serving without weakening approvals.

**Rationale**

A single router preserves equal-name isolation, revisions, rollback, takedown, and customer-facing stable URLs. The random public ID limits casual enumeration but is not authentication; `noindex, nofollow` remains the default.

**Known costs**

Vercel Pro is displayed at `$20/month` with included usage credit and usage-based overage; Hobby is not the production recommendation for this commercial product.[5]

**Required accounts**

Vercel team/project access, verified domain/DNS control, Convex deployments, and least-privilege CI/deployment credentials. Production projects/domains are not to be created under this packet alone.

**Operational constraints**

Upload immutable bundles, verify every object by digest/count, health-check the exact stable route, then atomically advance the publication pointer. Entry HTML needs short revalidation; versioned assets can be immutable. Takedown and rollback must work without deleting audit evidence.

**Security/compliance implications**

Public bundle allowlists exclude email, internal requests, reviewer details, provider configuration, and private provenance. Separate environments and memberships; secrets are server-only. Approval and publication are separate commands. A public URL is still public processing even when unlisted.

**Open questions**

- `D1`: Approve the proposed subdomains and stable-path contract?
- `D2`: Which runtime hosts TTS and `ffprobe` after an authorized feasibility test?
- `D3`: What maximum bundle size, cache/takedown SLA, monitoring, and rollback objective apply?
- `D4`: Is control of every required production domain verified?

**Decision — choose exactly one:**

- `APPROVE D` — approve Vercel + the shared stable router and record `D1-D4` as release-gate questions.
- `REJECT D` — reject the recommendation and name the selected host/router model.
- `REVISE D: <exact changes and constraints>`.

---

## E. Transactional email

**Recommended choice**

Use Resend for payment-link and final-delivery email from a verified sending subdomain. Bind each delivery attempt to the exact job, revision, publication, stable URL, and application idempotency key. Treat `sent` as provider acceptance and `delivered` as a valid signed delivery webhook.

**Material alternatives**

- Direct SMTP: lower vendor abstraction but more deliverability, telemetry, and operational work.
- Manual email: reject as the durable launch path; it lacks idempotent evidence and reliable status.
- Another transactional provider: viable if data location, retention, or deliverability requirements disqualify Resend.

**Rationale**

Resend supplies a small operational surface, domain-scoped keys, provider IDs, and signed delivery events. A stable sender and custom-domain URL avoid exposing provider-owned customer links.

**Known costs**

Resend Free is displayed at `$0/month` for 3,000 emails/month with a 100/day cap; Pro is `$20/month` for 50,000 emails/month, with published overage beyond that allowance.[9]

**Required accounts**

Resend account, owned domain, verified sending subdomain, restricted/domain-scoped API keys, and webhook signing secrets. Resend recommends a sending subdomain to isolate reputation.[10]

**Operational constraints**

Non-production recipients are allowlisted. Use bounded retries and one logical idempotency key. Bounce/complaint suppresses automatic resend. Subject lines omit the baby's name by default; the body includes the stable URL, support/takedown instructions, and retention promise.

**Security/compliance implications**

Do not log recipient address, baby details, URL token, or raw provider payload. Minimize retained provider metadata, verify webhook raw bodies, restrict keys, and disclose Resend as a processor.

**Open questions**

- `E1`: Confirm sending subdomain, sender identity, reply/support address, and recipient allowlist.
- `E2`: Is provider acceptance or confirmed delivery the customer-facing completion target?
- `E3`: Confirm required email/provider retention and bounce/complaint operating procedure.

**Decision — choose exactly one:**

- `APPROVE E` — approve Resend and record `E1-E3` as release-gate questions.
- `REJECT E` — reject Resend and name the selected email path.
- `REVISE E: <exact changes and constraints>`.

---

## F. Religious and Arabic content policy

**Recommended choice**

Adopt `bebebonjour-editorial-v1` with human-only launch approval. Require one exact content approval per revision and, when narration is requested, a second approval of exact decoded audio bytes for every requested language. No job may publish, send, or become complete before every required approval for the exact delivered revision is valid.

**Material alternatives**

- Hadith quotations in V1: reject by default; permit only after a curated exact Arabic/collection/numbering/grading/translation catalog is approved.
- Agent approval at launch: reject. An agent may provide a non-authoritative recommendation only.
- Silent transliteration/canonicalization or unsupported meaning/scriptural claims: reject.

**Rationale**

The policy preserves submitted Latin/Arabic display spellings, stops ambiguous or cross-script-conflicting names, and gives original/unsupported names neutral claim-free language. Quran text requires approved exact source bytes and identifiers; du'a is labeled as du'a; interpretations cannot be represented as consensus or authority.

**Known costs**

No policy subscription is required, but qualified human Arabic/religious/content and narration review is an unpriced per-order cost. Narration adds usage-priced OpenAI TTS and review time; actual usage, retries, and reviewer minutes must be recorded per job. See `openspec/reports/2026-08-06-provider-cost-operational-facts.md`.

**Required accounts**

Authenticated operator/reviewer identities with declared competencies. OpenAI is required only when approved narration is generated; its API key is server-only and unavailable to the deterministic preview worker.

**Operational constraints**

Review every language and customer demand. Record immutable reviewer identity, competency, rubric/policy versions, exact artifact digests, source dispositions, decision, reasons, timestamp, and authenticated signature. `request_changes` creates a new immutable revision. Regenerated audio invalidates the affected approval chain.

**Security/compliance implications**

Religious preference may be sensitive personal data. Keep it private, minimize access, disclose processing, and omit it from public/analytics metadata unless the approved content intentionally expresses it. Public projection excludes reviewer identity and private provenance.

**Open questions**

- `F1`: Name the qualified content and narration reviewers and their competencies.
- `F2`: Approve exact Quran editions, translation sources/versions, licenses, meaning-source catalog, and immutable source digests.
- `F3`: Finalize the rubric for Arabic grammar, pronunciation, RTL/mixed-script rendering, and abstention/escalation.
- `F4`: Confirm human-only authority duration and evidence threshold for any future agent reviewer.

**Decision — choose exactly one:**

- `APPROVE F` — approve `bebebonjour-editorial-v1` and record `F1-F4` as pre-release questions.
- `REJECT F` — reject the policy and state which content must remain unsupported.
- `REVISE F: <exact changes and constraints>`.

---

## G. Lifecycle and non-bypassable release invariant

**Recommended choice**

Use one canonical job aggregate with immutable evidence for intake, payment, revision, artifact set, content decision, narration decision, stage attempts, publication, delivery, and events. Preserve the reviewed lifecycle from `intake_pending` through payment, generation, content review, optional narration review, guarded publication, guarded delivery, failure/retry, retirement, and cancellation. Refund/dispute remains a payment outcome with compensating publication/delivery actions.

Only database functions may advance validated state. Approval makes an exact revision eligible for a separate shipping command; it never publishes or sends. `complete` is derived only when the exact approved revision is published and delivery reaches the approved success condition.

**Open questions**

- `G1`: Exact max attempts/backoff and terminal success rule for every stage.
- `G2`: Operator authority for unblock, refund, takedown, restoration, and retry.
- `G3`: Whether narration failure allows a separately reviewed no-audio revision or fails the purchased product.

**Decision — choose exactly one:** `APPROVE G` | `REJECT G: <reason>` | `REVISE G: <exact changes>`.

---

## H. Cost, accounts, privacy, and retention constraint

**Recommended launch envelope**

- Dependable fixed baseline: approximately `$45/month` for Convex Professional (`$25/developer/month`) plus Vercel Pro (`$20/month`), before taxes, overages, domains, Stripe, TTS, email upgrades, monitoring, backups/exports, and human review.[1][5]
- Lower-cost authorized testing may use Convex Free/Starter and existing Vercel capacity, but this does not approve purchases or production use.
- Resend Free may cover low launch volume; Stripe and TTS are usage-priced.[6][9]

**Recommended retention pending final legal/product approval**

- Abandoned, blocked, failed, rejected, and private review PII/artifacts: 30 days, absent a documented support/refund hold.
- Delivered operational PII: remove from generation access after 30 days; retain only the minimum protected support/delivery link.
- Approved public bundle and redacted audit/cost evidence: 365 days after delivery, with earlier authenticated takedown and separately approved renewal/restoration rules.
- Legal/accounting payment records: retain only what qualified advice requires; do not duplicate Stripe data unnecessarily.

**Open questions**

- `H1`: Is the `$45/month` fixed baseline acceptable before paid production orders?
- `H2`: Approve or revise every 30/365-day period and the customer-facing availability promise.
- `H3`: Which accounts already exist, who owns them, what spend caps apply, and who may purchase/upgrade?
- `H4`: What legal basis, privacy notice, processor/DPA, consent, deletion, and accounting-retention advice is required before live data?

**Decision — choose exactly one:** `APPROVE H` | `REJECT H: <constraint>` | `REVISE H: <exact budget/retention/account changes>`.

---

## I. Landing vulnerability remediation and release gate

**Recommended choice**

Before any landing release, apply the smallest audited upgrade on the selected landing branch: Vite `6.4.3`, PostCSS `8.5.26`, and esbuild `0.25.12`; regenerate the lockfile and require clean install, full and production-only audit, exact dependency resolution, production build, and local dev-server HTTP/CTA smoke. The upstream audit found the vulnerable Vite 5 tree dev-only, but still inside the developer/CI security boundary.

**Material alternative**

The existing local Vite `8.2.0` migration also audited and smoked clean, but it has a higher Node floor and broader Rolldown/Oxc/Lightning CSS and browser-target change surface. Select it only as an intentional major migration with browser visual regression evidence.

**Known costs/accounts/security**

No service purchase or production account change is required. Engineering and regression-testing time are the costs. Release remains blocked on a fresh point-in-time audit because registry advisories can change.

**Open questions**

- `I1`: Narrow Vite 6 remediation or intentional Vite 8 migration?
- `I2`: Required Node LTS pin and browser/visual regression scope?

**Decision — choose exactly one:** `APPROVE I` | `REJECT I: <release remains blocked>` | `REVISE I: <choose Vite 8 or another exact plan>`.

---

## J. Test-mode implementation authorization — distinct consequential-action boundary

Select the maximum permitted boundary; approval of Areas A-I does **not** select it automatically.

### `TEST-A` — local only

Permit source/schema/migration changes, local deterministic generation/review commands, unit tests, static analysis, and synthetic fixtures. No provider control-plane mutation, hosted deployment, email, payment event, or remote data write.

### `TEST-B` — local plus existing non-production provider resources

Permit `TEST-A` plus use of already-existing Stripe test mode, non-production Convex deployment, private non-production Vercel preview/staging, and Resend test/allowlisted recipients, using synthetic data only. Permit creation or mutation of test-only records/endpoints only after read-only inventory and within existing accounts/plan allowances. No plan upgrade, new paid account, public production alias, or live-mode credential.

### Explicit exclusions from both options

Unless separately and explicitly authorized in writing, neither option permits:

- any service purchase, subscription, paid upgrade, or spend commitment;
- production publication or public customer announcement;
- live customer-data access, migration, storage, or processing;
- live payment, refundable smoke charge, refund, dispute action, or live-mode webhook;
- production deployment/release, DNS cutover, public form launch, customer email, or production database migration;
- secret disclosure in chat, source, artifacts, logs, or decision records.

A later live smoke payment/refund, provider purchase, production migration, DNS change, publication, customer email, or production release each requires its own exact written authorization and scope.

**Authorization open questions**

- `J1`: Choose `TEST-A`, `TEST-B`, or no implementation.
- `J2`: If `TEST-B`, list the exact existing non-production accounts/projects, permitted mutations, recipient allowlist, and spend cap (`€0` by default).
- `J3`: May synthetic provider test events be sent to private staging endpoints?

**Decision — choose exactly one:**

- `APPROVE J — TEST-A`.
- `APPROVE J — TEST-B: <exact accounts/projects/mutations/recipient allowlist; spend cap defaults to €0>`.
- `REJECT J — no implementation authorized`.
- `REVISE J: <exact narrower or different boundary>`.

---

## Consolidated unresolved-choice register

The unresolved choices are `A1-A3`, `B1-B5`, `C1-C3`, `D1-D4`, `E1-E3`, `F1-F4`, `G1-G3`, `H1-H4`, `I1-I2`, and `J1-J3`. An area may be approved with named questions deferred only when the disposition states the gate at which they must be resolved. No deferred question may be silently defaulted if it affects spending, personal data, payment, publication, customer communication, editorial authority, or production release.

## Required written response

Reply through the auditable decision channel with all of the following:

- `Packet ID: BB-ARCH-RELEASE-2026-08-06-v3.0`
- `Decision-maker name or accountable role: ...`
- `A: APPROVE | REJECT | REVISE — ...`
- `B: APPROVE | REJECT | REVISE — ...`
- `C: APPROVE | REJECT | REVISE — ...`
- `D: APPROVE | REJECT | REVISE — ...`
- `E: APPROVE | REJECT | REVISE — ...`
- `F: APPROVE | REJECT | REVISE — ...`
- `G: APPROVE | REJECT | REVISE — ...`
- `H: APPROVE | REJECT | REVISE — ...`
- `I: APPROVE | REJECT | REVISE — ...`
- `J: APPROVE TEST-A | APPROVE TEST-B | REJECT | REVISE — ...`
- `Approved cost ceiling and account constraints: ...`
- `Unresolved question IDs and required resolution gate: ...`
- `Exact additional authorizations, if any: ...`
- `Timestamp: ...`

Every line requires an explicit disposition. Follow-up exchanges must quote this Packet ID and the affected area/question IDs. A generic acknowledgement, silence, or consent inferred from implementation activity is not approval.

## Sources

[1] https://www.convex.dev/pricing — Convex pricing
[2] https://docs.convex.dev/scheduling/scheduled-functions — Convex scheduled functions
[3] https://docs.convex.dev/file-storage/serve-files — Convex file serving
[4] https://docs.convex.dev/production/regions — Convex deployment regions
[5] https://vercel.com/pricing — Vercel pricing
[6] https://stripe.com/fr/pricing — Stripe France pricing
[7] https://docs.stripe.com/keys — Stripe API keys
[8] https://docs.stripe.com/webhooks/signature — Stripe webhook signatures
[9] https://resend.com/pricing — Resend pricing
[10] https://resend.com/docs/dashboard/domains/introduction — Resend verified domains
[11] https://tally.so/pricing — Tally pricing
[12] https://supabase.com/pricing — Supabase pricing
