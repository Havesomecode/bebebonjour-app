import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';
import { convexTest } from 'convex-test';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import schema from '../../convex/schema.js';
import { readSupportRequest, MAX_SUPPORT_EVENT_BYTES } from '../../convex/supportForwardHttp.js';

// Synthetic MIME/transport only. Real router, SDK verification/forwarding and
// Convex atomic mutations run unchanged; no external service is contacted.
const secretBytes = Buffer.from('offline-support-signing-material-32-bytes');
const secret = `whsec_${secretBytes.toString('base64')}`;
const emailId = '11111111-2222-4333-8444-555555555555';
const outboundId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const endpoint = '/support/resend/webhook';
const sha = value => createHash('sha256').update(value).digest('hex');
const modules = {
  './_generated/server.js': () => import('convex/server'),
  './supportForward.js': () => import('../../convex/supportForward.js'),
  './supportForwardHttp.js': () => import('../../convex/supportForwardHttp.js'),
  './supportForwardProvider.js': () => import('../../convex/supportForwardProvider.js'),
  './http.js': () => import('../../convex/http.js'),
};
const ref = name => makeFunctionReference(`supportForward:${name}`);
const rawMime = [
  'From: Synthetic Parent <parent@example.invalid>',
  'To: contact@bebebonjour.com',
  'Reply-To: reply@example.invalid',
  'Subject: =?UTF-8?B?UXVlc3Rpb24gZsOpbGljaXRhdGlvbnM=?=',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="offline-boundary"', '',
  '--offline-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Une question privée — مرحباً.',
  '--offline-boundary', 'Content-Type: application/octet-stream',
  'Content-Disposition: attachment; filename="synthetic.bin"', 'Content-Transfer-Encoding: base64', '',
  Buffer.from([0, 255, 13, 10, 128]).toString('base64'), '--offline-boundary--', '',
].join('\r\n');
function event(overrides = {}) {
  return { type: 'email.received', created_at: '2026-10-17T00:00:00Z', data: {
    email_id: emailId, from: 'Synthetic Parent <parent@example.invalid>',
    to: ['contact@bebebonjour.com'], received_for: ['contact@bebebonjour.com'],
    subject: 'PRIVATE_SUBJECT_SENTINEL', attachments: [{ filename: 'PRIVATE_ATTACHMENT_SENTINEL' }],
    ...overrides,
  } };
}
const encode = value => Buffer.from(JSON.stringify(value, null, 2));
function sign(bytes, { id = 'msg_offline_support_001', timestamp = Math.floor(Date.now() / 1000), key = secretBytes } = {}) {
  return {
    'svix-id': id, 'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.`).update(bytes).digest('base64')}`,
  };
}
const post = (t, bytes = encode(event()), headers = {}) => t.fetch(endpoint, {
  method: 'POST', body: bytes, headers: { 'content-type': 'application/json', ...sign(bytes), ...headers },
});
const receipts = t => t.run(ctx => ctx.db.query('supportForwardReceipts').collect());
function fixture(context) {
  Object.assign(process.env, {
    NODE_ENV: 'test', BEBEBONJOUR_SUPPORT_FORWARD_ENABLED: 'true',
    BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET: secret, RESEND_API_KEY: 're_offline_support_fixture_only',
    // These must not redirect either SDK transport or the fixed mail target.
    RESEND_BASE_URL: 'https://untrusted-override.example.invalid',
    BEBEBONJOUR_SUPPORT_TO: 'attacker@example.invalid', RESEND_FROM: 'attacker@example.invalid',
  });
  const state = { calls: [], posts: [], mode: 'ok', logs: [], rawMime, subject: 'Question félicitations' };
  context.mock.method(console, 'error', (...args) => state.logs.push(args));
  const forbidden = () => { throw new Error('unexpected_live_network_forbidden'); };
  for (const transport of [http, https]) for (const method of ['request', 'get']) context.mock.method(transport, method, forbidden);
  context.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    url = String(url); state.calls.push({ url, method: options.method || 'GET' });
    if (url === `https://api.resend.com/emails/receiving/${emailId}`) {
      assert.equal(options.method, 'GET');
      if (state.mode === 'read_error') return Response.json({ message: 'PRIVATE_PROVIDER_ERROR', name: 'application_error' }, { status: 503 });
      return Response.json({ id: emailId, subject: state.subject, raw: state.mode === 'missing_raw' ? null : { download_url: 'https://synthetic.example.invalid/private-signed-mime' } });
    }
    if (url === 'https://synthetic.example.invalid/private-signed-mime') {
      if (state.mode === 'raw_error') return new Response('PRIVATE_RAW_ERROR', { status: 503 });
      if (state.mode === 'raw_timeout') throw new Error('PRIVATE_RAW_TIMEOUT');
      return new Response(state.rawMime);
    }
    if (url === 'https://api.resend.com/emails') {
      assert.equal(options.method, 'POST');
      const data = JSON.parse(options.body);
      state.posts.push({ data, key: new Headers(options.headers).get('idempotency-key') });
      assert.equal((await receipts(state.t)).find(row => row.emailId === emailId).status, 'inflight', 'durable fence precedes provider mutation');
      if (state.pause) await state.pause;
      if (state.mode === 'timeout') throw new Error('PRIVATE_PROVIDER_TIMEOUT');
      if (state.mode === 'provider_error') return Response.json({ message: 'PRIVATE_PROVIDER_ERROR', name: 'rate_limit_exceeded' }, { status: 429 });
      if (state.mode === 'missing_id') return Response.json({});
      return Response.json({ id: outboundId });
    }
    return forbidden();
  });
  state.t = convexTest(schema, modules);
  return { t: state.t, state };
}
function assertPrivate(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('signed real-router event forwards original UTF8 MIME and base64 attachment through pinned SDK to fixed destination', async context => {
  const { t, state } = fixture(context); const bytes = encode(event());
  const response = await post(t, bytes);
  assert.equal(response.status, 200); assertPrivate(response);
  assert.deepEqual(await response.json(), { status: 'sent' });
  assert.equal(state.posts.length, 1);
  const [{ data, key }] = state.posts;
  assert.equal(data.from, 'Bébé Bonjour <bonjour@updates.bebebonjour.com>');
  assert.equal(data.to, 'z@havesomecode.io');
  assert.equal(data.subject, 'Fwd: Question félicitations');
  assert.equal(data.text, 'Message reçu pour contact@bebebonjour.com. Le message original et ses pièces jointes sont joints.');
  assert.equal(data.html, undefined); assert.equal(data.cc, undefined); assert.equal(data.bcc, undefined);
  assert.equal(key, `support-forward:${emailId}`);
  assert.equal(data.attachments.length, 1);
  assert.equal(data.attachments[0].filename, 'forwarded_message.eml');
  assert.equal(data.attachments[0].content_type, 'message/rfc822');
  assert.equal(Buffer.from(data.attachments[0].content, 'base64').toString('utf8'), rawMime);
  const [row] = await receipts(t);
  assert.equal(row.rawBodySha256, sha(bytes)); assert.equal(row.providerMessageId, outboundId);
  assert.equal(row.status, 'sent'); assert.equal(row.emailId, emailId);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|parent@|contact@|havesomecode|download|Question|attachment|subject|rawMime/);
  assert.deepEqual(state.logs, []);
  for (const response of await Promise.all(Array.from({ length: 8 }, () => post(t, bytes)))) assert.equal(response.status, 200);
  assert.deepEqual(await receipts(t), [row]); assert.equal(state.posts.length, 1); assert.equal(state.calls.length, 3);
});

