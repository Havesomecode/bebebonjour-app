# Approval evidence and decision log

> Template status: blank — no approval is recorded by this file.
>
> Copy this template for one versioned decision packet. Do not overwrite a completed
> record. Corrections and later decisions must be appended as follow-up evidence or
> recorded in a new log that identifies the record it supersedes.

## 1. Record identity

| Field | Value |
|---|---|
| Decision-log ID | `[unique immutable ID]` |
| Record status | `[DRAFT / WAITING_FOR_RESPONSE / FOLLOW_UP_REQUIRED / COMPLETE_WITH_UNRESOLVED_ITEMS / COMPLETE]` |
| Created at (UTC, ISO 8601) | `[YYYY-MM-DDTHH:MM:SSZ]` |
| Recorded by | `[name and accountable role]` |
| Supersedes decision-log ID | `[ID / NONE]` |
| Superseded by decision-log ID | `[ID / NONE]` |
| Related task/change/request | `[auditable reference]` |

`COMPLETE` is permitted only when all six decision areas have an explicit written
`APPROVE` or `REJECT` disposition, or an explicit `REVISE` disposition whose requested
revision has subsequently been resolved by a new packet and decision. Otherwise use
`FOLLOW_UP_REQUIRED` or `COMPLETE_WITH_UNRESOLVED_ITEMS` and identify every unresolved
item below.

## 2. Decision packet reviewed

| Field | Value |
|---|---|
| Packet title | `[exact title]` |
| Packet version | `[exact version]` |
| Immutable packet reference | `[repository path, artifact ID, or immutable URL]` |
| Packet SHA-256 or content digest | `[digest / NOT AVAILABLE — explain]` |
| Packet issued at (UTC, ISO 8601) | `[YYYY-MM-DDTHH:MM:SSZ]` |
| Packet sent through | `[auditable written channel]` |
| Packet message/reference ID | `[message, comment, ticket, or email ID]` |
| Packet sent at (UTC, ISO 8601) | `[YYYY-MM-DDTHH:MM:SSZ]` |
| Intended decision-maker | `[name and identity or accountable role]` |
| Attached/referenced supporting evidence | `[references and versions]` |

If the response does not identify the packet version, record the follow-up that made
the version explicit. Do not infer that a response to an earlier packet applies to a
later packet.

## 3. Decision-maker identity and response context

| Field | Value |
|---|---|
| Decision-maker name | `[full name]` |
| Immutable identity/account identifier | `[account ID, verified address, or directory ID; do not record secrets]` |
| Accountable role | `[role and decision authority]` |
| Organization/project relationship | `[relationship]` |
| Identity verification basis | `[authenticated account, signed email, ticket identity, or other evidence]` |
| Primary response timestamp (UTC, ISO 8601) | `[YYYY-MM-DDTHH:MM:SSZ]` |
| Primary response channel | `[channel]` |
| Primary response message/reference ID | `[ID]` |
| Recorder timestamp (UTC, ISO 8601) | `[YYYY-MM-DDTHH:MM:SSZ]` |

### Exact primary written response

Copy the response verbatim. Do not summarize, correct spelling, or silently remove
conditions. If redaction is legally or operationally required, mark the exact location
and retain an auditable reference to the protected original.

```text
[exact written response]
```

Original evidence location: `[immutable or access-controlled reference]`

Original evidence digest/attachment ID: `[digest or ID / NOT AVAILABLE — explain]`

## 4. Evidence classification rules

Every evidence item must be assigned exactly one classification:

- `EXPLICIT_DECISION`: a written `APPROVE`, `REJECT`, or `REVISE` tied to this exact
  packet version and decision area.
- `REVISION_DETAIL`: a written clarification of an already explicit `REVISE` response;
  it does not approve the revised proposal.
- `ACKNOWLEDGEMENT_ONLY`: receipt, thanks, “seen”, “looks good”, or similar language
  without an explicit disposition.
- `AMBIGUOUS_OR_CONDITIONAL`: language whose disposition, scope, condition, or packet
  reference cannot be determined exactly.
- `NO_RESPONSE`: no written response by the recorded follow-up time.

