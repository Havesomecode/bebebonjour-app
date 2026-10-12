"use node";

import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { createHash } from "node:crypto";
import { performNarration, performEmail } from "../src/delivery-loop/provider-transport.mjs";
import { inspectPaidPayment } from "../src/delivery-loop/paid-payment.mjs";

const ref = (name) => makeFunctionReference(`deliveryLoop:${name}`);
const identity = { workerToken: v.string(), jobId: v.string(), leaseToken: v.string(), revision: v.number() };

export const narrate = actionGeneric({
  args: { ...identity, language: v.string(), text: v.string(), textDigest: v.string() },
  handler: async (context, args) => {
    const snapshot = await context.runQuery(ref('read'), { workerToken: args.workerToken, jobId: args.jobId });
    const stage = snapshot.orderMode === 'paid_route_a' ? 'finalize' : 'generate';
    const job = await context.runQuery(ref('authorizeProvider'), { ...pickIdentity(args), stage });
    if (!job.intake.languages.includes(args.language)) throw new Error('narration_language_invalid');
    const existing = (job.narrationReceipts || []).find(receipt => receipt.revision === args.revision
      && receipt.language === args.language && receipt.textDigest === args.textDigest);
    if (existing) return { storageId: existing.storageId, textDigest: existing.textDigest,
      provider: existing.provider, model: existing.model, voice: existing.voice };
    if (createHash('sha256').update(args.text).digest('hex') !== args.textDigest) throw new Error('narration_text_mismatch');
    await context.runMutation(ref('beginNarration'), { ...pickIdentity(args), language: args.language, textDigest: args.textDigest });
    const receipt = await provider('narrate', { language: args.language, text: args.text, textDigest: args.textDigest });
    const bytes = Buffer.from(receipt.audioBase64, 'base64');
    if (bytes.length !== receipt.bytes || bytes.length < 128 || bytes.length > 12 * 1024 * 1024
      || createHash('sha256').update(bytes).digest('hex') !== receipt.audioDigest
      || receipt.textDigest !== args.textDigest || receipt.provider !== 'openai'
      || receipt.voice !== 'cedar') throw new Error('narration_receipt_invalid');
    await context.runQuery(ref('authorizeProvider'), { ...pickIdentity(args), stage });
    const storageId = await context.storage.store(new Blob([bytes], { type: 'audio/mpeg' }));
    await context.runMutation(ref('recordNarration'), { ...pickIdentity(args), language: args.language,
      textDigest: args.textDigest, storageId, provider: receipt.provider, model: receipt.model, voice: receipt.voice });
    return { storageId, textDigest: args.textDigest, provider: receipt.provider, model: receipt.model, voice: receipt.voice };
  },
});

export const sendEmail = actionGeneric({
  args: { ...identity, stage: v.union(v.literal('draft_email'), v.literal('final_email')) },
  handler: async (context, args) => {
    const job = await context.runQuery(ref('authorizeProvider'), args);
    const payload = emailPayload(job, args.stage, args.revision);
    await context.runMutation(ref('fence'), args);
    let receipt;
    try {
      receipt = await provider('sendEmail', payload);
    } catch (error) {
      // Never blindly re-send an uncertain email. Resend's canonical idempotency
      // key stays recorded so the exact effect can be reconciled rather than duplicated.
      await context.runMutation(ref('fail'), { workerToken: args.workerToken, jobId: args.jobId,
        leaseToken: args.leaseToken, reason: safeReason(error), retryable: false });
      throw new Error(safeReason(error));
    }
    await context.runMutation(ref('completeEmail'), { ...args, providerMessageId: receipt.providerMessageId });
    return { providerMessageId: receipt.providerMessageId, status: args.stage === 'final_email' ? 'approved_sent' : 'awaiting_review' };
  },
});

export const inspectEmail = actionGeneric({
  args: { workerToken: v.string(), jobId: v.string(), providerMessageId: v.string() },
  handler: async (context, args) => {
    const job = await context.runQuery(ref('read'), { workerToken: args.workerToken, jobId: args.jobId });
    if (!job || !(job.emailReceipts || job.emails || []).some(receipt => receipt.providerMessageId === args.providerMessageId)) {
      throw new Error('email_receipt_not_bound');
    }
    return provider('inspectEmail', { providerMessageId: args.providerMessageId });
  },
});

