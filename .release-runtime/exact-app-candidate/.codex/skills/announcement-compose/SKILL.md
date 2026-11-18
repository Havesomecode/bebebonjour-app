---
name: announcement-compose
description: Compose a draft birth announcement page from intake data using the local announce CLI and reference discovery flow.
license: MIT
compatibility: Requires the local announce CLI in this repository.
---

Use this skill when the user wants to turn intake data into a draft `announcement-page.json`.

## What This Skill Does

- validates `customer-intake.json`
- runs `announce compose`
- surfaces candidate suggestions when operator selection is required
- preserves blocked states when no good references or meanings are found

## Workflow

1. Confirm the intake file path.
2. Run:
   ```bash
   node ./bin/announce.mjs compose --input <intake.json> --output <page.json>
   ```
3. If the CLI returns `selection_required`, show the candidate ids and ask which one to use.
4. Re-run with:
   ```bash
   node ./bin/announce.mjs compose --input <intake.json> --output <page.json> --select <candidate-id>
   ```
5. Treat the generated page as draft content until explicitly reviewed and approved.

## Guardrails

- Do not invent content when compose returns a blocked result.
- Do not mark draft output as approved without explicit operator intent.
- Keep the workflow anchored to `announcement-page.json` as the canonical output.
