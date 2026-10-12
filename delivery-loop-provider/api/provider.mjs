import { authorizeProviderToken, performEmail, performNarration } from '../../src/delivery-loop/provider-transport.mjs';

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
    if (body.operation === 'health') result = { emailConfigured: Boolean(process.env.RESEND_API_KEY),
      sender: process.env.BEBEBONJOUR_DELIVERY_LOOP_FROM || process.env.RESEND_FROM || 'Bébé Bonjour <bonjour@updates.bebebonjour.com>' };
    else if (body.operation === 'narrate') result = await performNarration(body.payload);
    else if (body.operation === 'sendEmail') result = await performEmail(body.payload);
    else if (body.operation === 'inspectEmail') {
      const id = body.payload?.providerMessageId;
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(id || '')) throw new Error('email_inspection_invalid');
      const providerResponse = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(30_000),
      });
      if (!providerResponse.ok) throw new Error(`email_inspection_http_${providerResponse.status}`);
      result = await providerResponse.json();
    } else return response.status(400).json({ status: 'error', code: 'operation_invalid' });
    return response.status(200).json({ status: 'ok', result });
  } catch (error) {
    const code = /^[A-Za-z0-9_]{1,120}$/.test(error?.message || '') ? error.message : 'provider_transport_uncertain';
    return response.status(502).json({ status: 'error', code });
  }
}
