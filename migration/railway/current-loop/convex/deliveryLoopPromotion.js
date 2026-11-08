import { v } from 'convex/values';
import { TEST_PROMOTION_POLICY } from '../src/delivery-loop/test-promotion.mjs';

export const promotionEvidence = v.object({
  policyId: v.literal(TEST_PROMOTION_POLICY), couponId: v.string(), promotionCodeId: v.string(), checkoutSessionId: v.string(),
  ordinaryAmountMinor: v.literal(3900), discountAmountMinor: v.literal(3800), countsAs39EURFirstSale: v.literal(false),
});
