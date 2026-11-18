## ADDED Requirements

### Requirement: Multiple generations coexist in one application
The system SHALL retain every approved generation route when another generation is prepared or published.

#### Scenario: Publish a second generation
- **WHEN** generation B is added after generation A
- **THEN** generation A remains byte-equivalent and reachable at its stable route

### Requirement: Public identity is not the display-name slug alone
The system MUST use a collision-safe generation identity independent of the submitted display name.

#### Scenario: Two children have the same display name
- **WHEN** two unrelated orders use the same name
- **THEN** they receive distinct immutable generation identities and neither overwrites the other

### Requirement: Revisions are immutable
The system SHALL store generated content and artifacts under generation and revision identities and SHALL change the public pointer only after a matching approval and shipping action.

#### Scenario: Regenerate after review feedback
- **WHEN** a new revision is prepared
- **THEN** the prior revision remains intact and any approval remains bound only to the prior digest

### Requirement: Artifact economics are measurable
The system SHALL emit a provider-neutral manifest containing artifact byte counts and generation/revision identity.

#### Scenario: Cost analysis
- **WHEN** one generation is complete
- **THEN** storage and provider costs can be compared with its recognized revenue without exposing customer PII
