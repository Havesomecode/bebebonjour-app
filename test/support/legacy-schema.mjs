// Reconstruct the historical Convex test schema from its checked-in installation manifest.
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('../../ops/installation-compatibility.json', import.meta.url), 'utf8'));
function validator(s) {
  if (s.type === 'object') return v.object(Object.fromEntries(Object.entries(s.value).map(([k,f]) => [k, f.optional ? v.optional(validator(f.fieldType)) : validator(f.fieldType)])));
  if (s.type === 'union') return v.union(...s.value.map(validator));
  if (s.type === 'array') return v.array(validator(s.value));
  if (s.type === 'literal') return v.literal(s.value);
  return v[s.type]();
}
const tables = Object.fromEntries(manifest.productionSchema.tables.map(t => {
  const table = defineTable(validator(t.documentType));
  for (const i of t.indexes) table.index(i.indexDescriptor, i.fields.filter(f => f !== '_creationTime'));
  return [t.tableName, table];
}));
const promotion = v.object({policyId:v.literal('owner1038-five-tests-v1'),couponId:v.string(),promotionCodeId:v.string(),checkoutSessionId:v.string(),ordinaryAmountMinor:v.literal(3900),discountAmountMinor:v.literal(3800),countsAs39EURFirstSale:v.literal(false)});
tables.customerFlowAbuseBudgets = defineTable({scope:v.string(),minuteStartedAtMs:v.number(),dayStartedAtMs:v.number(),minuteAttempts:v.number(),dayAttempts:v.number()}).index('by_scope',['scope']);
tables.deliveryLoopPaymentEvents = defineTable({providerAccountId:v.string(),providerEventId:v.string(),type:v.literal('payment_intent.succeeded'),livemode:v.boolean(),rawBodySha256:v.string(),providerPaymentId:v.optional(v.string()),jobId:v.optional(v.string()),revision:v.optional(v.number()),previewDigest:v.optional(v.string()),disposition:v.union(v.literal('settled'),v.literal('test_only'),v.literal('rejected')),reason:v.string(),processedAtMs:v.number()}).index('by_identity',['providerAccountId','providerEventId']).index('by_fingerprint',['providerAccountId','providerEventId','rawBodySha256']);
tables.deliveryLoopPaymentEvidence = defineTable({jobId:v.string(),revision:v.number(),previewDigest:v.string(),providerPaymentId:v.string(),amountMinor:v.number(),currency:v.string(),livemode:v.boolean(),settled:v.boolean(),providerAccountId:v.string(),provider:v.literal('stripe'),status:v.string(),verifiedAtMs:v.number(),promotion:v.optional(promotion)}).index('by_payment_id',['providerPaymentId']).index('by_promotion_policy',['promotion.policyId']);
tables.deliveryLoopRetainedEvidence = defineTable({jobId:v.string(),retainedAtMs:v.number(),reason:v.string(),evidence:v.any()}).index('by_job_id',['jobId']);
export default defineSchema(tables);