Only `EXPLICIT_DECISION` can establish a disposition. `REVISION_DETAIL` can define a
requested revision but cannot approve a new packet. `ACKNOWLEDGEMENT_ONLY`,
`AMBIGUOUS_OR_CONDITIONAL`, `NO_RESPONSE`, silence, and implied consent are **not
approval**. Record them as evidence and keep the affected area unresolved.

## 5. Evidence register

Assign stable evidence IDs (`EV-001`, `EV-002`, ...). Preserve exact text and metadata
for every response and follow-up used to interpret a disposition.

| Evidence ID | Timestamp (UTC) | Author name + identity/role | Channel + message/reference ID | Packet version | Area(s) | Classification | Exact-text location or quoted-text section | Original evidence reference/digest |
|---|---|---|---|---|---|---|---|---|
| `EV-001` | `[timestamp]` | `[identity]` | `[channel + ID]` | `[version]` | `[A-F / GLOBAL]` | `[classification]` | `[section/ref]` | `[reference/digest]` |
| `EV-___` | | | | | | | | |

## 6. Disposition summary — all six areas mandatory

Allowed recorded dispositions are exactly `APPROVE`, `REJECT`, `REVISE`, or
`UNRESOLVED`. `UNRESOLVED` is a status, not a decision. It must be used when explicit
written evidence is missing, ambiguous, merely acknowledges receipt, refers to the
wrong packet version, or leaves a condition unanswered.

| Area | Required subject | Disposition | Decisive evidence ID(s) | Conditions/revision IDs | Resolution state |
|---|---|---|---|---|---|
| A | Intake/forms | `[APPROVE / REJECT / REVISE / UNRESOLVED]` | `[EV-___]` | `[C-___ / R-___ / NONE]` | `[RESOLVED / FOLLOW_UP_REQUIRED]` |
| B | Database and job-state storage | `[APPROVE / REJECT / REVISE / UNRESOLVED]` | `[EV-___]` | `[C-___ / R-___ / NONE]` | `[RESOLVED / FOLLOW_UP_REQUIRED]` |
| C | Payment | `[APPROVE / REJECT / REVISE / UNRESOLVED]` | `[EV-___]` | `[C-___ / R-___ / NONE]` | `[RESOLVED / FOLLOW_UP_REQUIRED]` |
| D | Deployment/publication | `[APPROVE / REJECT / REVISE / UNRESOLVED]` | `[EV-___]` | `[C-___ / R-___ / NONE]` | `[RESOLVED / FOLLOW_UP_REQUIRED]` |
| E | Email/delivery | `[APPROVE / REJECT / REVISE / UNRESOLVED]` | `[EV-___]` | `[C-___ / R-___ / NONE]` | `[RESOLVED / FOLLOW_UP_REQUIRED]` |
| F | Religious and Arabic content policy | `[APPROVE / REJECT / REVISE / UNRESOLVED]` | `[EV-___]` | `[C-___ / R-___ / NONE]` | `[RESOLVED / FOLLOW_UP_REQUIRED]` |

## 7. Per-area decision records

Complete one block for every area, including areas that remain unresolved. Exact quoted
text must be sufficient to trace the disposition without relying on the recorder's
interpretation.

### A — Intake/forms

| Field | Value |
|---|---|
| Packet proposal reviewed | `[exact choice and packet section]` |
| Explicit disposition | `[APPROVE / REJECT / REVISE / UNRESOLVED]` |
| Approved choice(s) | `[exact choices / NONE]` |
| Rejected alternative(s) | `[exact alternatives / NONE STATED]` |
| Requested revision(s) | `[R-___ / NONE]` |
| Cost limit(s) | `[COST-___ / NONE STATED]` |
| Account/resource constraint(s) | `[ACCT-___ / NONE STATED]` |
| Other condition(s) | `[C-___ / NONE]` |
| Decisive evidence ID(s) | `[EV-___ / NONE]` |
| Exact supporting words | `“[verbatim excerpt / NO EXPLICIT DECISION]”` |
| Unresolved question(s) | `[U-___ / NONE]` |
| Resolution state | `[RESOLVED / FOLLOW_UP_REQUIRED]` |

### B — Database and job-state storage

