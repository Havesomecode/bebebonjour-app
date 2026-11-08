# Delivery-loop Cloudflare candidate

The current signed support baseline already tracks the delivery-loop implementation, including paid controls and the separate closure-notice fence. The older untracked files in the canonical checkout must not overwrite it. Support forwarding, existing MX and historical Resend receipts remain unchanged.

Outgoing Cloudflare email must use atomic one-shot admission before transport, retain the selected provider with each effect and receipt, and never retry or fall back after an uncertain send. Closure notices use their own existing notice fence. Inspection must select the provider recorded on the receipt; legacy untagged receipts remain Resend. Cloudflare IDs are opaque and must not be normalized. A receipt does not prove inbox delivery.

Cloudflare uses `bonjour@mail.havesomecode.io` with the existing support reply-to. Runtime account and zone IDs and separately scoped sending and analytics credentials are required; the provider selector defaults to Resend.

This document describes a candidate, not an activation. Deployment requires an independent review of the exact candidate, verification of the currently deployed source, configured credentials and sending-domain privacy settings, and reconciliation of uncertain effects before any new send. No support inbound, backend migration, DNS, or customer data change is implied.
