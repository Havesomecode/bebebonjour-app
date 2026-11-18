# Bébé Bonjour architecture and release approval record

## 1. Record identity and status

| Field | Value |
|---|---|
| Decision-log ID | `BB-ARCH-RELEASE-2026-08-10-DECISION-v1.0` |
| Record status | `COMPLETE_WITH_UNRESOLVED_ITEMS` |
| Created at (UTC) | `2026-08-10T22:14:57Z` |
| Recorded by | Hermes Agent profile `default`, task `t_8d54264d` |
| Supersedes decision-log ID | `NONE` |
| Superseded by decision-log ID | `NONE` |
| Related decision task | `t_55fb9a56` |
| Final-record task | `t_8d54264d` |
| Parent decision program | `t_676a4802` |

`COMPLETE_WITH_UNRESOLVED_ITEMS` means the response evidence and every disposition
are completely recorded, but named implementation, staging, privacy, spending, and
release questions remain open. It does not mean that the unresolved matters were
approved or silently defaulted.

## 2. Exact decision packet reviewed

| Field | Value |
|---|---|
| Packet title | Bébé Bonjour architecture and release decision packet |
| Packet ID/version | `BB-ARCH-RELEASE-2026-08-06-v3.0` |
| Immutable packet reference | `openspec/reports/2026-08-06-architecture-release-decision-packet-v3.md` |
| Packet SHA-256 | `4e85c509f6a64eb0f95700114ec903c5e404a0e5a6c2764363630a13e45f1267` |
| Packet prepared at (UTC) | `2026-08-06T16:36:31Z` |
| Packet presented through | Bébé Bonjour Kanban dashboard written thread |
| Packet message/reference | Dashboard comment `257` on task `t_55fb9a56` |
| Packet presented at (UTC) | `2026-08-10T09:27:38Z` |
| Intended decision-maker | Bébé Bonjour accountable owner/operator |

The packet hash was freshly reverified from the repository while compiling this
record. The packet remains a decision request; this separate record captures the
response without rewriting the reviewed packet.

Supporting material identified by the packet:

- `openspec/reports/2026-08-06-fulfillment-architecture-and-editorial-policy.md`
  — current repository SHA-256
  `1e566407c4102f3fdf3ac623319f9a1fb206e7080d9d3c4b831497a659638a7f`.
- `openspec/reports/2026-08-06-provider-cost-operational-facts.md`
  — current repository SHA-256
  `2adb02605f1a0ab9d7fd656dedc3535d293c9bfb89ba11d4dd195e5ca12b8b08`.
- `openspec/reports/approval-evidence-and-decision-log-template.md`
  — current repository SHA-256
  `883d2ef3b679cca7718287b44b6640c196da7be10985be1a4b64370b1ea300f2`.
- Packet sections A-J, its consolidated unresolved-choice register, and the sources
  listed in that packet.

Only the packet SHA-256 is the approval binding. Supporting-file hashes above are
inventory evidence and must not be treated as enlarging the approved scope.

## 3. Decision-maker identity and response context

| Field | Value |
|---|---|
| Decision-maker name/display identity | `Muvaiah` |
| Accountable role | Bébé Bonjour accountable owner/operator |
| Organization/project relationship | Accountable owner/operator for Bébé Bonjour |
| Original written channel | Discord |
| Original message ID | `1536497299931533463` |
| Original response timestamp (UTC) | `2026-08-10T22:11:43.043Z` |
| Exact original response | `APPROVE PACKAGE` |
| Preservation/normalization channel | Bébé Bonjour Kanban dashboard task `t_55fb9a56` |
| Preservation timestamp (UTC) | `2026-08-10T22:12:42Z` |
| Identity verification basis | Authenticated Discord message as identified by the decision-maker's dashboard record, plus a user-authored dashboard record preserving the source, role, exact response, and A-J normalization |
| Original evidence digest | `NOT AVAILABLE` — the Discord message ID is preserved, but no raw-message export or digest was attached to the task |

The Discord display identity is recorded because it appears in the authenticated
written decision record. A numeric Discord author/account ID was not supplied and is
not inferred. An independent reviewer requiring source-channel authentication beyond
the preserved dashboard evidence must retrieve message
`1536497299931533463` from its access-controlled Discord context.

## 4. Evidence classification and register

Only `EXPLICIT_DECISION` evidence establishes a disposition. Revision comments and
acknowledgements are retained but do not become approval.

