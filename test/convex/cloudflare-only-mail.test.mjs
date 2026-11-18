import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import schema from '../../convex/schema.js';
import { sendEmail, inspectEmail } from '../../convex/deliveryLoopProviders.js';
import { sendClosureNotice } from '../../convex/deliveryLoopDataProviders.js';
import { receive } from '../../convex/supportForwardProvider.js';
import { supportForwardWebhook } from '../../convex/supportForwardHttp.js';
import retiredRelay from '../../delivery-loop-provider/api/provider.mjs';

// In-memory Convex records and injected HTTP only; never hosted cases/payments.
const workerToken = 'offline-cloudflare-only-worker-32-characters';
const password = 'offline-cloudflare-only-password';
const ref = name => makeFunctionReference(`deliveryLoop:${name}`);
const dataRef = name => makeFunctionReference(`deliveryLoopData:${name}`);
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(context, selector) {
  const saved = { ...process.env };
  context.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    BEBEBONJOUR_DELIVERY_LOOP_TOKEN: workerToken,
    BEBEBONJOUR_TRIAL_PASSWORD_SHA256: sha(password), CONVEX_SITE_URL: 'https://offline.convex.site',
    BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED: 'true', RESEND_API_KEY: 'offline-must-not-be-used',
    BEBEBONJOUR_DELIVERY_LOOP_PROVIDER_URL: 'https://retired-relay.example.invalid',
    BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), BEBEBONJOUR_CLOUDFLARE_ZONE_ID: 'b'.repeat(32),
    BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: 'offline-cloudflare-token',
  });
  if (selector === undefined) delete process.env.BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER;
  else process.env.BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER = selector;
  return convexTest(schema, {
    './_generated/server.js': () => import('convex/server'),
    './deliveryLoop.js': () => import('../../convex/deliveryLoop.js'),
    './deliveryLoopData.js': () => import('../../convex/deliveryLoopData.js'),
  });
}
async function ready(t) {
  const job = await t.mutation(ref('submit'), { magicPassword: password, idempotencyKey: 'offline-only-admission', intake: {
    email: 'fixture@example.invalid', babyName: 'Fixture', language: 'fr', gender: 'neutral', context: 'general',
    voiceEnabled: false, consent: true, fictional: true,
  } });
  const lease = await t.mutation(ref('claim'), { workerToken, workerId: 'offline', leaseToken: 'offline-generate-lease-001' });
  const contentHtml = '<html><body>Fixture</body></html>';
  await t.mutation(ref('publish'), { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken, revision: 1,
    contentHtml, contentDigest: sha(contentHtml), composition: {}, compositionReceipt: {}, audioFiles: [] });
  const mail = await t.mutation(ref('claim'), { workerToken, workerId: 'offline', leaseToken: 'offline-mail-lease-001' });
  return { workerToken, jobId: job.jobId, leaseToken: mail.leaseToken, revision: 1, stage: 'draft_email' };
}
const raw = (t, jobId) => t.run(ctx => ctx.db.query('deliveryLoopJobs').withIndex('by_job_id', q => q.eq('jobId', jobId)).unique());
async function notice(t, provider, status = 'queued') {
  const jobId = 'job_offline_notice';
  await t.run(ctx => ctx.db.insert('deliveryLoopJobs', { jobId, publicToken: 'offline-notice-public', idempotencyKey: 'offline-notice-key', status: 'approved_sent', data: {
    orderMode: 'paid_route_a', intake: { customer: { email: 'fixture@example.invalid' } }, reviewToken: 'offline-private-token',
    hostingEndsAtMs: Date.now() + 86400000, closureNotice: { status, idempotencyKey: `bebe-loop:${jobId}:1:closure_notice`, ...(provider ? { provider } : {}) },
  } }));
  return jobId;
}
const contextFor = t => ({ runQuery: (fn, args) => t.query(fn, args), runMutation: (fn, args) => t.mutation(fn, args) });

for (const selector of [undefined, 'cloudflare']) test(`new announcement defaults/admit only Cloudflare (${selector ?? 'unset'})`, async context => {
  const t = fixture(context, selector); const args = await ready(t); let calls = 0;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.match(url, /^https:\/\/api\.cloudflare\.com\//);
    assert.equal((await raw(t, args.jobId)).data.lease.emailProvider, 'cloudflare');
    const body = JSON.parse(options.body);
    return Response.json({ success: true, errors: [], result: { message_id: '<opaque+only@example.invalid>', queued: [body.to], delivered: [], permanent_bounces: [] } });
  });
  await sendEmail._handler(contextFor(t), args);
  const row = await raw(t, args.jobId);
  assert.equal(row.data.emailReceipts[0].provider, 'cloudflare');
  assert.equal(row.data.emailReceipts[0].providerMessageId, '<opaque+only@example.invalid>');
  await assert.rejects(sendEmail._handler(contextFor(t), args)); assert.equal(calls, 1);
});