const opaqueMimeCases = [
  ['ISO8859-1 8bit body', Buffer.concat([
    Buffer.from('From: parent@example.invalid\r\nTo: contact@bebebonjour.com\r\nReply-To: reply@example.invalid\r\nSubject: question\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nUne question sur le pr', 'ascii'),
    Buffer.from([0xe9]), Buffer.from('nom\r\n', 'ascii'),
  ])],
  ['binary MIME attachment', Buffer.concat([
    Buffer.from('From: parent@example.invalid\r\nReply-To: reply@example.invalid\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="binary-boundary"\r\n\r\n--binary-boundary\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="opaque.bin"\r\nContent-Transfer-Encoding: binary\r\n\r\n', 'ascii'),
    Buffer.from([0, 0xff, 0xe9, 0x80, 0xc3, 0x28, 13, 10]), Buffer.from('\r\n--binary-boundary--\r\n', 'ascii'),
  ])],
];
for (const [name, original] of opaqueMimeCases) test(`forwarded .eml preserves every original byte: ${name}`, async context => {
  const { t, state } = fixture(context); state.rawMime = original;
  const bytes = encode(event());
  const response = await post(t, bytes);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'sent' });
  const [{ data, key }] = state.posts;
  assert.deepEqual(Buffer.from(data.attachments[0].content, 'base64'), original);
  assert.equal(data.attachments[0].content_type, 'message/rfc822');
  assert.equal(data.attachments[0].filename, 'forwarded_message.eml');
  assert.equal(data.to, 'z@havesomecode.io'); assert.equal(data.from, 'Bébé Bonjour <bonjour@updates.bebebonjour.com>');
  assert.equal(key, `support-forward:${emailId}`);
  const [row] = await receipts(t); assert.equal(row.status, 'sent'); assert.equal(row.providerMessageId, outboundId);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|parent@|download|opaque|iso-8859|charset|attachment/i);
  assert.equal((await post(t, bytes)).status, 200); assert.equal(state.posts.length, 1); assert.deepEqual(state.logs, []);
});