| Evidence ID | Timestamp (UTC) | Author/identity | Channel/reference | Packet/areas | Classification | Decisive use |
|---|---|---|---|---|---|---|
| `EV-001` | `2026-08-06T16:25:10Z` | Dashboard operator | Dashboard task `t_676a4802`, comment `c_9617f2fe` | Pre-v3, A/B | `REVISION_DETAIL` | Establishes the requested Convex and Tally-alternative revision; not approval |
| `EV-002` | `2026-08-10T09:27:38Z` | Hermes Agent `default` | Dashboard task `t_55fb9a56`, comment `257` | `BB-ARCH-RELEASE-2026-08-06-v3.0`, A-J | `DECISION_REQUEST` | Establishes the exact packet/hash, enumerated choices, TEST-A/TEST-B meaning, and mandatory boundary presented |
| `EV-003` | `2026-08-10T22:11:43.043Z` | Muvaiah, accountable owner/operator | Discord message `1536497299931533463` | v3 package, global A-J | `EXPLICIT_DECISION` | Exact original package approval |
| `EV-004` | `2026-08-10T22:12:42Z` | User/decision record | Dashboard task `t_55fb9a56` | `BB-ARCH-RELEASE-2026-08-06-v3.0`, A-J | `EXPLICIT_DECISION` | Explicit A-J dispositions, H revision, costs/accounts, deferred gates, TEST-A boundary, and mandatory exclusions |

### EV-001 — exact revision response

```text
Let's use convex instead of supabase. if a Tally alternative can already be possible lets consider it. I say that because of the Tally embedded payment already being a fallback
```

Effect: this was a `REVISION_DETAIL`, not an approval. It caused the earlier
Supabase/Tally proposal to be superseded. The resulting first-party-intake and Convex
choices were later presented in v3 and explicitly approved through `EV-003` and
`EV-004`.

### EV-002 — exact final written decision request

````text
## Explicit written decision required — packet `BB-ARCH-RELEASE-2026-08-06-v3.0`

Decision packet reviewed/presented for decision:
- Repository path: `openspec/reports/2026-08-06-architecture-release-decision-packet-v3.md`
- SHA-256 (freshly verified 2026-08-10T09:27:05Z): `4e85c509f6a64eb0f95700114ec903c5e404a0e5a6c2764363630a13e45f1267`
- Intended decision-maker: Bébé Bonjour accountable owner/operator

Please inspect that exact packet and reply in this dashboard thread by copying and completing every line below. Use exactly `APPROVE`, `REJECT`, or `REVISE`, followed by any constraints or requested changes. A response is not approval unless it identifies this packet, the decision-maker, and an explicit disposition for every area.

```text
Packet ID: BB-ARCH-RELEASE-2026-08-06-v3.0
Decision-maker name or accountable role:

A — Intake/forms: APPROVE | REJECT | REVISE —
B — Database/job-state/scheduler/artifacts: APPROVE | REJECT | REVISE —
C — Payment: APPROVE | REJECT | REVISE —
D — Deployment/stable URLs/publication: APPROVE | REJECT | REVISE —
E — Transactional email/delivery: APPROVE | REJECT | REVISE —
F — Religious and Arabic content policy: APPROVE | REJECT | REVISE —
G — Lifecycle/non-bypassable release invariant: APPROVE | REJECT | REVISE —
H — Cost/accounts/privacy/retention: APPROVE | REJECT | REVISE —
I — Landing vulnerability remediation/release gate: APPROVE | REJECT | REVISE —
J — Test-mode implementation boundary: APPROVE TEST-A | APPROVE TEST-B | REJECT | REVISE —

Approved cost ceiling, spend cap, and account/resource constraints:
Unresolved question IDs and the exact gate for resolving each:
Exact additional authorizations, if any:

I explicitly accept this boundary: Approval does not authorize service purchases, production publication, live customer-data processing, live payments, or production release unless each action is separately and explicitly authorized.
```

For `J`, `TEST-A` means local source/schema changes, local deterministic commands, tests/static analysis, and synthetic fixtures only. `TEST-B` additionally permits named existing non-production provider resources with synthetic data; if selecting it, name every account/project, permitted mutation, recipient allowlist, and spend cap (default `€0`). Neither option permits purchases, plan upgrades, live/customer data, live payments/refunds, production/DNS/publication/customer-email/release actions, or secret disclosure without separate exact authorization.

If you choose `REJECT` or `REVISE`, state the approved alternative or exact requested changes and constraints. If any line is omitted, conditional, internally inconsistent, or only acknowledges receipt, it will remain unresolved and receive a targeted written follow-up. Silence and implied consent do not count as approval.
````

