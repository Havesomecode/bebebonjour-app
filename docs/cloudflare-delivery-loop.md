# Delivery-loop Cloudflare email

The delivery loop sends announcement messages and closure notices through Cloudflare Email. Each effect is admitted once before transport, and an uncertain send is held for reconciliation rather than repeated. The persisted application key is a correlation value, not provider-side idempotency.

Receipts record Cloudflare message IDs without normalizing them. Untagged historical receipts and admissions remain unidentified and cannot be inspected using the Cloudflare adapter. Provider acceptance does not prove inbox delivery. Cloudflare status inspection remains unavailable because adaptive analytics can be sampled; retain the receipt and do not send again because status is unavailable.

Cloudflare sends from `bonjour@mail.havesomecode.io` with the existing support reply-to. The account ID, zone ID and sending credential are required. No analytics credential is required while status inspection is unavailable. The provider selector defaults to Cloudflare and rejects other values.

Source changes do not activate a deployment. Review the exact candidate, deployed source, credentials and sending-domain settings, and reconcile uncertain effects before any separately authorized live operation.