test('concurrent first delivery, in-flight retries and different webhook IDs cannot issue a second send', { timeout: 5000 }, async context => {
  const { t, state } = fixture(context); const bytes = encode(event()); let release;
  state.pause = new Promise(resolve => { release = resolve; });
  const first = post(t, bytes);
  while (!state.posts.length) await new Promise(resolve => setTimeout(resolve, 5));
  const retries = await Promise.all(Array.from({ length: 8 }, (_, i) => post(t, bytes, sign(bytes, { id: `msg_retry_${i}` }))));
  assert.ok(retries.every(r => r.status === 503)); assert.equal(state.posts.length, 1);
  release(); assert.equal((await first).status, 200);
  assert.equal((await post(t, bytes, sign(bytes, { id: 'msg_new_delivery_id' }))).status, 200);
  assert.equal((await receipts(t)).length, 1); assert.equal(state.posts.length, 1);
});

test('same ID with changed signed bytes or another email is refused without overwriting its receipt', async context => {
  const { t, state } = fixture(context); const bytes = encode(event()); await post(t, bytes);
  const before = await receipts(t);
  for (const changed of [Buffer.concat([bytes, Buffer.from(' ')]), encode(event({ email_id: '22222222-2222-4333-8444-555555555555' }))]) {
    const response = await post(t, changed); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'reconciliation_required' });
  }
  assert.deepEqual(await receipts(t), before); assert.equal(state.posts.length, 1);
});

test('strict receiving envelope, not spoofable To/cc/bcc, decides routing; aliases and loops are ignored', async context => {
  const { t, state } = fixture(context);
  const cases = [
    { received_for: ['other@bebebonjour.com'] }, { received_for: ['contact+alias@bebebonjour.com'] },
    { received_for: ['contact@bebebonjour.com', 'other@bebebonjour.com'] }, { received_for: [' contact@bebebonjour.com'] },
    ...['z@havesomecode.io', 'contact@bebebonjour.com', 'bonjour@updates.bebebonjour.com'].flatMap(from => [{ from }, { from: `Loop <${from.toUpperCase()}>` }]),
  ];
  for (let i = 0; i < cases.length; i++) {
    const bytes = encode(event({ ...cases[i], email_id: `11111111-2222-4333-8444-${String(i).padStart(12, '0')}` }));
    const response = await post(t, bytes, sign(bytes, { id: `msg_ignored_${i}` }));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ignored' });
  }
  assert.equal(state.calls.length, 0); assert.equal((await receipts(t)).length, cases.length);
  const bytes = encode(event({ received_for: ['CONTACT@BEBEBONJOUR.COM'], to: ['attacker@example.invalid'], cc: ['attacker@example.invalid'] }));
  assert.equal((await post(t, bytes)).status, 200); assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].data.to, 'z@havesomecode.io');
});

test('forged, absent, stale, future and byte-mutated signatures fail before persistence or provider use', async context => {
  const { t, state } = fixture(context); const bytes = encode(event()); const now = Math.floor(Date.now() / 1000);
  for (const headers of [
    { 'svix-id': '' }, { 'svix-timestamp': '' }, { 'svix-signature': '' },
    sign(bytes, { timestamp: now - 301 }), sign(bytes, { timestamp: now + 301 }),
    sign(bytes, { key: Buffer.from('wrong-secret') }), sign(Buffer.concat([bytes, Buffer.from(' ')])),
    { 'svix-timestamp': `${now}junk` }, { 'svix-id': 'x'.repeat(257) }, { 'svix-signature': 'x'.repeat(2049) },
  ]) assert.equal((await post(t, bytes, headers)).status, 400);
  assert.equal(state.calls.length, 0); assert.deepEqual(await receipts(t), []);
  const good = sign(bytes);
  const rotated = { ...good, 'svix-signature': `v1,${Buffer.alloc(32).toString('base64')} ${good['svix-signature']}` };
  assert.equal((await post(t, bytes, rotated)).status, 200);
});

