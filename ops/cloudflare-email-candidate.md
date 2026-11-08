# Bébé Bonjour — Cloudflare Email candidate

Status: offline preparation only, 8 November 2026. Task `t_7b9d9059`, consumer `personal-projects/t_3073d2ce`. Base `caa06ca6be0a8fd86600a79808ca2a90c0fe7ea5`. Nothing in this candidate changes the selected production provider. No DNS, new credential, provider call, deployment, real message or customer-data transfer is permitted by this task.

## Actual call paths and source boundary

1. At the base, `production-completion-worker.mjs` validates Resend-only TEST-A configuration, then `test-a-completion-capabilities.mjs` creates `createResendDeliveryAdapter`. `external-effect-stage-handlers.mjs` binds job/revision/manifest/recipient digest and calls `reconcile`, `send`, then `status`. The job orchestrator persists `effectStartedAt` before issuing the callback. An interrupted effect can only reconcile; it cannot resend. `sent` is acceptance, not inbox receipt.
2. The private-operations-interface worktree has the same Resend adapter bytes as the base, but other uncommitted orchestration changes. Leave those changes alone.
3. The canonical checkout is newer and dirty. Its adapter additionally exports `createResendConfiguredTestDeliveryAdapter` for one exact fictional job/recipient; its separate owner adapter restricts delivery to the owner. Neither is a general customer adapter.
4. The canonical checkout also has an uncommitted `convex/deliveryLoopProviders.js` -> `src/delivery-loop/provider-transport.mjs` / `delivery-loop-provider/api/provider.mjs` path. This sends draft/corrected/final messages using `bebe-loop:job_*:<revision>:<stage>` keys. The generic transport in this candidate accepts that existing message shape (subject, text, HTML, recipient, key), without reconstructing its reader-facing copy. Those newer sources are not silently copied into this older baseline.
5. `customer-flow/service.mjs` records payment-link/delivery events; it does not itself call Resend. Historical docs mentioning payment-link email do not establish a separate active send. Existing TEST-A sinks, credentials, deployment manifests and Resend dependencies remain unchanged for rollback.

## Candidate design

- Add an opt-in Cloudflare REST transport plus a fulfillment adapter using the **existing** external-effect adapter seam and durable orchestration; do not replace or weaken the approved TEST-A Resend adapter. One recipient only, no CC/BCC/attachments. Sender fixed to `Bébé Bonjour <bonjour@updates.bebebonjour.com>`, reply-to fixed to `contact@bebebonjour.com`.
- Require an explicit `provider: cloudflare` configuration and `enabled: true` before constructing a sending transport. The checked-in configuration is disabled and contains only invalid placeholders. Account/zone IDs are validated without normalization. Secrets are injected by the runtime; no new token is created here.
- Never assume a provider idempotency header exists. Preserve the application key in receipts and an `X-Bebe-Operation` header, but that header is correlation, **not** deduplication. A persisted mutation fence is mandatory before POST. No automatic HTTP retries or fallback to Resend. An uncertain response is a non-retryable reconciliation requirement. Existing orchestration prevents resending after a started effect, including after restart.
- Validate REST `success`, numeric HTTP result, exact recipient partition and a real `result.message_id`. Refuse responses missing the ID; do not manufacture an ID from the application key. The narrative REST docs omit this field but the API schema includes it. This discrepancy must be checked on the authorized pilot. A permanent bounce/suppression is never success.
- Status uses the documented zone-level `emailSendingAdaptive` GraphQL dataset, selects only ID/status/time (no subject, addresses or body), and matches the exact message ID. The query covers the last 24 hours, up to 50 events; absent, truncated, malformed or unknown results remain unavailable, never delivered. No status operation sends mail. `sent` is pending; `delivered` means recipient-server delivery only; `deliveryFailed`, `rejected`, `failed` are terminal failures. Conflicting latest events fail closed. Analytics needs a separately supplied Analytics Read token. This bounded reader is suitable for pilot qualification, not an unbounded high-volume reconciliation service.

## Non-secret configuration

`ops/cloudflare-email.example.json` is the executable input shape. Use `readCloudflareEmailConfiguration(config, environment)` and `createCloudflareEmailTransport(...)`, or `createCloudflareDeliveryAdapter(...)` for the fulfillment seam. API credentials are looked up only by `BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN` and `BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN`; no generic Cloudflare admin token or Resend fallback is read. The transport uses only fixed Cloudflare HTTPS hosts, rejects redirects, and bounds send and status requests at 30 seconds.

