import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import Stripe from 'stripe';
import http from 'node:http';
import https from 'node:https';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../convex/schema.js';
import { MAX_PAID_EVENT_BYTES, verifyPaidEvent, readPaidEventBytes } from '../../src/delivery-loop/paid-event.mjs';
import { paidStripeKeyMode, inspectPaidPayment } from '../../src/delivery-loop/paid-payment.mjs';

const workerToken = 'offline-payment-worker-capability-over-32-characters';
const editorialToken = 'offline-payment-human-capability-over-32-characters';
const webhookSecret = 'whsec_offlineSignedEventFixtureNotARealSecret';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ref = name => makeFunctionReference(`deliveryLoop:${name}`);
const modules = {
  './_generated/server.js': () => import('convex/server'),
  './deliveryLoop.js': () => import('../../convex/deliveryLoop.js'),
  './deliveryLoopHttp.js': () => import('../../convex/deliveryLoopHttp.js'),
  './deliveryLoopData.js': () => import('../../convex/deliveryLoopData.js'),
  './deliveryLoopPaymentHttp.js': () => import('../../convex/deliveryLoopPaymentHttp.js'),
  './deliveryLoopPaymentEvents.js': () => import('../../convex/deliveryLoopPaymentEvents.js'),
  './deliveryLoopProviders.js': () => import('../../convex/deliveryLoopProviders.js'),
  './http.js': () => import('../../convex/http.js'),
  './narrationHttp.js': () => import('../../convex/narrationHttp.js'),
};
function fixture(context) {
  Object.assign(process.env, {
    BEBEBONJOUR_DELIVERY_LOOP_TOKEN: workerToken, BEBEBONJOUR_PAID_EDITORIAL_TOKEN: editorialToken,
    BEBEBONJOUR_PAID_ROUTE_A_ENABLED: 'true', BEBEBONJOUR_PAID_TERMS_URL: 'https://offline.example.invalid/terms',
    BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID: 'acct_offline', BEBEBONJOUR_PAID_STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_SECRET_KEY: 'rk_live_offlineFixtureNotARealCredential', CONVEX_SITE_URL: 'https://offline.convex.site',
  });
  delete process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED;
  delete process.env.BEBEBONJOUR_PAID_TEST_PROMO_JSON;
  const state = { intents: new Map(), objects: new Map(), calls: [], account: 'acct_offline', fail: null };
  const forbidden = () => { throw new Error('unexpected_network_forbidden'); };
  context.mock.method(globalThis, 'fetch', forbidden);
  for (const transport of [http, https]) {
    context.mock.method(transport, 'request', forbidden); context.mock.method(transport, 'get', forbidden);
  }
  // Only the transport is synthetic. Actual SDK retrieval, webhook, internal
  // action, genuine-inspection validation and Convex transaction run unchanged.
  context.mock.method(Stripe._platformFunctions, 'createDefaultHttpClient', () => ({
    getClientName: () => 'offline-fixture',
    makeRequest: async (_host, _port, path, method) => {
      assert.equal(method, 'GET', 'no provider mutation or checkout issuance');
      if (state.failAt && path === state.failAt) throw new Stripe.errors.StripePermissionError({ message: 'offline_denied' });
      let value;
      if (path === '/v1/account') { state.calls.push('account'); value = { id: state.account }; }
      else if (state.objects.has(new URL(path, 'https://offline.invalid').pathname)) {
        state.calls.push(path); value = structuredClone(state.objects.get(new URL(path, 'https://offline.invalid').pathname));
      } else {
        const url = new URL(path, 'https://offline.invalid');
        assert.match(url.pathname, /^\/v1\/payment_intents\/pi_[A-Za-z0-9]+$/);
        const id = url.pathname.split('/').at(-1);
        const options = { expand: url.searchParams.getAll('expand[0]') };
        state.calls.push({ id, options }); value = structuredClone(state.intents.get(id));
      }
      if (state.fail) throw state.fail;
      return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: async () => value };
    },
  }));
  return { t: convexTest(schema, modules), state };
}
const read = (t, job) => t.query(ref('read'), { workerToken, jobId: job.jobId });
const claim = t => t.mutation(ref('claim'), { workerToken, workerId: 'offline-fixture', leaseToken: crypto.randomUUID() });
async function ready(t) {
  const intake = { email: `fictional-${crypto.randomUUID()}@example.invalid`, babyName: 'Amal', language: 'fr', gender: 'girl', context: 'general', voiceEnabled: true, consent: true, customerPermissions: true, fictional: true };
  const job = await t.mutation(ref('submit'), { intake, orderMode: 'paid_route_a', previewConsent: true, idempotencyKey: crypto.randomUUID() });
  const lease = await claim(t);
  const contentHtml = '<html><body>Texte privé approuvé.</body></html>';
  const composition = { languages: { fr: { introLines: ['Bienvenue.'], blessingLines: ['Des jours doux.'], closingLines: ['Notre amour.'] } } };
  const p = { revision: 1, contentDigest: sha(contentHtml) };
  await t.mutation(ref('publish'), { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken, revision: 1,
    contentHtml, contentDigest: p.contentDigest, composition, compositionJson: JSON.stringify(composition),
    compositionReceipt: { provider: 'openai-codex-subscription', outputDigest: sha(JSON.stringify(composition)) }, audioFiles: [] });
  const email = await claim(t);
  const identity = { workerToken, jobId: job.jobId, leaseToken: email.leaseToken, revision: 1, stage: 'draft_email' };
  await t.mutation(ref('fence'), identity);
  await t.mutation(ref('completeEmail'), { ...identity, provider: 'cloudflare', providerMessageId: 'offline_preview_notice' });
  await t.mutation(ref('requestReview'), { jobId: job.jobId, reviewToken: job.reviewToken, expectedRevision: 1, action: 'approve', idempotencyKey: crypto.randomUUID() });
  await t.mutation(ref('paidPermissions'), { jobId: job.jobId, reviewToken: job.reviewToken, expectedRevision: 1, termsVersion: 'route-a-39-v1', termsAccepted: true, publication: true });
  return { job, p };
}
async function patch(t, job, data) {
  await t.run(async ctx => {
    const row = await ctx.db.query('deliveryLoopJobs').withIndex('by_job_id', q => q.eq('jobId', job.jobId)).unique();
    await ctx.db.patch(row._id, { data: { ...row.data, ...data } });
  });
}
function eventFixture(job, p, live = true, id = 'evt_offline') {
  const intent = { object: 'payment_intent', id: 'pi_offline', status: 'succeeded', amount: 3900, amount_received: 3900, currency: 'eur', livemode: live,
    metadata: { project: 'bebebonjour', order_mode: 'paid_route_a', job_id: job.jobId, revision: String(p.revision), preview_digest: p.contentDigest },
    latest_charge: { paid: true, captured: true, refunded: false, amount_refunded: 0, disputed: false, amount: 3900, currency: 'eur', payment_intent: 'pi_offline', livemode: live },
    client_secret: 'offline-sensitive-sentinel', customer: 'cus_sensitive', receipt_email: 'private@example.invalid' };
  return { object: 'event', id, type: 'payment_intent.succeeded', livemode: live, data: { object: intent } };
}
const encode = value => Buffer.from(JSON.stringify(value));
function signature(bytes, timestamp = Math.floor(Date.now() / 1000), secret = webhookSecret) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(bytes).digest('hex')}`;
}
const post = (t, bytes, headers = {}) => t.fetch('/delivery/payment/webhook', { method: 'POST', body: bytes,
  headers: { 'content-type': 'application/json', 'stripe-signature': signature(bytes), ...headers } });
const ledger = t => t.run(ctx => ctx.db.query('deliveryLoopPaymentEvents').collect());
const evidence = t => t.run(ctx => ctx.db.query('deliveryLoopPaymentEvidence').collect());
function bind(state, event) { state.intents.set(event.data.object.id, structuredClone(event.data.object)); }
async function assertUnpaid(t, job) { assert.equal((await read(t, job)).payment.status, 'pending'); assert.equal((await evidence(t)).length, 0); assert.equal(await claim(t), null); }

// These are actual HTTP raw-byte proofs, not direct settlement assertions.
test('signed HTTP settlement inspects genuine scope, records redacted immutable ledger, and preserves the human/final fences', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const event = eventFixture(job, p); bind(state, event);
  const bytes = Buffer.from(JSON.stringify(event, null, 2));
  const response = await post(t, bytes); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'settled' });
  assert.equal((await read(t, job)).payment.status, 'settled'); assert.equal(await claim(t), null, 'payment never attests human editorial review');
  assert.equal(state.calls.length, 2); assert.deepEqual(state.calls[1].options, { expand: ['latest_charge'] });
  const [receipt] = await ledger(t); assert.equal(receipt.rawBodySha256, sha(bytes)); assert.equal(receipt.jobId, job.jobId);
  assert.doesNotMatch(JSON.stringify(receipt), /sensitive|client_secret|receipt_email|metadata|latest_charge|private@example/);
  const before = await read(t, job); const receipts = await ledger(t);
  for (const result of await Promise.all(Array.from({ length: 8 }, () => post(t, bytes)))) assert.equal(result.status, 200);
  assert.deepEqual(await read(t, job), before); assert.deepEqual(await ledger(t), receipts); assert.equal((await evidence(t)).length, 1); assert.equal(state.calls.length, 2, 'duplicate does not invoke provider');
  await t.mutation(ref('paidEditorial'), { editorialToken, jobId: job.jobId, expectedRevision: 1, previewDigest: p.contentDigest, reviewerId: 'offline-human', humanReviewed: true });
  const lease = await claim(t); assert.equal(lease.stage, 'finalize');
  const identity = { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken, revision: 1, language: 'fr', textDigest: sha('Bienvenue.\n\nDes jours doux.\n\nNotre amour.') };
  await t.mutation(ref('beginNarration'), identity);
  await assert.rejects(t.mutation(ref('beginNarration'), identity), /narration_reconciliation_required/);
  await t.mutation(ref('fail'), { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken, reason: 'provider_timeout', retryable: true });
  await post(t, bytes); assert.equal((await read(t, job)).status, 'reconciliation_required'); assert.equal(await claim(t), null);
});

test('first-delivery concurrency and changed-byte same identity are atomic; conflicts retain the original receipt and order', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const event = eventFixture(job, p); bind(state, event);
  const bytes = encode(event);
  const responses = await Promise.all(Array.from({ length: 8 }, () => post(t, bytes)));
  assert.ok(responses.every(r => r.status === 200)); assert.equal((await ledger(t)).length, 1); assert.equal((await evidence(t)).length, 1);
  const before = await read(t, job); const [original] = await ledger(t); const changed = Buffer.concat([bytes, Buffer.from(' ')]);
  assert.deepEqual(await (await post(t, changed)).json(), { status: 'rejected' });
  const receipts = await ledger(t); assert.equal(receipts.length, 2); assert.deepEqual(receipts[0], original); assert.equal(receipts[1].reason, 'payment_event_conflict');
  await post(t, changed); assert.deepEqual(await ledger(t), receipts); assert.deepEqual(await read(t, job), before);
});

test('forged, absent, stale, future and changed raw-byte signatures fail before parsing, provider or persistence', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const bytes = encode(eventFixture(job, p));
  const timestamp = Math.floor(Date.now() / 1000);
  for (const header of ['', `t=${timestamp},v1=${'0'.repeat(64)}`, signature(bytes, timestamp - 301), signature(bytes, timestamp + 301), signature(bytes, timestamp, 'whsec_wrongSecret123456789'), signature(Buffer.concat([bytes, Buffer.from(' ')])), `t=${timestamp},${signature(bytes)}`, 'x'.repeat(2049)]) {
    assert.equal((await post(t, bytes, { 'stripe-signature': header })).status, 400);
  }
  await assert.rejects(verifyPaidEvent(bytes, signature(bytes), undefined), /payment_event_configuration/);
  assert.equal(state.calls.length, 0); assert.deepEqual(await ledger(t), []); await assertUnpaid(t, job);
});

test('Stripe v1 rotation and exact tolerance boundary authenticate unmodified UTF8 bytes', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const event = eventFixture(job, p); bind(state, event);
  event.description = 'Félicitations — مرحباً'; const bytes = encode(event); const timestamp = Math.floor(Date.now() / 1000);
  const header = `${signature(bytes, timestamp)},v1=${'0'.repeat(64)},v0=legacy`;
  assert.equal((await verifyPaidEvent(bytes, header, webhookSecret, timestamp * 1000 + 300000)).rawBodySha256, sha(bytes));
  await assert.rejects(verifyPaidEvent(bytes, header, webhookSecret, timestamp * 1000 + 300001), /payment_event_signature/);
  assert.equal((await post(t, bytes, { 'stripe-signature': header })).status, 200);
  assert.doesNotMatch(JSON.stringify(await ledger(t)), /Félicitations|مرحبا|description/);
});

test('new adapter functions are internal only and offline transport guards prohibit accidental live reads', async context => {
  fixture(context);
  const events = await import('../../convex/deliveryLoopPaymentEvents.js'); const providers = await import('../../convex/deliveryLoopProviders.js');
  for (const fn of [events.lookupEvent, events.recordEvent, providers.reconcilePaidEvent]) assert.equal(fn.isInternal, true);
  assert.throws(() => https.request('https://api.stripe.com'), /unexpected_network_forbidden/);
  assert.throws(() => http.request('http://api.stripe.com'), /unexpected_network_forbidden/);
  assert.throws(() => fetch('https://api.stripe.com'), /unexpected_network_forbidden/);
});

test('strict signed format, bounded headers/body and chunked raw-body limits reject without effects', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const event = eventFixture(job, p);
  for (const bytes of [Buffer.from('{invalid'), Buffer.from([0xff, 0xfe]), encode({ ...event, type: 'checkout.session.completed' }), encode({ ...event, id: 'not-event' }), encode({ ...event, livemode: 'true' }), encode([])]) assert.equal((await post(t, bytes)).status, 400);
  const huge = Buffer.alloc(MAX_PAID_EVENT_BYTES + 1, 32); assert.equal((await post(t, huge)).status, 413);
  assert.equal((await post(t, encode(event), { 'content-length': String(MAX_PAID_EVENT_BYTES + 1) })).status, 413);
  assert.equal((await post(t, encode(event), { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await post(t, encode(event), { 'content-encoding': 'gzip' })).status, 400);
  let cancelled = false;
  const request = new Request('https://offline.invalid', { method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_PAID_EVENT_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }) });
  await assert.rejects(readPaidEventBytes(request), /payment_event_too_large/); assert.equal(cancelled, true);
  assert.equal(state.calls.length, 0); assert.deepEqual(await ledger(t), []); await assertUnpaid(t, job);
});

test('signed wrong account/job/revision/digest/offer/mode is durably rejected without advancing an order', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const base = eventFixture(job, p);
  const variants = [
    e => { e.account = 'acct_wrong'; }, e => { e.data.object.metadata.job_id = 'job_unknown'; },
    e => { e.data.object.metadata.revision = '2'; }, e => { e.data.object.metadata.preview_digest = 'a'.repeat(64); },
    e => { e.data.object.currency = 'usd'; }, e => { e.data.object.amount = 3800; }, e => { e.data.object.amount_received = 3899; },
    e => { e.data.object.metadata.project = 'foreign'; }, e => { e.data.object.metadata.order_mode = 'complimentary'; },
    e => { e.data.object.livemode = false; }, e => { delete e.data.object.metadata.preview_digest; },
  ];
  for (const [i, mutate] of variants.entries()) {
    const event = structuredClone(base); event.id = `evt_wrong${i}`; mutate(event); bind(state, event);
    assert.deepEqual(await (await post(t, encode(event))).json(), { status: 'rejected' }); await assertUnpaid(t, job);
  }
  assert.equal((await ledger(t)).length, variants.length); assert.ok((await ledger(t)).every(r => r.disposition === 'rejected'));
});

test('provider current metadata, account, mode and settled non-refunded/non-disputed charge are independently authoritative', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const base = eventFixture(job, p);
  const variants = [
    i => { i.metadata.job_id = 'job_foreign'; }, i => { i.metadata.preview_digest = 'b'.repeat(64); }, i => { i.metadata.revision = '2'; },
    i => { i.amount_received = 0; }, i => { i.status = 'processing'; }, i => { i.currency = 'usd'; },
    i => { i.latest_charge.refunded = true; }, i => { i.latest_charge.amount_refunded = 1; }, i => { i.latest_charge.disputed = true; },
    i => { i.latest_charge.captured = false; }, i => { i.latest_charge.payment_intent = 'pi_other'; },
    i => { i.livemode = false; i.latest_charge.livemode = false; },
  ];
  for (const [n, mutate] of variants.entries()) {
    const event = structuredClone(base); event.id = `evt_provider${n}`; bind(state, event); mutate(state.intents.get('pi_offline'));
    assert.deepEqual(await (await post(t, encode(event))).json(), { status: 'rejected' }); await assertUnpaid(t, job);
  }
  state.account = 'acct_wrong'; bind(state, base); base.id = 'evt_provideraccount';
  assert.deepEqual(await (await post(t, encode(base))).json(), { status: 'rejected' }); await assertUnpaid(t, job);
});

test('stale approvals and cancelled/revoked/deleted/expired/complimentary scopes reject atomically at commit', async context => {
  const { t, state } = fixture(context);
  for (const [n, change] of [
    { paidApproval: null }, { paidPermissions: null }, { desiredRevision: 2 }, { cancelledAtMs: Date.now() },
    { revokedAtMs: Date.now() }, { deletionRequestedAtMs: Date.now() }, { deletedAtMs: Date.now() },
    { previewExpiresAtMs: Date.now() - 1 }, { orderMode: 'complimentary' },
    { paidApproval: { revision: 1, previewDigest: 'b'.repeat(64) } },
    { paidPermissions: { revision: 1, previewDigest: 'b'.repeat(64), termsVersion: 'route-a-39-v1', publication: true } },
    { paidPermissions: { revision: 1, previewDigest: 'invalid', termsVersion: 'old-terms', publication: false } },
  ].entries()) {
    const { job, p } = await ready(t); const event = eventFixture(job, p, true, `evt_scope${n}`); bind(state, event); await patch(t, job, change);
    assert.deepEqual(await (await post(t, encode(event))).json(), { status: 'rejected' }); assert.equal((await evidence(t)).length, 0);
    const row = await t.run(ctx => ctx.db.query('deliveryLoopJobs').withIndex('by_job_id', q => q.eq('jobId', job.jobId)).unique()); assert.equal(row.data.payment.status, 'pending');
  }
});

test('test signed settlement stays test_only and cannot downgrade settled live payment; exact replay survives erasure', async context => {
  const { t, state } = fixture(context); process.env.STRIPE_SECRET_KEY = 'rk_test_offlineFixtureNotARealCredential';
  const { job, p } = await ready(t); const event = eventFixture(job, p, false); bind(state, event);
  assert.deepEqual(await (await post(t, encode(event))).json(), { status: 'test_only' }); assert.equal((await read(t, job)).payment.status, 'test_only'); assert.equal(await claim(t), null);
  await t.mutation(ref('paidEditorial'), { editorialToken, jobId: job.jobId, expectedRevision: 1, previewDigest: p.contentDigest, reviewerId: 'offline-human', humanReviewed: true }); assert.equal(await claim(t), null);
  process.env.STRIPE_SECRET_KEY = 'rk_live_offlineFixtureNotARealCredential';
  const live = eventFixture(job, p, true, 'evt_live'); live.data.object.id = 'pi_livefixture'; live.data.object.latest_charge.payment_intent = 'pi_livefixture'; bind(state, live);
  assert.deepEqual(await (await post(t, encode(live))).json(), { status: 'settled' }); assert.equal((await read(t, job)).payment.status, 'settled');
  const testAgain = { ...event, id: 'evt_testnew' }; bind(state, testAgain); process.env.STRIPE_SECRET_KEY = 'rk_test_offlineFixtureNotARealCredential';
  assert.deepEqual(await (await post(t, encode(testAgain))).json(), { status: 'test_only' }); assert.equal((await read(t, job)).payment.status, 'settled', 'an existing test receipt cannot downgrade the live order');
  await patch(t, job, { deletedAtMs: Date.now() }); const before = await ledger(t); const calls = state.calls.length;
  await post(t, encode(live)); assert.deepEqual(await ledger(t), before); assert.equal(state.calls.length, calls);
});

test('transient provider failures and restricted-key permission refusal return retryable503 with no ack/ledger; retry succeeds', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const event = eventFixture(job, p); bind(state, event);
  for (const failure of [new Error('ECONNRESET'), new Error('payment_evidence_mismatch'), new Stripe.errors.StripePermissionError({ message: 'sensitive provider refusal' }), new Stripe.errors.StripeRateLimitError({ message: 'rate_limit' })]) {
    state.fail = failure; const response = await post(t, encode(event)); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'payment_event_retry' });
    assert.deepEqual(await ledger(t), []); await assertUnpaid(t, job);
  }
  state.fail = null; assert.equal((await post(t, encode(event))).status, 200); assert.equal((await ledger(t)).length, 1);
});

test('failed datastore commit rolls back evidence and event receipt; same signed event remains retryable', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const event = eventFixture(job, p); bind(state, event);
  await patch(t, job, { offlinePadding: 'x'.repeat(850000) });
  assert.equal((await post(t, encode(event))).status, 503); assert.deepEqual(await ledger(t), []); await assertUnpaid(t, job);
  await patch(t, job, { offlinePadding: '' }); assert.equal((await post(t, encode(event))).status, 200); assert.equal((await evidence(t)).length, 1);
});

test('different event reusing a PaymentIntent across jobs rejects; manual recovery and event share one payment authority', async context => {
  const { t, state } = fixture(context); const a = await ready(t); const event = eventFixture(a.job, a.p); bind(state, event);
  await t.action(makeFunctionReference('deliveryLoopProviders:reconcilePaidPayment'), { editorialToken, jobId: a.job.jobId, expectedRevision: 1, providerPaymentId: 'pi_offline' });
  const before = await read(t, a.job); await post(t, encode(event)); assert.deepEqual(await read(t, a.job), before); assert.equal((await evidence(t)).length, 1);
  const b = await ready(t); const other = eventFixture(b.job, b.p, true, 'evt_otherjob'); bind(state, other);
  assert.deepEqual(await (await post(t, encode(other))).json(), { status: 'rejected' }); assert.equal((await read(t, b.job)).payment.status, 'pending');
  assert.equal((await ledger(t)).at(-1).reason, 'payment_evidence_conflict');
});

test('real privacy erasure keeps only distinct financial/replay evidence and duplicates cannot restore content or eligibility', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const event = eventFixture(job, p); bind(state, event);
  await post(t, encode(event)); const before = await ledger(t);
  await t.mutation(makeFunctionReference('deliveryLoopData:customerControl'), { jobId: job.jobId, reviewToken: job.reviewToken, action: 'delete' });
  const row = await t.run(ctx => ctx.db.query('deliveryLoopJobs').withIndex('by_job_id', q => q.eq('jobId', job.jobId)).unique());
  assert.equal(row.status, 'data_deleted'); assert.equal(row.data.intake, undefined); assert.equal(row.data.revisions, undefined);
  const calls = state.calls.length; assert.deepEqual(await (await post(t, encode(event))).json(), { status: 'settled' });
  assert.deepEqual(await ledger(t), before); assert.equal(state.calls.length, calls); assert.equal((await evidence(t)).length, 1);
  const after = await t.run(ctx => ctx.db.get(row._id)); assert.deepEqual(after, row); assert.equal(await claim(t), null);
});

test('durable rejection is immutable after repaired consent; genuine manual reconciliation remains the recovery seam', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const approval = (await read(t, job)).paidApproval;
  const event = eventFixture(job, p); bind(state, event); await patch(t, job, { paidApproval: null });
  assert.deepEqual(await (await post(t, encode(event))).json(), { status: 'rejected' }); const rejected = await ledger(t);
  await patch(t, job, { paidApproval: approval }); const calls = state.calls.length;
  assert.deepEqual(await (await post(t, encode(event))).json(), { status: 'rejected' }); assert.equal(state.calls.length, calls); await assertUnpaid(t, job);
  await t.action(makeFunctionReference('deliveryLoopProviders:reconcilePaidPayment'), { editorialToken, jobId: job.jobId, expectedRevision: 1, providerPaymentId: 'pi_offline' });
  assert.equal((await read(t, job)).payment.status, 'settled'); assert.deepEqual(await ledger(t), rejected); assert.equal(await claim(t), null);
});

test('restricted read credential modes are accepted; invalid or cross-mode evidence fails closed', async () => {
  for (const prefix of ['sk', 'rk']) { assert.equal(paidStripeKeyMode(`${prefix}_test_offline`), false); assert.equal(paidStripeKeyMode(`${prefix}_live_offline`), true); }
  for (const key of ['', 'pk_live_offline', 'rk_live_', 'sk_live_offline\n']) assert.throws(() => paidStripeKeyMode(key), /payment_configuration_invalid/);
  const scope = { jobId: 'job_offline', revision: 1, previewDigest: 'a'.repeat(64) }; const event = eventFixture({ jobId: scope.jobId }, { revision: 1, contentDigest: scope.previewDigest }, false);
  const stripe = { accounts: { retrieve: async () => ({ id: 'acct_offline' }) }, paymentIntents: { retrieve: async () => event.data.object } };
  await assert.rejects(inspectPaidPayment({ scope, providerPaymentId: 'pi_offline', accountId: 'acct_offline', apiKey: 'rk_live_offline', stripe }), /payment_evidence_mismatch/);
  assert.equal((await inspectPaidPayment({ scope, providerPaymentId: 'pi_offline', accountId: 'acct_offline', apiKey: 'rk_test_offline', stripe })).livemode, false);
});

function promoFixture(state, job, p, n = 0) {
  const event = eventFixture(job, p, true, `evt_promo${n}`);
  const intent = event.data.object;
  intent.id = `pi_promo${n}`; intent.amount = intent.amount_received = intent.latest_charge.amount = 100;
  intent.latest_charge.payment_intent = intent.id; bind(state, event);
  const sessionId = `cs_live_offline${n}`;
  const session = { id: sessionId, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
    payment_intent: intent.id, livemode: true, currency: 'eur', amount_subtotal: 3900, amount_total: 100,
    total_details: { amount_discount: 3800, amount_tax: 0, amount_shipping: 0 }, metadata: { ...intent.metadata },
    discounts: [{ coupon: 'coupon_offline', promotion_code: 'promo_offline' }] };
  const promotion = { id: 'promo_offline', object: 'promotion_code', promotion: { type: 'coupon', coupon: 'coupon_offline' },
    livemode: true, max_redemptions: 5, times_redeemed: 1, active: true };
  const coupon = { id: 'coupon_offline', object: 'coupon', amount_off: 3800, currency: 'eur', percent_off: null,
    duration: 'once', max_redemptions: 5, times_redeemed: 1, livemode: true, valid: true };
  state.objects.set(`/v1/checkout/sessions/${sessionId}`, session);
  state.objects.set('/v1/promotion_codes/promo_offline', promotion); state.objects.set('/v1/coupons/coupon_offline', coupon);
  const binding = { jobId: job.jobId, revision: p.revision, previewDigest: p.contentDigest, checkoutSessionId: sessionId };
  const policy = { policyId: 'owner1038-five-tests-v1', providerAccountId: 'acct_offline', livemode: true,
    couponId: coupon.id, promotionCodeId: promotion.id, endsAtMs: Date.now() + 3600000, bindings: [binding] };
  process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED = 'true'; process.env.BEBEBONJOUR_PAID_TEST_PROMO_JSON = JSON.stringify(policy);
  return { event, policy, binding, session, promotion, coupon };
}
const setPolicy = policy => { process.env.BEBEBONJOUR_PAID_TEST_PROMO_JSON = JSON.stringify(policy); };

test('promo: concurrent fifth/sixth attempts have a single winner; deactivation between inspection and commit blocks settlement', async context => {
  const { t, state } = fixture(context);
  for (let n = 0; n < 4; n++) {
    const { job, p } = await ready(t); const x = promoFixture(state, job, p, n);
    assert.deepEqual(await (await post(t, encode(x.event))).json(), { status: 'settled' });
  }
  const a = await ready(t), b = await ready(t);
  const x = promoFixture(state, a.job, a.p, 40), y = promoFixture(state, b.job, b.p, 41);
  y.policy.bindings.push(x.binding); setPolicy(y.policy);
  const result = await Promise.all([post(t, encode(x.event)), post(t, encode(y.event))]);
  assert.deepEqual((await Promise.all(result.map(r => r.json()))).map(r => r.status).sort(), ['rejected', 'settled']);
  assert.equal((await evidence(t)).length, 5);
  const c = await ready(t); const z = promoFixture(state, c.job, c.p, 42);
  const { testPromotionBinding } = await import('../../src/delivery-loop/test-promotion.mjs');
  const promotion = testPromotionBinding({ jobId: c.job.jobId, revision: 1, previewDigest: c.p.contentDigest }, 'acct_offline', true);
  process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED = 'false';
  await assert.rejects(t.mutation(ref('recordPaymentEvidence'), { jobId: c.job.jobId, revision: 1, previewDigest: c.p.contentDigest,
    providerPaymentId: z.event.data.object.id, providerAccountId: 'acct_offline', amountMinor: 100, currency: 'eur', livemode: true, settled: true, promotion }), /payment_evidence_mismatch/);
  assert.equal((await read(t, c.job)).payment.status, 'pending');
});

test('promo: native discount settles once, retains human review and committed payment after deactivation', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const { event, promotion, coupon } = promoFixture(state, job, p);
  promotion.times_redeemed = coupon.times_redeemed = 5; promotion.active = coupon.valid = false;
  const bytes = encode(event);
  assert.deepEqual(await (await post(t, bytes)).json(), { status: 'settled' });
  const before = await read(t, job); assert.equal(before.payment.amountMinor, 100);
  assert.equal(before.payment.promotion.policyId, 'owner1038-five-tests-v1'); assert.equal(before.payment.promotion.countsAs39EURFirstSale, false);
  assert.equal(await claim(t), null);
  const calls = state.calls.length; process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED = 'false';
  for (const response of await Promise.all(Array.from({ length: 5 }, () => post(t, bytes)))) assert.equal(response.status, 200);
  assert.equal(state.calls.length, calls); assert.deepEqual(await read(t, job), before); assert.equal((await evidence(t)).length, 1);
  await t.mutation(ref('paidEditorial'), { editorialToken, jobId: job.jobId, expectedRevision: 1, previewDigest: p.contentDigest, reviewerId: 'offline-human', humanReviewed: true });
  assert.equal((await claim(t)).stage, 'finalize');
});

test('promo: five lifetime uses cannot be reset by config rotation or concurrent sixth settlement', async context => {
  const { t, state } = fixture(context);
  for (let n = 0; n < 5; n++) {
    const { job, p } = await ready(t); const { event } = promoFixture(state, job, p, n);
    assert.deepEqual(await (await post(t, encode(event))).json(), { status: 'settled' });
  }
  assert.equal((await evidence(t)).length, 5);
  const { job, p } = await ready(t); const { event } = promoFixture(state, job, p, 6);
  for (const response of await Promise.all(Array.from({ length: 3 }, () => post(t, encode(event))))) assert.deepEqual(await response.json(), { status: 'rejected' });
  assert.equal((await evidence(t)).length, 5); assert.equal((await read(t, job)).payment.status, 'pending');
  assert.equal((await ledger(t)).at(-1).reason, 'payment_promotion_limit');
});

test('promo: disabled/unbound/expired/over-five policies reject discounted events; ordinary39EUR is isolated', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t); const base = promoFixture(state, job, p);
  const variants = [policy => { policy.bindings = []; }, policy => { policy.endsAtMs = Date.now() - 1; },
    policy => { policy.bindings[0].previewDigest = 'b'.repeat(64); }, policy => { policy.bindings[0].revision = 2; },
    policy => { policy.bindings = Array(6).fill(policy.bindings[0]); }, policy => { policy.providerAccountId = 'acct_other'; },
    policy => { policy.livemode = false; }];
  for (const [n, mutate] of variants.entries()) {
    const policy = structuredClone(base.policy); mutate(policy); setPolicy(policy);
    const event = { ...base.event, id: `evt_badpolicy${n}` }; const response = await post(t, encode(event));
    assert.notEqual((await response.json()).status, 'settled'); await assertUnpaid(t, job);
  }
  setPolicy(base.policy); process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED = 'false';
  assert.deepEqual(await (await post(t, encode({ ...base.event, id: 'evt_disabledpromo' }))).json(), { status: 'rejected' });
  const ordinary = eventFixture(job, p, true, 'evt_fullprice'); bind(state, ordinary);
  process.env.BEBEBONJOUR_PAID_TEST_PROMO_ENABLED = 'true'; process.env.BEBEBONJOUR_PAID_TEST_PROMO_JSON = '{invalid';
  assert.deepEqual(await (await post(t, encode(ordinary))).json(), { status: 'settled' });
  assert.equal((await read(t, job)).payment.amountMinor, 3900); assert.equal((await read(t, job)).payment.promotion, undefined);
});

test('promo: tampered native evidence and scoped permission refusal never settle', async context => {
  const { t, state } = fixture(context); const { job, p } = await ready(t);
  const variants = [x => { x.session.payment_intent = 'pi_other'; }, x => { x.session.metadata.preview_digest = 'a'.repeat(64); },
    x => { x.session.amount_subtotal = 100; }, x => { x.session.total_details.amount_discount = 0; },
    x => { x.session.total_details.amount_tax = 1; }, x => { x.session.payment_status = 'unpaid'; },
    x => { x.session.discounts[0].promotion_code = 'promo_other'; }, x => { x.session.discounts.push(x.session.discounts[0]); },
    x => { x.promotion.max_redemptions = 6; }, x => { x.coupon.max_redemptions = null; },
    x => { x.coupon.amount_off = 3799; }, x => { x.coupon.currency = 'usd'; }, x => { x.coupon.times_redeemed = 6; },
    x => { x.promotion.promotion.coupon = 'wrong'; }, x => { x.coupon.livemode = false; },
    x => { x.session.status = 'open'; }, x => { x.coupon.duration = 'forever'; }, x => { x.promotion.times_redeemed = 0; }];
  for (const [n, mutate] of variants.entries()) {
    const x = promoFixture(state, job, p, n); mutate(x);
    assert.deepEqual(await (await post(t, encode(x.event))).json(), { status: 'rejected' }); await assertUnpaid(t, job);
  }
  const x = promoFixture(state, job, p, 90);
  state.failAt = `/v1/checkout/sessions/${x.binding.checkoutSessionId}`;
  assert.equal((await post(t, encode(x.event))).status, 503);
  assert.equal((await ledger(t)).length, variants.length); await assertUnpaid(t, job);
});

test('promo: stale approval/permissions, cancellation and test mode retain all existing gates', async context => {
  const { t, state } = fixture(context);
  for (const [n, change] of [
    { paidApproval: null }, { paidPermissions: null }, { desiredRevision: 2 }, { cancelledAtMs: Date.now() },
    { paidApproval: { revision: 1, previewDigest: 'b'.repeat(64) } },
    { paidPermissions: { revision: 1, previewDigest: 'invalid', termsVersion: 'old-terms', publication: false } },
  ].entries()) {
    const { job, p } = await ready(t); const x = promoFixture(state, job, p, n); await patch(t, job, change);
    assert.deepEqual(await (await post(t, encode(x.event))).json(), { status: 'rejected' });
    assert.equal((await read(t, job)).payment.status, 'pending');
  }
  const { job, p } = await ready(t); const x = promoFixture(state, job, p, 100);
  x.event.livemode = x.event.data.object.livemode = x.event.data.object.latest_charge.livemode = false;
  x.session.livemode = x.promotion.livemode = x.coupon.livemode = x.policy.livemode = false;
  setPolicy(x.policy); bind(state, x.event); process.env.STRIPE_SECRET_KEY = 'rk_test_offlineFixtureNotARealCredential';
  assert.deepEqual(await (await post(t, encode(x.event))).json(), { status: 'test_only' });
  await t.mutation(ref('paidEditorial'), { editorialToken, jobId: job.jobId, expectedRevision: 1, previewDigest: p.contentDigest, reviewerId: 'offline-human', humanReviewed: true });
  assert.equal(await claim(t), null);
});
