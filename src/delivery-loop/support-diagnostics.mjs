import { createHash } from 'node:crypto';
import { PAYMENT_EVENT_REJECTION_REASONS } from './paid-event.mjs';

// Offline advice only. No provider, datastore, capability or worker imports.
const invalid = () => { throw new Error('invalid_redacted_snapshot'); };
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key))) invalid();
};
const choice = (value, choices) => { if (!choices.includes(value)) invalid(); };
const integer = value => { if (!Number.isSafeInteger(value) || value < 1) invalid(); };
const id = (value, pattern) => { if (typeof value !== 'string' || !pattern.test(value)) invalid(); };
const boolean = value => { if (typeof value !== 'boolean') invalid(); };
const digest = value => id(value, /^[a-f0-9]{64}$/);
const eventKeys = ['providerAccountId', 'providerEventId', 'rawBodySha256', 'providerPaymentId', 'jobId', 'revision', 'previewDigest'];
function event(value, receipt = false) {
  object(value, receipt ? [...eventKeys, 'type', 'livemode', 'disposition', 'reason', 'processedAtMs'] : eventKeys);
  id(value.providerAccountId, /^acct_[A-Za-z0-9]{1,196}$/);
  id(value.providerEventId, /^evt_[A-Za-z0-9]{1,196}$/);
  digest(value.rawBodySha256);
  if (value.providerPaymentId !== undefined) id(value.providerPaymentId, /^pi_[A-Za-z0-9]{1,196}$/);
  if (value.jobId !== undefined) id(value.jobId, /^[A-Za-z0-9_-]{1,100}$/);
  if (value.revision !== undefined) integer(value.revision);
  if (value.previewDigest !== undefined) digest(value.previewDigest);
  if (receipt) {
    choice(value.type, ['payment_intent.succeeded']); boolean(value.livemode);
    choice(value.disposition, ['settled', 'test_only', 'rejected']);
    choice(value.reason, ['payment_verified', ...PAYMENT_EVENT_REJECTION_REASONS]);
    integer(value.processedAtMs);
    if (value.disposition === 'rejected' ? value.reason === 'payment_verified'
      : value.reason !== 'payment_verified' || value.livemode !== (value.disposition === 'settled')) invalid();
    if (value.disposition !== 'rejected' && ['providerPaymentId', 'jobId', 'revision', 'previewDigest'].some(key => value[key] === undefined)) invalid();
  }
}
const statuses = ['generation_queued', 'generation_running', 'draft_email_queued', 'draft_email_running',
  'awaiting_review', 'paid_blocked', 'finalize_queued', 'finalize_running', 'final_email_queued',
  'final_email_running', 'delivered', 'reconciliation_required', 'failed', 'cancelled', 'closed', 'revoked', 'data_deleted'];
const stages = ['generate', 'draft_email', 'finalize', 'final_email'];
function order(value) {
  // Explicit projection of safeStatus + protected aggregate/retained effect fields.
  // Raw order.data, prose, email addresses, capabilities and provider errors are rejected.
  object(value, ['jobId', 'status', 'orderMode', 'paymentStatus', 'cancelled', 'revoked', 'previewExpired',
    'uncertainEffect', 'narrationEffects']);
  id(value.jobId, /^[A-Za-z0-9_-]{1,100}$/); choice(value.orderMode, ['paid_route_a']);
  choice(value.status, statuses); choice(value.paymentStatus, ['pending', 'settled', 'test_only', null]);
  for (const field of ['cancelled', 'revoked', 'previewExpired']) boolean(value[field]);
  if (value.uncertainEffect !== null) {
    object(value.uncertainEffect, ['stage', 'revision', 'startedAtMs']);
    choice(value.uncertainEffect.stage, stages); integer(value.uncertainEffect.revision); integer(value.uncertainEffect.startedAtMs);
  }
  if (!Array.isArray(value.narrationEffects) || value.narrationEffects.length > 20) invalid();
  for (const effect of value.narrationEffects) {
    object(effect, ['revision', 'language', 'textDigest', 'status', 'startedAtMs']);
    integer(effect.revision); choice(effect.language, ['fr', 'ar']); digest(effect.textDigest);
    choice(effect.status, ['inflight', 'complete']); integer(effect.startedAtMs);
  }
}
function validate(snapshot) {
  object(snapshot, ['schemaVersion', 'source', 'http', 'request', 'receipt', 'order']);
  choice(snapshot.schemaVersion, [1]); choice(snapshot.source, ['synthetic', 'redacted_snapshot']);
  if (snapshot.http !== undefined) {
    object(snapshot.http, ['status', 'code']);
    const codes = { 200: ['settled', 'test_only', 'rejected'], 400: ['payment_event_signature', 'payment_event_format'],
      413: ['payment_event_too_large'], 503: ['payment_event_retry'] };
    choice(snapshot.http.status, [200, 400, 413, 503]); choice(snapshot.http.code, codes[snapshot.http.status]);
  }
  if (snapshot.request !== undefined) event(snapshot.request);
  if (snapshot.receipt !== undefined) event(snapshot.receipt, true);
  if (snapshot.order !== undefined) order(snapshot.order);
  if (!snapshot.http && !snapshot.receipt && !snapshot.order) invalid();
}
const recovery = {
  receipt: 'Inspect the exact account/event/raw-byte fingerprint in deliveryLoopPaymentEvents and its existing order/payment evidence. Preserve immutable receipts; never invent an event ID or paid assertion.',
  scope: 'Resolve the exact account, PaymentIntent, job, revision, digest and customer/terms/publication scope with the accountable human operator. If separately authorized, use existing reconcilePaidPayment for genuine current evidence; a rejected event cannot be resurrected.',
  frozen: 'Keep the order frozen. With separate action-specific authority, verify cancellation/revocation and denied final access before provider refund/dispute remediation. Cancellation is not refund confirmation.',
  effect: 'Preserve the existing lease, narration/email fences and recorded provider identifiers. Escalate to the human operator for exact effect-receipt reconciliation; no automatic recovery mutation exists for lost narration receipts. Do not clear fences, claim work or resend effects.',
};
const pseudonym = value => createHash('sha256').update(value).digest('hex');

