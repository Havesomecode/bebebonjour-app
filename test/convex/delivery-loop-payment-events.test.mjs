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
  const state = { intents: new Map(), calls: [], account: 'acct_offline', fail: null };
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
      let value;
      if (path === '/v1/account') { state.calls.push('account'); value = { id: state.account }; }
      else {
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
  await t.mutation(ref('completeEmail'), { ...identity, providerMessageId: 'offline_preview_notice' });
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
