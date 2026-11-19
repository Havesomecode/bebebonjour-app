# Bébé Bonjour — state of play (2026-11-18)

Repos: `bebebonjour-app` (this one: Convex backend + workers), `bebebonjour-landing` (Vite site), `bebebonjour-ops` (private Next.js console).

## 1. Goal

A parent creates a French or Arabic digital birth announcement (optional Cedar narration) in a few minutes; it is composed, published at a private link and emailed automatically, then corrected and approved by the parent. Paid offer: €39, one-time.

## 2. What works today

- **Landing** https://www.bebebonjour.com (19/11) — sells the €39 announcement around a real example: the hero plays the Amal announcement in one click (Codex text + Cedar voice from the 5 Oct production run) and links its static, non-indexed copy https://www.bebebonjour.com/exemple/amal/. It states the price, what you receive (page, text, voice, 2 corrections, 12 months online) and the flow *describe → we read your request → you pay → your announcement arrives*. That flow is the target of the operator-gated intake (card t_4ef53f3c); until it ships, `/delivery` still shows the older form. The `/demo` pages stay online, unlinked.
- **Order path today = free only**: "Créer mon faire-part" → `/delivery` (proxied by the landing's Vercel rewrites to `https://tacit-antelope-577.convex.site`, same domain since 18/11) → form with consent and an *offer password* → payment waived. No card is asked anywhere.
- **Loop behind it** (Convex + `bebebonjour-delivery-loop.service`, running since 9 Nov): Codex composes, OpenAI Cedar narrates, the announcement is published at an unguessable link, the first version is emailed *before* human review; correction request → republished at the same link; approval → final email. Verified 5 Oct on a fictional family up to provider send acceptance (not inbox delivery). Source of this loop: `DELIVERY_LOOP.md`.
- **Paid €39 route (Stripe Checkout, signed webhooks) — LIVE since 18/11**: merged (fda6e48, payments review PASS), deployed to Convex prod `tacit-antelope-577`, `BEBEBONJOUR_PAID_ROUTE_A_ENABLED=true`. `https://www.bebebonjour.com/delivery` offers the €39 paid preview path (offer-password path kept behind "J’ai un mot de passe offert"). Verified in production: intake → preview → approval → terms → "Payer 39 € par carte" opens a **live** Stripe Checkout (`cs_live_…`, 39,00 €, EUR); session expired unpaid. Live webhook `we_1UdEfEGrir6mz3o7Gwbqmkqm` → `https://www.bebebonjour.com/delivery/payment/webhook` (`payment_intent.succeeded`), signing secret in Convex `BEBEBONJOUR_PAID_STRIPE_WEBHOOK_SECRET`; older `we_1UQuJ6…` (convex.site, unknown secret) disabled. **No real card payment has been made yet**, so webhook reconciliation of a live payment is untested.
- `bebebonjour-ops` main: private operations console with narration and owner-completion controls (builds, 37 tests pass). Not checked against the delivery loop.

## 3. To make the product viable (ordered, one session each)

1. **Prove a real inbox receives the mails** (Sonnet): send first/correction/final mails to an address we control through the live mail path; read delivered/bounce status back. Today only "provider accepted" is known.
2. ~~**Serve `/delivery` on bebebonjour.com itself**~~ DONE 18/11 (`BEBEBONJOUR_DELIVERY_LOOP_ORIGIN=https://www.bebebonjour.com` on Convex prod; POST accepts that origin; landing proxies `/delivery/*` and `/announcements/*`): replace the 307 to `*.convex.site` with a same-domain route so the form, review links and mails carry the brand. Update the landing CSP accordingly.
3. **Turn on paying customers** (Opus): enable Route A (Stripe Checkout €39 → webhook → paid gate before final narration/publication/mail) in test mode end to end, then live. Needs Zacaria's go for live keys (see §5).
4. **Replace the offer password with real signup** (Sonnet): free path stays for invited families only; public visitors get the paid path; clear states for pending payment, expiry, failure, support contact.
5. ~~**Operations view of delivery-loop jobs**~~ DONE 18/11: `bebebonjour-ops` page `/commandes` lists jobs newest first (family, status, revisions, public link, last error) and retries a failed correction. It calls the operator-token functions `deliveryLoop:operatorJobs` and `deliveryLoop:operatorRetryCorrection` (the console never holds the worker token; `retryCorrection` stays worker-only). The retry button needs `retry_correction` in `BEBEBONJOUR_OPS_ENABLED_ACTIONS` on the ops project. The public page serves only the latest revision, so there is one link per job, not one per revision.
6. **First 5 real families** (Haiku drafts, Zacaria sends): invitation text and a feedback question; collect what breaks.

## 4. What we drop

- TEST-A / TEST-B frozen exact-source audits and their build hooks are retired; they do not establish customer delivery.
- Exact-source reviews, "witness", parity and evidence-bundle cards; owner publication runbooks scoped to old jobs.
- The older **owner-trial line** (operator-assisted publication, narration worker, `vercel.owner-trial-*`): not merged. Kept at tag `archive/2026-11-18/main-pre-live-integration` (it conflicts with the live line in 6 files). Reopen only if operator-assisted publication is wanted again.
- The Tally→Stripe checkout handoff WIP (tag `archive/2026-11-18/resume-bebe-private-trial-current`): superseded by the first-party `/delivery` flow.
- Mail (18/11): all sending goes through Cloudflare Email from `bonjour@mail.havesomecode.io`; the Resend code, dependency and inbound webhook are removed and deployed to Convex `tacit-antelope-577`. The `bebebonjour.com` zone is on Cloudflare (Gandi stays registrar); `contact@bebebonjour.com` is forwarded to the owner by Cloudflare Email Routing (`docs/support-email-routing.md`).

## 5. Real blockers (need Zacaria)

- **GitHub push protection** rejects any history containing commit `f64d2f8` (fake `rk_live_…` key in a test fixture). 7 archive tags that contain it stay local (`git tag -l 'archive/2026-11-18/*'`, backed up in a bundle). Question: allow that one alert on the GitHub repo, or leave them local?
- Stripe live: DONE 18/11 (Checkout Sessions: Write enabled, live webhook created). Zacaria can now remove `Webhook Endpoints: Write` from `rk_live_…AGnm`. Open: first real €39 payment (Zacaria's own card or first family) to prove webhook reconciliation.

## Git map

`main` = live delivery-loop line (production worker runs af0d277 + `bebebonjour-delivery-loop` runtime) squashed onto `origin/main`. Every other branch is a tag `archive/2026-11-18/<branch>`.
