---
name: announcement-status
description: Inspect the operational state of an announcement job, including revision, template version, deployment state, and email state.
license: MIT
compatibility: Requires the local announce CLI in this repository.
---

Use this skill when the user wants a concise operational summary for a customer page.

## Workflow

1. Confirm the job file path.
2. Run:
   ```bash
   node ./bin/announce.mjs status --job <job.json> --json
   ```
3. Summarize:
   - current live page revision
   - template/runtime version
   - deployment status
   - public URL
   - email status

## Guardrails

- Always distinguish page revision from template/runtime version.
- Prefer reading the job file through the CLI rather than inferring state from scattered files.
- If deployment or email status is missing, say so directly instead of guessing.
