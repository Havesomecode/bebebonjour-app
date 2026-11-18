# Birth Announcement Schema And CLI Draft

Date: 2026-03-07

## Purpose

This document turns the exploration into a concrete contract:

- canonical JSON documents
- validation rules
- generated artifacts
- CLI command surface
- exit codes and failure semantics

This is still exploration material, not implementation.

## Document model

Three JSON document types are enough for V1:

```text
customer-intake.json   raw request
announcement-page.json canonical content source
announcement-job.json  operational pipeline state
```

Only `announcement-page.json` should be treated as durable content truth.

## Canonical source of truth

The system should use this rule:

- authored truth: `announcement-page.json`
- generated truth: `transcript.json`, TTS manifests, audio files
- operational truth: `announcement-job.json`

That means exact narration timestamps should not be hand-authored in the canonical page file.

## `customer-intake.json`

### Intent

Represents what the customer submitted plus minimal normalization.

### Draft shape

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_2026_03_07_001",
  "submittedAt": "2026-03-07T21:30:00Z",
  "customer": {
    "email": "parent@example.com"
  },
  "baby": {
    "firstName": "Bayane",
    "nameArabic": "بيان",
    "gender": "girl"
  },
  "languages": ["ar", "fr"],
  "voicePreference": {
    "gender": "male"
  },
  "notes": {
    "specificDemands": "Elegant and reverent tone.",
    "religiousReferencesHint": [
      "Ar-Rahman 55:4",
      "Al-Imran 3:138"
    ]
  }
}
```

### Validation rules

- `schemaVersion` is required and starts at `1.0`
- `requestId` is required
- `submittedAt` must be ISO-8601 date-time
- `customer.email` is required and must be syntactically valid
- `baby.firstName` is required
- `baby.gender` is required and must be one of:
  - `girl`
  - `boy`
  - `neutral`
- `languages` is required and must be one of:
  - `["ar"]`
  - `["fr"]`
  - `["ar", "fr"]`
- `voicePreference.gender` is required and must be one of:
  - `male`
  - `female`
  - `neutral`

### Review note

`notes.religiousReferencesHint` is not publishable content. It is editorial guidance only.

## `announcement-page.json`

### Intent

This is the canonical render contract and the only content document the renderer and TTS pipeline should need.

### Design principles

- fixed section ids
- no raw HTML fragments
- display text separated from narration text
- language-scoped content only for enabled languages
- religious references stored as structured objects
- review state embedded in the page document

### Draft shape

```json
{
  "schemaVersion": "1.0",
  "pageId": "page_bayane_2026_03_07",
  "slug": "bayane",
  "languages": ["ar", "fr"],
  "defaultLanguage": "ar",
  "theme": "blessed-arrival",
  "identity": {
    "nameLatin": "Bayane",
    "nameArabic": "بيان",
    "gender": "girl",
    "childLabel": {
      "ar": "بابنتنا",
      "fr": "notre fille"
    }
  },
  "seo": {
    "title": "Une Naissance Bénie | Bayane",
    "description": "Par la grâce de Dieu, nous avons accueilli notre fille.",
    "ogImageMode": "generated"
  },
  "sections": {
    "intro": {
      "ar": {
        "displayLines": ["..."],
        "narrationText": "..."
      },
      "fr": {
        "displayLines": ["..."],
        "narrationText": "..."
      }
    },
    "dua": {
      "ar": {
        "displayLines": ["..."],
        "narrationText": "..."
      },
      "fr": {
        "displayLines": ["..."],
        "narrationText": "..."
      }
    },
    "meaning": {
      "ar": {
        "displayLines": ["..."],
        "narrationText": "..."
      },
      "fr": {
        "displayLines": ["..."],
        "narrationText": "..."
      }
    },
    "reveal": {
      "ar": {
        "introLines": ["...", "..."],
        "name": "بَيَان",
        "narrationText": "..."
      },
      "fr": {
        "introLines": ["...", "..."],
        "name": "BAYANE",
        "narrationText": "..."
      }
    },
    "verses": {
      "ar": [
        {
          "kind": "quran",
          "quote": "عَلَّمَهُ الْبَيَانَ",
          "reference": "الرحمن: ٤",
          "sourceKey": "quran-55-4"
        }
      ],
      "fr": [
        {
          "kind": "quran_translation",
          "quote": "Il lui a enseigné l’expression claire.",
          "reference": "Sourate Ar-Rahman, 55:4",
          "sourceArabic": "عَلَّمَهُ الْبَيَانَ",
          "sourceKey": "quran-55-4"
        }
      ]
    },
    "closing": {
      "ar": {
        "displayLines": ["..."],
        "narrationText": "..."
      },
      "fr": {
        "displayLines": ["..."],
        "narrationText": "..."
      }
    }
  },
  "audioPlan": {
    "provider": "openai",
    "model": "gpt-4o-mini-tts",
    "voiceByLanguage": {
      "ar": "onyx",
      "fr": "onyx"
    },
    "instructionsByLanguage": {
      "ar": "Soft, spiritual, contemplative.",
      "fr": "Soft, spiritual, contemplative."
    }
  },
  "review": {
    "status": "approved",
    "reviewedBy": "operator@example.com",
    "reviewedAt": "2026-03-07T22:00:00Z"
  },
  "provenance": {
    "sourceRequestId": "req_2026_03_07_001"
  }
}
```

## `announcement-page.json` strict rules

### Root-level rules

- `schemaVersion` is required and initially `1.0`
- `pageId` is required and immutable once deployed
- `slug` is required
- `slug` must match:
  - `^[a-z0-9]+(?:-[a-z0-9]+)*$`
- `languages` is required
- `languages` must contain unique values only
- allowed values in `languages`:
  - `ar`
  - `fr`
- `defaultLanguage` must be included in `languages`
- `theme` defaults to `blessed-arrival`

### Identity rules

- `identity.nameLatin` is required
- `identity.gender` is required and must be `girl`, `boy`, or `neutral`
- if `languages` contains `ar`, `identity.nameArabic` should be required
- `childLabel` must only contain languages present in `languages`

### Section rules

The following section ids are fixed and required:

- `intro`
- `dua`
- `meaning`
- `reveal`
- `verses`
- `closing`

There should be no custom section ids in V1.

### Text block rules

For `intro`, `dua`, `meaning`, and `closing`:

- each enabled language object must include:
  - `displayLines`
  - `narrationText`
- `displayLines` must be a non-empty array of non-empty strings
- `narrationText` must be a non-empty string

For `reveal`:

- each enabled language object must include:
  - `introLines`
  - `name`
  - `narrationText`
- `introLines` must be a non-empty array
- `name` must be non-empty

### Verse rules

For each verse object:

- `kind` is required
- allowed values:
  - `quran`
  - `quran_translation`
  - `hadith`
  - `hadith_translation`
  - `other_reference`
- `quote` is required
- `reference` is required
- `sourceKey` is required for deduplication and editorial traceability
- `sourceArabic` is optional and mainly useful for translated variants

### Review rules

- `review.status` is required
- allowed values:
  - `draft`
  - `approved`
  - `rejected`
- deploy must refuse documents unless `review.status` is `approved`

## JSON Schema draft for `announcement-page.json`

This is intentionally partial but already implementable.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/announcement-page.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "pageId",
    "slug",
    "languages",
    "defaultLanguage",
    "identity",
    "seo",
    "sections",
    "audioPlan",
    "review",
    "provenance"
  ],
  "properties": {
    "schemaVersion": {
      "type": "string",
      "const": "1.0"
    },
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "slug": {
      "type": "string",
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    },
    "languages": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["ar", "fr"]
      },
      "uniqueItems": true,
      "minItems": 1,
      "maxItems": 2
    },
    "defaultLanguage": {
      "type": "string",
      "enum": ["ar", "fr"]
    },
    "theme": {
      "type": "string"
    },
    "identity": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nameLatin", "gender", "childLabel"],
      "properties": {
        "nameLatin": {
          "type": "string",
          "minLength": 1
        },
        "nameArabic": {
          "type": "string",
          "minLength": 1
        },
        "gender": {
          "type": "string",
          "enum": ["girl", "boy", "neutral"]
        },
        "childLabel": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "ar": { "type": "string", "minLength": 1 },
            "fr": { "type": "string", "minLength": 1 }
          }
        }
      }
    },
    "seo": {
      "type": "object",
      "additionalProperties": false,
      "required": ["title", "description"],
      "properties": {
        "title": { "type": "string", "minLength": 1 },
        "description": { "type": "string", "minLength": 1 },
        "ogImageMode": {
          "type": "string",
          "enum": ["generated", "static", "custom"]
        }
      }
    },
    "sections": {
      "type": "object",
      "additionalProperties": false,
      "required": ["intro", "dua", "meaning", "reveal", "verses", "closing"]
    },
    "audioPlan": {
      "type": "object",
      "additionalProperties": false,
      "required": ["provider", "model", "voiceByLanguage"],
      "properties": {
        "provider": { "type": "string", "enum": ["openai"] },
        "model": { "type": "string", "minLength": 1 },
        "voiceByLanguage": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "ar": { "type": "string", "minLength": 1 },
            "fr": { "type": "string", "minLength": 1 }
          }
        },
        "instructionsByLanguage": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "ar": { "type": "string" },
            "fr": { "type": "string" }
          }
        }
      }
    },
    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": ["status"],
      "properties": {
        "status": {
          "type": "string",
          "enum": ["draft", "approved", "rejected"]
        },
        "reviewedBy": { "type": "string" },
        "reviewedAt": { "type": "string", "format": "date-time" }
      }
    },
    "provenance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sourceRequestId"],
      "properties": {
        "sourceRequestId": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  }
}
```