for (const selector of ['resend', 'invalid']) test(`selector ${selector} refuses announcement and closure before admission`, async context => {
  const t = fixture(context, selector); const args = await ready(t); const jobId = await notice(t);
  const before = await raw(t, args.jobId); const oldNotice = await raw(t, jobId);
  await assert.rejects(t.mutation(ref('fence'), args), /email_provider_invalid/);
  await assert.rejects(t.mutation(dataRef('beginNotice'), { jobId }), /email_provider_invalid/);
  assert.deepEqual(await raw(t, args.jobId), before); assert.deepEqual(await raw(t, jobId), oldNotice);
});

test('closure defaults to Cloudflare with its separate one-shot fence', async context => {
  const t = fixture(context); const jobId = await notice(t); let calls = 0;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.match(url, /^https:\/\/api\.cloudflare\.com\//);
    const row = await raw(t, jobId); assert.equal(row.data.closureNotice.status, 'inflight');
    assert.equal(row.data.closureNotice.provider, 'cloudflare');
    const body = JSON.parse(options.body);
    assert.match(body.headers['X-Bebe-Operation'], /:closure_notice$/);
    return Response.json({ success: true, errors: [], result: { message_id: '<notice+only@example.invalid>', queued: [body.to], delivered: [], permanent_bounces: [] } });
  });
  await sendClosureNotice._handler(contextFor(t), { jobId });
  await sendClosureNotice._handler(contextFor(t), { jobId });
  assert.equal(calls, 1); assert.equal((await raw(t, jobId)).data.closureNotice.status, 'sent');
});

test('closure concurrency and a lost database acknowledgement retain the sole exact receipt', async context => {
  const t = fixture(context); const jobId = await notice(t); let calls = 0;
  let reached, release;
  const started = new Promise(resolve => { reached = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  context.after(() => release());
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.match(url, /^https:\/\/api\.cloudflare\.com\//); reached(); await pending;
    const body = JSON.parse(options.body);
    return Response.json({ success: true, errors: [], result: { message_id: '<lost-ack+notice@example.invalid>', queued: [body.to], delivered: [], permanent_bounces: [] } });
  });
  const ctx = { runMutation: async (fn, args) => {
    const result = await t.mutation(fn, args);
    if (getFunctionName(fn).endsWith(':finishNotice') && args.providerMessageId) throw Error('offline_lost_ack');
    return result;
  } };
  const first = sendClosureNotice._handler(ctx, { jobId }); await started;
  assert.deepEqual(await sendClosureNotice._handler(ctx, { jobId }), { skipped: true });
  release(); assert.deepEqual(await first, { reconciliationRequired: true });
  const row = await raw(t, jobId);
  assert.equal(row.data.closureNotice.status, 'sent');
  assert.equal(row.data.closureNotice.provider, 'cloudflare');
  assert.equal(row.data.closureNotice.providerMessageId, '<lost-ack+notice@example.invalid>');
  assert.deepEqual(await sendClosureNotice._handler(ctx, { jobId }), { skipped: true }); assert.equal(calls, 1);
});

for (const failure of ['missing_credentials', 'rejected', 'timeout', 'malformed']) test(`Cloudflare ${failure} never falls back or re-admits`, async context => {
  const t = fixture(context); const args = await ready(t); let calls = 0;
  if (failure === 'missing_credentials') delete process.env.BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN;
  context.mock.method(globalThis, 'fetch', async url => {
    calls++; assert.match(url, /^https:\/\/api\.cloudflare\.com\//);
    if (failure === 'timeout') throw Error('offline_timeout');
    if (failure === 'rejected') return Response.json({ success: false }, { status: 401 });
    return Response.json({ success: true, result: {} });
  });
  await assert.rejects(sendEmail._handler(contextFor(t), args));
  assert.equal((await raw(t, args.jobId)).status, 'reconciliation_required');
  const before = calls; await assert.rejects(sendEmail._handler(contextFor(t), args));
  assert.equal(calls, before); assert.equal(calls, failure === 'missing_credentials' ? 0 : 1);
});

for (const provider of [undefined, 'resend']) test(`legacy ${provider ?? 'untagged'} admission can acknowledge but cannot send again`, async context => {
  const t = fixture(context); const args = await ready(t);
  await t.run(async ctx => {
    const row = await ctx.db.query('deliveryLoopJobs').withIndex('by_job_id', q => q.eq('jobId', args.jobId)).unique();
    row.data.lease.effectStartedAtMs = Date.now();
    row.data.lease.emailIdempotencyKey = `bebe-loop:${args.jobId}:1:draft_email`;
    if (provider) row.data.lease.emailProvider = provider;
    await ctx.db.patch(row._id, { data: row.data });
  });
  const before = await raw(t, args.jobId);
  context.mock.method(globalThis, 'fetch', () => { throw Error('unexpected_provider_call'); });
  await assert.rejects(sendEmail._handler(contextFor(t), args), /email_reconciliation_required/);
  assert.deepEqual(await raw(t, args.jobId), before);
  await t.mutation(ref('completeEmail'), { ...args, ...(provider ? { provider } : {}), providerMessageId: 'historical-resend-id' });
  await t.mutation(ref('completeEmail'), { ...args, ...(provider ? { provider } : {}), providerMessageId: 'historical-resend-id' });
  assert.equal((await raw(t, args.jobId)).data.emailReceipts[0].provider, 'resend');
  for (const status of ['inflight', 'sent', 'reconciliation_required']) {
    const jobId = await notice(t, provider, status); const oldNotice = await raw(t, jobId);
    assert.deepEqual(await sendClosureNotice._handler(contextFor(t), { jobId }), { skipped: true });
    assert.deepEqual(await raw(t, jobId), oldNotice);
    await t.run(ctx => ctx.db.delete(oldNotice._id));
  }
});

for (const provider of [undefined, 'resend']) test(`legacy ${provider ?? 'untagged'} receipt inspection retains uncertainty without API/relay calls`, async context => {
  fixture(context); let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ status: 'ok', result: { last_event: 'delivered' } }); });
  const ctx = { runQuery: async () => ({ emailReceipts: [{ providerMessageId: 'old-receipt', ...(provider ? { provider } : {}) }] }) };
  await assert.rejects(inspectEmail._handler(ctx, { workerToken, jobId: 'job_offline', providerMessageId: 'old-receipt' }), /legacy_email_status_unavailable/);
  assert.equal(calls, 0);
  await assert.rejects(inspectEmail._handler(ctx, { workerToken, jobId: 'job_offline', providerMessageId: 'unknown' }), /email_receipt_not_bound/);
});

