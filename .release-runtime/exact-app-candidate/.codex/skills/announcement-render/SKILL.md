---
name: announcement-render
description: Render an approved announcement-page.json into versioned static output using the local announce CLI.
license: MIT
compatibility: Requires the local announce CLI in this repository.
---

Use this skill when the user wants to render a page revision into static output.

## Workflow

1. Confirm the page file path and output directory.
2. Run:
   ```bash
   node ./bin/announce.mjs render --input <page.json> --output <out-dir>
   ```
3. Use `--allow-draft` only if the user explicitly wants a non-production preview.
4. Inspect the generated output under:
   - `artifacts/current/`
   - `artifacts/revisions/`
   - `deploy/<slug>/`

## Guardrails

- Prefer approved pages for normal render flows.
- Preserve page revision and template version metadata in the generated output.
- Do not replace the shared template with customer-specific edits during rendering.
