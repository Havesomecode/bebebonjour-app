import Stripe from "stripe";

// Read-only provider reconciliation. There is no charge/create/refund operation.
export async function inspectPaidPayment({ scope, providerPaymentId, apiKey, accountId, stripe }) {
  if (!/^pi_[A-Za-z0-9]+$/.test(providerPaymentId || "") || !/^acct_[A-Za-z0-9]+$/.test(accountId || "")) throw new Error("payment_configuration_invalid");
  if (!stripe) {
    if (!/^sk_(live|test)_/.test(apiKey || "")) throw new Error("payment_configuration_invalid");
    stripe = new Stripe(apiKey, { maxNetworkRetries: 2, timeout: 30000 });
  }
  const account = await stripe.accounts.retrieve();
  if (account.id !== accountId) throw new Error("payment_account_mismatch");
  const intent = await stripe.paymentIntents.retrieve(providerPaymentId, { expand: ["latest_charge"] });
  const metadata = intent.metadata || {};
  const charge = intent.latest_charge;
  if (intent.id !== providerPaymentId || metadata.project !== "bebebonjour" || metadata.order_mode !== "paid_route_a"
      || metadata.job_id !== scope.jobId || metadata.revision !== String(scope.revision) || metadata.preview_digest !== scope.previewDigest
      || intent.status !== "succeeded" || intent.amount !== 3900 || intent.amount_received !== 3900 || intent.currency !== "eur"
      || typeof intent.livemode !== "boolean" || !charge || typeof charge !== "object" || charge.paid !== true || charge.captured !== true
      || charge.refunded !== false || charge.amount_refunded !== 0 || charge.disputed !== false || charge.amount !== 3900 || charge.currency !== "eur"
      || charge.payment_intent !== intent.id || charge.livemode !== intent.livemode) throw new Error("payment_evidence_mismatch");
  return { ...scope, providerPaymentId, amountMinor: intent.amount_received, currency: intent.currency, livemode: intent.livemode, settled: true, providerAccountId: account.id };
}