The fulfillment adapter additionally requires an exact test-job policy (`jobId`, `revisionId`, `artifactManifestDigest`, `targetRef`, `recipient`, `stableUrl`) and refuses production jobs. The generic transport preserves the actual delivery-loop payload. Its caller must keep the durable single-effect/reconciliation boundary; do not expose it as an unauthenticated HTTP send endpoint or invoke it directly from the browser.

After the separate activation authority, the fulfillment composition point is:

```js
import { createCloudflareDeliveryAdapter } from "../src/fulfillment/cloudflare-delivery-adapter.mjs";
const deliveryAdapter = createCloudflareDeliveryAdapter({
  config: approvedConfiguration, // explicit enabled=true, exact IDs and fixed sender/reply-to
  environment: injectedEnvironment, // scoped sending and analytics tokens; never log this object
  policy: exactSyntheticJobPolicy,
});
// Supply deliveryAdapter to createExternalEffectStageHandlers alongside the
// existing publication adapter and canonical resolveDeliveryTarget callback.
```

The configuration validator itself performs no network request. The example remains deliberately non-activatable. Tests demonstrate the complete composition with the local durable store. The production composition is not changed here.

## Activation and rollback — separate authority

1. Reconcile the signed candidate onto the exact newer production source in a new assigned integration lane. Preserve the delivery-loop subject/text/HTML. Bind its provider call to a durable **one-shot** lease fence. Its current `fence` mutation records a start but permits repeat calls for the same lease; Cloudflare does not promise Resend's idempotency retention. Reject a repeated started effect atomically before the provider call. Qualify duplicate concurrent invocations and crash recovery on the integrated runtime before activation. Preserve old provider identity per receipt: inspect historical Resend IDs with Resend, never Cloudflare, and never resend an uncertain old message through the new provider.
2. Obtain authority for the exact sending-domain DNS changes and new scoped secrets. Workers Paid is already confirmed by the parent; no new purchase is needed or authorized here. Review provider-generated SPF/DKIM and cf-bounce MX records for `updates.bebebonjour.com`; do not invent record values. Preserve the principal MX records and `contact@bebebonjour.com` -> `z@havesomecode.io` route. No inbound Routing/Resend route change is included. Configure reply-to without changing forwarding. Newly onboarded domains enable Email preview by default, retaining message content for about seven days: explicitly qualify/disable this setting under the activation authority before any private content is transferred.
3. After distinct deployment/data/send authorization, qualify one disposable recipient: real `message_id`, acceptance vs GraphQL status, receipt binding, timeout ambiguity, duplicate prevention and bounce/suppression. Cloudflare IDs are treated as opaque printable identifiers (including RFC-style `<...@...>`); the newer Resend-only inspection endpoint's alphanumeric-ID regex must not be reused for them. Capture SPF/DKIM/DMARC and actual inbox reception separately. Check Analytics Read entitlement/schema and the bounded lookup on this account. A synthetic response is not evidence of provider acceptance or inbox delivery.
4. Keep active Resend configuration and credentials available throughout qualification. Roll back selection for **new, unstarted** operations only. Preserve existing Cloudflare message IDs, started attempts and reconciliation evidence. Do not auto-fallback after any POST starts, delete records, change principal MX, or cancel Resend here.

## Offline verification

Run with Node 22 and no real provider credentials:

```sh
node --test test/fulfillment/cloudflare-email-transport.test.mjs test/fulfillment/cloudflare-delivery-adapter.test.mjs
npm test
npm run build
npm run test:integration
npm run test:vercel-routing
npm run test:production-audit
npm audit --omit=dev
```

Transport tests use synthetic HTTP responses; orchestration tests use a real file-backed local fulfillment store and reopen it after an uncertain effect. These checks do not create a Cloudflare domain/token/message. Final execution results and exact source identity are recorded in the attached handoff, not inferred from this command list.

## Primary contracts checked on 8 November 2026

- REST guide: https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
- REST schema including `message_id`: https://developers.cloudflare.com/api/resources/email_sending/methods/send/
- REST types (`address`, `reply_to`, `message_id`): https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/email-sending/email-sending.ts
- Request addressing and reply-to: https://developers.cloudflare.com/email-service/examples/email-sending/recipients/
- Allowed correlation headers: https://developers.cloudflare.com/email-service/reference/headers/
- Zone-level events and Analytics Read: https://developers.cloudflare.com/email-service/observability/metrics-analytics/
- Status meanings: https://developers.cloudflare.com/email-service/observability/logs/
- Sending-domain onboarding / cf-bounce: https://developers.cloudflare.com/email-service/get-started/send-emails/

These references define the candidate contract, not evidence that this account has been configured or the API exercised.