test('mixed historical provider identity refuses before status access', async context => {
  fixture(context); const ctx = { runQuery: async () => ({ emailReceipts: [
    { providerMessageId: 'shared-id' }, { provider: 'cloudflare', providerMessageId: 'shared-id' },
  ] }) };
  await assert.rejects(inspectEmail._handler(ctx, { workerToken, jobId: 'job_offline', providerMessageId: 'shared-id' }), /email_receipt_provider_ambiguous/);
});

test('defensive send actions refuse non-Cloudflare admissions without transport', async context => {
  fixture(context); let calls = 0; const mutations = [];
  context.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ status: 'ok', result: { providerMessageId: 'old-relay-result' } }); });
  const ctx = { runQuery: async () => ({ jobId: 'job_offline', intake: { baby: { firstName: 'Fixture' }, customer: { email: 'fixture@example.invalid' } }, publicUrl: 'https://example.invalid', reviewUrl: 'https://example.invalid/review' }),
    runMutation: async (fn, args) => { mutations.push({ name: getFunctionName(fn), args }); return { emailProvider: 'resend' }; } };
  await assert.rejects(sendEmail._handler(ctx, { workerToken, jobId: 'job_offline', leaseToken: 'lease', revision: 1, stage: 'draft_email' }), /email_provider_invalid/);
  const closure = { runMutation: async fn => getFunctionName(fn).endsWith(':beginNotice') ? { provider: 'resend', to: 'fixture@example.invalid', reviewToken: 'offline', hostingEndsAtMs: Date.now() + 86400000, idempotencyKey: 'bebe-loop:job_offline:1:closure_notice' } : null };
  assert.deepEqual(await sendClosureNotice._handler(closure, { jobId: 'job_offline' }), { reconciliationRequired: true });
  assert.equal(calls, 0); assert.equal(mutations.at(-1).name, 'deliveryLoop:fail');
});

test('retired support HTTP and internal action cannot be reactivated by old flags', async context => {
  fixture(context); Object.assign(process.env, { BEBEBONJOUR_SUPPORT_FORWARD_ENABLED: 'true', BEBEBONJOUR_SUPPORT_RESEND_WEBHOOK_SECRET: 'offline-secret' });
  const forbidden = () => { throw Error('unexpected_support_effect'); };
  const response = await supportForwardWebhook._handler({ runAction: forbidden }, { get body() { return forbidden(); }, get headers() { return forbidden(); } });
  assert.equal(response.status, 410); assert.deepEqual(await response.json(), { status: 'retired' });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  await assert.rejects(receive._handler({ runMutation: forbidden }, { eventId: 'offline', emailId: 'offline', rawBodySha256: 'a'.repeat(64), disposition: 'forward' }), /support_forward_retired/);
});

test('retired Vercel relay refuses mail, inspection and health without credentials or effects', async () => {
  for (const operation of ['sendEmail', 'inspectEmail', 'health', 'narrate']) {
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await retiredRelay({ method: 'POST', body: { operation }, headers: {} }, response);
    assert.equal(response.statusCode, 410); assert.deepEqual(response.body, { status: 'error', code: 'provider_retired' });
  }
});