test('malformed event, encoding, method and bounded raw request are rejected without effects', async context => {
  const { t, state } = fixture(context);
  for (const bytes of [Buffer.from('{broken'), Buffer.from([0xff, 0xfe]), encode([]), encode({ type: 'email.received' }), encode(event({ email_id: '../escape' })), encode(event({ received_for: undefined })), encode(event({ from: 'broken' }))]) {
    assert.equal((await post(t, bytes)).status, 400);
  }
  const bytes = encode(event());
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }]) assert.equal((await post(t, bytes, headers)).status, 400);
  assert.equal((await post(t, Buffer.alloc(MAX_SUPPORT_EVENT_BYTES + 1, 32))).status, 413);
  assert.equal((await post(t, bytes, { 'content-length': String(MAX_SUPPORT_EVENT_BYTES + 1) })).status, 413);
  assert.equal((await t.fetch(endpoint, { method: 'GET' })).status, 404);
  assert.equal(state.calls.length, 0); assert.deepEqual(await receipts(t), []);
  let cancelled = false;
  const request = { headers: new Headers({ 'content-type': 'application/json', ...sign(bytes) }), body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_SUPPORT_EVENT_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }) };
  await assert.rejects(readSupportRequest(request), /support_event_too_large/); assert.equal(cancelled, true);
});

test('unsubscribed event types are ignored without forwarding or ledger pollution', async context => {
  const { t, state } = fixture(context); const bytes = encode({ ...event(), type: 'email.delivered' });
  const response = await post(t, bytes); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ignored' });
  assert.equal(state.calls.length, 0); assert.deepEqual(await receipts(t), []);
});

test('disabled/missing configuration fails closed without reading provider or creating a fence', async context => {
  const { t, state } = fixture(context);
  for (const key of ['BEBEBONJOUR_SUPPORT_FORWARD_ENABLED', 'BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET', 'RESEND_API_KEY']) {
    const value = process.env[key]; delete process.env[key];
    const response = await post(t); assert.equal(response.status, 503); assertPrivate(response);
    process.env[key] = value;
  }
  const signingSecret = process.env.BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET;
  process.env.BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET = 'malformed!';
  assert.equal((await post(t)).status, 503);
  process.env.BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET = signingSecret;
  assert.equal(state.calls.length, 0); assert.deepEqual(await receipts(t), []);
});

for (const mode of ['timeout', 'provider_error', 'missing_id', 'read_error', 'missing_raw', 'raw_error', 'raw_timeout']) test(`uncertain ${mode} is durable and never retried, even beyond provider idempotency expiry`, async context => {
  const { t, state } = fixture(context); state.mode = mode; const bytes = encode(event());
  const response = await post(t, bytes); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'reconciliation_required' });
  const [row] = await receipts(t); assert.equal(row.status, 'reconciliation_required');
  const calls = state.calls.length; const posts = state.posts.length;
  if (['read_error', 'missing_raw', 'raw_error', 'raw_timeout'].includes(mode)) assert.equal(posts, 0);
  await t.run(async ctx => { await ctx.db.patch(row._id, { startedAtMs: Date.now() - 48 * 60 * 60 * 1000 }); });
  state.mode = 'ok';
  for (let i = 0; i < 3; i++) assert.equal((await post(t, bytes, sign(bytes, { id: `msg_after_failure_${i}` }))).status, 503);
  assert.equal(state.calls.length, calls); assert.equal(state.posts.length, posts);
  assert.doesNotMatch(JSON.stringify(await receipts(t)), /PRIVATE|download_url|subject|attachment|parent@/i);
  assert.deepEqual(state.logs, []);
});

test('crash after fence and stale completion cannot reopen or duplicate a send; all transitions internal', async context => {
  const { t, state } = fixture(context); const bytes = encode(event());
  const identity = { eventId: 'msg_offline_support_001', emailId, rawBodySha256: sha(bytes) };
  const claim = await t.mutation(ref('begin'), { ...identity, disposition: 'forward' });
  assert.equal(claim.status, 'claimed');
  const [row] = await receipts(t);
  await t.run(ctx => ctx.db.patch(row._id, { startedAtMs: Date.now() - 48 * 60 * 60 * 1000 }));
  assert.equal((await post(t, bytes)).status, 503); assert.equal(state.calls.length, 0);
  await assert.rejects(t.mutation(ref('finish'), { ...identity, rawBodySha256: '0'.repeat(64), providerMessageId: outboundId }), /support_fence_mismatch/);
  await t.mutation(ref('finish'), { ...identity, providerMessageId: outboundId });
  await t.mutation(ref('finish'), identity);
  assert.equal((await receipts(t))[0].status, 'sent'); assert.equal((await post(t, bytes)).status, 200);
  const store = await import('../../convex/supportForward.js'); const provider = await import('../../convex/supportForwardProvider.js');
  for (const fn of [store.begin, store.finish, provider.receive]) assert.equal(fn.isInternal, true);
  assert.throws(() => https.request('https://api.resend.com'), /unexpected_live_network_forbidden/);
});

