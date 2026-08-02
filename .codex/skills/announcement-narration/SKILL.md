---
name: announcement-narration
description: Generate narration assets and transcript timings for a rendered announcement page using the local announce CLI.
license: MIT
compatibility: Requires the local announce CLI and OPENAI_API_KEY for real narration generation.
---

Use this skill when the user wants narration files, manifests, and updated transcript timing data.

## Workflow

1. Confirm the page file path and output directory from the render step.
2. Run:
   ```bash
   node ./bin/announce.mjs tts --input <page.json> --output <out-dir> --lang all
   ```
3. If only one language should be generated, pass `--lang ar` or `--lang fr`.
4. If the command returns a partial state, inspect which language failed before continuing.

## Guardrails

- Do not claim narration is complete if the CLI returned partial success.
- Keep manifest and transcript timing files aligned with the current page revision.
- Require explicit operator awareness when credentials or provider failures block narration.
