import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendClient } from '../../src/backend/client.mjs';

test('client sends the exact function protocol for all call kinds', async () => {
  const requests = [];
  const client = createBackendClient('https://backend.example.invalid', { fetch: async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return Response.json({ status: 'success', value: { ok: true }, logLines: [] });
  }});
  for (const kind of ['query', 'mutation', 'action']) {
    assert.deepEqual(await client[kind]('deliveryLoop:read', { token: 'synthetic' }), { ok: true });
    const request = requests.at(-1);
    assert.equal(request.url, `https://backend.example.invalid/api/${kind}`);
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.body, { path: 'deliveryLoop:read', args: [{ token: 'synthetic' }] });
  }
});

test('client propagates backend error text and does not log response bodies', async () => {
  const client = createBackendClient('https://backend.example.invalid', { fetch: async () => Response.json({ status: 'error', errorMessage: 'Uncaught Error: stale_lease', logLines: ['private'] }) });
  await assert.rejects(client.mutation('deliveryLoop:claim', {}), { message: 'Uncaught Error: stale_lease' });
});

test('client rejects malformed and non-success HTTP responses', async () => {
  for (const response of [new Response('private-body', { status: 500 }), Response.json({ invalid: true }), new Response('not-json')]) {
    const client = createBackendClient('https://backend.example.invalid', { fetch: async () => response });
    await assert.rejects(client.query('deliveryLoop:read', {}), { message: 'backend_response_invalid' });
  }
});
