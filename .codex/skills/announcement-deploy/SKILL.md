---
name: announcement-deploy
description: Deploy rendered announcement output to Vercel and preserve immutable revision-aware job metadata.
license: MIT
compatibility: Requires the local announce CLI and Vercel access for real deployment.
---

Use this skill when the user wants to deploy or redeploy a rendered page revision.

## Workflow

1. Confirm the output directory or job file.
2. For a non-mutating rehearsal, run:
   ```bash
   node ./bin/announce.mjs deploy --input <out-dir> --dry-run
   ```
3. For a real deployment, run:
   ```bash
   node ./bin/announce.mjs deploy --input <out-dir>
   ```
4. Report the resulting public URL and the live page revision separately from the template/runtime version.

## Guardrails

- Treat deploy as a mutating action that must be explicit.
- Do not describe a dry run as a live deployment.
- Keep immutable deployment behavior: new revisions deploy intentionally, old deployments do not silently change.
