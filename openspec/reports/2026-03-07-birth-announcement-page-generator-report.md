# Birth Announcement Page Generator Report

Date: 2026-03-07

## Scope of this exploration

This report captures the current state of the reusable page template in `../happy`, the boundary between fixed presentation and client-specific content, and a recommended path toward a CLI-driven birth-announcement page generator.

There is currently no active OpenSpec change in this repository. There are also no existing specs here beyond `openspec/config.yaml`, so this document is the working record for the exploration phase.

## What exists today in `../happy`

The historical deployment URL is intentionally redacted. The reference implementation appeared to be generated from the local sibling project `../happy`.

The implementation is already close to a reusable product skeleton:

- `../happy/index.html`
  - Contains the full page structure and almost all copy.
  - The current Bayane-specific content is hard-coded here.
- `../happy/src/styles.css`
  - Contains the visual system: gradients, typography, particles, reveal motion, section treatments, and responsive behavior.
  - This is mostly reusable as a template.
- `../happy/src/main.js`
  - Handles language routing (`/ar` and `/fr`), narration query state (`?narration=on|off`), phrase-by-phrase reveal, section tracking, and audio playback.
  - This is mostly reusable as a template runtime.
- `../happy/public/transcript.json`
  - Holds the spoken text and timing by language and section.
  - This is content data, not template.
- `../happy/public/assets/audio/narration/<lang>/manifest.json`
  - Maps narration files to sections and timestamps.
  - This is generated content metadata, not template.
- `../happy/scripts/generate-tts.mjs`
  - Generates narration audio from transcript content using OpenAI TTS.
  - This is reusable generation tooling.
- `../happy/vercel.json`
  - Configures route rewrites so `/ar` and `/fr` resolve to the same static app.
  - This is reusable deployment glue.

## Template boundary

The page is currently a mix of:

- Stable presentation logic
- Stable interaction logic
- Bayane-specific content
- Bayane-specific generated assets

The extraction target should be:

```text
                  TEMPLATE / ENGINE
┌──────────────────────────────────────────────────────┐
│ layout skeleton                                      │
│ typography + motion + particles + reveal pacing      │
│ language toggle + narration toggle + URL state       │
│ transcript loading + audio playback runtime          │
│ static build + deploy adapter                        │
└──────────────────────────────────────────────────────┘
                           │
                           ▼
                    CLIENT CONTENT PACK
┌──────────────────────────────────────────────────────┐
│ baby identity                                        │
│ Arabic + French copy per section                     │
│ meaning / etymology                                  │
│ religious references                                 │
│ transcript by language                               │
│ voice selection                                      │
│ og metadata                                          │
│ generated audio + manifest                           │
└──────────────────────────────────────────────────────┘
```

In concrete terms:

- Keep the visual system from `styles.css`.
- Keep the runtime behavior from `main.js`.
- Replace hard-coded copy in `index.html` with a render step fed by structured data.
- Keep `transcript.json` and audio manifests generated from that same data model.

## Recommended product shape

The cleanest direction is not “generate a whole new app each time”.

The cleanest direction is:

- one stable template app
- one content schema
- one CLI that materializes a client-specific content pack and deploys it

That gives this operating model:

```text
customer form
    │
    ▼
intake record (JSON / DB row)
    │
    ▼
content generation + editorial review
    │
    ▼
page config + transcript + audio assets
    │
    ▼
static build / deploy
    │
    ▼
public URL
    │
    ▼
email to customer
```

This is better than cloning `../happy` per customer because:

- template fixes propagate cleanly
- the CLI can stay small and deterministic
- content generation becomes auditable
- deployment can be standardized

## Proposed content schema

The current customer form is a good start:

- email
- first name of the baby
- language (`fr`, `ar`, `both`)
- gender of voice
- specific demands
- religious references where the name may appear

For reliable generation, the system should also derive or collect:

- slug
  - Example: `bayane-tatar`
- display name per language
  - Arabic script and Latin script should not be inferred blindly from one another.
- baby gender for pronouns in French and Arabic
- reveal wording
  - Example: `our daughter`, `our son`, or a neutral variant if needed
- meaning summary
  - A short editorial interpretation used in the “meaning” section
- religious reference list
  - Exact source, exact quotation, translation, and whether it is direct or interpretive
- SEO fields
  - title, description, og subtitle
- voice model and voice id per language
  - One “gender” field is useful for intake, but actual TTS selection should be explicit in generated config.
- deployment metadata
  - target domain/subpath, sent status, created-at, reviewed-by

Minimal generated content object:

