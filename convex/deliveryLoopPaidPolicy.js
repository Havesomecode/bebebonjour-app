// Only an explicit mode opts into Route A. Legacy rows remain complimentary.
import { isTestPromotionReceipt } from '../src/delivery-loop/test-promotion.mjs';
export const expectedLivemode = () => process.env.BEBEBONJOUR_PAID_STRIPE_LIVEMODE !== 'false';
export const PAID_MODE = "paid_route_a";
export const TERMS_VERSION = "route-a-39-v1";
export const PREVIEW_MS = 24 * 60 * 60 * 1000;
export const isPaid = (row) => row.data.orderMode === PAID_MODE;
export const currentPreview = (row) => row.data.revisions.find((r) => r.revision === row.data.latestRevision) || row.data.finalPublication;
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
export function activePreview(row) {
  activePaid(row);
  if (!row.data.previewExpiresAtMs || row.data.previewExpiresAtMs <= Date.now()) throw new Error("preview_expired");
}
export function paidEligible(row) {
  activePaid(row);
  const revision = row.data.desiredRevision;
  const preview = currentPreview(row);
  const decision = row.data.paidApproval;
  const permissions = row.data.paidPermissions;
  const editorial = row.data.editorialApproval;
  const payment = row.data.payment;
  if (!preview || preview.revision !== revision || row.data.latestRevision !== revision || decision?.revision !== revision || decision.previewDigest !== preview.contentDigest) throw new Error("content_approval_required");
  if (permissions?.revision !== revision || permissions.previewDigest !== preview.contentDigest || permissions.termsVersion !== TERMS_VERSION || permissions.publication !== true) throw new Error("paid_permissions_required");
  if (editorial?.revision !== revision || editorial.previewDigest !== preview.contentDigest || editorial.human !== true) throw new Error("editorial_approval_required");
  if (payment?.status !== "settled" || payment.provider !== "stripe" || payment.livemode !== expectedLivemode() || !(payment.amountMinor === 3900 && !payment.promotion || isTestPromotionReceipt(payment)) || payment.currency !== "eur" || payment.revision !== revision || payment.previewDigest !== preview.contentDigest || !payment.providerPaymentId) throw new Error("payment_required");
  return preview;
}
export function stageState(stage, suffix) {
  return `${stage === "generate" ? "generation" : stage}_${suffix}`;
}
export function paidStageGate(row, stage) {
  if (!isPaid(row)) return;
  activePaid(row);
  if (stage === "generate") {
    if (!row.data.previewConsent) throw new Error("preview_consent_required");
    if (row.data.paidApproval || row.data.payment.status === "settled") throw new Error("paid_preview_locked");
  } else if (stage === "draft_email") {
    if (row.data.previewExpiresAtMs && row.data.previewExpiresAtMs <= Date.now()) throw new Error("preview_expired");
  }
  else {
    paidEligible(row);
    if (stage === "final_email" && row.data.finalPublication?.revision !== row.data.desiredRevision) throw new Error("final_publication_required");
  }
}
export function paidSafeStatus(row) {
  const expired = !!row.data.previewExpiresAtMs && row.data.previewExpiresAtMs <= Date.now();
  const preview = currentPreview(row);
  const matches = evidence => evidence?.revision === row.data.latestRevision && evidence?.previewDigest === preview?.contentDigest && row.data.desiredRevision === row.data.latestRevision;
  const contentApproved = matches(row.data.paidApproval);
  const permissionsAccepted = matches(row.data.paidPermissions) && row.data.paidPermissions?.termsVersion === TERMS_VERSION && row.data.paidPermissions?.publication === true;
  return {
    checkoutAvailable: contentApproved && permissionsAccepted && row.data.payment.status !== 'settled' && !!row.data.previewExpiresAtMs && !expired && !row.data.cancelledAtMs && !row.data.revokedAtMs && !row.data.closedAtMs && !row.data.deletedAtMs && !row.data.deletionRequestedAtMs,
    orderMode: PAID_MODE, priceMinor: 3900, currency: "EUR", support: "contact@bebebonjour.com",
    paymentStatus: row.data.payment.status, correctionsRemaining: 2 - row.data.correctionsUsed,
    previewExpiresAtMs: row.data.previewExpiresAtMs || null, previewRenewals: row.data.previewRenewals,
    previewExpired: expired, cancelled: !!row.data.cancelledAtMs, revoked: !!row.data.revokedAtMs,
    contentApproved,
    permissionsAccepted,
    editorialApproved: row.data.editorialApproval?.revision === row.data.latestRevision,
    termsVersion: TERMS_VERSION, termsUrl: process.env.BEBEBONJOUR_PAID_TERMS_URL || null,
    delivered: row.data.finalPublication?.revision === row.data.latestRevision,
    hostingEndsAtMs: row.data.hostingEndsAtMs || null,
  };
}
