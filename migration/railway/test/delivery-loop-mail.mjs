import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Resend } from 'resend';
import { materializeCorrectedMail, CORRECTED_MAIL_COMMIT } from '../materialize-mail.mjs';
import { createDeliveryLoopEmailBridge } from '../delivery-loop-email-bridge.mjs';
import { createResendReceiptReader } from '../email-effects.mjs';
import { openTestDatabase } from './database.mjs';
import { command, fixture, storedDocument, syntheticTransport, workerToken } from './delivery-loop-fixture.mjs';

const { root, receipt } = await materializeCorrectedMail();
after(() => rm(root, { recursive: true, force: true }));
assert.equal(receipt.commit, CORRECTED_MAIL_COMMIT);
console.log(`CURRENT_LOOP_MAIL_SOURCE=${JSON.stringify(receipt)}`);
const { createCloudflareEmailTransport } = await import(pathToFileURL(path.join(root, 'src/fulfillment/cloudflare-email-transport.mjs')));
const config = { provider: 'cloudflare', enabled: true, accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32),
  from: 'Bébé Bonjour <bonjour@updates.bebebonjour.com>', replyTo: 'contact@bebebonjour.com' };
const environment = { BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: 'synthetic_send_not_real', BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN: 'synthetic_read_not_real' };
const json = value => ({ ok: true, json: async () => value });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('unexpected_provider_network'); };
after(() => { globalThis.fetch = originalFetch; });
const api = (pool, transport, options = {}) => createDeliveryLoopEmailBridge({ pool, mode: 'synthetic', workerToken, provider: 'cloudflare', transport, ...options });

for (const [status, reason] of [['deliveryFailed', 'cloudflare_delivery_failed'], ['failed', 'cloudflare_failed'], ['rejected', 'cloudflare_rejected']]) {
  test(`current-loop corrected Cloudflare composition preserves a 998-byte opaque ID and terminal ${status} across reopening`, async t => {
    const db = await openTestDatabase(t);
    const f = await fixture();
    const claim = await f.publish();
    await f.seed(db.pool);
    const prefix = `<CF.Message+${claim.jobId}:Case/`;
    const suffix = '@opaque.example>';
    const opaque = `${prefix}${'x'.repeat(998 - prefix.length - suffix.length)}${suffix}`;
    let sends = 0;
    let reads = 0;
    const transport = createCloudflareEmailTransport({ config, environment, fetch: async (url, options) => {
      assert.equal(options.redirect, 'error');
      const payload = JSON.parse(options.body);
      if (url === `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`) {
        sends++;
        assert.equal(payload.headers['X-Bebe-Operation'], `bebe-loop:${claim.jobId}:1:draft_email`);
        const job = await storedDocument(db.pool, claim.jobId);
        assert.equal(payload.to, job.data.intake.customer.email);
        assert.ok(job.data.lease.effectStartedAtMs);
        assert.equal((await db.pool.query('SELECT state FROM bb_candidate.email_effects WHERE job_id=$1', [claim.jobId])).rows[0].state, 'issued');
        return json({ success: true, errors: [], result: { message_id: opaque, delivered: [], queued: [payload.to], permanent_bounces: [], suppressed_recipients: [] } });
      }
      assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql');
      assert.ok(!url.includes(opaque));
      reads++;
      return json({ data: { viewer: { zones: [{ emailSendingAdaptive: [
        { messageId: opaque.toLowerCase(), status: 'delivered', datetime: new Date(Date.now() - 1000).toISOString() },
        { messageId: opaque, status, datetime: new Date(Date.now() - 1000).toISOString() },
      ] }] } } });
    } });
    const c = command(claim);
    const sent = await api(db.pool, transport).send(c);
    assert.equal(sent.providerMessageId, opaque);
    assert.equal((await storedDocument(db.pool, claim.jobId)).data.emailReceipts[0].providerMessageId, opaque);
    assert.equal((await storedDocument(db.pool, claim.jobId)).data.emailReceipts[0].provider, 'cloudflare');
    const reopened = api(db.newPool(), transport, { provider: 'resend', readers: { cloudflare: transport.status, resend: async () => { throw new Error('wrong_provider'); } } });
    assert.equal((await reopened.reconcile(c)).providerMessageId, opaque);
    const observation = await reopened.inspect(c);
    assert.equal(observation.outcome, 'failed');
    assert.equal(observation.reasonCode, reason);
    assert.equal(observation.retryable, false);
    const persisted = (await db.pool.query('SELECT state,receipt,inspection FROM bb_candidate.email_effects WHERE job_id=$1', [claim.jobId])).rows[0];
    assert.equal(persisted.state, 'failed');
    assert.equal(persisted.receipt.providerMessageId, opaque);
    assert.equal(persisted.inspection.reasonCode, reason);
    await assert.rejects(reopened.reconcile(c), /email_reconciliation_required/);
    await assert.rejects(reopened.send(c), /stale_lease/);
    await assert.rejects(reopened.inspectHistorical({ jobId: c.jobId, providerMessageId: opaque }), /email_receipt_in_ledger/);
    assert.equal(sends, 1);
    assert.equal(reads, 1);
  });
}

test('current-loop historical Resend receipt uses the actual SDK reader, independent of new Cloudflare selection', async t => {
  const db = await openTestDatabase(t);
  const f = await fixture({ paid: true });
  const claim = await f.paidFinal();
  const before = await f.seed(db.pool);
  const old = before.data.emailReceipts[0];
  let gets = 0;
  let cloudflareReads = 0;
  let event = 'delivered';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `https://api.resend.com/emails/${old.providerMessageId}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    gets++;
    return new Response(JSON.stringify({ id: old.providerMessageId, last_event: event }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = async () => { throw new Error('unexpected_provider_network'); }; });
  const transport = syntheticTransport('cloudflare');
  const readers = { resend: createResendReceiptReader({ client: new Resend('re_synthetic_not_real', { baseUrl: 'https://api.resend.com' }) }),
    cloudflare: async () => { cloudflareReads++; throw new Error('wrong_provider'); } };
  const request = { jobId: claim.jobId, providerMessageId: old.providerMessageId };
  const observed = await api(db.pool, transport, { readers }).inspectHistorical(request);
  assert.equal(observed.outcome, 'delivered');
  assert.equal(observed.provider, 'resend');
  assert.deepEqual((await storedDocument(db.pool, claim.jobId)).data.emailReceipts, before.data.emailReceipts);
  assert.equal((await storedDocument(db.pool, claim.jobId)).data.lastActivityAtMs, before.data.lastActivityAtMs, 'inspection must not renew retention activity');
  event = 'bounced';
  await assert.rejects(api(db.newPool(), transport, { readers }).inspectHistorical(request), /email_inspection_conflict/);
  const after = await storedDocument(db.pool, claim.jobId);
  assert.equal(after.data.emailReceiptInspections[0].outcome, 'delivered');
  assert.equal((await db.pool.query('SELECT 1 FROM bb_candidate.email_effects WHERE job_id=$1', [claim.jobId])).rowCount, 0);
  assert.equal(gets, 2);
  assert.equal(cloudflareReads, 0);
  assert.equal(transport.sends, 0);
});