for (const commitApplied of [false, true]) test(`provider acceptance followed by ${commitApplied ? 'lost commit acknowledgement' : 'failed commit'} cannot authorize another send`, async context => {
  const { t, state } = fixture(context); const bytes = encode(event());
  const { receive } = await import('../../convex/supportForwardProvider.js');
  const { supportForwardWebhook } = await import('../../convex/supportForwardHttp.js');
  const signed = sign(bytes);
  const identity = { eventId: signed['svix-id'], emailId, rawBodySha256: sha(bytes), disposition: 'forward' };
  await assert.rejects(receive._handler({ runMutation: async (reference, args) => {
    if (getFunctionName(reference) === 'supportForward:finish') {
      if (commitApplied) await t.mutation(reference, args);
      throw new Error('PRIVATE_COMMIT_UNCERTAINTY');
    }
    return t.mutation(reference, args);
  } }, identity), /PRIVATE_COMMIT_UNCERTAINTY/);
  assert.equal(state.posts.length, 1);
  assert.equal((await receipts(t))[0].status, commitApplied ? 'sent' : 'inflight');
  const response = await post(t, bytes);
  assert.equal(response.status, commitApplied ? 200 : 503); assert.equal(state.posts.length, 1);
  const failedResponse = await supportForwardWebhook._handler({ runAction: async () => { throw new Error('PRIVATE_COMMIT_UNCERTAINTY'); } },
    new Request('https://offline.example.invalid' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...signed }, body: bytes }));
  assert.equal(failedResponse.status, 503); assert.deepEqual(await failedResponse.json(), { status: 'unavailable' });
  assert.deepEqual(state.logs, []);
});

test('support activity leaves seeded owner/payment records and paid-disabled flags untouched', async context => {
  const { t } = fixture(context);
  process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED = 'false'; process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED = 'false';
  const ids = await t.run(async ctx => Promise.all([
    ctx.db.insert('ownerTrialReviews', { jobId: 'job_owner_trial_support_fixture', decisionType: 'publish', receipt: { synthetic: true } }),
    ctx.db.insert('deliveryLoopPaymentEvents', { providerAccountId: 'acct_synthetic', providerEventId: 'evt_support_fixture', rawBodySha256: 'a'.repeat(64), type: 'payment_intent.succeeded', livemode: true, disposition: 'settled', reason: 'accepted', processedAtMs: 1 }),
  ]));
  const before = await t.run(ctx => Promise.all(ids.map(id => ctx.db.get(id))));
  await post(t);
  assert.deepEqual(await t.run(ctx => Promise.all(ids.map(id => ctx.db.get(id)))), before);
  assert.equal(process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED, 'false'); assert.equal(process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED, 'false');
});

test('raw signed content and webhook credentials never cross the internal action seam; exact byte limit is inclusive', async context => {
  const { t, state } = fixture(context);
  const { supportForwardWebhook } = await import('../../convex/supportForwardHttp.js');
  const body = encode(event()); const bytes = Buffer.concat([body, Buffer.alloc(MAX_SUPPORT_EVENT_BYTES - body.length, 32)]);
  const response = await supportForwardWebhook._handler({ runAction: async (reference, args) => {
    assert.equal(getFunctionName(reference), 'supportForwardProvider:receive');
    assert.deepEqual(args, { emailId, eventId: 'msg_offline_support_001', rawBodySha256: sha(bytes), disposition: 'forward' });
    assert.doesNotMatch(JSON.stringify(args), /PRIVATE|subject|attachment|signature|payload|parent@|whsec|re_offline/);
    return t.action(reference, args);
  } }, new Request('https://offline.example.invalid' + endpoint, { method: 'POST', body: bytes, headers: { 'content-type': 'application/json; charset=utf-8', ...sign(bytes) } }));
  assert.equal(response.status, 200); assert.equal(state.posts.length, 1);
});
