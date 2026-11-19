"use node";
import { internalActionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { cloudflareTransport, alreadyAdmitted } from "../src/delivery-loop/cloudflare-runtime.mjs";

const ref = (name) => makeFunctionReference(`deliveryLoop:${name}`);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function consoleBase(environment) {
  const url = new URL(environment.BEBEBONJOUR_OPS_CONSOLE_URL || "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("operator_notice_unconfigured");
  return url.href.replace(/\/$/, "");
}

// Operator notices carry only the console link: no name, email or request text.
export function noticePayload(notice, environment = process.env) {
  const idempotencyKey = `bebe-notice:${notice.jobId}:${notice.revision}:${notice.kind}`;
  if (notice.kind === "operator_new" || notice.kind === "operator_correction") {
    const to = environment.BEBEBONJOUR_OPERATOR_EMAIL;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(to)) throw new Error("operator_notice_unconfigured");
    let base;
    try { base = consoleBase(environment); } catch { throw new Error("operator_notice_unconfigured"); }
    const link = `${base}/commandes/${encodeURIComponent(notice.jobId)}`;
    const correction = notice.kind === "operator_correction";
    const subject = correction ? "Correction Bébé Bonjour à relire" : "Nouvelle demande Bébé Bonjour à relire";
    const line = correction ? "Une demande de correction attend votre relecture :" : "Une nouvelle demande attend votre relecture :";
    return { to, subject, text: `${line} ${link}`, html: `<p>${escapeHtml(line)} <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`, idempotencyKey };
  }
  if (notice.kind === "customer_payment") {
    if (!notice.customerEmail || !notice.firstName || !notice.reviewUrl) throw new Error("customer_notice_invalid");
    const subject = `${notice.firstName} — votre demande est acceptée`;
    const intro = `Nous avons lu votre demande. Le faire-part de ${notice.firstName} sera créé dès réception du paiement de 39 €.`;
    return { to: notice.customerEmail, subject,
      text: `${intro}\n\nPayer et suivre votre commande : ${notice.reviewUrl}\n\nBébé Bonjour · contact@bebebonjour.com`,
      html: `<div style="font-family:Georgia,serif;color:#20392d;max-width:580px"><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(notice.reviewUrl)}">Payer et suivre votre commande</a></p><p>Bébé Bonjour · contact@bebebonjour.com</p></div>`,
      idempotencyKey };
  }
  throw new Error("notice_kind_invalid");
}

export const send = internalActionGeneric({
  args: { jobId: v.string(), kind: v.string(), revision: v.number() },
  handler: async (ctx, args) => {
    const notice = await ctx.runQuery(ref("noticeContext"), args);
    if (!notice) return { skipped: true };
    let payload;
    try { payload = noticePayload(notice); } catch (error) {
      await ctx.runMutation(ref("finishNotice"), { ...args, reason: /^[a-z_]{1,60}$/.test(error?.message || "") ? error.message : "notice_invalid" });
      return { sent: false };
    }
    try {
      const receipt = await cloudflareTransport().send(payload, { fenceExternalEffect: alreadyAdmitted });
      await ctx.runMutation(ref("finishNotice"), { ...args, providerMessageId: receipt.providerMessageId });
      return { sent: true };
    } catch (error) {
      // Transport reason codes are stable and carry no provider response text.
      await ctx.runMutation(ref("finishNotice"), { ...args, reason: /^cloudflare_[a-z_]{1,48}$/.test(error?.reasonCode || "") ? error.reasonCode : "notice_send_failed" });
      return { sent: false };
    }
  },
});
