'use node';

import { internalActionGeneric, makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { Resend } from 'resend';

const destination = 'z@havesomecode.io';
const sender = 'Bébé Bonjour <bonjour@updates.bebebonjour.com>';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const begin = makeFunctionReference('supportForward:begin');
const finish = makeFunctionReference('supportForward:finish');

// Internal only. The signed HTTP boundary supplies identifiers, never content.
export const receive = internalActionGeneric({
  args: { eventId: v.string(), emailId: v.string(), rawBodySha256: v.string(),
    disposition: v.union(v.literal('forward'), v.literal('ignored')) },
  handler: async (ctx, args) => {
    if (process.env.BEBEBONJOUR_SUPPORT_FORWARD_ENABLED !== 'true'
      || !process.env.BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET || !process.env.RESEND_API_KEY) throw new Error('support_unavailable');
    const { disposition, ...identity } = args;
    const claim = await ctx.runMutation(begin, { ...identity, disposition });
    if (claim.status !== 'claimed') return claim;

    let providerMessageId;
    try {
      // Fixed API origin ignores ambient RESEND_BASE_URL. SDK6.20.0 logs
      // freeform errors outside production; suppress those here too.
      const resend = new Resend(process.env.RESEND_API_KEY, { baseUrl: 'https://api.resend.com' });
      resend.logError = () => {};
      const result = await resend.emails.receiving.forward({
        emailId: identity.emailId, from: sender, to: destination, passthrough: false,
        text: 'Message reçu pour contact@bebebonjour.com. Le message original et ses pièces jointes sont joints.',
      }, { idempotencyKey: `support-forward:${identity.emailId}`, signal: AbortSignal.timeout(30_000) });
      if (!result.error && typeof result.data?.id === 'string' && uuid.test(result.data.id)) providerMessageId = result.data.id;
    } catch { /* Unknown provider effect: keep the fence, never auto-resend. */ }
    await ctx.runMutation(finish, { ...identity, ...(providerMessageId ? { providerMessageId } : {}) });
    return { status: providerMessageId ? 'sent' : 'reconciliation_required' };
  },
});