## Rules not worth forcing into JSON Schema alone

Some constraints are better enforced in application validation:

- if `languages` includes `ar`, all required Arabic section content must exist
- if `languages` excludes `fr`, no French content should be present
- `defaultLanguage` must be a member of `languages`
- verse `sourceKey` values should be unique within a page
- reveal section must contain exactly one visible name string per language
- `review.status=approved` should imply `reviewedBy` and `reviewedAt`

## `announcement-job.json`

### Intent

Tracks pipeline state, deployment metadata, and delivery status.

### Draft shape

```json
{
  "schemaVersion": "1.0",
  "jobId": "job_2026_03_07_001",
  "pageId": "page_bayane_2026_03_07",
  "slug": "bayane",
  "status": "deployed",
  "paths": {
    "intakeFile": "./data/intake/bayane.json",
    "pageFile": "./data/pages/bayane.json",
    "outputDir": "./out/bayane"
  },
  "deploy": {
    "provider": "vercel",
    "baseUrl": "https://announcements.example.com",
    "publicUrl": "https://announcements.example.com/bayane/ar?narration=on",
    "deployedAt": "2026-03-07T22:10:00Z"
  },
  "email": {
    "status": "sent",
    "sentAt": "2026-03-07T22:15:00Z"
  }
}
```