### EV-003 — exact original written response

```text
APPROVE PACKAGE
```

Original evidence location: Discord message `1536497299931533463`.

### EV-004 — exact preservation, normalization, and boundary record

```text
## Explicit written decision record — BB-ARCH-RELEASE-2026-08-06-v3.0

Packet SHA-256 (reverified immediately before recording): 4e85c509f6a64eb0f95700114ec903c5e404a0e5a6c2764363630a13e45f1267
Decision-maker identity/role: Bébé Bonjour accountable owner/operator
Decision source: Discord message 1536497299931533463 by Muvaiah at 2026-08-10T22:11:43.043Z, replying directly to the fully enumerated A-J recommendation in this thread.
Exact written response: `APPROVE PACKAGE`

Normalized dispositions explicitly incorporated by that package response:
- A — APPROVE: first-party accessible intake; Tally only as a temporary rollback.
- B — APPROVE: Convex for durable jobs, scheduling, immutable revisions/events, and initial artifacts.
- C — APPROVE: per-job Stripe Checkout with explicit project/product/environment/job correlation.
- D — APPROVE: Vercel plus one stable announcement router; no per-customer deployment.
- E — APPROVE: Resend as the target transactional-email provider.
- F — APPROVE: bebebonjour-editorial-v1, human-only launch approval, exact content/audio revision gates.
- G — APPROVE: canonical lifecycle with non-bypassable approval, separate publication, and delivery boundaries.
- H — REVISE: test-stage spend ceiling €0; no paid-plan commitment. The 30-day private/PII cleanup and 365-day approved-public-bundle availability remain provisional hypotheses requiring privacy, legal, and product validation before live use and are not yet customer promises.
- I — APPROVE: narrow Vite 6 remediation, not the broader Vite 8 migration.
- J — APPROVE TEST-A only: local source/schema changes, deterministic local commands, tests, static analysis, and synthetic fixtures. TEST-B is not authorized.

Cost/accounts/resources: €0 spend ceiling; existing local resources only; no account creation, provider control-plane mutation, purchase, paid upgrade, or spend commitment.
Additional authorizations: none.

Deferred gates:
- A1-A3 before intake staging or publication.
- B1-B5 before hosted Convex/provider use.
- C1-C3 before Stripe test integration or any live payment.
- D1-D4 before private staging, domain/DNS, or production deployment.
- E1-E3 before any provider email.
- F1-F4 before religious/Arabic content can ship.
- G1-G3 before release-state implementation is accepted for staging.
- H1-H4 before spend or live personal-data processing.
- I2 before release.
- J2-J3 unresolved; TEST-B remains unauthorized.

Mandatory boundary explicitly accepted: Approval does not authorize service purchases, production publication, live customer-data processing, live payments, customer email, DNS changes, or production release. Each requires separate exact written authorization.
```

## 5. Disposition summary

### Six mandatory decision areas

| Area | Subject | Explicit disposition | Decisive evidence | Resolution state |
|---|---|---|---|---|
| A | Intake/forms | `APPROVE` | `EV-003`, `EV-004` | Approved architecture; A1-A3 deferred to stated gates |
| B | Database/job-state/scheduler/artifacts | `APPROVE` | `EV-003`, `EV-004` | Approved architecture; B1-B5 deferred to hosted-use gate |
| C | Payment | `APPROVE` | `EV-003`, `EV-004` | Approved architecture; C1-C3 deferred; no provider test or live payment authorized |
| D | Deployment/stable URLs/publication | `APPROVE` | `EV-003`, `EV-004` | Approved architecture; D1-D4 deferred; no deployment/publication authorized |
| E | Transactional email/delivery | `APPROVE` | `EV-003`, `EV-004` | Approved architecture; E1-E3 deferred; no provider email authorized |
| F | Religious and Arabic content policy | `APPROVE` | `EV-003`, `EV-004` | Policy approved; F1-F4 must resolve before this content ships |

### Supplemental packet areas

| Area | Subject | Explicit disposition | Decisive evidence | Resolution state |
|---|---|---|---|---|
| G | Lifecycle/non-bypassable release invariant | `APPROVE` | `EV-003`, `EV-004` | Architecture approved; G1-G3 deferred before staging acceptance |
| H | Cost/accounts/privacy/retention | `REVISE` | `EV-003`, `EV-004` | €0/local-only current boundary applied; live budget/privacy/retention remain unresolved |
| I | Landing vulnerability remediation/release gate | `APPROVE` | `EV-003`, `EV-004` | Narrow Vite 6 path selected; I2 remains a release gate |
| J | Test-mode implementation boundary | `APPROVE TEST-A` | `EV-003`, `EV-004` | TEST-A authorized; TEST-B and J2-J3 unresolved and unauthorized |

