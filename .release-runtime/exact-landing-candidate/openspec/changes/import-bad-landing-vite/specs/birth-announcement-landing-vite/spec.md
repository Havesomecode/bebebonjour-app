## ADDED Requirements

### Requirement: Vite Landing Application Structure
The repository MUST provide a root-level Vite application as the canonical landing implementation, with executable development and production build scripts.

#### Scenario: Developer runs the project locally
- **WHEN** a developer installs dependencies and runs the development command
- **THEN** the application MUST start successfully as a Vite app from the repository root

#### Scenario: Production bundle is generated
- **WHEN** a developer runs the production build command
- **THEN** the application MUST produce a static output directory suitable for deployment on Vercel

### Requirement: Landing Content Conforms to SPEC
The landing page MUST render the complete content blocks defined in `SPEC.md`, including hero, trust proof line, benefits, process steps, offers with prices and CTA labels, FAQ entries, and final CTA text.

#### Scenario: Visitor reads the page
- **WHEN** the landing page is loaded
- **THEN** the page MUST include all required sections and the French copy specified in `SPEC.md`

#### Scenario: Visitor compares offer tiers
- **WHEN** the visitor reaches the offers section
- **THEN** the page MUST display the three offers `Essentiel — 39€`, `Accompagné — 119€`, and `Sur-mesure — 249€` with their corresponding bullet points and CTA labels

### Requirement: Legacy Implementation Is Migrated and Removed
The useful implementation content from `bad-implem` commit `2cccc8b` MUST be migrated into the root Vite application, and the `bad-implem/` directory MUST be removed once migration is complete.

#### Scenario: Repository cleanup after migration
- **WHEN** migration is completed
- **THEN** the root project MUST contain the working landing implementation and `bad-implem/` MUST no longer exist

### Requirement: Vercel Deployment Compatibility
The repository MUST include deployment settings compatible with Vercel static hosting for the Vite output and domain use.

#### Scenario: Deployment configuration is evaluated
- **WHEN** Vercel reads the repository configuration
- **THEN** it MUST find a valid build command and output directory for the Vite app
