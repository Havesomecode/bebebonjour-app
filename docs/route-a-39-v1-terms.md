# Route A terms serving — route-a-39-v1

## Contract and source boundary

Serve customer-readable French HTML at `GET /delivery/terms/route-a-39-v1` on the selected Convex site. The route is readable without credentials or enabled paid flags, performs no datastore/provider calls, and accepts no decision or payment. It is an exact version route, not a wildcard or a redirect to a placeholder. HTML must work without JavaScript, with French language, a descriptive title, one main landmark and heading hierarchy, readable responsive text, and noindex/noarchive plus private/no-store and restrictive CSP headers.

The ordinary offer is EUR39 consumer-total, once: free private 24-hour text preview from successful availability notice; French OR Arabic with final narration; two editorial corrections; a fresh 24-hour window after a correction and one manual renewal. Silence/expiry never authorizes approval, payment or publication. Exact-content approval, voluntary payment, terms acceptance, publication permission and human editorial review remain distinct. Delivery is within five working days after approval AND confirmed payment. Hosting lasts twelve months from final delivery, with thirty days' closure notice and final text/audio/page-archive export before closure, no automatic renewal or recurring charge. Customers are adult private mainland-France residents with necessary parental permissions. Support is contact@bebebonjour.com, initial response within two working days, takedown/security reports prioritized.

State statutory rights without invented waiver, mediator agreement, professional clearance or extra discretionary refund promise. A cancellation is not a refund confirmation. Separate controlled promotional tests are at most five voluntary EUR1 payments after EUR38 discount during testing; these are not EUR39 sales and do not change the ordinary price or consent/review requirements. Do not promise general availability of a promotion.

## Settled authority and precedence

- Historical business decision receipt: `/home/hermes/.hermes/ops/bebe-policy-batch-1559074931029966869/owner-decisions-1559078824489132096.json`, Discord thread1559074931029966869/message1559078824489132096, question messages1559077450414161973/1559077454751203369, brief742 SHA256 `f4bbfb57e5086dc6525dc4eb5e978df62dc2c779bf141378d66267269d693caa`. Owner: “1 approve / 2 approve / 3 the support email must be contact@bebebonjour.com the rest is approve / 4 approve / 5 accountant yes, law advisor no, consumer mediation no / The company is HAVESOMECODE siret 879 252 336 00034”. Assent covers the visible numbered defaults, not unpresented clauses. Seller identity is owner supplied, not registry-verified by this change. No legal/accounting opinion or mediation agreement is established.
- Newer authority1037 on release task `t_18eae3ac`, attachment `production-pilot-authority-1560324119004713052.json`, Discord message1560324119004713052: “Oui j'autorise” to the accompanied voluntary EUR39 pilot and up to five controlled promotional tests. Supersedes historical private-preparation-only limits for that scoped production pilot, not all public opening or unrelated effects.
- Authority1038, attachment `promo-amount-authority-1560325095203938517.json`, message1560325095203938517: “ok pour 1€” to EUR38 reduction/EUR1 payable, maximum five tests, distinct from first EUR39 sale. Supersedes only the unresolved discount amount in1037; remaining pilot limits persist.
- Release1065 on `t_18eae3ac`, `release1621-verification.json`: installed signed base `5f9e63928b7489f92b4d5e5e8f2807e4c1edbc7d`, tree `82415b3abe5bbdfb559258f3e8a3639c713f2be2`, selected site `https://tacit-antelope-577.convex.site`. The remaining work includes serving these terms; both paid flags are false. This is a historical installation receipt, not a fresh live readback from this builder.

This task authorizes offline implementation only, not deployment or provider/configuration mutation. Preserve newer authorities1037/1038 for the release owner; do not reinterpret the old receipt's historical `liveSaleApproved:false` as a new blanket stop. Serving terms does not itself enable admission, record customer acceptance, provision support, prove a sale or waive any production acceptance check.

## Authority fingerprints

SHA256 of the exact durable input bytes (not newly inferred approval):

- Owner decision receipt: `fbbf20aac0212906352e96305f85113ccdba50c84b5066eba6fe902311a13b82`.
- Authority1037: `0e2e3ce88c39f65d989f49f566b1d363659bf9dc7caffdb7ed1a0ea1ae4be327`.
- Authority1038: `a614eeb04d0ea69c6e4cbb13d2833e80a62585c15a489927789b7e11c82ecfcb`.
- Release1065: `7f67a7aa3ba3a32a722e5f0e8f29cdd52190112b7f40a70e87e6121a1aa80f98`.

## Verification and installation

Run `node --test test/convex/delivery-loop-terms.test.mjs test/convex/installation-compatibility.test.mjs` under Node22, then repository `npm run verify` and `node ops/bundle-installation-offline.cjs . OUTPUT_JSON`. Tests must traverse the real router, verify the exact text/version/security/no-script properties, reject other version/method paths, and retain disabled paid routes plus unauthenticated owner-artifact denial. Existing compatibility tests preserve validators, financial/effect fences, worker schema and the full old route inventory with only the new GET appended.

No change to the worker, settlement, journals, schema, lockfile or either paid flag. Release consumes the exact independently reviewed successor, installs only under its own authority, then reads back the real GET and sets `BEBEBONJOUR_PAID_TERMS_URL=https://tacit-antelope-577.convex.site/delivery/terms/route-a-39-v1` before any separately authorized admission. This source work does not set it or claim it is deployed.