| Field | Value |
|---|---|
| Packet proposal reviewed | `[exact choice and packet section]` |
| Explicit disposition | `[APPROVE / REJECT / REVISE / UNRESOLVED]` |
| Approved choice(s) | `[exact choices / NONE]` |
| Rejected alternative(s) | `[exact alternatives / NONE STATED]` |
| Requested revision(s) | `[R-___ / NONE]` |
| Cost limit(s) | `[COST-___ / NONE STATED]` |
| Account/resource constraint(s) | `[ACCT-___ / NONE STATED]` |
| Other condition(s) | `[C-___ / NONE]` |
| Decisive evidence ID(s) | `[EV-___ / NONE]` |
| Exact supporting words | `“[verbatim excerpt / NO EXPLICIT DECISION]”` |
| Unresolved question(s) | `[U-___ / NONE]` |
| Resolution state | `[RESOLVED / FOLLOW_UP_REQUIRED]` |

### C — Payment

| Field | Value |
|---|---|
| Packet proposal reviewed | `[exact choice and packet section]` |
| Explicit disposition | `[APPROVE / REJECT / REVISE / UNRESOLVED]` |
| Approved choice(s) | `[exact choices / NONE]` |
| Rejected alternative(s) | `[exact alternatives / NONE STATED]` |
| Requested revision(s) | `[R-___ / NONE]` |
| Cost/transaction limit(s) | `[COST-___ / NONE STATED]` |
| Account, environment, or correlation constraint(s) | `[ACCT-___ / NONE STATED]` |
| Other condition(s) | `[C-___ / NONE]` |
| Decisive evidence ID(s) | `[EV-___ / NONE]` |
| Exact supporting words | `“[verbatim excerpt / NO EXPLICIT DECISION]”` |
| Unresolved question(s) | `[U-___ / NONE]` |
| Resolution state | `[RESOLVED / FOLLOW_UP_REQUIRED]` |

### D — Deployment/publication

| Field | Value |
|---|---|
| Packet proposal reviewed | `[exact choice and packet section]` |
| Explicit disposition | `[APPROVE / REJECT / REVISE / UNRESOLVED]` |
| Approved choice(s) | `[exact choices / NONE]` |
| Rejected alternative(s) | `[exact alternatives / NONE STATED]` |
| Requested revision(s) | `[R-___ / NONE]` |
| Cost limit(s) | `[COST-___ / NONE STATED]` |
| Account, project, domain, or environment constraint(s) | `[ACCT-___ / NONE STATED]` |
| Other condition(s) | `[C-___ / NONE]` |
| Decisive evidence ID(s) | `[EV-___ / NONE]` |
| Exact supporting words | `“[verbatim excerpt / NO EXPLICIT DECISION]”` |
| Unresolved question(s) | `[U-___ / NONE]` |
| Resolution state | `[RESOLVED / FOLLOW_UP_REQUIRED]` |

### E — Email/delivery

| Field | Value |
|---|---|
| Packet proposal reviewed | `[exact choice and packet section]` |
| Explicit disposition | `[APPROVE / REJECT / REVISE / UNRESOLVED]` |
| Approved choice(s) | `[exact choices / NONE]` |
| Rejected alternative(s) | `[exact alternatives / NONE STATED]` |
| Requested revision(s) | `[R-___ / NONE]` |
| Cost/sending limit(s) | `[COST-___ / NONE STATED]` |
| Account, domain, recipient, or environment constraint(s) | `[ACCT-___ / NONE STATED]` |
| Other condition(s) | `[C-___ / NONE]` |
| Decisive evidence ID(s) | `[EV-___ / NONE]` |
| Exact supporting words | `“[verbatim excerpt / NO EXPLICIT DECISION]”` |
| Unresolved question(s) | `[U-___ / NONE]` |
| Resolution state | `[RESOLVED / FOLLOW_UP_REQUIRED]` |

### F — Religious and Arabic content policy

| Field | Value |
|---|---|
| Packet proposal/policy version reviewed | `[exact policy, version, and packet section]` |
| Explicit disposition | `[APPROVE / REJECT / REVISE / UNRESOLVED]` |
| Approved choice(s) | `[exact rules / NONE]` |
| Rejected alternative(s) | `[exact alternatives / NONE STATED]` |
| Requested revision(s) | `[R-___ / NONE]` |
| Reviewer/competency/account constraint(s) | `[ACCT-___ / NONE STATED]` |
| Other condition(s) | `[C-___ / NONE]` |
| Decisive evidence ID(s) | `[EV-___ / NONE]` |
| Exact supporting words | `“[verbatim excerpt / NO EXPLICIT DECISION]”` |
| Unresolved question(s) | `[U-___ / NONE]` |
| Resolution state | `[RESOLVED / FOLLOW_UP_REQUIRED]` |

