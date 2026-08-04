# Autonomous generation to operator review

## Why

The fulfillment ingress now establishes one paid, durable `review_required` job, but generation remains a sequence of manually invoked CLI commands. The next product slice should make generation routine and autonomous while retaining an explicit, attributable operator decision before any publication or delivery.

The target tracer is:

```text
paid order
  -> deterministic intake validation
  -> name resolution and claim policy
  -> composition
  -> canonical validation
  -> private rendering
  -> review dossier
  -> operator review
```

Publication, email, delivery, refunds, customer contact, and delegated approval remain outside this change.

## What changes

- Introduce explicit name-resolution evidence, confidence, aliases, and safe unknown-name fallback behavior.
- Add a side-effect-free `prepare-review` CLI command that composes and renders a deterministic private preview.
- Add a separate local `approve-review` command that binds an operator decision to the exact validated dossier and preview without publishing.
- Define failure categories and stage evidence for a future durable worker.
- Specify a shared multi-generation application model with immutable revisions and collision-safe public identities.
- Specify an operator review dossier and a future shadow agent-review boundary.
- Separate privacy retention from generated-artifact availability and unit economics.

## What does not change

- Stripe `payment_intent.succeeded` at exactly EUR 3900 remains fulfillment authority.
- Webhook signature, idempotency, privacy, and reconciliation boundaries remain unchanged.
- Existing deploy approval and bundle-integrity gates remain in force.
- No provider, production database, deployment, or customer-facing route is changed by the local tracer.

## First acceptance milestone

Given a synthetic intake, `announce prepare-review` produces a deterministic private preview and bounded review dossier, creates no `deploy/` directory or deployable `job.json`, and either uses catalog-backed claims or a claim-free fallback for an original/unknown name. A separate explicit local approval can then prepare an approved page for ordinary render and dry-run-only deploy/delivery verification.
