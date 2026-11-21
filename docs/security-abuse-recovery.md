# Security, abuse and recovery

The Railway backend validates function arguments (`src/backend/functions.mjs`) and limits function API bodies to 8 MiB (`src/backend/http.mjs`). Delivery intake and payment webhook have their own checks and limits in `src/backend/deliveryLoopHttp.js` and `src/delivery-loop/paid-event.mjs`. Operator, editorial and worker credentials are separate capabilities; keep them private. Never put customer data, private URLs, tokens or raw provider responses in logs or source control.

Public access controls, rate limits and provider protections do not establish an unlimited abuse or spending guarantee. Review the actual deployment, provider controls and alerts under separate authorization. Local synthetic tests are not a production security audit.

PostgreSQL holds documents, stored audio and scheduled work. Record and verify the real backup scope, encryption, retention and restore procedure separately; application deletion does not prove erasure from backups or third-party copies. Before any authorized restoration, prevent customer/provider effects, preserve and reapply deletion and revocation evidence, and verify the restored state before exposure. Do not repeat uncertain email, narration or payment effects without genuine reconciliation; cancellation is not a refund.