## 8. Revisions, limits, constraints, and unresolved conditions

Use stable IDs so each item can be traced from the area records and follow-up evidence.
Do not convert a conditional response into approval. Unless the decision-maker writes
an explicit `APPROVE` for the exact conditioned proposal, retain `REVISE` or
`UNRESOLVED`.

### Requested revisions

| Revision ID | Area(s) | Exact requested change | Evidence ID | Requires new packet/version? | Status | Resolution evidence/new packet |
|---|---|---|---|---|---|---|
| `R-001` | `[A-F]` | `[exact change]` | `[EV-___]` | `[YES / NO]` | `[OPEN / SUPERSEDED / RESOLVED]` | `[reference / NONE]` |

### Cost limits

| Cost ID | Area(s) | Currency | One-time cap | Recurring cap + period | Usage cap/rate | Taxes/overages included? | Evidence ID | Status |
|---|---|---|---|---|---|---|---|---|
| `COST-001` | `[A-F/GLOBAL]` | `[currency]` | `[amount / NONE]` | `[amount + period / NONE]` | `[cap / NONE]` | `[YES / NO / UNRESOLVED]` | `[EV-___]` | `[CLEAR / UNRESOLVED]` |

### Account and resource constraints

| Constraint ID | Area(s) | Provider/resource/account/environment | Exact allowed account or boundary | Explicit exclusions | Evidence ID | Status |
|---|---|---|---|---|---|---|
| `ACCT-001` | `[A-F/GLOBAL]` | `[resource]` | `[exact boundary]` | `[exclusions]` | `[EV-___]` | `[CLEAR / UNRESOLVED]` |

Never record secret values. Use a non-secret account/project identifier or an
access-controlled reference.

### Other conditions and unresolved questions

| ID | Area(s) | Condition or question | Why unresolved | Owner | Follow-up due | Evidence ID(s) | Status |
|---|---|---|---|---|---|---|---|
| `U-001` | `[A-F/GLOBAL]` | `[exact condition/question]` | `[reason]` | `[owner]` | `[timestamp/date]` | `[EV-___]` | `[OPEN / RESOLVED]` |

## 9. Precise test-mode implementation authorization

A decision about architecture does not itself authorize implementation. Record the
boundary independently and quote the exact written authorization.

