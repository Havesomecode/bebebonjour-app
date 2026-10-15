// Trusted server configuration only. Never derive eligibility from provider metadata.
export const TEST_PROMOTION_POLICY = 'owner1038-five-tests-v1';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const sessionId = value => typeof value === 'string' && /^cs_(live|test)_[A-Za-z0-9]+$/.test(value);
export function testPromotionBinding(scope, accountId, livemode) {
  if (process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED !== 'true') return null;
  let policy;
  try { policy = JSON.parse(process.env.BEBEBONJOUR_PAID_TEST_PROMO_JSON || ''); } catch { throw new Error('payment_promotion_configuration'); }
  if (!policy || policy.policyId !== TEST_PROMOTION_POLICY || !/^acct_[A-Za-z0-9]+$/.test(policy.providerAccountId || '')
      || typeof policy.livemode !== 'boolean' || !id(policy.couponId) || !/^promo_[A-Za-z0-9]+$/.test(policy.promotionCodeId || '')
      || !Number.isSafeInteger(policy.endsAtMs) || !Array.isArray(policy.bindings) || policy.bindings.length > 5
      || policy.bindings.some(b => !b || !id(b.jobId) || !Number.isSafeInteger(b.revision) || b.revision < 1
        || !/^[a-f0-9]{64}$/.test(b.previewDigest || '') || !sessionId(b.checkoutSessionId))
      || new Set(policy.bindings.map(b => b.jobId)).size !== policy.bindings.length
      || new Set(policy.bindings.map(b => b.checkoutSessionId)).size !== policy.bindings.length) throw new Error('payment_promotion_configuration');
  if (policy.endsAtMs <= Date.now() || policy.providerAccountId !== accountId || policy.livemode !== livemode) return null;
  const binding = policy.bindings.find(b => b.jobId === scope.jobId && b.revision === scope.revision && b.previewDigest === scope.previewDigest);
  return binding ? { policyId: policy.policyId, couponId: policy.couponId, promotionCodeId: policy.promotionCodeId,
    checkoutSessionId: binding.checkoutSessionId, ordinaryAmountMinor: 3900, discountAmountMinor: 3800, countsAs39EURFirstSale: false } : null;
}
export function isTestPromotionReceipt(payment) {
  const p = payment?.promotion;
  return payment?.amountMinor === 100 && p?.policyId === TEST_PROMOTION_POLICY && id(p.couponId)
    && /^promo_[A-Za-z0-9]+$/.test(p.promotionCodeId || '') && sessionId(p.checkoutSessionId)
    && p.ordinaryAmountMinor === 3900 && p.discountAmountMinor === 3800 && p.countsAs39EURFirstSale === false;
}
export function samePromotion(a, b) {
  return !!a && !!b && ['policyId', 'couponId', 'promotionCodeId', 'checkoutSessionId', 'ordinaryAmountMinor', 'discountAmountMinor', 'countsAs39EURFirstSale'].every(k => a[k] === b[k]);
}
const objectId = value => typeof value === 'string' ? value : value?.id;
export async function inspectNativeTestPromotion(stripe, promotion, scope, intent) {
  const session = await stripe.checkout.sessions.retrieve(promotion.checkoutSessionId);
  const code = await stripe.promotionCodes.retrieve(promotion.promotionCodeId);
  const coupon = await stripe.coupons.retrieve(promotion.couponId);
  const metadata = session.metadata || {};
  const bounded = object => object.max_redemptions === 5 && Number.isInteger(object.times_redeemed) && object.times_redeemed >= 1 && object.times_redeemed <= 5 && object.livemode === intent.livemode;
  return session.id === promotion.checkoutSessionId && session.object === 'checkout.session' && session.mode === 'payment'
    && session.status === 'complete' && session.payment_status === 'paid' && objectId(session.payment_intent) === intent.id
    && session.livemode === intent.livemode && session.currency === 'eur' && session.amount_subtotal === 3900 && session.amount_total === 100
    && session.total_details?.amount_discount === 3800 && session.total_details.amount_tax === 0 && session.total_details.amount_shipping === 0
    && metadata.project === 'bebebonjour' && metadata.order_mode === 'paid_route_a' && metadata.job_id === scope.jobId
    && metadata.revision === String(scope.revision) && metadata.preview_digest === scope.previewDigest
    && session.discounts?.length === 1 && objectId(session.discounts[0].coupon) === promotion.couponId && objectId(session.discounts[0].promotion_code) === promotion.promotionCodeId
    && code.id === promotion.promotionCodeId && code.object === 'promotion_code' && code.promotion?.type === 'coupon'
    && objectId(code.promotion.coupon) === promotion.couponId && bounded(code)
    && coupon.id === promotion.couponId && coupon.object === 'coupon' && coupon.amount_off === 3800 && coupon.currency === 'eur'
    && coupon.percent_off === null && coupon.duration === 'once' && bounded(coupon);
}
