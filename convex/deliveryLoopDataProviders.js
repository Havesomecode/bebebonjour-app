"use node";
import { internalActionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { cloudflareTransport, alreadyAdmitted } from "../src/delivery-loop/cloudflare-runtime.mjs";
const ref = name => makeFunctionReference(`deliveryLoopData:${name}`);
export const sendClosureNotice = internalActionGeneric({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const notice = await ctx.runMutation(ref("beginNotice"), args);
    if (!notice) return { skipped: true };
    // Fence before transport; crashes/timeouts never initiate another send,
    // including after provider idempotency TTL. Reconcile from provider evidence.
    try {
      const origin = new URL(process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN || process.env.CONVEX_SITE_URL);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("invalid_origin");
      const url = `${origin.origin}/delivery/review?${new URLSearchParams({ jobId: args.jobId, token: notice.reviewToken })}`;
      const text = `Votre hébergement Bébé Bonjour se termine le ${new Date(notice.hostingEndsAtMs).toISOString().slice(0, 10)}. La page et son audio seront fermés et supprimés à cette échéance, sans renouvellement ni charge automatique. Téléchargez auparavant votre texte final, votre audio et votre archive de page depuis votre espace privé : ${url}\nSupport : contact@bebebonjour.com`;
      const payload = { to: notice.to, subject: "Votre annonce : fin de l’hébergement", text, html: `<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`, idempotencyKey: notice.idempotencyKey };
      const receipt = await cloudflareTransport().send(payload, { fenceExternalEffect: alreadyAdmitted });
      await ctx.runMutation(ref("finishNotice"), { ...args, providerMessageId: receipt.providerMessageId });
      return { sent: true };
    } catch {
      await ctx.runMutation(ref("finishNotice"), args);
      return { reconciliationRequired: true };
    }
  },
});