```json
{
  "slug": "bayane-example",
  "languages": ["ar", "fr"],
  "identity": {
    "nameLatin": "Bayane",
    "nameArabic": "بيان",
    "childLabel": {
      "fr": "notre fille",
      "ar": "بابنتنا"
    }
  },
  "sections": {
    "intro": { "ar": "...", "fr": "..." },
    "dua": { "ar": "...", "fr": "..." },
    "meaning": { "ar": "...", "fr": "..." },
    "revealIntro": { "ar": "...", "fr": "..." },
    "revealName": { "ar": "...", "fr": "..." },
    "verses": {
      "ar": ["..."],
      "fr": ["..."]
    },
    "closing": { "ar": "...", "fr": "..." }
  },
  "transcript": {
    "ar": [{ "section": "intro", "time": "00:00", "text": "..." }],
    "fr": [{ "section": "intro", "time": "00:00", "text": "..." }]
  },
  "audio": {
    "voiceByLanguage": { "ar": "onyx", "fr": "onyx" }
  },
  "seo": {
    "title": "...",
    "description": "..."
  }
}
```

## Extraction plan for the existing template

The current Bayane app can be separated into three layers.

### 1. Presentation layer

Reusable with minimal change:

- section card layout
- reveal animation system
- parallax background layers
- particles
- Arabic/French typography handling
- narration toggle and start CTA

### 2. Runtime layer

Reusable with moderate change:

- URL state parsing
- language switching
- narration playback sequencing
- transcript-driven cue logic
- sticky phrase reveal pacing

The main runtime change should be to load a page config JSON instead of assuming all content is present in `index.html`.

### 3. Content layer

Must become fully data-driven:

- intro copy
- du'a copy
- meaning copy
- reveal text
- verses and references
- closing copy
- OG metadata
- transcript
- generated audio manifests

## CLI concept

The first CLI should stay narrow.

Suggested commands:

- `announce-page generate --input <customer.json> --out <dir>`
  - Creates a page config, transcript, and rendered static app.
- `announce-page tts --input <page-config.json>`
  - Generates narration assets from transcript data.
- `announce-page deploy --input <build-dir-or-config>`
  - Uploads to hosting and returns a public URL.
- `announce-page send-email --input <job.json>`
  - Sends the final customer email containing the URL.

For the first milestone, `generate` is enough.

Expected `generate` behavior:

1. Validate intake data.
2. Build a normalized page content object.
3. Render template content into a static app.
4. Emit `transcript.json`.
5. Prepare asset folders and metadata.
6. Output a deterministic build artifact that can later be deployed.

## Recommended operating model

Do not fully automate religious/reference writing at the start.

A safer first version is:

- customer fills intake form
- an internal operator reviews or edits generated content
- the CLI builds the final page from approved content

That creates a human-in-the-loop system where automation accelerates production without making theological or linguistic mistakes public.

## Risks and hidden complexity

### Religious references are not plain metadata

The field “religious references where the name may appear” sounds simple, but it is the highest-risk part of the workflow.

The system must distinguish:

- exact occurrence of the word
- same root but different derived word
- interpretive association rather than direct textual match

If this is sloppy, the generated page will look polished and still be wrong.

### Arabic and French are not symmetric

The app supports both languages well at the UI level, but content generation is harder than simple translation:

- Arabic phrasing needs native-quality rhythm
- French needs elegant, non-literal rendering
- name transliteration must be explicit
- gendered grammar differs

### TTS voice choice is more granular than “male/female”

The intake field should remain simple for customers, but internally the system should map that to:

- TTS provider
- model
- voice id
- pacing instructions
- language-specific overrides

### Deployment model needs an opinion

You need to decide early whether each page is:

- its own project deployment
- one multi-page app with generated routes
- one static bucket with per-customer directories

My current recommendation is:

- one generator repo
- one output folder per customer/job
- one hosting target with predictable per-slug URLs

### Browser audio policies matter

The current app already handles autoplay restrictions by showing a start CTA. That means narration cannot be assumed to auto-start for every visitor. The generated experience should still feel complete without audio.

## Recommended first milestone

The best first milestone is not full monetized automation.

It is:

```text
M1: extract a reusable template and generate one new page locally
```

Success criteria for M1:

- the Bayane page can be regenerated from structured data
- a second baby name can be generated from the same template without manual HTML editing
- Arabic-only, French-only, and bilingual variants are supported
- transcript generation is deterministic
- the generated page still supports narration mode and route-based language selection

## Suggested next OpenSpec change

This exploration feels ready for a real change proposal.

A sensible change name would be:

- `extract-birth-announcement-template`

That change should likely include:

- proposal
  - why the Bayane page must become a reusable generator
- design
  - page schema, CLI shape, rendering model, deployment model
- tasks
  - template extraction
  - content schema
  - generator CLI
  - sample second page

## Bottom line

The current `../happy` app is already a strong prototype for the final product. The reusable value is mostly there. The main missing step is to move the Bayane-specific story out of the template and into a structured content model that a CLI can render repeatedly and safely.

The technical challenge is manageable.

The product challenge is content correctness, especially around:

- Arabic prose quality
- name meaning interpretation
- religious references
- deployment and delivery workflow
