# Security, abuse resistance and recovery — commercial candidate

This is an offline engineering candidate, not a production-security or launch attestation. No deployment, live-data read, paid provider call, customer message, or restore was executed. The existing owner/seller and qualified-review decisions on card `t_dfd9851e` are not assumed approved. Baseline: `c86664a3011519b63084c976140ef9f11893ae04`.

## Threat model and trust boundaries

| Surface / attacker | Controls and bounded failure | Evidence |
| --- | --- | --- |
| `POST /api/customer-flow/v1/intakes`: automation, hidden payloads, unbounded storage | TEST-A access plus HTTPS origin allowlist; 64,000-byte raw-body cap in Node adapter and Hono; explicit root/nested field allowlists, consent, bounded text, no control characters; minute/day attempt admission before persistence | `test/security/abuse.test.mjs`, `test/api/hosted-customer-flow-entrypoint.test.mjs` |
| `POST /api/customer-flow/v1/jobs/:id/checkout`: guesses, checkout storms, cross-job payment forgery | TEST-A gate, job-scoped bearer capability, global checkout attempt budget; stable Stripe idempotency key, server price and environment/correlation checks. Client intake cannot assert payment, approvals, or worker authority | `test/customer-flow/customer-flow.test.mjs`, `stripe-test-gateway.test.mjs`, `stripe-checkout-webhook.test.mjs` |
| `GET` and `HEAD .../status`: enumeration, secret/PII leak | Same shared status budget for both methods; wrong capability and absent job yield the same 404; SHA-256 token digest, 256 random bits for new hosted tokens; no raw token persisted; no-store public projection | `test/security/abuse.test.mjs`, `test/customer-flow/http-api.test.mjs` |
| `POST /api/customer-flow/webhooks/stripe`: spoofing, old/conflicting/repeated events | 64,000-byte cap, raw-byte Stripe timestamped signature verification, TEST-A live-mode refusal, minute/day budget, durable event fingerprint and job/payment correlation; event claims and provider-effect fences converge concurrent retries | `test/customer-flow/hosted-runtime.test.mjs`, `stripe-checkout-webhook.test.mjs` |
| `POST /api/webhooks/tally`: spoofing, spam, malformed signed form, replay | 1,000,000-byte streaming cap, raw HMAC verification, configured form/field/option/type allowlists and consent; global pre-signature budget; durable event/submission idempotency. Tally HMAC has no fresh timestamp: permanent same-event/submission replay controls are required | `test/security/abuse.test.mjs`, `test/customer-flow/tally-intake-webhook.test.mjs`, `tally-intake.test.mjs` |
| Private Operations mutations and worker invocations | Existing operator/worker role separation, action/lease/claim binding and login throttle; cron credentials are distinct from Convex worker credentials; persisted review authority precedes effects; workers and private artifact reads are not customer upload endpoints | `test/convex/operations-authorization.test.mjs`, `generation-worker-authority.test.mjs`, `narration-lifecycle.test.mjs`, `test/config/hosted-provider-artifacts.test.mjs` |
| Arbitrary file URL, HTML/script content, model instruction injection | Public intake accepts no file/URL/attachment fields. Text is data, not effect authority; bounded composition output and editorial review remain required. Rendering escapes customer text; artifact paths, manifests and byte/digest limits remain enforced. No claim that prompt injection is solved by character filtering | `test/fulfillment/codex-subscription-composer.test.mjs`, `committed-artifact-content-set.test.mjs`, `test/security/content-safety.test.mjs` |

The candidate does not enable live payments or self-service worker privileges. Customer capabilities authorize only their own status/checkout operations. Capabilities are not identity or a login session. Anyone holding one can use it; existing capabilities have no expiry and are not silently invalidated by this change. New tokens use `randomBytes(32)` rather than hosted UUID defaults; encrypted replay uses AES-256-GCM with job/status associated data.

## Admission policy and privacy

`convex/abusePolicy.js` is the backend-owned policy. Limits count attempts including invalid signatures, invalid bearer credentials and retries. There are exactly five reusable rows, one per scope, in `customerFlowAbuseBudgets`:

| Scope | Per UTC minute | Per UTC day |
| --- | ---: | ---: |
| intake | 30 | 300 |
| checkout | 60 | 600 |
| status (GET/HEAD) | 600 | 20,000 |
| stripe | 300 | 10,000 |
| tally | 60 | 1,000 |

Convex mutations own time and atomic increments across replicas; no client-supplied clock or policy is accepted. A denied request does not write a row or reach job/provider work. HTTP 429 includes integer `Retry-After` and no-store; backend outage or malformed admission result fails closed with 503. Minute/day rollover provides automatic recovery without deleting state. Fixed windows permit a double burst around a boundary. These are conservative initial small-volume deployment-wide limits, not measured capacity guarantees or per-customer fairness.