### Status values

Recommended job statuses:

- `created`
- `composed`
- `rendered`
- `tts_partial`
- `tts_complete`
- `deployed`
- `emailed`
- `failed`

## Generated artifacts

Output layout should be predictable:

```text
data/
  intake/
  pages/
  jobs/

template/
  app/

out/
  <slug>/
    index.html
    page.json
    transcript.json
    assets/
      audio/
        narration/
          ar/
            manifest.json
            01-intro.mp3
          fr/
            manifest.json
            01-intro.mp3
```

## Generated `transcript.json`

This file should be generated from `announcement-page.json`.

Before TTS:

- contains section ordering
- contains narration text
- contains placeholder times if useful, or no times at all

After TTS:

- contains exact timings
- contains exact section-to-audio mapping

Suggested shape:

```json
{
  "version": 1,
  "tracks": {
    "ar": [
      {
        "section": "intro",
        "text": "...",
        "time": "00:00",
        "seconds": 0
      }
    ],
    "fr": [
      {
        "section": "intro",
        "text": "...",
        "time": "00:00",
        "seconds": 0
      }
    ]
  }
}
```

## Routing contract

Use one host with per-slug language routes:

- `/<slug>/ar`
- `/<slug>/fr`

Narration remains query-driven:

- `/<slug>/ar?narration=on`
- `/<slug>/fr?narration=off`

This is operationally simpler than subdomains or separate projects per page.

## CLI contract

Recommended command set:

- `announce compose`
- `announce render`
- `announce tts`
- `announce deploy`
- `announce send`
- `announce status`

## Global CLI principles

- same input must produce same output for deterministic steps
- stdout should be human-readable by default
- `--json` should emit machine-readable results
- non-zero exit codes should be stable and documented
- commands should refuse unsafe states instead of silently guessing

## Exit codes

Recommended global exit code map:

- `0` success
- `2` usage error
- `3` validation error
- `4` review gate failure
- `5` external service failure
- `6` filesystem or template failure
- `7` deployment failure
- `8` email failure
- `9` partial completion

`9` is useful for TTS when one language succeeds and another fails.

## `announce compose`

### Purpose

Convert intake data into canonical page content.

### Example

```bash
announce compose \
  --input data/intake/bayane.json \
  --output data/pages/bayane.json
```

### Inputs

- `customer-intake.json`

### Outputs

- `announcement-page.json`

### Required behavior

1. validate intake
2. normalize language configuration
3. create structured sections
4. create `audioPlan`
5. create `review` block
6. mark result as `draft` unless explicitly overridden

### Flags

