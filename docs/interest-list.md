# Interest list (bebebonjour.com)

Visitors leave an email on the landing (`#liste`) to hear about news. Double opt-in, one table, no new service.

- Routes (served by `api`, proxied by the landing's Vercel rewrites on the same domain): `POST /interest/subscribe` (JSON `{email, consent:true, website:"", source:"landing"}`), `GET|POST /interest/confirm?t=`, `GET|POST /interest/unsubscribe?t=`, `GET /interest/stats` and `POST /interest/erase` (both `Authorization: Bearer $BEBEBONJOUR_OPERATIONS_TOKEN`).
- Mail links open a page with a button; only the POST confirms or unsubscribes, so mail scanners cannot do it.
- Table `interest_list` (created at startup): email, status (`pending|confirmed|unsubscribed`), consent text and version, timestamps, source, tokens. An unconfirmed address is deleted after 7 days. Nothing else is stored (no IP, no user agent).
- Limits: honeypot field `website`, 5 requests per IP per hour (in memory), 300 new addresses per hour overall, one confirmation mail per address per hour.
- Weekly measure: `GET /interest/stats` returns confirmed total and per-week (Monday, Europe/Paris) requests, confirmations and unsubscriptions; `.test` and `.invalid` addresses are excluded.
- Erase on request: `POST /interest/erase {"email":…}` with the operations token.
- Texts and schema: `~/Documents/marketing/listes-interet/` (SCHEMA.md, bebebonjour.md). Sending the news itself is not built; export confirmed addresses from the table when needed.