| Capability/action | Authorization | Exact scope, resource, environment, and limit | Evidence ID |
|---|---|---|---|
| Source-code changes | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[branches/directories/features]` | `[EV-___]` |
| Schemas and migrations | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[local files only, disposable DB, etc.]` | `[EV-___]` |
| Automated tests and synthetic fixtures | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[permitted data and environment]` | `[EV-___]` |
| Local/disposable provider test mode | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[named provider/account/project; exact operations]` | `[EV-___]` |
| Existing remote non-production resources | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[each resource must be named]` | `[EV-___]` |
| Remote account/project/resource creation | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[exactly what, if separately authorized]` | `[EV-___]` |
| Credential, secret, DNS, or webhook changes | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[exactly what, if separately authorized]` | `[EV-___]` |
| External email or messages | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[recipient allowlist/test sink]` | `[EV-___]` |
| Commit | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[repository/branch]` | `[EV-___]` |
| Push or pull request | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[repository/branch/remote]` | `[EV-___]` |
| Staging deployment | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[named project/environment]` | `[EV-___]` |
| Production deployment/release | `[AUTHORIZED / NOT AUTHORIZED / UNRESOLVED]` | `[must be separately explicit]` | `[EV-___]` |

Exact authorized test-mode boundary, copied verbatim:

```text
[exact written authorization / NO EXPLICIT AUTHORIZATION]
```

Effective authorization summary (must not be broader than the exact written evidence):

```text
[precise allowed actions, named resources/environments, limits, exclusions, and expiry]
```

Authorization expiry or review trigger: `[timestamp, milestone, packet revision, or NONE STATED]`

Any test-mode field that is `UNRESOLVED` or lacks `EXPLICIT_DECISION` evidence is **not
authorized** until clarified in writing.

## 10. Mandatory non-authorization statement

The decision-maker must explicitly accept or restate the following boundary. Record the
supporting evidence ID. Do not shorten it in a way that broadens authorization.

> Approval does not authorize service purchases, production publication, live
> customer-data processing, live payments, or production release unless each action is
> separately and explicitly authorized.

| Field | Value |
|---|---|
| Statement explicitly accepted? | `[YES / NO / UNRESOLVED]` |
| Exact acceptance words | `“[verbatim response / NONE]”` |
| Evidence ID | `[EV-___ / NONE]` |
| Separately authorized exception(s) | `[exact action + scope + evidence ID / NONE]` |

If this statement is not explicitly accepted, the architecture dispositions may still
be recorded, but no implementation or listed live/production action may be inferred
from them.

## 11. Follow-up exchanges

Append exchanges chronologically. Preserve exact questions and responses, including
acknowledgements and non-responses, because they explain why an area is resolved or
unresolved.

### Follow-up `[sequence number]`

| Field | Value |
|---|---|
| Evidence ID | `[EV-___]` |
| Sent at (UTC, ISO 8601) | `[timestamp]` |
| Sent by | `[name + identity/role]` |
| Channel + message/reference ID | `[channel + ID]` |
| Packet version | `[version]` |
| Area(s)/condition(s) addressed | `[A-F, R-___, C-___, U-___]` |
| Response due | `[timestamp / NONE]` |
| Response received at | `[timestamp / NO RESPONSE]` |
| Response author identity/role | `[identity / NO RESPONSE]` |
| Response message/reference ID | `[ID / NO RESPONSE]` |
| Evidence classification | `[EXPLICIT_DECISION / REVISION_DETAIL / ACKNOWLEDGEMENT_ONLY / AMBIGUOUS_OR_CONDITIONAL / NO_RESPONSE]` |

Exact follow-up question:

```text
[verbatim written question]
```

Exact response:

```text
[verbatim written response / NO RESPONSE]
```

Effect on disposition and why:

```text
[area/condition changed or remains unresolved; cite the exact words and evidence IDs]
```

## 12. Final audit determination

| Check | Result | Evidence/notes |
|---|---|---|
| Decision-maker name and identity or accountable role are recorded | `[PASS / FAIL]` | `[reference]` |
| Primary timestamp and auditable written channel are recorded | `[PASS / FAIL]` | `[reference]` |
| Exact packet version and immutable reference are recorded | `[PASS / FAIL]` | `[reference]` |
| Exact primary response and every decisive follow-up are preserved | `[PASS / FAIL]` | `[EV IDs]` |
| All six areas have explicit dispositions or are visibly `UNRESOLVED` | `[PASS / FAIL]` | `[summary rows]` |
| Every non-`UNRESOLVED` disposition traces to `EXPLICIT_DECISION` evidence | `[PASS / FAIL]` | `[EV IDs]` |
| Approved choices and rejected alternatives are recorded | `[PASS / FAIL]` | `[area sections]` |
| Requested revisions and unresolved conditions are recorded | `[PASS / FAIL]` | `[R/U IDs]` |
| Cost limits and account/resource constraints are recorded | `[PASS / FAIL]` | `[COST/ACCT IDs]` |
| Test-mode authorization is precise and evidence-backed | `[PASS / FAIL]` | `[EV IDs]` |
| Mandatory non-authorization statement is explicitly accepted | `[PASS / FAIL]` | `[EV ID]` |
| Silence, acknowledgement, ambiguity, or implied consent was not counted as approval | `[PASS / FAIL]` | `[EV IDs/notes]` |

Final gate status: `[APPROVED_WITHIN_RECORDED_BOUNDARY / REJECTED / REVISION_REQUIRED / UNRESOLVED]`

Unresolved area IDs: `[A-F / NONE]`

Open revision/condition/constraint IDs: `[R-___, C-___, COST-___, ACCT-___, U-___ / NONE]`

Authorized next action, if any: `[exact action within section 9 / NONE]`

Prohibited next actions: `[exact exclusions, including every unresolved or unauthorized action]`

Audit reviewed by: `[name and role]`

Audit review timestamp (UTC, ISO 8601): `[YYYY-MM-DDTHH:MM:SSZ]`

Audit notes:

```text
[why the evidence is sufficient, or exactly what remains unresolved]
```
