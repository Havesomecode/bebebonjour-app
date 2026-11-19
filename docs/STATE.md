# Bébé Bonjour — state of play (2026-11-19)

Repos: `bebebonjour-app` (this one: Convex backend + workers), `bebebonjour-landing` (Vite site), `bebebonjour-ops` (private Next.js console).

## 1. Goal

A parent asks for a French or Arabic digital birth announcement (optional Cedar narration). An operator reads the request and launches generation from a short brief; public orders pay €39 first. The announcement is published at a private link and emailed, then corrected and approved by the parent.

## 2. What works today

- **Landing** https://www.bebebonjour.com — offer "Essentiel 39 €", demo https://www.bebebonjour.com/demo/announcements/bayane/fr/ (live, HTTP 200).
- **Order path today = free only**: "Créer mon faire-part" → `/delivery` (proxied by the landing's Vercel rewrites to `https://tacit-antelope-577.convex.site`, same domain since 18/11) → form with consent and an *offer password* → payment waived. No card is asked anywhere.
- **Operator gate (branch `wt/operator-gated-intake`, not deployed yet)**: requests wait in `awaiting_operator`; the owner gets an email with a link to `/commandes/<jobId>` in the ops console, edits the brief (first name, Arabic name, gender, date, faith context, tone, up to 3 phrases) and launches or refuses. Paid: launch → customer email with the payment link → Stripe settlement → generation. Codex receives only the brief. Spec: `docs/operator-gated-intake.md`.
- **Paid €39 route**: `BEBEBONJOUR_PAID_ROUTE_A_ENABLED=false` on Convex prod since 18/11 (owner decision: someone could consume the Codex subscription without paying). Turned back on after the operator gate is deployed. Live webhook `we_1UdEfEGrir6mz3o7Gwbqmkqm` → `https://www.bebebonjour.com/delivery/payment/webhook` (`payment_intent.succeeded`). No real card payment yet.
- `bebebonjour-ops` main: private operations console with narration and owner-completion controls (builds, 37 tests pass). Not checked against the delivery loop.

## 3. To make the product viable (ordered, one session each)

1. **Prove a real inbox receives the mails** (Sonnet): send first/correction/final mails to an address we control through the live mail path; read delivered/bounce status back. Today only "provider accepted" is known.
2. ~~**Serve `/delivery` on bebebonjour.com itself**~~ DONE 18/11 (`BEBEBONJOUR_DELIVERY_LOOP_ORIGIN=https://www.bebebonjour.com` on Convex prod; POST accepts that origin; landing proxies `/delivery/*` and `/announcements/*`): replace the 307 to `*.convex.site` with a same-domain route so the form, review links and mails carry the brand. Update the landing CSP accordingly.
3. **Turn on paying customers** (Opus): enable Route A (Stripe Checkout €39 → webhook → paid gate before final narration/publication/mail) in test mode end to end, then live. Needs Zacaria's go for live keys (see §5).
4. **Replace the offer password with real signup** (Sonnet): free path stays for invited families only; public visitors get the paid path; clear states for pending payment, expiry, failure, support contact.
5. ~~**Operations view of delivery-loop jobs**~~ DONE: `bebebonjour-ops` `/commandes` lists jobs; `/commandes/<jobId>` shows the raw request and the brief editor with Launch/Refuse (`deliveryLoop:operatorJobs|operatorJob|operatorLaunch|operatorRefuse`, operator token only). Buttons need `launch_generation` / `refuse_request` in `BEBEBONJOUR_OPS_ENABLED_ACTIONS`.
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