No bearer token, raw/hashed IP, device identifier, email, job ID, request body, event ID, or fingerprint is a rate-limit key or field. Rows contain only scope, window times and attempt counts. Constant cardinality needs no TTL cleanup and cannot accumulate attacker-chosen identities. Existing provider-event fingerprints and operator-login source hashes are separate pre-existing integrity/authentication records, not newly introduced customer abuse telemetry.

Global caps deliberately trade availability for bounded downstream admission: an attacker can consume a legitimate user's allowance. Rate limiting does not bound Vercel/Convex invocation charges or raw network bandwidth. Before public commercial launch, the authorized release operator must verify provider edge protection, hard provider spending ceilings/alerts, and legitimate retry capacity in staging; none was changed here. Do not evade a exhausted budget by clearing rows, switching deployment, disabling checks, or giving clients backend tokens.

## Secret inventory and rotation

Inventory records names/scopes only; never secret values. `ops/test-a-hosted-provider-manifest.json` `secretStores` and the executable validators in `src/config/test-a-hosted-provider-manifest.mjs` are the exact allowed/forbidden worker inventory. `.env.example` and `src/config/hosted-customer-flow-config.mjs` cover customer ingress. No new secret is required for budgets: their mutation accepts only the existing backend credential.

| Secret class | Where it belongs | Rotation constraint |
| --- | --- | --- |
| `CUSTOMER_FLOW_BACKEND_TOKEN`, `CUSTOMER_FLOW_TEST_ACCESS_TOKEN`, `TALLY_INTAKE_SIGNING_SECRET`, `STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET` | Backend/ingress stores; never public assets or generation worker | Pause ingress for coordinated backend-token change; update Convex and all consumers, roll cold starts, verify old credential denied using synthetic fixtures. Tally/Stripe webhook changes require configured provider handoff and retry reconciliation |
| `CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY` | Ingress only, separately encrypted recovery escrow | Do not overwrite: old encrypted submission responses become unreadable. Require an authorized decrypt/re-encrypt migration and tested rollback; this candidate implements no key ring or token revocation migration |
| Operations operator/rate-limit, generation, narration-control, TTS and completion worker tokens; `CRON_SECRET` | Distinct, least-privilege control/worker stores from manifest | Stop affected scheduling and workers; reconcile in-flight effect/lease states; rotate both sides without co-mounting privileges; expired/old worker must fail before an effect |
| `BEBEBONJOUR_CODEX_AUTH_ENCRYPTION_KEY`, encrypted subscription auth; `BEBEBONJOUR_APPROVAL_HMAC_KEY` | Generation auth and exact approval boundary respectively | Preserve decryptability/version linkage; key change is not permission to synthesize approval or replay an unknown provider effect |
| `OPENAI_API_KEY`, `BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN`, `STRIPE_SECRET_KEY`, `VERCEL_TOKEN`, protection-bypass credentials, Convex deploy/admin access | Provider-scoped isolated projects and authorized operators | Revoke compromised credential at provider, issue least-privilege replacement, update only allowed stores; synthetic negative/positive checks and deployed readback require separate current authorization |

Maintainer generates high-entropy credentials through approved secret tooling, not chat or command-line arguments. Escrow encryption keys separately from data archives. Production/staging credentials and data must remain separate. Infrastructure presence, escrow custody, actual rotation timestamps and provider MFA were not inspected in this offline card; the release reviewer verifies them.

## Audit-safe logging and vulnerability gates

Candidate request handlers do not log bodies, signatures, authorization headers, customer content, capability values or raw provider exceptions. Tally no longer reflects arbitrary exception `code`/`statusCode`; domain codes are bounded and responses are no-store. Hosted API uses an explicit public-error map. For incident metrics, permit only scope, bounded reason code, status, count, build ID and time bucket. Do not add payload capture, access-token URLs, IP logs, email/job correlation, or telemetry SDKs for abuse attribution. Provider access-log behavior and retention require the policy/provider review; absence of application logging is not proof that provider logs are anonymous.

Run `npm ci --ignore-scripts`, Node 22 canonical `npm run verify`, `npm ls --all`, and both `npm audit --omit=dev` and `npm audit`. This candidate pins Vercel CLI 62.7.0 and patched transitive ranges (including tar 7.5.22); the lockfile is part of the candidate and routing artifacts are actually built. Runtime audit is expected to have zero findings. A development-only unpatched `braces <=3.0.3` stack-exhaustion advisory propagates through the CLI's glob/ts-morph chain (21 high package reports; zero critical after patching). Do not suppress or call this a clean full audit. Use the CLI only against reviewed owned source/config paths, never untrusted uploaded projects or glob patterns. Independent review must classify this residual; commercial release review must re-audit against current advisories. No owner acceptance is invented.