There are no missing dispositions. `H` is recorded as `REVISE`, not converted to
approval. Deferred questions are not approvals and do not expand `TEST-A`.

## 6. Per-area choices, alternatives, and conditions

### A — Intake/forms — `APPROVE`

- Approved: first-party accessible intake in the web application; create canonical
  `job_id`, opaque intake token, and private server-side intake before payment.
- Approved constraint: Tally may exist only as a temporary, bounded rollback path.
- Rejected for the target: Tally as the target architecture; Tally payment block;
  fixed Stripe Payment Link plus email matching.
- Cost evidence: no separate form subscription is expected; engineering,
  accessibility, abuse-prevention, and monitoring remain unpriced costs.
- Account boundary: no Vercel, Convex, Stripe, or Tally hosted change is authorized by
  this approval.
- Exact decisive words: `A — APPROVE: first-party accessible intake; Tally only as a temporary rollback.`
- Open: A1-A3.

### B — Database/job-state/scheduler/artifacts — `APPROVE`

- Approved: Convex as durable source of truth for jobs, payment correlation, immutable
  revisions/events, artifact metadata, decisions, attempts, publication, and delivery;
  scheduled functions for recovery/orchestration; initial file storage only where the
  packet's private/public and bundle-verification constraints can be enforced.
- Rejected/superseded: Supabase as the selected target; local `job.json` or filesystem
  state as production authority.
- Conditionally acceptable but not selected: a separate object store if Convex file
  serving cannot satisfy the verified launch requirements.
- Cost evidence, not spend authorization: packet price snapshot lists Convex
  Free/Starter at `$0/month` and Professional at `$25 per developer/month`, with
  published allowances and metered overage.
- Account boundary: existing local resources only; hosted Convex/provider use is not
  authorized.
- Exact decisive words: `B — APPROVE: Convex for durable jobs, scheduling, immutable revisions/events, and initial artifacts.`
- Open: B1-B5.

### C — Payment — `APPROVE`

- Approved architecture: server-created, per-job Stripe Checkout Session with
  `project=bebebonjour`, approved `product`, `environment`, `job_id`, and
  `intake_digest` on the Session and Payment Intent; signed webhook as payment
  authority.
- Rejected: fixed Payment Link plus email matching.
- Fallback only, not authorized now: Tally-embedded payment with separately approved
  real-payment/refund evidence if required.
- Cost evidence, not spend authorization: the packet's France snapshot lists standard
  EEA cards at `1.5% + €0.25` per successful charge; other fees vary.
- Account constraint: the eventual shared Stripe account must use explicit
  project/product/environment/job correlation, separate test/live keys and Price IDs,
  endpoint-specific webhook secrets, and allowlists. TEST-A authorizes no Stripe
  provider event or control-plane mutation.
- Exact decisive words: `C — APPROVE: per-job Stripe Checkout with explicit project/product/environment/job correlation.`
- Open: C1-C3.

### D — Deployment/stable URLs/publication — `APPROVE`

- Approved architecture: Vercel for the operator/public-router applications; one stable
  announcement router and route contract; publication by verified immutable bundle and
  approved pointer, not by per-customer deployment.
- Rejected: one Vercel project/deployment per customer; rebuild of one aggregate static
  site for every publication.
- Cost evidence, not spend authorization: Vercel Pro was displayed at `$20/month` plus
  usage/overage in the packet snapshot.
- Account/domain boundary: no hosted project, private staging, domain, DNS, deployment,
  publication, or production action is authorized.
- Exact decisive words: `D — APPROVE: Vercel plus one stable announcement router; no per-customer deployment.`
- Open: D1-D4.

### E — Transactional email/delivery — `APPROVE`

- Approved architecture: Resend as target transactional-email provider, with a verified
  sending subdomain, stable sender, idempotent delivery attempts, exact job/revision/
  publication binding, and signed delivery webhooks.
- Rejected: manual email as the durable launch path.
- Not selected: direct SMTP or another provider; either requires a later revised
  decision if adopted.
- Cost evidence, not spend authorization: packet snapshot lists Resend Free at
  `$0/month` for 3,000 emails/month with a 100/day cap and Pro at `$20/month` plus
  published overage.
- Account/recipient boundary: no Resend account/domain/key/webhook mutation and no
  provider or customer email is authorized.
