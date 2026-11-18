# Bébé Bonjour — state of play (2026-11-18)

Repos: `bebebonjour-app` (this one: Convex backend + workers), `bebebonjour-landing` (Vite site), `bebebonjour-ops` (private Next.js console).

## 1. Goal

A parent creates a French or Arabic digital birth announcement (optional Cedar narration) in a few minutes; it is composed, published at a private link and emailed automatically, then corrected and approved by the parent. Paid offer: €39, one-time.

## 2. What works today

- **Landing** https://www.bebebonjour.com — offer "Essentiel 39 €", demo https://www.bebebonjour.com/demo/announcements/bayane/fr/ (live, HTTP 200).
- **Order path today = free only**: "Créer mon faire-part" → `/delivery` (307 to `https://tacit-antelope-577.convex.site/delivery`) → form with consent and an *offer password* → payment waived. No card is asked anywhere.
- **Loop behind it** (Convex + `bebebonjour-delivery-loop.service`, running since 9 Nov): Codex composes, OpenAI Cedar narrates, the announcement is published at an unguessable link, the first version is emailed *before* human review; correction request → republished at the same link; approval → final email. Verified 5 Oct on a fictional family up to provider send acceptance (not inbox delivery). Source of this loop: `DELIVERY_LOOP.md`.
- **Paid €39 route (Stripe, signed webhooks)**: coded and tested offline, disabled by default (`docs/paid-route-a-current-delivery.md`). Whether it is switched on in production was not checked here: payments untouched.
- `bebebonjour-ops` main: private operations console with narration and owner-completion controls (builds, 37 tests pass). Not checked against the delivery loop.

## 3. To make the product viable (ordered, one session each)

1. **Prove a real inbox receives the mails** (Sonnet): send first/correction/final mails to an address we control through the live mail path; read delivered/bounce status back. Today only "provider accepted" is known.
2. **Serve `/delivery` on bebebonjour.com itself** (Sonnet): replace the 307 to `*.convex.site` with a same-domain route so the form, review links and mails carry the brand. Update the landing CSP accordingly.
3. **Turn on paying customers** (Opus): enable Route A (Stripe Checkout €39 → webhook → paid gate before final narration/publication/mail) in test mode end to end, then live. Needs Zacaria's go for live keys (see §5).
4. **Replace the offer password with real signup** (Sonnet): free path stays for invited families only; public visitors get the paid path; clear states for pending payment, expiry, failure, support contact.
5. **Operations view of delivery-loop jobs** (Sonnet): list jobs, status, revision links, retry a failed correction (`deliveryLoop:retryCorrection`) from `bebebonjour-ops`.
6. **First 5 real families** (Haiku drafts, Zacaria sends): invitation text and a feedback question; collect what breaks.

## 4. What we drop

- TEST-A / TEST-B frozen exact-source audits and their build hooks are retired; they do not establish customer delivery.
- Exact-source reviews, "witness", parity and evidence-bundle cards; owner publication runbooks scoped to old jobs.
- The older **owner-trial line** (operator-assisted publication, narration worker, `vercel.owner-trial-*`): not merged. Kept at tag `archive/2026-11-18/main-pre-live-integration` (it conflicts with the live line in 6 files). Reopen only if operator-assisted publication is wanted again.
- The Tally→Stripe checkout handoff WIP (tag `archive/2026-11-18/resume-bebe-private-trial-current`): superseded by the first-party `/delivery` flow.
- Mail (18/11): all sending goes through Cloudflare Email from `bonjour@mail.havesomecode.io`; the Resend code, dependency and inbound webhook are removed and deployed to Convex `tacit-antelope-577`. The `bebebonjour.com` zone is on Cloudflare (Gandi stays registrar); `contact@bebebonjour.com` is forwarded to the owner by Cloudflare Email Routing (`docs/support-email-routing.md`).

## 5. Real blockers (need Zacaria)

- **GitHub push protection** rejects any history containing commit `f64d2f8` (fake `rk_live_…` key in a test fixture). 7 archive tags that contain it stay local (`git tag -l 'archive/2026-11-18/*'`, backed up in a bundle). Question: allow that one alert on the GitHub repo, or leave them local?
- Live Stripe key and go-live decision for item 3: do you want paying customers now, or after items 1–2?

## Git map

`main` = live delivery-loop line (production worker runs af0d277 + `bebebonjour-delivery-loop` runtime) squashed onto `origin/main`. Every other branch is a tag `archive/2026-11-18/<branch>`.
