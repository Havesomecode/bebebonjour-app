## ADDED Requirements

### Requirement: Schema defines a canonical page document
The system SHALL define `announcement-page.json` as the canonical authored content document for rendering, narration generation, and review.

#### Scenario: Render from canonical page data
- **WHEN** the renderer, TTS pipeline, and deployment workflow need page content
- **THEN** they consume the approved `announcement-page.json` document rather than raw intake data or job-state metadata

### Requirement: Schema separates content, intake, and job state
The system SHALL define separate contracts for `customer-intake.json`, `announcement-page.json`, and `announcement-job.json`.

#### Scenario: Inspect customer request and live deployment state
- **WHEN** an operator reviews a customer request and a deployed page
- **THEN** raw intake, canonical page content, and operational job metadata are available as separate documents with distinct responsibilities

### Requirement: Schema records section order and supported section ids
The canonical page document SHALL include `sectionOrder`, and SHALL constrain section ordering to the supported section ids `intro`, `dua`, `meaning`, `reveal`, `verses`, and `closing`.

#### Scenario: Validate a page document with duplicate section ids
- **WHEN** a page document includes the same supported section id more than once in `sectionOrder`
- **THEN** schema validation fails and the page is not considered valid

### Requirement: Schema separates template versioning from page revisioning
The canonical page and operational job documents SHALL record template/runtime version metadata separately from customer page revision metadata.

#### Scenario: Diagnose a customer change
- **WHEN** an operator inspects a deployed page after a customer requests a content tweak
- **THEN** they can distinguish the template/runtime version that generated the page from the approved page revision that is currently live

### Requirement: Schema records review state before publication
The canonical page document SHALL carry review metadata including review status, and publication workflows MUST treat unapproved content as not deployable.

#### Scenario: Attempt to publish draft content
- **WHEN** a page document has review status `draft`
- **THEN** downstream deployment workflows treat that page as not approved for publication

### Requirement: Job schema retains moderate operational metadata
`announcement-job.json` SHALL retain pointers to source artifacts and a moderate set of copied operational metadata needed for support, redeploy, and customer communication workflows.

#### Scenario: Inspect a job without opening every source file
- **WHEN** an operator opens `announcement-job.json`
- **THEN** they can identify the intake file, current page file, current live revision, customer email, requested languages, approval state, deployed URL, and email delivery state
