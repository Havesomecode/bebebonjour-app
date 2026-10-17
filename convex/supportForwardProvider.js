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
      const received = await resend.emails.receiving.get(identity.emailId);
      if (received.error || !received.data?.raw?.download_url) throw new Error('support_raw_unavailable');
      const raw = await fetch(received.data.raw.download_url, { signal: AbortSignal.timeout(30_000) });
      if (!raw.ok) throw new Error('support_raw_unavailable');
      // Never use receiving.forward: SDK6.20.0 decodes MIME as UTF8 text,
      // corrupting non-UTF8/8bit/binary originals before attaching them.
      const content = Buffer.from(await raw.arrayBuffer()).toString('base64');
      const subject = received.data.subject || '(no subject)';
      const result = await resend.emails.send({
        from: sender, to: destination,
        subject: subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`,
        text: 'Message reçu pour contact@bebebonjour.com. Le message original et ses pièces jointes sont joints.',
        attachments: [{ filename: 'forwarded_message.eml', content, contentType: 'message/rfc822' }],
      }, { idempotencyKey: `support-forward:${identity.emailId}`, signal: AbortSignal.timeout(30_000) });
      if (!result.error && typeof result.data?.id === 'string' && uuid.test(result.data.id)) providerMessageId = result.data.id;
    } catch { /* Unknown provider effect: keep the fence, never auto-resend. */ }
    await ctx.runMutation(finish, { ...identity, ...(providerMessageId ? { providerMessageId } : {}) });
    return { status: providerMessageId ? 'sent' : 'reconciliation_required' };
  },
});