function pickIdentity(args) {
  return { workerToken: args.workerToken, jobId: args.jobId, leaseToken: args.leaseToken, revision: args.revision };
}

function emailPayload(job, stage, revision) {
  const firstName = job.intake.baby.firstName;
  const final = stage === 'final_email';
  if (job.orderMode === 'paid_route_a' && !final) {
    const intro = 'Votre aperçu privé est prêt. Il n’est pas publié et la narration finale sera créée après votre accord, le paiement vérifié et la révision éditoriale. Vous disposez de 24 heures pour examiner cette version. Deux corrections éditoriales sont incluses.';
    return { to: job.intake.customer.email, subject: `${firstName} — votre aperçu privé est prêt`,
      text: `${intro}\n\nAperçu et révision : ${job.reviewUrl}\n\nSupport : contact@bebebonjour.com`,
      html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(job.reviewUrl)}">Examiner l’aperçu privé</a></p><p>contact@bebebonjour.com</p>`,
      idempotencyKey: `bebe-loop:${job.jobId}:${revision}:${stage}` };
  }
  const subject = final ? `${firstName} — votre annonce approuvée` : `${firstName} — ${revision > 1 ? 'votre annonce corrigée' : 'votre première annonce'} est prête`;
  const intro = final ? 'Votre annonce a été approuvée. Elle est prête à être partagée avec vos proches.'
    : 'Votre première version a été créée automatiquement, avant révision humaine. Vous pouvez la consulter, demander une correction ou l’approuver.';
  const text = `${intro}\n\nVotre annonce : ${job.publicUrl}\n${final ? '' : `\nRévision et corrections : ${job.reviewUrl}\n`}\nBébé Bonjour`;
  const html = `<div style="font-family:Georgia,serif;color:#20392d;max-width:580px"><h1>${escapeHtml(subject)}</h1><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(job.publicUrl)}">Ouvrir votre annonce</a></p>${final ? '' : `<p><a href="${escapeHtml(job.reviewUrl)}">Réviser, corriger ou approuver</a></p>`}<p>Bébé Bonjour</p></div>`;
  return { to: job.intake.customer.email, subject, text, html,
    idempotencyKey: `bebe-loop:${job.jobId}:${revision}:${stage}` };
}

async function provider(operation, payload) {
  if (operation !== 'narrate' && process.env.BEBEBONJOUR_DELIVERY_LOOP_PROVIDER_URL) {
    const url = new URL(process.env.BEBEBONJOUR_DELIVERY_LOOP_PROVIDER_URL);
    if (url.protocol !== 'https:') throw new Error('provider_url_invalid');
    const response = await fetch(url, { method: 'POST', headers: {
      authorization: `Bearer ${process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ operation, payload }), signal: AbortSignal.timeout(150_000) });
    const result = await response.json();
    if (!response.ok || result.status !== 'ok') throw new Error(result.code || `provider_proxy_http_${response.status}`);
    return result.result;
  }
  if (operation === 'narrate') return performNarration(payload);
  if (operation === 'sendEmail') return performEmail(payload);
  if (operation === 'inspectEmail') {
    const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(payload.providerMessageId)}`, {
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`email_inspection_http_${response.status}`);
    return response.json();
  }
  throw new Error('provider_operation_invalid');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function safeReason(error) {
  return /^[A-Za-z0-9_]{1,120}$/.test(error?.message || '') ? error.message : 'provider_transport_uncertain';
}

export const reconcilePaidPayment = actionGeneric({
  args: { editorialToken: v.string(), jobId: v.string(), expectedRevision: v.number(), providerPaymentId: v.string() },
  handler: async (context, args) => {
    const scope = await context.runQuery(ref('paymentScope'), { editorialToken: args.editorialToken, jobId: args.jobId, expectedRevision: args.expectedRevision });
    let evidence;
    try {
      evidence = await inspectPaidPayment({ scope, providerPaymentId: args.providerPaymentId,
        apiKey: process.env.STRIPE_SECRET_KEY, accountId: process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID });
    } catch (error) { throw new Error(safeReason(error)); }
    return context.runMutation(ref('recordPaymentEvidence'), evidence);
  },
});