- Exact decisive words: `E — APPROVE: Resend as the target transactional-email provider.`
- Open: E1-E3.

### F — Religious and Arabic content policy — `APPROVE`

- Approved: `bebebonjour-editorial-v1`; human-only launch approval; one exact content
  approval per revision and separate exact decoded-audio approval for every requested
  language; neutral claim-free fallback for unsupported/original names; required
  sourcing and Arabic review rules.
- Rejected by the approved policy: hadith quotations in V1 by default; agent approval at
  launch; silent transliteration/canonicalization; unsupported meaning or scriptural
  claims.
- Cost evidence: no policy subscription; qualified human Arabic/religious/content and
  narration review remains an unpriced per-order cost. Narration has usage-priced TTS
  and review time, neither authorized here.
- Account/reviewer boundary: reviewers and competencies are not yet selected; OpenAI
  use is not authorized by TEST-A.
- Exact decisive words: `F — APPROVE: bebebonjour-editorial-v1, human-only launch approval, exact content/audio revision gates.`
- Open: F1-F4.

### G — Lifecycle/non-bypassable release invariant — `APPROVE`

- Approved: canonical durable lifecycle with immutable evidence and non-bypassable
  exact-revision approvals; approval only makes a revision eligible for a separate
  publish/send command.
- Rejected by the invariant: UI flags, local mutable state, manual row changes, or an
  approval alone causing publication, delivery, or completion.
- Exact decisive words: `G — APPROVE: canonical lifecycle with non-bypassable approval, separate publication, and delivery boundaries.`
- Open: G1-G3.

### H — Cost/accounts/privacy/retention — `REVISE`

- Current approved constraint: total test-stage spend ceiling `€0`; existing local
  resources only; no paid-plan commitment.
- Requested revision applied to the current boundary: the packet's approximately
  `$45/month` dependable production baseline is informational only and is not approved
  spend.
- Unresolved: 30-day private/PII cleanup and 365-day approved-public-bundle availability
  are provisional hypotheses, not customer promises. Privacy, legal, and product
  validation are required before live use.
- Rejected/not authorized now: provider/account creation, provider control-plane
  mutation, purchase, paid upgrade, usage spend, or any other spend commitment.
- Exact decisive words: `H — REVISE: test-stage spend ceiling €0; no paid-plan commitment. The 30-day private/PII cleanup and 365-day approved-public-bundle availability remain provisional hypotheses requiring privacy, legal, and product validation before live use and are not yet customer promises.`
- Open: H1-H4.

### I — Landing vulnerability remediation/release gate — `APPROVE`

- Approved: narrow Vite 6 remediation described by the packet: Vite `6.4.3`, PostCSS
  `8.5.26`, resolved esbuild `0.25.12`, regenerated lockfile, clean install, full and
  production audit, exact resolution, production build, and local HTTP/CTA smoke.
- Rejected for this decision: broader Vite 8/Rolldown/Oxc migration.
- Cost/account boundary: engineering time only; no service purchase or release is
  authorized.
- Exact decisive words: `I — APPROVE: narrow Vite 6 remediation, not the broader Vite 8 migration.`
- Resolved: I1. Open: I2 before release.

### J — Test-mode implementation authorization — `APPROVE TEST-A`

- Authorized: the exact TEST-A boundary in section 9 below.
- Rejected/not authorized: TEST-B; all existing remote non-production provider use;
  all provider control-plane mutation.
- Additional authorizations: none.
- Exact decisive words: `J — APPROVE TEST-A only: local source/schema changes, deterministic local commands, tests, static analysis, and synthetic fixtures. TEST-B is not authorized.`
- Resolved: J1 as TEST-A. Open: J2-J3; their existence does not authorize TEST-B.

## 7. Revisions, limits, and account/resource constraints

### Requested revisions

| Revision ID | Area(s) | Exact requested change | Evidence | Status |
|---|---|---|---|---|
| `R-001` | B | Use Convex instead of Supabase | `EV-001` | `RESOLVED` by packet v3 and B approval |
| `R-002` | A | Consider an already-possible Tally alternative because Tally embedded payment was only a fallback | `EV-001` | `RESOLVED` by packet v3 first-party intake and A approval |
| `R-003` | H | Set test-stage spend to €0/no paid commitment; keep 30/365-day retention as provisional hypotheses pending privacy/legal/product validation | `EV-004` | `APPLIED TO TEST-A`; live-use resolution remains open |

### Cost limits

