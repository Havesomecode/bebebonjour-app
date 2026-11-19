"use node";

import { actionGeneric, internalActionGeneric, makeFunctionReference } from "convex/server";
import { paymentEventFields } from "./deliveryLoopPaymentEvents.js";
import { paymentEventRejection } from "../src/delivery-loop/paid-event.mjs";
import { v } from "convex/values";
import { createHash } from "node:crypto";
import { performNarration } from "../src/delivery-loop/provider-transport.mjs";
import { splitNarrationPhrases, validPhraseStarts } from "../src/delivery-loop/narration-timing.mjs";
import { cloudflareTransport, alreadyAdmitted } from "../src/delivery-loop/cloudflare-runtime.mjs";
import Stripe from "stripe";
import { expectedLivemode } from "./deliveryLoopPaidPolicy.js";
import { createPaidCheckoutSession } from "../src/delivery-loop/paid-checkout.mjs";
import { inspectPaidPayment, PaidPaymentInspectionError, paidStripeKeyMode } from "../src/delivery-loop/paid-payment.mjs";

const ref = (name) => makeFunctionReference(`deliveryLoop:${name}`);
const identity = { workerToken: v.string(), jobId: v.string(), leaseToken: v.string(), revision: v.number() };

export const narrate = actionGeneric({
  args: { ...identity, language: v.string(), text: v.string(), textDigest: v.string() },
  handler: async (context, args) => {
    const stage = 'generate';
    const job = await context.runQuery(ref('authorizeProvider'), { ...pickIdentity(args), stage });
    if (!job.intake.languages.includes(args.language)) throw new Error('narration_language_invalid');
    if (createHash('sha256').update(args.text).digest('hex') !== args.textDigest) throw new Error('narration_text_mismatch');
    const voice = job.intake.voicePreference?.voice ?? 'pere';
    const phraseCount = splitNarrationPhrases(args.text).length;
    const existing = (job.narrationReceipts || []).find(receipt => receipt.revision === args.revision
      && receipt.language === args.language && receipt.textDigest === args.textDigest);
    if (existing) {
      if (existing.provider !== 'voxcpm' || existing.voice !== voice || !validPhraseStarts(existing.phraseStarts, phraseCount)) throw new Error('narration_receipt_invalid');
      return { storageId: existing.storageId, textDigest: existing.textDigest, phraseStarts: existing.phraseStarts,
        provider: existing.provider, model: existing.model, voice: existing.voice };
    }
    await context.runMutation(ref('beginNarration'), { ...pickIdentity(args), language: args.language, textDigest: args.textDigest });
    const receipt = await provider('narrate', { language: args.language, text: args.text, textDigest: args.textDigest, voice });
    const bytes = Buffer.from(receipt.audioBase64, 'base64');
    if (bytes.length !== receipt.bytes || bytes.length < 128 || bytes.length > 12 * 1024 * 1024
      || createHash('sha256').update(bytes).digest('hex') !== receipt.audioDigest
      || receipt.textDigest !== args.textDigest || receipt.provider !== 'voxcpm'
      || receipt.voice !== voice || !validPhraseStarts(receipt.phraseStarts, phraseCount)) throw new Error('narration_receipt_invalid');
    await context.runQuery(ref('authorizeProvider'), { ...pickIdentity(args), stage });
    const storageId = await context.storage.store(new Blob([bytes], { type: 'audio/mpeg' }));
    try {
      await context.runMutation(ref('recordNarration'), { ...pickIdentity(args), language: args.language,
        textDigest: args.textDigest, storageId, provider: receipt.provider, model: receipt.model, voice: receipt.voice, phraseStarts: receipt.phraseStarts });
    } catch (error) {
      // A takedown/deletion may race storage.store. This action alone owns the
      // just-created blob: never leave it orphaned when recording is denied.
      await context.storage.delete(storageId);
      throw error;
    }
    return { storageId, textDigest: args.textDigest, provider: receipt.provider, model: receipt.model, voice: receipt.voice, phraseStarts: receipt.phraseStarts };
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
      receipt = await cloudflareTransport().send(payload, { fenceExternalEffect: alreadyAdmitted });
    } catch (error) {
      // A started effect requires reconciliation; never issue it again automatically.
      await context.runMutation(ref('fail'), { workerToken: args.workerToken, jobId: args.jobId,
        leaseToken: args.leaseToken, reason: safeReason(error), retryable: false });
      throw new Error(safeReason(error));
    }
    await context.runMutation(ref('completeEmail'), { ...args, provider: 'cloudflare', providerMessageId: receipt.providerMessageId });
    return { providerMessageId: receipt.providerMessageId, status: args.stage === 'final_email' ? 'approved_sent' : 'awaiting_review' };
  },
});

