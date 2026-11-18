## ADDED Requirements

### Requirement: Template renders supported announcement sections from canonical page data
The template SHALL render birth-announcement pages from `announcement-page.json` using the supported section ids `intro`, `dua`, `meaning`, `reveal`, `verses`, and `closing`.

#### Scenario: Render a bilingual page
- **WHEN** the renderer receives an approved page document containing Arabic and French content for the supported sections
- **THEN** it produces a page that renders those sections from the canonical content instead of hard-coded template copy

### Requirement: Template respects configured section order
The template SHALL render supported sections in the order specified by the page document's `sectionOrder` field, and SHALL refuse unsupported or duplicate section ids.

#### Scenario: Render a reordered page
- **WHEN** the page document specifies `sectionOrder` as `["intro", "meaning", "dua", "reveal", "verses", "closing"]`
- **THEN** the rendered page presents those supported sections in that exact order

### Requirement: Template supports configured language presentation
The template SHALL support Arabic-only, French-only, and bilingual pages, and SHALL expose language-specific routes consistent with the configured languages in the page document.

#### Scenario: Render an Arabic-only page
- **WHEN** the page document enables only Arabic content
- **THEN** the rendered page exposes only the Arabic presentation and does not require French content to render successfully

### Requirement: Template degrades gracefully without narration assets
The template SHALL remain usable when narration assets are absent, unavailable, or blocked by browser autoplay policy.

#### Scenario: Render page before narration generation
- **WHEN** a page is rendered without generated narration files
- **THEN** the page still displays all configured sections and remains navigable without audio playback

### Requirement: Template applies only declared customization variants
The template SHALL apply customer-specific presentation changes only through declared template variants or explicit feature flags carried by the page document.

#### Scenario: Enable a declared feature flag
- **WHEN** the page document includes a supported feature flag for a template variant
- **THEN** the rendered page applies that declared variation without requiring ad hoc template edits for that customer