| Cost ID | Areas | Currency | Total approved cap | Recurring/usage authorization | Evidence | Status |
|---|---|---|---|---|---|---|
| `COST-001` | Global A-J | EUR | `€0` | None; no paid plan, purchase, upgrade, usage spend, tax, overage, or commitment | `EV-004` | `CLEAR FOR TEST-A` |

Published packet prices are planning facts, not exceptions to `COST-001`.

### Account and resource constraints

| Constraint ID | Areas | Exact allowed boundary | Explicit exclusions | Evidence | Status |
|---|---|---|---|---|---|
| `ACCT-001` | Global | Existing local resources only | Hosted/provider resources and remote writes | `EV-004` | `CLEAR` |
| `ACCT-002` | Global | No remote account/project/resource creation | Any account, project, endpoint, deployment, or other remote resource creation | `EV-004` | `CLEAR` |
| `ACCT-003` | B-E/J | No provider control-plane mutation | Stripe, Convex, Vercel, Resend, OpenAI, DNS, credentials, secrets, or webhooks | `EV-002`, `EV-004` | `CLEAR` |
| `ACCT-004` | C/J | No TEST-B or live payment-provider use | Test events, live charges, refundable smoke charges, refunds, disputes, or live-mode webhooks | `EV-002`, `EV-004` | `CLEAR` |
| `ACCT-005` | D/E/J | No staging, production, publication, or external delivery | Private hosted staging, public aliases, DNS, customer email, production migration, release | `EV-002`, `EV-004` | `CLEAR` |

No secret value is recorded.

## 8. Unresolved conditions and required next actions

Every item below remains open. The required next action is an exact written resolution
or revised packet at the named gate. Implementation activity, silence, a default in
code, or an acknowledgement cannot resolve any item.

| IDs | Exact unresolved questions | Required resolution gate and next action |
|---|---|---|
| A1-A3 | A1 acceptable anti-bot/rate-limit mechanism and whether it may add a processor; A2 exact launch fields and consent wording; A3 duration, if any, of Tally rollback | Before intake staging or publication: record explicit choices, processor/privacy impact, field/consent contract, and rollback end condition |
| B1-B5 | B1 Free/Starter or Professional; B2 EU region/DPA/backup/export/recovery/deletion evidence; B3 Convex-only files or separate object store; B4 operator identity and authorization model; B5 proof that scheduling/runtime meets lease/concurrency/retry invariants | Before hosted Convex/provider use: select named deployment/account boundaries and verify the operational/security requirements in writing |
| C1-C3 | C1 product/Price ID, launch price, currency, VAT, refund/dispute policy; C2 restricted-key permissions and shared-account allowlists; C3 whether a separately authorized live smoke payment/refund is acceptable | Before Stripe test integration or any live payment: obtain an exact provider/environment scope; live smoke remains separately gated and defaults to no |
| D1-D4 | D1 subdomains/stable path; D2 TTS/ffprobe runtime; D3 bundle size, cache/takedown SLA, monitoring, rollback objective; D4 production-domain control | Before private staging, domain/DNS, or production deployment: resolve each contract and authorize each consequential action separately |
| E1-E3 | E1 sending subdomain, sender/reply/support identity and recipient allowlist; E2 provider acceptance versus confirmed delivery as completion; E3 email/provider retention and bounce/complaint procedure | Before any provider email: record exact domain/account/recipient test boundary and operating policy; customer email remains separately prohibited |
| F1-F4 | F1 qualified content/narration reviewers and competencies; F2 exact Quran editions/translations/licenses/source digests; F3 Arabic grammar/pronunciation/RTL/abstention rubric; F4 duration/evidence threshold for human-only authority and any future agent reviewer | Before religious/Arabic content can ship: approve named reviewers, immutable source catalog and rubric; future agent authority requires a separate policy/evaluation decision |
| G1-G3 | G1 max attempts/backoff/terminal success per stage; G2 unblock/refund/takedown/restoration/retry authorities; G3 whether narration failure permits a reviewed no-audio revision | Before release-state implementation is accepted for staging: record the durable state-machine policy and authority matrix, then verify it |
| H1-H4 | H1 whether the approximately `$45/month` baseline is acceptable; H2 final 30/365-day periods and availability promise; H3 existing accounts/owners/spend caps/purchase authority; H4 legal basis, notice, processor/DPA, consent, deletion and accounting-retention advice | Before any spend or live personal-data processing: complete privacy/legal/product validation and obtain separate exact spending and live-processing authorization |
| I2 | Required Node LTS pin and browser/visual regression scope | Before release: record the exact runtime and regression matrix; release remains separately unauthorized |
| J2-J3 | J2 exact TEST-B accounts/projects/mutations/recipient allowlist/spend cap; J3 whether synthetic test events may reach private staging endpoints | No TEST-B action may occur. To enable it, provide all named resources/operations/recipients, retain a €0 default unless revised, and issue a new explicit written authorization |