export function diagnosePaidSupport(snapshot) {
  validate(snapshot);
  const { request, receipt, order: row, http } = snapshot;
  const findings = [];
  const add = (code, severity, owner, nextAction) => findings.push({ code, severity, owner, nextAction });
  // Hash even syntactically valid identifiers; never echo arbitrary input strings.
  const correlation = {};
  if (request) correlation.request = pseudonym(JSON.stringify(eventKeys.map(key => request[key] ?? null)));
  if (receipt) correlation.receipt = pseudonym(JSON.stringify(eventKeys.map(key => receipt[key] ?? null)));
  if (row) correlation.order = pseudonym(row.jobId);
  const exact = request && receipt && eventKeys.every(key => request[key] === receipt[key]);
  const bound = !row || !receipt?.jobId || receipt.jobId === row.jobId;
  if (receipt && (!bound || (request && !exact))) {
    add('receipt_correlation_mismatch', 'critical', 'support_operator', recovery.receipt);
  } else if (receipt) {
    if (http?.status === 200 && http.code !== receipt.disposition) {
      add('http_receipt_mismatch', 'critical', 'support_operator', recovery.receipt);
    }
    if (receipt.disposition === 'rejected') {
      const closed = ['order_cancelled', 'hosting_ended', 'data_deleted', 'preview_expired', 'not_found'].includes(receipt.reason);
      add(receipt.reason, 'warning', 'support_operator', closed ? recovery.frozen : recovery.scope);
    } else if (receipt.disposition === 'test_only') {
      add('test_only_not_payment', 'warning', 'support_operator', 'Test evidence cannot authorize live final delivery. Do not relabel or waive it; any genuine live payment requires separate authority and existing provider inspection.');
    } else {
      add('settlement_receipt_observed', 'info', 'support_operator', 'Receipt records inspection at processing time, not current refund/dispute state or editorial approval. Retain existing customer, human-editorial and final-effect gates.');
      if (row && row.paymentStatus !== null && row.paymentStatus !== 'settled') add('order_payment_mismatch', 'critical', 'support_operator', recovery.receipt);
    }
    if (exact) add('exact_receipt_noop', 'info', 'support_operator', 'An exact recorded event replay is a no-op in the existing adapter, including rejected events. Do not replay final effects or edit receipts; this diagnostic performs no replay.');
    if (http?.status === 503) add('retry_response_receipt_observed', 'warning', 'release_operator', 'A retry response does not prove the transaction failed. Resolve timing/concurrency against the exact durable receipt before considering transport redelivery; preserve all final-effect fences.');
  } else if (http?.status === 503) {
    add('payment_event_retry_unknown', 'warning', 'release_operator', '503 means uncertain provider/configuration/datastore inspection or commit, not a business rejection or proof of no charge. Look up the exact durable receipt first. Resolve the specific configuration/read-permission/transport issue under its own authority; only the existing signed-event transport may redeliver unchanged bytes with a current signature. Never expand key permissions, assert payment, or replay final effects.');
  } else if (http?.status === 200) {
    add('durable_receipt_missing', 'critical', 'support_operator', recovery.receipt);
  } else if (http) {
    add(http.code, 'warning', 'release_operator', 'Ingress rejected authentication/format/size before provider inspection. Verify the dedicated signing configuration and bounded exact bytes under separate authority. Do not treat this as payment evidence or print raw bodies/signatures/secrets.');
  }
  if (row) {
    if (row.paymentStatus === null) add('order_payment_snapshot_missing', 'warning', 'support_operator', 'Payment state is absent from this projection, not pending or refunded. Consult separately retained financial/effect evidence under existing authority; do not infer settlement or clear fences.');
    if (row.status === 'reconciliation_required' || row.uncertainEffect
        || row.narrationEffects.some(effect => effect.status === 'inflight')) {
      add('final_effect_uncertain', 'critical', 'support_operator', recovery.effect);
    }
    if (row.cancelled || row.revoked || ['cancelled', 'closed', 'revoked', 'data_deleted'].includes(row.status)) {
      add('order_frozen', 'warning', 'support_operator', recovery.frozen);
    }
  } else {
    add('order_snapshot_missing', 'warning', 'support_operator', 'Obtain an authorized redacted order/effect projection before diagnosing downstream fulfillment. No order state is inferred from a payment receipt alone.');
  }
  return { schemaVersion: 1, boundary: 'offline_advice_only', source: snapshot.source,
    provesProviderState: false, authorizesEffects: false, correlation, findings };
}
