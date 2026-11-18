## ADDED Requirements

### Requirement: Preview generation is pulled from durable eligibility
The system SHALL claim generation work from durable `review_required` order and open-review-job state rather than executing generation in a webhook request or inferring work from a webhook response.

#### Scenario: Either provider arrives last
- **WHEN** Tally and Stripe arrive in either order and reconciliation reaches `review_required`
- **THEN** one eligible generation run can be claimed independently of which webhook completed reconciliation

#### Scenario: Webhook replay
- **WHEN** either signed provider event is replayed
- **THEN** no duplicate active generation run or artifact is created for the same order and input digest

### Requirement: Generation runs use an independent leased lifecycle
The system SHALL store generation state separately from `fulfillment_review_jobs` and SHALL use lease-token compare-and-set transitions.

#### Scenario: Parallel claims
- **WHEN** multiple workers concurrently claim eligible work
- **THEN** `FOR UPDATE SKIP LOCKED` semantics lease a given run to at most one worker

#### Scenario: Worker crash
- **WHEN** a worker stops after claiming a run
- **THEN** no other worker receives it before lease expiry and at most one bounded retry is claimable after expiry

#### Scenario: Stale completion
- **WHEN** a worker presents an expired or replaced lease token
- **THEN** completion and failure mutation are rejected without changing the current run

### Requirement: Completion rechecks fulfillment eligibility
The system MUST transactionally recheck the parent order and review job before recording `preview_ready`.

#### Scenario: Payment eligibility regresses during generation
- **WHEN** an order becomes blocked or its review job closes after claim but before completion
- **THEN** completion is rejected, the run cannot expose a usable preview, and uploaded artifacts are inaccessible or scheduled for purge

### Requirement: Worker authority is generation-only
The worker MUST NOT invoke TTS, deployment, publication, email, customer delivery, refunds, payment decisions, or approval mutation.

#### Scenario: Private preview succeeds
- **WHEN** one leased order is composed and rendered
- **THEN** the run stops at `preview_ready` and no shipping or consequential external side effect occurs

#### Scenario: Unsafe input needs editorial handling
- **WHEN** name resolution, gendered copy, or content policy cannot produce a safe deterministic preview
- **THEN** the run enters `needs_editorial_input` with bounded reason codes and no automatic guess

### Requirement: Private artifacts are immutable and fully bound
The worker SHALL upload only an allowlisted sanitized subtree under an order/run/content-digest namespace and SHALL bind review to a manifest digest covering every rendered byte.

#### Scenario: Same display name on different orders
- **WHEN** two orders use the same submitted first name
- **THEN** they receive distinct immutable object prefixes and cannot overwrite one another

#### Scenario: Rendered byte changes
- **WHEN** intake, catalog, template, runtime, stylesheet, media, or any rendered output byte changes
- **THEN** the file digest or aggregate manifest digest changes and prior review evidence does not authorize the new artifact

#### Scenario: Private-data scan
- **WHEN** a preview is prepared for upload
- **THEN** exact synthetic PII markers are absent from the uploaded subtree, manifest, logs, and safe error fields

### Requirement: Preview access is private and revocable
Preview artifacts SHALL remain private and SHALL be accessible only through authenticated, short-lived, revision-bound authorization.

#### Scenario: Anonymous access
- **WHEN** an unauthenticated client requests a private preview
- **THEN** the service returns 401 or 404 without disclosing artifact metadata

#### Scenario: Expired or revoked access
- **WHEN** preview authorization expires or is revoked
- **THEN** subsequent access fails and no permanent public URL remains usable

### Requirement: Generation privileges are least-privilege
Only the internal worker role SHALL execute claim, complete, and fail operations or access private generation metadata.

#### Scenario: Public database roles
- **WHEN** `anon` or ordinary `authenticated` roles attempt to read generation runs or execute worker RPCs
- **THEN** database authorization rejects the operation
