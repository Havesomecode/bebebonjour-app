import { httpActionGeneric } from 'convex/server';

// The accepted Cloudflare inbound forward is external to this application.
// Retired provider callbacks must not read/persist content or acknowledge delivery.
export const supportForwardWebhook = httpActionGeneric(async () => new Response(
  JSON.stringify({ status: 'retired' }), {
    status: 410,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
    },
  },
));