## 9. Exact TEST-A implementation authorization

### Verbatim authorization

```text
J — APPROVE TEST-A only: local source/schema changes, deterministic local commands, tests, static analysis, and synthetic fixtures. TEST-B is not authorized.
```

Packet definition incorporated by that response:

```text
Permit source/schema/migration changes, local deterministic generation/review commands, unit tests, static analysis, and synthetic fixtures. No provider control-plane mutation, hosted deployment, email, payment event, or remote data write.
```

### Effective action matrix

| Capability/action | Authorization | Exact effective scope |
|---|---|---|
| Local source-code changes | `AUTHORIZED` | Bébé Bonjour local working copies, only to implement approved architecture/policy choices; no remote effect is inferred |
| Local schema/migration-file changes | `AUTHORIZED` | Source files and local/disposable execution only; no hosted or production migration |
| Local deterministic generation/review commands | `AUTHORIZED` | Existing local resources and synthetic inputs only; no paid or remote provider call |
| Unit tests, static analysis, and synthetic fixtures | `AUTHORIZED` | Local execution with synthetic/non-customer data only |
| Local or disposable provider test-mode calls | `NOT AUTHORIZED` | TEST-A permits no provider control-plane mutation, payment event, email, or remote write |
| Existing remote non-production resources | `NOT AUTHORIZED` | TEST-B was not authorized; no resource is named or allowlisted |
| Remote account/project/resource creation | `NOT AUTHORIZED` | No provider/account/project/endpoint creation |
| Credential, secret, DNS, or webhook changes | `NOT AUTHORIZED` | No disclosure, creation, rotation, configuration, or remote mutation |
| External email or messages | `NOT AUTHORIZED` | No provider test email and no customer email; no recipient allowlist was approved |
| Commit | `NOT AUTHORIZED BY THIS RECORD` | Source changes are authorized, but no repository, branch, or commit authorization was explicitly granted |
| Push or pull request | `NOT AUTHORIZED` | Remote repository changes were not included in TEST-A |
| Hosted private preview or staging deployment | `NOT AUTHORIZED` | No Vercel/Convex/provider staging action |
| Production deployment/release | `NOT AUTHORIZED` | Requires separate exact written authorization |
| Production publication or public form/page launch | `NOT AUTHORIZED` | Requires separate exact written authorization |
| Live customer-data processing | `NOT AUTHORIZED` | Synthetic data only |
| Live payment/refund/dispute action | `NOT AUTHORIZED` | Requires separate exact written authorization |
| Service purchase, subscription, paid upgrade, or spend | `NOT AUTHORIZED` | Global cap `€0` |

No repository/branch list, expiry timestamp, or permission to commit was stated. This
record therefore does not infer those permissions. Review is triggered by any packet
revision, request to use a hosted/provider resource, request to spend, or request to
process live/customer data.

## 10. Mandatory non-authorization boundary

Required canonical boundary presented in `EV-002` and explicitly accepted through the
package response:

> Approval does not authorize service purchases, production publication, live
> customer-data processing, live payments, or production release unless each action is
> separately and explicitly authorized.

The exact broader acceptance preserved in `EV-004` is:

> Mandatory boundary explicitly accepted: Approval does not authorize service
> purchases, production publication, live customer-data processing, live payments,
> customer email, DNS changes, or production release. Each requires separate exact
> written authorization.

| Field | Value |
|---|---|
| Statement explicitly accepted? | `YES` |
| Evidence | `EV-003`, `EV-004` |
| Separately authorized exceptions | `NONE` |

For avoidance of doubt, this approval does **not** authorize any service purchase,
subscription, plan upgrade, spend commitment, production publication, public customer
announcement, live customer-data access/migration/storage/processing, live payment,
refundable smoke charge, refund, dispute action, live-mode webhook, customer email,
DNS change, production database migration, production deployment, production release,
or secret disclosure. Each action requires separate, exact, written authorization.

## 11. Follow-up chronology

