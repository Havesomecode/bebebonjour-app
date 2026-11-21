# Paid payment event contract

`POST /delivery/payment/webhook` is implemented by `src/backend/deliveryLoopPaymentHttp.js` at the Railway backend. It accepts signed `payment_intent.succeeded` events, verifies bounded raw bytes and inspects the configured Stripe account and payment before recording evidence. The event and payment ledgers bind the job, revision and brief digest and prevent duplicate effects. See `src/backend/deliveryLoopPaymentEvents.js`, `src/delivery-loop/paid-event.mjs` and [the paid runbook](paid-route-a-runbook.md).

A signature or browser assertion alone is not settlement evidence. Test-mode evidence does not authorize live generation. Refunds and provider configuration are separately authorized operations; never repeat an uncertain effect merely because an event is redelivered. Offline tests do not prove a real payment or webhook configuration.
