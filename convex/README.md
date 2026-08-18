# Hosted TEST-A functions

This directory is deployed to one isolated Convex TEST-A deployment.

The functions use public Convex function names because the Vercel API is a separate server runtime. Every function requires the same high-entropy `CUSTOMER_FLOW_BACKEND_TOKEN`; do not expose this token to browser code. Intake-token replay material reaches Convex only as Vercel-encrypted AES-256-GCM ciphertext.

Release order and provider/environment separation are defined in:

- `../ops/test-a-hosted-provider-manifest.json`
- `../openspec/reports/2026-08-18-test-a-hosted-provider-release-candidate.md`

Do not run `npx convex deploy` without independent approval for the exact signed candidate and target deployment.
