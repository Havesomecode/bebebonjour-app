// Only an explicit mode opts into Route A. Legacy rows remain complimentary.
export const expectedLivemode = () => process.env.BEBEBONJOUR_PAID_STRIPE_LIVEMODE !== 'false';
export const PAID_MODE = "paid_route_a";
export const TERMS_VERSION = "route-a-39-v2";
export const isPaid = (row) => row.data.orderMode === PAID_MODE;
export function paidEnabled() {
  if (process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED !== "true") throw new Error("paid_route_unavailable");
  const url = new URL(process.env.BEBEBONJOUR_PAID_TERMS_URL || "https://invalid.local");
  if (!process.env.BEBEBONJOUR_PAID_TERMS_URL || url.protocol !== "https:" || url.username || url.password) throw new Error("paid_route_unavailable");
  return url.href;
}
export function activePaid(row) {
  if (!isPaid(row)) throw new Error("paid_order_required");
  if (row.data.hostingEndsAtMs && row.data.hostingEndsAtMs <= Date.now()) throw new Error("hosting_ended");
  if (row.data.cancelledAtMs || row.data.revokedAtMs || row.data.closedAtMs || row.data.deletedAtMs || row.data.deletionRequestedAtMs) throw new Error("order_cancelled");
}
export function stageState(stage, suffix) {
  return `${stage === "generate" ? "generation" : stage}_${suffix}`;
}
// A paid order is generated only after its verified payment.
export function paidStageGate(row, stage) {
  if (!isPaid(row)) return;
  activePaid(row);
  if (stage === "generate" && row.data.payment?.status !== "settled") throw new Error("payment_required");
}
// Paid additions to the customer status:
// { orderMode, priceMinor, currency, support, paymentStatus, checkoutAvailable,
//   correctionsRemaining, cancelled, revoked, refused, termsVersion, termsUrl,
//   delivered, hostingEndsAtMs }
export function paidSafeStatus(row) {
  const d = row.data;
  return {
    orderMode: PAID_MODE, priceMinor: 3900, currency: "EUR", support: "contact@bebebonjour.com",
    paymentStatus: d.payment.status,
    checkoutAvailable: row.status === "payment_pending" && d.payment.status !== "settled" && !d.cancelledAtMs && !d.revokedAtMs && !d.closedAtMs && !d.deletedAtMs && !d.deletionRequestedAtMs,
    correctionsRemaining: 2 - (d.correctionsUsed || 0),
    cancelled: !!d.cancelledAtMs, revoked: !!d.revokedAtMs, refused: row.status === "refused",
    termsVersion: TERMS_VERSION, termsUrl: process.env.BEBEBONJOUR_PAID_TERMS_URL || null,
    delivered: !!d.deliveredAtMs, hostingEndsAtMs: d.hostingEndsAtMs || null,
  };
}