| Time (UTC) | Exchange | Classification/effect |
|---|---|---|
| `2026-08-06T16:25:10Z` | Operator wrote the exact EV-001 Convex/Tally revision | `REVISION_DETAIL`; earlier proposal not approved |
| `2026-08-06T16:31:52Z` | Revised packet v2 posted in task `t_676a4802` | Superseded intermediate request; no approval inferred |
| `2026-08-06T16:33:28Z` | Final checklist v2.1 posted in task `t_676a4802` | Superseded intermediate request; no approval inferred |
| `2026-08-06T16:36:31Z` | Self-contained packet `BB-ARCH-RELEASE-2026-08-06-v3.0` prepared | Final reviewed decision object; no approval by itself |
| `2026-08-10T09:27:38Z` | Exact EV-002 decision request posted with packet hash | Awaited explicit response; silence did not count |
| `2026-08-10T22:11:43.043Z` | Muvaiah replied `APPROVE PACKAGE` in Discord message `1536497299931533463` | `EXPLICIT_DECISION`, tied directly to the fully enumerated A-J package |
| `2026-08-10T22:12:42Z` | User-authored EV-004 record preserved exact source, A-J normalization, H revision, TEST-A, and exclusions | `EXPLICIT_DECISION`; removed per-area ambiguity without broadening the source response |

The earlier v2/v2.1 messages are historical follow-up context, not the approved packet.
Only the hash-bound v3 packet and the final evidence establish this record.

## 12. Final audit determination

| Check | Result | Evidence/notes |
|---|---|---|
| Decision-maker identity/accountable role recorded | `PASS` | Section 3; `EV-003`, `EV-004` |
| Primary timestamp and auditable channel recorded | `PASS` | Discord message ID/timestamp and dashboard preservation timestamp |
| Exact packet version, path, and SHA-256 recorded | `PASS` | Section 2; hash freshly reverified |
| Exact original response preserved | `PASS` | `EV-003`: `APPROVE PACKAGE` |
| Decisive normalization and boundary preserved verbatim | `PASS` | Full `EV-004` quote |
| All six mandatory areas have explicit dispositions | `PASS` | A-F are each `APPROVE` |
| Supplemental G-J dispositions are explicit | `PASS` | G `APPROVE`; H `REVISE`; I `APPROVE`; J `APPROVE TEST-A` |
| Approved choices and rejected/not-selected alternatives recorded | `PASS` | Section 6 |
| Requested revisions recorded without conversion to approval | `PASS` | H remains `REVISE`; R-001-R-003 |
| Costs and account/resource constraints recorded | `PASS` | `COST-001`, `ACCT-001`-`ACCT-005` |
| Every incomplete matter is visibly unresolved with a next action | `PASS` | Section 8 |
| TEST-A boundary is precise and no broader than evidence | `PASS` | Section 9 |
| Mandatory non-authorization statement explicitly accepted | `PASS` | Section 10; `EV-003`, `EV-004` |
| Silence, acknowledgement, or implied consent counted as approval | `PASS` | None; EV-001 is revision detail, packet/request messages are not approval |
| Original Discord author account ID/raw-message digest captured | `LIMITATION` | Message ID/display identity/timestamp are preserved; raw export and numeric author ID were not attached |

Final gate status: `APPROVED_WITHIN_RECORDED_TEST_A_BOUNDARY`.

Unresolved decision-area IDs: `H` remains `REVISE` for live budget/privacy/retention.
The six mandatory architecture areas A-F have explicit `APPROVE` dispositions.

Open IDs: `A1-A3`, `B1-B5`, `C1-C3`, `D1-D4`, `E1-E3`, `F1-F4`,
`G1-G3`, `H1-H4`, `I2`, `J2-J3`, and `R-003` for live use.

Authorized next action: local TEST-A implementation and verification only, within
section 9 and with synthetic data.

Prohibited next actions: every TEST-B, hosted/provider, spending, customer/live-data,
payment, email, DNS, publication, commit/push, production migration, deployment, and
release action listed in sections 9-10 unless separately and explicitly authorized in
writing.

Audit compiled and reviewed by: Hermes Agent profile `default`.

Audit timestamp (UTC): `2026-08-10T22:14:57Z`.

Audit conclusion:

```text
The hash-bound packet, original Discord message reference and exact response, and
user-authored dashboard preservation allow an independent reviewer to reconstruct
what was presented and how every A-J disposition was recorded. A-F are explicitly
approved; G and I are approved; H is explicitly revised; J authorizes TEST-A only.
No silence, acknowledgement, implementation activity, planning cost, or unresolved
question was treated as approval. The only authorized implementation boundary is
local, synthetic, deterministic TEST-A work at €0. All consequential hosted, paid,
live-data, payment, email, DNS, publication, commit/push, and production actions remain
separately gated.
```
