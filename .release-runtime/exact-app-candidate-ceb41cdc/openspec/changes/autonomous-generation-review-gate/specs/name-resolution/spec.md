## ADDED Requirements

### Requirement: Submitted spelling remains display authority
The system SHALL preserve the exact submitted Latin and Arabic name spellings for display while keeping normalized comparison keys private.

#### Scenario: Diacritic-bearing alternate spelling
- **WHEN** a submitted diacritic-bearing spelling is not the canonical catalog spelling
- **THEN** the system resolves it only through an explicit alias and does not replace the submitted display spelling

#### Scenario: Reveal spelling
- **WHEN** the draft renders a submitted Latin or Arabic name
- **THEN** identity and reveal content use the exact submitted display form without automatic uppercasing or transliteration

### Requirement: Alternate orthographies require explicit aliases
The system SHALL resolve alternate spellings only when an explicit catalog alias identifies one canonical entry.

#### Scenario: Known transliteration alias
- **WHEN** a submitted spelling matches exactly one explicit alias
- **THEN** the system records an alias match and requires operator awareness

#### Scenario: Ambiguous alias
- **WHEN** one normalized alias points to multiple canonical names
- **THEN** the system stops for review and permits no meaning or name-specific scriptural claim

#### Scenario: Other script identifies one ambiguous candidate
- **WHEN** either supplied script is ambiguous even though the other script identifies one member of that candidate set
- **THEN** the system still stops with `name_match_ambiguous` before cross-script intersection

### Requirement: Cross-script conflicts fail safe
The system MUST NOT silently choose a canonical identity when submitted Latin and Arabic forms resolve to different catalog entries.

#### Scenario: Conflicting Latin and Arabic forms
- **WHEN** the two scripts point to different names
- **THEN** the system returns `name_cross_script_conflict` and creates no draft

#### Scenario: Supplied Arabic form normalizes to empty
- **WHEN** `nameArabic` is supplied but contains only marks, tatweel, punctuation, or symbols after normalization
- **THEN** the system returns `name_arabic_normalizes_empty`, enables no name claims, and creates no draft

### Requirement: Original and unknown names receive claim-free fallbacks
The system SHALL create a neutral review draft for an unsupported name without inventing meaning, etymology, or holy-book association.

#### Scenario: Unknown name with religious context
- **WHEN** a religiously scoped intake contains a name absent from the catalog and aliases
- **THEN** the draft may contain generic blessings but contains no name meaning or name-specific scripture claim and records `name_not_in_catalog`

### Requirement: Scriptural labels require scriptural sources
The renderer MUST NOT introduce scripture-specific labels when the selected content contains no source-backed scriptural items.

#### Scenario: Religious generic fallback
- **WHEN** a generic religious fallback has no verses
- **THEN** the section is labeled as wishes or blessings rather than scripture

#### Scenario: Individual reference lacks source evidence
- **WHEN** any proposed scripture item lacks a non-empty `sourceKey`
- **THEN** that item is removed before composition and cannot appear under a scripture-specific label

#### Scenario: Free-form narration accompanies filtered references
- **WHEN** a suggestion supplies custom verse narration but its referenced items do not pass source enforcement
- **THEN** the custom narration is ignored and narration is derived only from post-policy items or the neutral fallback

### Requirement: Meaning claims require dedicated provenance
The composer MUST NOT treat scripture source keys or curated catalog text alone as evidence for a name meaning or etymology.

#### Scenario: Catalog meaning has no meaning source key
- **WHEN** a resolved catalog suggestion contains meaning text but no non-empty `meaningSourceKeys`
- **THEN** `meaningAllowed` is false and the composed meaning section uses neutral name-choice wording
