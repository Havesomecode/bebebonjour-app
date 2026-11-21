# Route A terms serving — route-a-39-v2

## Contract and source boundary

Serve customer-readable French HTML at `GET /delivery/terms/route-a-39-v2` on the Railway backend. The route is readable without credentials or enabled paid flags, performs no datastore/provider calls, and accepts no decision or payment. It is an exact version route, not a wildcard or a redirect to a placeholder. HTML must work without JavaScript, with French language, a descriptive title, one main landmark and heading hierarchy, readable responsive text, and noindex/noarchive plus private/no-store and restrictive CSP headers.

The ordinary offer is EUR39 consumer-total, once: Bébé Bonjour reads each request before creating anything; if accepted, the customer receives a payment link, and creation starts after confirmed payment (no free preview, owner decision 18/11/2026). French OR Arabic with narration; two corrections; the customer approves the final version. Terms acceptance and publication permission are recorded at the request. Delivery is within five working days after confirmed payment. Hosting lasts twelve months from final delivery, with thirty days' closure notice and final text/audio/page-archive export before closure, no automatic renewal or recurring charge. Customers are adult private mainland-France residents with necessary parental permissions. Support is contact@bebebonjour.com, initial response within two working days, takedown/security reports prioritized.

State statutory rights without invented waiver, mediator agreement, professional clearance or extra discretionary refund promise. A cancellation is not a refund confirmation. Separate controlled promotional tests are at most five voluntary EUR1 payments after EUR38 discount during testing; these are not EUR39 sales and do not change the ordinary price or flow. Do not promise general availability of a promotion.

## Verification

The implementation is `src/backend/deliveryLoopTerms.js`. Run `node --test test/backend/delivery-loop-terms.test.mjs`. Serving terms does not enable paid admission or prove a sale. An authorized operator must verify the deployed route and `BEBEBONJOUR_PAID_TERMS_URL` separately.
