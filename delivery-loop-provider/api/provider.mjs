import { authorizeProviderToken, performNarration } from '../../src/delivery-loop/provider-transport.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'POST') return response.status(405).json({ status: 'error', code: 'method_not_allowed' });
  const authorization = request.headers.authorization || '';
  try {
    authorizeProviderToken(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
  } catch {
    return response.status(403).json({ status: 'error', code: 'forbidden' });
  }
  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    if (!body || JSON.stringify(body).length > 64_000) return response.status(413).json({ status: 'error', code: 'body_too_large' });
    let result;
    if (body.operation === 'narrate') result = await performNarration(body.payload);
    else return response.status(400).json({ status: 'error', code: 'operation_invalid' });
    return response.status(200).json({ status: 'ok', result });
  } catch (error) {
    const code = /^[A-Za-z0-9_]{1,120}$/.test(error?.message || '') ? error.message : 'provider_transport_uncertain';
    return response.status(502).json({ status: 'error', code });
  }
}