## Backups and restore

The executable offline drill is `test/security/recovery.test.mjs`: a JSON-round-tripped synthetic Convex snapshot plus private blob bytes is restored into a fresh fixture, with storage reference remapping. Encrypted capability replay remains decryptable, status authorizes, signed Tally retry remains a duplicate with one job/work item, exhausted daily budget still denies, and private blob bytes match. This tests application invariants, not the hosted Convex export/import CLI, account permissions, production snapshot consistency, elapsed restore time or external-provider state.

An authorized operator's hosted drill must capture all schema tables and file storage, signed source/schema/deployment identities, provider-effect/command correlation ledger, data snapshot time, encrypted key-version escrow, and a checksum manifest. Data-only backup without storage or keys is insufficient. No retention schedule, RPO/RTO promise or legal hold policy is approved here; agree them with owner/qualified review before launch.

Pinned Convex 1.44.0 CLI help was checked offline. Future authorized commands must explicitly target a named deployment, never implicit dev/prod defaults:

1. Freeze intake and every worker/schedule; capture reconciliation state. Export with `node node_modules/convex/bin/main.js export --deployment <approved-source> --include-file-storage --path <private-snapshot.zip>`.
2. Encrypt the snapshot with approved escrow tooling; checksum, restrict access, and keep it outside source control. Store decryptable key versions separately. Do not attach real data to engineering Kanban.
3. Provision a separately authorized empty recovery deployment with identical schema/source and no production provider credentials. Restore with `node node_modules/convex/bin/main.js import --deployment <approved-empty-recovery> <private-snapshot.zip>`; do not use `--yes`, `--append`, or destructive replace flags on an existing deployment.
4. Verify tables, storage IDs/bytes, capability decryptability, review versions, budget continuity and durable duplicate handling with synthetic/provider-sandbox probes. Compare real external Stripe/email/Vercel outcomes separately under authorization; a restored snapshot cannot undo or prove an external effect.
5. Keep workers paused until every in-flight/unknown effect has an explicit reconcile outcome; then obtain the exact production cutover authorization, read back deployment identities, and enable only verified scopes. Never blind-retry delivery, publication, payment or TTS after restore.

## Incident roles, recovery and communications

Engineering on-call owns containment/evidence and a bounded technical timeline; the owner owns deployment/data/provider authorizations and commercial decisions; an independent reviewer verifies candidate/cutover; qualified privacy/legal review determines reportability, recipients and deadlines. These are proposed operational roles, not an approved staffing roster or legal conclusion.

1. Record severity, detection time, affected surface, exact source/deployment, redacted reason counts and unknowns. Do not paste family content or credentials into the engineering board. For suspected compromise, preserve bounded existing evidence with restricted custody.
2. Ask the authorized operator to isolate the affected route, revoke the compromised privilege and stop dependent schedules. Unaffected offline tests/remediation continue. Do not grant a worker extra privilege or bypass an admission/review fence to restore availability.
3. Build a signed correction; run the synthetic security/restore suite and independent review. Reconcile all potentially executed external effects before any retry. Restore only through the isolated drill above and a separately authorized cutover.
4. Owner and qualified reviewer decide whether customer/provider/regulatory notifications are required. Draft only: what happened, verified affected scope, containment, user action (if any), and next update. Do not name speculative exposure or promise deadlines/retention rules; do not send messages without explicit authorization.
5. Independently verify the released source/deployment and synthetic journeys; retain a redacted incident record, reconcile paused work, and close only after recovery evidence. Any policy-dependent notification/retention question remains with existing commercial-policy review, not a new approval gate for this offline implementation.

## Release sequence and residual risks

Deploy the additive schema and `abuse:consume` backend before ingress code under separate release authorization; no backfill is needed. If ingress precedes the backend it intentionally returns 503. Rollback must preserve the new table and updated backend while rolling ingress to a previously independently approved source. Reverting ingress removes the new protection: keep public exposure restricted until restored. Do not drop budget/event/effect records to roll back.

The known residuals are global-budget availability/fixed-window bursts, pre-admission network/compute costs, legacy non-expiring capabilities and no key migration, unpatched development-only braces, unverified hosted backup/escrow/provider edge configuration, and unresolved owner policy/communications/retention decisions. They are not claims of launch readiness. Card `t_e03b13ea` consumes the exact signed candidate/archive and verification packet for independent commercial release assessment.
