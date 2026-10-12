import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../convex/schema.js';
import { diagnosePaidSupport } from '../../src/delivery-loop/support-diagnostics.mjs';
import { PAYMENT_EVENT_REJECTION_REASONS } from '../../src/delivery-loop/paid-event.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/paid-support/${name}.json`, import.meta.url)));
const codes = report => report.findings.map(finding => finding.code);
const guard = `import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
const deny=()=>{throw new Error('network_forbidden')}; globalThis.fetch=deny;
for(const t of [http,https]){t.request=deny;t.get=deny} net.connect=deny;net.createConnection=deny;`;
const cli = (args, input) => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`,
  'scripts/diagnose-paid-support.mjs', ...args], { input, encoding: 'utf8', env: {}, timeout: 5000 });
const prohibit = context => {
  const deny = () => { throw new Error('network_forbidden'); };
  context.mock.method(globalThis, 'fetch', deny);
  for (const transport of [http, https]) {
    context.mock.method(transport, 'request', deny); context.mock.method(transport, 'get', deny);
  }
  context.mock.method(net, 'connect', deny); context.mock.method(net, 'createConnection', deny);
};

test('two failures and a duplicate produce read-only actionable redacted CLI reports', context => {
  prohibit(context);
  for (const [name, expected] of [['inspection-retry', 'payment_event_retry_unknown'],
    ['final-effect-uncertain', 'final_effect_uncertain'], ['duplicate-noop', 'exact_receipt_noop']]) {
    const value = fixture(name); const before = structuredClone(value);
    const report = diagnosePaidSupport(value);
    assert.deepEqual(value, before); assert.ok(codes(report).includes(expected));
    assert.equal(report.authorizesEffects, false); assert.equal(report.provesProviderState, false);
    assert.equal(report.source, 'synthetic'); assert.equal(report.boundary, 'offline_advice_only');
    for (const finding of report.findings) assert.ok(finding.nextAction.length > 40);
    assert.doesNotMatch(JSON.stringify(report), /acct_offline|evt_offline|pi_offline|job_offline/);
    const result = cli([`test/fixtures/paid-support/${name}.json`]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), report);
  }
});

test('all native durable rejections and their exact duplicates stay rejected, never retry effects', () => {
  for (const reason of PAYMENT_EVENT_REJECTION_REASONS) {
    const value = fixture('duplicate-noop'); value.receipt.disposition = 'rejected';
    value.receipt.reason = reason; value.http.code = 'rejected'; value.order.paymentStatus = 'pending';
    const report = diagnosePaidSupport(value);
    assert.deepEqual(codes(report), [reason, 'exact_receipt_noop']);
    assert.match(report.findings[0].nextAction, /cannot be resurrected|Keep the order frozen/);
  }
});

test('test-only, missing receipts and 503 after a commit cannot become live-payment proof', () => {
  const value = fixture('duplicate-noop');
  value.receipt.disposition = 'test_only'; value.receipt.livemode = false; value.http.code = 'test_only';
  value.order.paymentStatus = 'test_only';
  assert.ok(codes(diagnosePaidSupport(value)).includes('test_only_not_payment'));
  delete value.receipt;
  assert.ok(codes(diagnosePaidSupport(value)).includes('durable_receipt_missing'));
  const committed = fixture('duplicate-noop'); committed.http = { status: 503, code: 'payment_event_retry' };
  assert.ok(codes(diagnosePaidSupport(committed)).includes('retry_response_receipt_observed'));
  assert.ok(!codes(diagnosePaidSupport(committed)).includes('payment_event_retry_unknown'));
});

test('changed bytes, wrong account/order and contradictory receipt are never classified as duplicate', () => {
  for (const mutate of [value => { value.request.rawBodySha256 = 'c'.repeat(64); },
    value => { value.request.providerAccountId = 'acct_other'; }, value => { value.order.jobId = 'job_other'; }]) {
    const value = fixture('duplicate-noop'); mutate(value);
    assert.deepEqual(codes(diagnosePaidSupport(value)), ['receipt_correlation_mismatch']);
  }
  const value = fixture('duplicate-noop'); value.http.code = 'rejected';
  assert.ok(codes(diagnosePaidSupport(value)).includes('http_receipt_mismatch'));
  value.http.code = 'settled'; value.order.paymentStatus = 'pending';
  assert.ok(codes(diagnosePaidSupport(value)).includes('order_payment_mismatch'));
});

test('payment and duplicate advice never suppress uncertain fences on frozen orders', () => {
  const value = fixture('duplicate-noop');
  value.order = { ...fixture('final-effect-uncertain').order, jobId: value.order.jobId, cancelled: true, revoked: true };
  const report = diagnosePaidSupport(value);
  assert.ok(codes(report).includes('exact_receipt_noop'));
  assert.ok(codes(report).includes('final_effect_uncertain')); assert.ok(codes(report).includes('order_frozen'));
  assert.match(report.findings.find(f => f.code === 'final_effect_uncertain').nextAction, /Do not clear fences/);
  value.order.uncertainEffect = null; value.order.status = 'paid_blocked';
  assert.ok(codes(diagnosePaidSupport(value)).includes('final_effect_uncertain'), 'inflight narration alone is enough');
  value.order.narrationEffects[0].status = 'complete';
  assert.ok(!codes(diagnosePaidSupport(value)).includes('final_effect_uncertain'));
});

test('native revoked/deleted states stay frozen and missing retained payment is unknown', () => {
  for (const status of ['revoked', 'data_deleted']) {
    const value = fixture('final-effect-uncertain'); value.order.status = status;
    value.order.paymentStatus = null;
    const report = diagnosePaidSupport(value);
    assert.ok(codes(report).includes('order_frozen'));
    assert.ok(codes(report).includes('order_payment_snapshot_missing'));
    assert.ok(codes(report).includes('final_effect_uncertain'));
    assert.ok(!codes(report).includes('order_payment_mismatch'));
  }
});

test('ingress codes and missing order remain actionable without importing credentials or prose', () => {
  for (const [status, code] of [[400, 'payment_event_signature'], [400, 'payment_event_format'], [413, 'payment_event_too_large']]) {
    const report = diagnosePaidSupport({ schemaVersion: 1, source: 'synthetic', http: { status, code } });
    assert.deepEqual(codes(report), [code, 'order_snapshot_missing']);
  }
});

test('reject unknown/raw/sensitive fields, invalid native states and inconsistent dispositions without echo', () => {
  for (const mutate of [
    value => { value.secret = 'sensitive-sentinel'; },
    value => { value.order.contentHtml = 'sensitive-sentinel'; },
    value => { value.receipt.customer = 'sensitive-sentinel'; },
    value => { value.order.uncertainEffect = { stage: 'final_email', revision: 1, startedAtMs: 1, emailIdempotencyKey: 'sensitive-sentinel' }; },
    value => { value.receipt.reason = 'sensitive-sentinel'; },
    value => { value.order.status = 'sensitive-sentinel'; },
    value => { value.receipt.livemode = false; },
    value => { value.receipt.revision = 0; },
    value => { value.http.status = 201; },
  ]) {
    const value = fixture('duplicate-noop'); mutate(value);
    assert.throws(() => diagnosePaidSupport(value), /^Error: invalid_redacted_snapshot$/);
    const result = cli(['-'], JSON.stringify(value));
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /sensitive-sentinel|acct_offline|evt_offline|stack/);
  }
  // Even an identifier that resembles a sensitive string is hashed, never echoed.
  const value = fixture('inspection-retry'); value.request.providerEventId = 'evt_sensitiveSentinel';
  assert.doesNotMatch(JSON.stringify(diagnosePaidSupport(value)), /sensitiveSentinel/);
});

test('CLI bounds bytes, rejects malformed/invalid UTF8 input and returns a fixed error', () => {
  for (const input of ['{', ' '.repeat(65537), Buffer.from([0xff])]) {
    const result = cli(['-'], input); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^support_diagnostics_invalid_input:/);
  }
  for (const args of [[], ['one', 'two'], ['does-not-exist-sensitive-sentinel'], ['test/fixtures']]) {
    const result = cli(args); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /sensitive-sentinel/);
  }
});

test('real existing Convex rejection and duplicate transaction feed diagnostics without order/receipt writes', async context => {
  prohibit(context);
  const original = process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID;
  process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID = 'acct_offline';
  context.after(() => { if (original === undefined) delete process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID; else process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID = original; });
  const t = convexTest(schema, {
    './_generated/server.js': () => import('convex/server'),
    './deliveryLoopPaymentEvents.js': () => import('../../convex/deliveryLoopPaymentEvents.js'),
  });
  const value = fixture('duplicate-noop');
  const event = { ...value.request, type: 'payment_intent.succeeded', livemode: true };
  const ref = makeFunctionReference('deliveryLoopPaymentEvents:recordEvent');
  const args = { event, rejectionReason: 'paid_permissions_required' };
  assert.deepEqual(await t.mutation(ref, args), { disposition: 'rejected', reason: 'paid_permissions_required' });
  const tables = async () => t.run(async ctx => ({ events: await ctx.db.query('deliveryLoopPaymentEvents').collect(),
    evidence: await ctx.db.query('deliveryLoopPaymentEvidence').collect(), jobs: await ctx.db.query('deliveryLoopJobs').collect() }));
  const before = await tables();
  for (let i = 0; i < 3; i++) await t.mutation(ref, args);
  assert.deepEqual(await tables(), before);
  const { _id, _creationTime, ...receipt } = before.events[0];
  value.receipt = receipt; value.http.code = 'rejected'; value.order.paymentStatus = 'pending';
  assert.deepEqual(codes(diagnosePaidSupport(value)), ['paid_permissions_required', 'exact_receipt_noop']);
  assert.deepEqual(await tables(), before, 'diagnosis does not mutate the native runtime');
});
