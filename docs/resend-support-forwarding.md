# Retired Resend support webhook

The accepted support route is the external Cloudflare forward `contact@bebebonjour.com` → `z@havesomecode.io`. This source change neither inspects nor modifies its current provider configuration, DNS or routing.

The starting report (`personal-projects/t_d48dcdb6`, attachment 1611, `rapport.md`) records historical evidence of the previous Resend forwarding implementation and the separately accepted Cloudflare transfer. It does not establish the current value of `BEBEBONJOUR_SUPPORT_FORWARD_ENABLED` or whether the historical webhook is still receiving events.

## Source behavior

`POST /support/resend/webhook` now always returns HTTP 410 with `status: retired`, private/no-store/noindex headers and no request-body processing. It never verifies, fetches, persists or forwards incoming messages. Old flags, webhook secrets, Resend credentials and destination overrides cannot reactivate it. A direct/previously queued invocation of `supportForwardProvider:receive` also refuses with `support_forward_retired` before any database or provider action. A 410 is a refusal, not successful forwarding; do not acknowledge retired traffic as delivered.

The support receipt table, indexes and identifier-only reconciliation mutations remain intact. Historical `sent`, `ignored`, `inflight` and `reconciliation_required` rows are not migrated, erased, relabelled or replayed. Reconciliation of uncertain old effects remains an operator task under separate authority; never delete a fence to enable a retry.

No new Cloudflare webhook, proxy, Vercel relay or second forwarding service is introduced. Resend forwarding/MIME/signature code and its obsolete tests are replaced by behavioral retirement tests. The SDK dependency remains for unrelated legacy fulfillment paths, not this support endpoint.

## Release boundary

This is a source candidate, not a live shutdown receipt. Independent review and a separately authorized scoped release are required. Do not change provider subscriptions, DNS, secrets or flags to manufacture evidence. If a future operator observes traffic at the retired endpoint, reconcile its origin and the accepted Cloudflare route rather than silently re-enabling Resend forwarding. Source rollback must not reopen uncertain support sends.
