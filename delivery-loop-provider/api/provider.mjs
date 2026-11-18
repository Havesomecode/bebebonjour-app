// Retired relay: Cloudflare sends require the existing durable Convex admission.
export default async function handler(_request, response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  return response.status(410).json({ status: 'error', code: 'provider_retired' });
}
