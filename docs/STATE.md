# Bébé Bonjour — state of play (2026-11-19)

Repos: `bebebonjour-app` (this one: Convex backend + workers), `bebebonjour-landing` (Vite site), `bebebonjour-ops` (private Next.js console).

## 1. Goal

A parent asks for a French or Arabic digital birth announcement (optional Cedar narration). An operator reads the request and launches generation from a short brief; public orders pay €39 first. The announcement is published at a private link and emailed, then corrected and approved by the parent.

## 2. What works today

- **Landing** https://www.bebebonjour.com (19/11) — sells the €39 announcement around a real example: the hero plays the Amal announcement in one click (Codex text + Cedar voice from the 5 Oct production run) and links its static, non-indexed copy https://www.bebebonjour.com/exemple/amal/. It states the price, what you receive (page, text, voice, 2 corrections, 12 months online) and the flow *describe → we read your request → you pay → your announcement arrives*. `/delivery` now follows that flow (19/11). The `/demo` pages stay online, unlinked.
- **Order path (19/11)**: "Créer mon faire-part" → `/delivery` (proxied by the landing's Vercel rewrites to `https://tacit-antelope-577.convex.site`) → paid form "Envoyer ma demande" (no card asked at submit). A hidden "J’ai un mot de passe offert" form keeps the free offer; it also waits for the operator.
- **Operator gate (live in prod since 19/11, app `22fb776`, ops `513dd1a`)**: requests wait in `awaiting_operator`; the owner gets an email at `BEBEBONJOUR_OPERATOR_EMAIL` with a link to `/commandes/<jobId>` in the ops console (`BEBEBONJOUR_OPS_CONSOLE_URL=https://bebebonjour-ops.vercel.app`), edits the brief (first name, Arabic name, gender, date, faith context, tone, up to 3 phrases) and launches or refuses. Paid: launch → customer email with the payment link → Stripe settlement → generation. Codex receives only the brief. Spec: `docs/operator-gated-intake.md`. Checked in prod 19/11: a real request waited, the owner email and the payment-link email were sent, the live €39 Checkout opened, and no generation was claimed while payment was pending.
- **Paid €39 route**: `BEBEBONJOUR_PAID_ROUTE_A_ENABLED=true` again since 19/11 (was off 18/11 until the operator gate shipped). Terms `route-a-39-v2`. Live webhook `we_1UdEfEGrir6mz3o7Gwbqmkqm` → `https://www.bebebonjour.com/delivery/payment/webhook` (`payment_intent.succeeded`). No real card payment yet.
- `bebebonjour-ops` main: private operations console; `/commandes` lists delivery-loop orders and `/commandes/<jobId>` launches or refuses (`BEBEBONJOUR_OPS_ENABLED_ACTIONS` includes `launch_generation,refuse_request`).

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
