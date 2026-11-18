import assert from 'node:assert/strict';
import test from 'node:test';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../convex/schema.js';

const ref = name => makeFunctionReference(`supportForward:${name}`);
const identity = { eventId: 'offline-historical-event', emailId: 'offline-historical-email', rawBodySha256: 'a'.repeat(64) };
function fixture() {
  return convexTest(schema, {
    './_generated/server.js': () => import('convex/server'),
    './supportForward.js': () => import('../../convex/supportForward.js'),
    './supportForwardHttp.js': () => import('../../convex/supportForwardHttp.js'),
    './supportForwardProvider.js': () => import('../../convex/supportForwardProvider.js'),
    './http.js': () => import('../../convex/http.js'),
  });
}
const receipts = t => t.run(ctx => ctx.db.query('supportForwardReceipts').collect());

for (const status of ['sent', 'ignored', 'inflight', 'reconciliation_required']) test(`retired support route preserves historical ${status} ledger rows`, async () => {
  const t = fixture();
  await t.run(ctx => ctx.db.insert('supportForwardReceipts', { ...identity, status,
    reason: 'forwarding', startedAtMs: 1, updatedAtMs: 2, ...(status === 'sent' ? { providerMessageId: 'historical-outbound-id' } : {}) }));
  const before = await receipts(t);
  const response = await t.fetch('/support/resend/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'untrusted-private-body-not-parsed' });
  assert.equal(response.status, 410); assert.deepEqual(await response.json(), { status: 'retired' });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(await receipts(t), before);
  const existing = await t.mutation(ref('begin'), { ...identity, disposition: 'forward' });
  assert.equal(existing.status, ['sent', 'ignored'].includes(status) ? status : 'reconciliation_required');
  assert.deepEqual(await receipts(t), before);
});

test('historical support completion still binds identity and cannot reopen terminal rows', async () => {
  const t = fixture();
  await t.run(ctx => ctx.db.insert('supportForwardReceipts', { ...identity, status: 'inflight', reason: 'forwarding', startedAtMs: 1, updatedAtMs: 1 }));
  await assert.rejects(t.mutation(ref('finish'), { ...identity, rawBodySha256: 'b'.repeat(64), providerMessageId: 'historical-id' }), /support_fence_mismatch/);
  await t.mutation(ref('finish'), { ...identity, providerMessageId: 'historical-id' });
  const before = await receipts(t);
  await t.mutation(ref('finish'), identity);
  assert.deepEqual(await receipts(t), before); assert.equal(before[0].status, 'sent');
});

test('retired support route never admits a new support receipt', async () => {
  const t = fixture();
  const response = await t.fetch('/support/resend/webhook', { method: 'POST', body: 'malformed' });
  assert.equal(response.status, 410); assert.deepEqual(await receipts(t), []);
});