export const inspectEmail = actionGeneric({
  args: { workerToken: v.string(), jobId: v.string(), providerMessageId: v.string() },
  handler: async (context, args) => {
    const job = await context.runQuery(ref('read'), { workerToken: args.workerToken, jobId: args.jobId });
    const matches = (job?.emailReceipts || job?.emails || []).filter(receipt => receipt.providerMessageId === args.providerMessageId);
    if (!matches.length) throw new Error('email_receipt_not_bound');
    if (matches.some(receipt => receipt.provider !== 'cloudflare')) throw new Error('email_provider_unknown');
    return cloudflareTransport().status({ providerMessageId: args.providerMessageId });
  },
});

function pickIdentity(args) {
  return { workerToken: args.workerToken, jobId: args.jobId, leaseToken: args.leaseToken, revision: args.revision };
}

function emailPayload(job, stage, revision) {
  const firstName = (job.briefs || []).find(entry => entry.revision === revision)?.brief.firstName || job.intake.baby.firstName;
  const final = stage === 'final_email';
  const subject = final ? `${firstName} — votre faire-part est approuvé` : `${firstName} — votre faire-part est prêt`;
  const intro = final ? 'Votre faire-part est approuvé. Il est prêt à être partagé avec vos proches.'
    : 'Votre faire-part est prêt. Ouvrez-le, puis demandez une correction ou approuvez-le.';
  const text = `${intro}\n\nVotre faire-part : ${job.publicUrl}\n${final ? '' : `\nCorriger ou approuver : ${job.reviewUrl}\n`}\nBébé Bonjour`;
  const html = `<div style="font-family:Georgia,serif;color:#20392d;max-width:580px"><h1>${escapeHtml(subject)}</h1><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(job.publicUrl)}">Ouvrir votre faire-part</a></p>${final ? '' : `<p><a href="${escapeHtml(job.reviewUrl)}">Corriger ou approuver</a></p>`}<p>Bébé Bonjour</p></div>`;
  return { to: job.intake.customer.email, subject, text, html,
    idempotencyKey: `bebe-loop:${job.jobId}:${revision}:${stage}` };
}

async function provider(operation, payload) {
  if (operation === 'narrate') return performNarration(payload);
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

export const reconcilePaidEvent = internalActionGeneric({
  args: { event: v.object(paymentEventFields) },
  handler: async (context, { event }) => {
    const events = name => makeFunctionReference(`deliveryLoopPaymentEvents:${name}`);
    const prior = await context.runQuery(events('lookupEvent'), { event });
    if (prior || event.rejectionReason) return context.runMutation(events('recordEvent'), { event });
    let evidence;
    try {
      evidence = await inspectPaidPayment({ scope: { jobId: event.jobId, revision: event.revision, previewDigest: event.previewDigest },
        providerPaymentId: event.providerPaymentId, apiKey: process.env.STRIPE_SECRET_KEY,
        accountId: process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID });
      if (evidence.livemode !== event.livemode) throw new PaidPaymentInspectionError('payment_evidence_mismatch');
    } catch (error) {
      const rejectionReason = error instanceof PaidPaymentInspectionError ? paymentEventRejection(error) : undefined;
      if (!rejectionReason) throw new Error('payment_inspection_retry'); // transport, permissions and configuration
      return context.runMutation(events('recordEvent'), { event, rejectionReason });
    }
    // Mutation rechecks current order/consent scope and handles races atomically.
    // Commit failures propagate to HTTP503; no rejected receipt masks a failed commit.
    return context.runMutation(events('recordEvent'), { event, evidence });
  },
});

export const createCheckout = actionGeneric({
  args: { jobId: v.string(), reviewToken: v.string(), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    const result = await ctx.runMutation(ref('beginCheckout'), args);
    if (result.url) return result;
    const scope = result.create;
    try {
      const key = process.env.STRIPE_SECRET_KEY;
      if (paidStripeKeyMode(key) !== expectedLivemode()) throw new Error('payment_configuration_invalid');
      const stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 30000 });
      const checkout = await createPaidCheckoutSession({ stripe, scope });
      await ctx.runMutation(ref('recordCheckout'), { jobId: scope.jobId, revision: scope.revision, attempt: scope.attempt, ...checkout });
      return { url: checkout.url };
    } catch (error) {
      await ctx.runMutation(ref('clearCheckout'), { jobId: scope.jobId, attempt: scope.attempt });
      if (error?.message === 'payment_configuration_invalid') throw new Error('payment_configuration_invalid');
      throw new Error('checkout_unavailable');
    }
  },
});
