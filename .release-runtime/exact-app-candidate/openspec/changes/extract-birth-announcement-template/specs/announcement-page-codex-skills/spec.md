## ADDED Requirements

### Requirement: Codex skills expose task-oriented page workflows
The system SHALL provide Codex skills that expose the page-generation workflow through task-oriented prompts for composing, rendering, narration generation, deployment, and operational follow-up.

#### Scenario: Operator asks Codex to prepare a page
- **WHEN** an operator invokes the relevant Codex skill for a page-generation task
- **THEN** the skill guides that workflow using the underlying CLI contracts rather than requiring the operator to assemble the command sequence manually

### Requirement: Codex skills use CLI commands as the execution layer
Codex skills SHALL call the page CLI for validation, rendering, narration generation, deployment, and status inspection, and SHALL NOT reimplement that business logic independently.

#### Scenario: Skill runs a render workflow
- **WHEN** a Codex skill performs a render-related task
- **THEN** it delegates the execution to the CLI instead of duplicating rendering rules inside the skill itself

### Requirement: Codex skills surface operator decisions explicitly
Codex skills SHALL surface blocked states and required operator choices when compose cannot find suitable references, when approval is missing, or when a mutating action such as deploy or redeploy is requested.

#### Scenario: Compose cannot find a suitable reference
- **WHEN** the compose workflow returns a blocked result because no reliable reference or meaning was found
- **THEN** the Codex skill asks the operator how to proceed instead of inventing content or silently continuing

### Requirement: Codex skills preserve revision-aware operations
Codex skills SHALL present template/runtime version and page revision as separate concepts when operators inspect, redeploy, or revise customer pages.

#### Scenario: Operator inspects a live customer page
- **WHEN** a Codex skill shows deployment state for a customer page
- **THEN** it identifies the live page revision separately from the template/runtime version that produced it
