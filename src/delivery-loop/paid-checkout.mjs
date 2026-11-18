export async function createPaidCheckoutSession({ stripe, scope }) {
  const metadata = { project: 'bebebonjour', order_mode: 'paid_route_a', job_id: scope.jobId, revision: String(scope.revision), preview_digest: scope.previewDigest };
  const review = new URL(scope.reviewUrl);
  const success = new URL(review); success.searchParams.set('paiement', 'retour');
  const cancel = new URL(review); cancel.searchParams.set('paiement', 'annule');
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', locale: 'fr',
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 3900, product_data: { name: 'Faire-part de naissance Bébé Bonjour' } } }],
    customer_email: scope.email, client_reference_id: scope.jobId, metadata, payment_intent_data: { metadata },
    expires_at: scope.expiresAtSec, success_url: success.href, cancel_url: cancel.href,
  }, { idempotencyKey: `bebe-checkout:${scope.jobId}:${scope.revision}:${scope.attempt}` });
  let url;
  try { url = new URL(session.url); } catch { throw new Error('checkout_unavailable'); }
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port || url.username || url.password || !/^cs_[A-Za-z0-9_]+$/.test(session.id || '') || !Number.isFinite(session.expires_at)) throw new Error('checkout_unavailable');
  return { sessionId: session.id, url: url.href, expiresAtMs: session.expires_at * 1000 };
}
