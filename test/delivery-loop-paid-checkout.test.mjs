import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaidCheckoutSession } from '../src/delivery-loop/paid-checkout.mjs';

test('checkout binds the exact scope, price and idempotency key and validates provider URL', async () => {
  // The provider's historical preview_digest field now binds the launched brief.
  const scope = { jobId:'job_offline', revision:1, previewDigest:'a'.repeat(64), email:'fictional@example.invalid', attempt:3, expiresAtSec:2000000000, reviewUrl:'https://offline.example.invalid/delivery/review?jobId=job_offline&token=fake' };
  let captured;
  const stripe = { checkout:{ sessions:{ create: async (...args) => { captured=args; return { id:'cs_offline', url:'https://checkout.stripe.com/c/pay/offline', expires_at:scope.expiresAtSec }; } } } };
  await createPaidCheckoutSession({stripe,scope});
  const [params,options]=captured;
  const metadata={project:'bebebonjour',order_mode:'paid_route_a',job_id:scope.jobId,revision:'1',preview_digest:scope.previewDigest};
  assert.deepEqual(params.metadata,metadata); assert.deepEqual(params.payment_intent_data.metadata,metadata);
  assert.equal(params.line_items[0].price_data.unit_amount,3900); assert.equal(params.line_items[0].price_data.currency,'eur');
  assert.equal(params.expires_at,scope.expiresAtSec); assert.equal(options.idempotencyKey,'bebe-checkout:job_offline:1:3');
  assert.match(params.success_url,/paiement=retour/); assert.match(params.cancel_url,/paiement=annule/);
  stripe.checkout.sessions.create=async()=>({id:'cs_offline',url:'https://checkout.stripe.com.attacker.invalid/',expires_at:scope.expiresAtSec});
  await assert.rejects(createPaidCheckoutSession({stripe,scope}),/checkout_unavailable/);
});
