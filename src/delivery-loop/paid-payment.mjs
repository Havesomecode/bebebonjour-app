import Stripe from "stripe";
import { testPromotionBinding, inspectNativeTestPromotion } from './test-promotion.mjs';

// Distinguish our deterministic inspection verdicts from provider error text.
export class PaidPaymentInspectionError extends Error {}

export function paidStripeKeyMode(apiKey) {
  const match = /^(?:sk|rk)_(live|test)_[A-Za-z0-9]+$/.exec(apiKey || "");
  if (!match) throw new Error("payment_configuration_invalid");
  return match[1] === "live";
}

// Read-only provider reconciliation. There is no charge/create/refund operation.
export async function inspectPaidPayment({ scope, providerPaymentId, apiKey, accountId, stripe }) {
  if (!/^pi_[A-Za-z0-9]+$/.test(providerPaymentId || "") || !/^acct_[A-Za-z0-9]+$/.test(accountId || "")) throw new Error("payment_configuration_invalid");
  if (!stripe) {
    paidStripeKeyMode(apiKey);
    stripe = new Stripe(apiKey, { maxNetworkRetries: 2, timeout: 30000 });
  }
  const intent = await stripe.paymentIntents.retrieve(providerPaymentId);
  const metadata = intent.metadata || {};
  const promotion = intent.amount === 100 ? testPromotionBinding(scope, accountId, intent.livemode) : null;
  const amount = promotion ? 100 : 3900;
  if (intent.id !== providerPaymentId || metadata.project !== "bebebonjour" || metadata.order_mode !== "paid_route_a"
      || metadata.job_id !== scope.jobId || metadata.revision !== String(scope.revision) || metadata.preview_digest !== scope.previewDigest
      || intent.status !== "succeeded" || intent.amount !== amount || intent.amount_received !== amount || intent.currency !== "eur"
      || typeof intent.livemode !== "boolean" || (apiKey !== undefined && intent.livemode !== paidStripeKeyMode(apiKey))) throw new PaidPaymentInspectionError("payment_evidence_mismatch");
  if (promotion && !await inspectNativeTestPromotion(stripe, promotion, scope, intent)) throw new PaidPaymentInspectionError('payment_evidence_mismatch');
  return { ...scope, providerPaymentId, amountMinor: intent.amount_received, currency: intent.currency, livemode: intent.livemode, settled: true, providerAccountId: accountId, ...(promotion ? { promotion } : {}) };
}