- `--input <file>`
- `--output <file>`
- `--default-language <ar|fr>`
- `--voice-ar <voice-id>`
- `--voice-fr <voice-id>`
- `--review-status <draft|approved>`
- `--json`

### Failure cases

- required intake fields missing
- unsupported language list
- Arabic output requested without Arabic name
- invalid slug derivation

## `announce render`

### Purpose

Render the canonical page document into a static output directory.

### Example

```bash
announce render \
  --input data/pages/bayane.json \
  --output out/bayane
```

### Inputs

- `announcement-page.json`
- template app files

### Outputs

- rendered static page
- copied `page.json`
- generated initial `transcript.json`

### Required behavior

1. validate page schema
2. refuse invalid review state only if `--require-approved` is set
3. materialize page content for enabled languages only
4. emit deterministic file structure
5. produce a page that works without narration assets

### Flags

- `--input <file>`
- `--output <dir>`
- `--base-path </slug>`
- `--require-approved`
- `--json`

### Failure cases

- invalid page schema
- missing template files
- unsupported theme
- output directory not writable

## `announce tts`

### Purpose

Generate audio narration, manifests, and final transcript timings.

### Example

```bash
announce tts \
  --input data/pages/bayane.json \
  --output out/bayane \
  --lang all
```

### Inputs

- `announcement-page.json`
- output directory from render step
- provider credentials

### Outputs

- audio files by language and section
- manifest per language
- updated `transcript.json`

### Required behavior

1. read narration text by section and language
2. preserve fixed section order
3. generate deterministic filenames
4. compute exact start times from returned audio durations
5. write manifests
6. update transcript timing fields

### Flags

- `--input <file>`
- `--output <dir>`
- `--lang <ar|fr|all>`
- `--provider <openai>`
- `--model <name>`
- `--force`
- `--json`

### Failure cases

- missing API key
- narration text missing for requested language
- external provider error
- audio generation partially successful

### Partial success rule

If one language succeeds and another fails:

- keep successful output
- mark job or command as partial
- exit with `9`

## `announce deploy`

### Purpose

Publish static output and return a stable public URL.

### Example

```bash
announce deploy \
  --input out/bayane \
  --slug bayane \
  --job data/jobs/bayane.json
```

### Inputs

- rendered output directory
- slug
- optional job file

### Outputs

- deployment metadata
- updated `announcement-job.json`

### Required behavior

1. validate output directory
2. publish to hosting provider
3. compute canonical public URLs
4. update job status and deployment metadata

### Flags

- `--input <dir>`
- `--slug <slug>`
- `--job <file>`
- `--provider <vercel>`
- `--json`

### Failure cases

- missing build output
- provider authentication failure
- provider upload failure
- returned URL does not match expected routing contract

## `announce send`

### Purpose

Target contract: email the customer the final page URL after a real delivery
provider is implemented. The current `console` provider is a redacted,
non-mutating preview and MUST NOT record a successful delivery.

### Example

```bash
announce send \
  --job data/jobs/bayane.json \
  --to parent@example.com
```

### Inputs

- `announcement-job.json`
- optional explicit recipient address

### Outputs

- updated email status in job file

### Required behavior

1. refuse to send if `publicUrl` is absent
2. choose recipient from `--to` or source intake metadata
3. record send timestamp

### Flags

- `--job <file>`
- `--to <email>`
- `--subject <text>`
- `--json`

### Failure cases

- no deployment URL
- no recipient email
- provider delivery failure

## `announce status`

### Purpose

Show pipeline state for one job.

### Example

```bash
announce status --job data/jobs/bayane.json
```

### Required output

Human output should answer:

- composed?
- rendered?
- tts complete?
- deployed?
- emailed?

JSON output should include:

- `status`
- `pageId`
- `slug`
- `publicUrl`
- `email.status`

## Minimal viable workflow

The smallest useful V1 is:

1. `announce compose`
2. human review of `announcement-page.json`
3. `announce render`
4. `announce tts`

Deployment and email can come immediately after, but they are not required to validate the content/template architecture.

## Recommended freeze points

The following decisions should now be treated as stable unless a new constraint appears:

- `announcement-page.json` is the canonical document
- transcript timings are generated, not authored
- route shape is `/<slug>/<lang>`
- verse data is structured, not free-form
- display text and narration text are separate
- deploy requires approved review state
- partial TTS completion is a first-class outcome

## Next good step

This design is now specific enough to convert into an OpenSpec change.

A sensible next step would be:

- create change: `extract-birth-announcement-template`

That change can use this document as the starting contract for:

- schema files
- CLI behavior
- template extraction
- a second generated sample page
