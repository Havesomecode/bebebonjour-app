import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openTestDatabase } from './database.mjs';
import { command, fixture, mutateDocument, ref, storedDocument, syntheticTransport, workerToken } from './delivery-loop-fixture.mjs';
import { createDeliveryLoopEmailBridge } from '../delivery-loop-email-bridge.mjs';

const bridge = (pool, transport, options = {}) => createDeliveryLoopEmailBridge({ pool, mode: 'synthetic', workerToken, provider: 'resend', transport, ...options });
const effect = async (pool, jobId) => (await pool.query('SELECT * FROM bb_candidate.email_effects WHERE job_id=$1 ORDER BY revision,stage', [jobId])).rows;
async function draft(t, options) {
  const db = await openTestDatabase(t);
  const f = await fixture(options);
  const claim = await f.publish();
  await f.seed(db.pool);
  return { ...db, f, claim, c: command(claim) };
}

// No test may fall back to a real provider request. Injected transports below
// are explicit fixtures; PostgreSQL is the sole external (loopback) connection.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('provider_network_forbidden_in_synthetic_bridge'); };
test.after(() => { globalThis.fetch = originalFetch; });

test('current control authorizes the exact server-built draft before PostgreSQL admission and completion', async t => {
  const { pool, f, c } = await draft(t);
  const before = await storedDocument(pool, c.jobId);
  const transport = syntheticTransport('resend', async message => {
    assert.equal(message.to, before.data.intake.customer.email);
    assert.match(message.text, /créée automatiquement, avant révision humaine/);
    assert.ok((await storedDocument(pool, c.jobId)).data.lease.effectStartedAtMs);
    assert.equal((await effect(pool, c.jobId))[0].state, 'issued');
  });
  const receipt = await bridge(pool, transport).send(c);
  const after = await storedDocument(pool, c.jobId);
  assert.equal(after.status, 'awaiting_review');
  assert.equal(after.data.emailReceipts[0].providerMessageId, receipt.providerMessageId);
  assert.equal(after.data.emailReceipts[0].provider, 'resend');
  assert.deepEqual(after.data.revisions, before.data.revisions);
  assert.deepEqual(after.data.payment, before.data.payment);
  assert.equal(after.data.reviewOperations.length, 0, 'first draft is not gated on human review');
  assert.equal(transport.sends, 1);
  assert.deepEqual(await bridge(pool, transport).reconcile(c), receipt);
  await assert.rejects(bridge(pool, transport).send(c), /stale_lease/);
  assert.equal(transport.sends, 1);
  assert.ok(f.job.jobId);
});

test('the current control minimum-length capability is preserved verbatim, without silently strengthening its contract', async t => {
  const db = await openTestDatabase(t);
  const f = await fixture();
  const claim = await f.publish('a'.repeat(16));
  assert.equal(claim.leaseToken, 'a'.repeat(16));
  await f.seed(db.pool);
  const transport = syntheticTransport('resend');
  await bridge(db.pool, transport).send(command(claim));
  assert.equal(transport.sends, 1);
  assert.equal((await storedDocument(db.pool, claim.jobId)).data.emailReceipts[0].leaseToken, claim.leaseToken);
});

test('an imported current-loop fence without this ledger admission is uncertain and cannot open a fresh send', async t => {
  const db = await openTestDatabase(t);
  const f = await fixture();
  const claim = await f.publish();
  await f.control.mutation(ref('fence'), { ...command(claim), workerToken });
  const before = await f.seed(db.pool);
  assert.ok(before.data.lease.effectStartedAtMs);
  const transport = syntheticTransport('resend');
  await assert.rejects(bridge(db.pool, transport).send(command(claim)), /email_reconciliation_required/);
  assert.equal((await effect(db.pool, claim.jobId)).length, 0, 'an uncertain source effect must not even prepare a replacement intent');
  assert.deepEqual(await storedDocument(db.pool, claim.jobId), before);
  assert.equal(transport.sends, 0);
});

test('server identity, capability, job, revision, stage and extra client approval/payload are rejected before intent', async t => {
  const { pool, c } = await draft(t);
  const transport = syntheticTransport('resend');
  const api = bridge(pool, transport);
  for (const changed of [
    { ...c, approved: true }, { ...c, workerToken }, { ...c, message: { to: 'attacker@example.test' } },
    { ...c, leaseToken: randomUUID() }, { ...c, revision: c.revision + 1 }, { ...c, stage: 'final_email' },
    { ...c, jobId: `job_${randomUUID()}` },
  ]) await assert.rejects(api.send(changed), /delivery_email_command_invalid|stale_lease|not_found/);
  await assert.rejects(bridge(pool, transport, { workerToken: 'incorrect-server-secret-over-32-characters' }).send(c), /forbidden/);
  assert.equal((await effect(pool, c.jobId)).length, 0);
  assert.equal(transport.sends, 0);
});

for (const [name, mutate, error] of [
  ['capability', row => { row.data.lease.leaseToken = randomUUID(); }, /stale_lease/],
  ['expired lease', row => { row.data.lease.leaseExpiresAtMs = Date.now() - 1000; }, /stale_lease/],
  ['changed lease expiration', row => { row.data.lease.leaseExpiresAtMs += 1000; }, /email_intent_mismatch/],
  ['revision', row => { row.data.desiredRevision++; }, /stale_lease/],
  ['status', row => { row.status = 'awaiting_review'; }, /stale_lease/],
  ['consent', row => { row.data.intake.customer.consent = false; }, /consent_required/],
  ['recipient', row => { row.data.intake.customer.email = 'other@example.test'; }, /email_payload_mismatch/],
  ['message URL', row => { row.publicToken = randomUUID(); }, /email_payload_mismatch/],
  ['publication', row => { row.data.latestRevision = 0; }, /email_publication_required/],
]) test(`admission rechecks ${name} after preparation, before either fence or provider`, async t => {
  const { pool, c } = await draft(t);
  let sends = 0;
  const transport = { async send(message, { fenceExternalEffect }) {
    await mutateDocument(pool, c.jobId, mutate);
    return fenceExternalEffect({ effectMayBeIssued: true }, async () => { sends++; throw new Error('must_not_reach_provider'); });
  } };
  await assert.rejects(bridge(pool, transport).send(c), error);
  assert.equal(sends, 0);
  assert.equal((await effect(pool, c.jobId))[0].state, 'ready');
  assert.equal((await storedDocument(pool, c.jobId)).data.lease.effectStartedAtMs, undefined);
});

test('a historical fixture cannot substitute for the current document owning an intent', async t => {
  const { pool, c } = await draft(t);
  let sends = 0;
  const row = await storedDocument(pool, c.jobId);
  await pool.query('INSERT INTO bb_candidate.customer_jobs(job_id, job) VALUES ($1,$2)', [c.jobId, { jobId: c.jobId, version: 1, intake: row.data.intake }]);
  const transport = { async send(message, { fenceExternalEffect }) {
    await pool.query('UPDATE bb_candidate.email_effects SET historical_job_id=job_id,delivery_loop_job_id=NULL WHERE job_id=$1', [c.jobId]);
    return fenceExternalEffect({ effectMayBeIssued: true }, async () => { sends++; throw new Error('must_not_send'); });
  } };
  await assert.rejects(bridge(pool, transport).send(c), /email_intent_mismatch/);
  assert.equal(sends, 0);
  assert.equal((await effect(pool, c.jobId))[0].state, 'ready');
});

test('twenty concurrent attempts share exactly one durable admission and one callback', async t => {
  const { pool, newPool, c } = await draft(t);
  const transport = syntheticTransport('resend', () => new Promise(resolve => setTimeout(resolve, 40)));
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => bridge(newPool(), transport).send(c)));
  const successful = results.filter(r => r.status === 'fulfilled');
  assert.ok(successful.length >= 1);
  assert.equal(new Set(successful.map(r => r.value.providerMessageId)).size, 1, 'concurrent durable replays return only the original receipt');
  assert.equal(transport.sends, 1);
  assert.equal((await effect(pool, c.jobId)).length, 1);
  assert.equal((await effect(pool, c.jobId))[0].state, 'accepted');
  assert.equal((await storedDocument(pool, c.jobId)).data.emailReceipts.length, 1);
});

test('real process exit after durable admission survives reopening without issuing a provider callback', async t => {
  const { pool, newPool, c, f } = await draft(t);
  let exit;
  try {
    execFileSync(process.execPath, [new URL('./delivery-loop-crash-worker.mjs', import.meta.url).pathname], {
      env: { ...process.env, BB_SYNTHETIC_COMMAND: JSON.stringify(c) }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
  } catch (error) { exit = error; }
  assert.equal(exit?.status, 73);
  assert.match(exit.stdout.toString(), /synthetic_admission_committed_no_network/);
  assert.equal((await effect(pool, c.jobId))[0].state, 'issued');
  assert.ok((await storedDocument(pool, c.jobId)).data.lease.effectStartedAtMs);
  const transport = syntheticTransport('cloudflare');
  await assert.rejects(bridge(newPool(), transport).send(c), /email_reconciliation_required/);
  await assert.rejects(bridge(newPool(), transport, { provider: 'cloudflare' }).send(c), /email_intent_conflict/);
  await mutateDocument(pool, c.jobId, row => { row.data.lease.leaseExpiresAtMs = Date.now() - 1; });
  await f.restore(pool);
  assert.equal(await f.claim(), null);
  assert.equal((await f.read()).status, 'reconciliation_required');
  await f.sync(pool);
  await assert.rejects(bridge(newPool(), transport).send(c), /stale_lease/);
  await assert.rejects(bridge(newPool(), transport).reconcile(c), /email_reconciliation_required/);
  assert.equal(transport.sends, 0);
});

test('lost admission COMMIT acknowledgment leaves both fences durable and performs no callback on reopening', async t => {
  const { pool, newPool, c } = await draft(t);
  let lost = false;
  const lossy = { query: pool.query.bind(pool), async connect() {
    const client = await pool.connect();
    let admitted = false;
    return { release: () => client.release(), async query(sql, params) {
      const result = await client.query(sql, params);
      if (typeof sql === 'string' && sql.startsWith("UPDATE bb_candidate.email_effects SET state='issued'")) admitted = true;
      if (sql === 'COMMIT' && admitted && !lost) { lost = true; throw new Error('synthetic_admission_ack_lost'); }
      return result;
    } };
  } };
  const transport = syntheticTransport('resend');
  await assert.rejects(bridge(lossy, transport).send(c), /synthetic_admission_ack_lost/);
  assert.equal((await effect(pool, c.jobId))[0].state, 'issued');
  assert.ok((await storedDocument(pool, c.jobId)).data.lease.effectStartedAtMs);
  await assert.rejects(bridge(newPool(), transport).send(c), /email_reconciliation_required/);
  assert.equal(transport.sends, 0);
});

test('lost database acknowledgment after receipt commit reconciles the durable receipt without a second send', async t => {
  const { pool, newPool, c } = await draft(t);
  let lost = false;
  const lossy = { connect: pool.connect.bind(pool), async query(sql, params) {
    const result = await pool.query(sql, params);
    if (!lost && sql.startsWith("UPDATE bb_candidate.email_effects SET state='accepted'")) { lost = true; throw new Error('synthetic_commit_ack_lost'); }
    return result;
  } };
  const transport = syntheticTransport('resend');
  await assert.rejects(bridge(lossy, transport).send(c), /email_effect_uncertain/);
  assert.equal((await effect(pool, c.jobId))[0].state, 'accepted');
  assert.equal((await storedDocument(pool, c.jobId)).status, 'draft_email_running');
  const recovered = await bridge(newPool(), transport).reconcile(c);
  assert.equal(recovered.providerMessageId, (await effect(pool, c.jobId))[0].provider_message_id);
  assert.equal((await storedDocument(pool, c.jobId)).status, 'awaiting_review');
  assert.equal(transport.sends, 1);
});

test('correction and final approval reuse the current handlers and preserve immutable revisions, reviews and receipts', async t => {
  const { pool, f, c } = await draft(t);
  const transport = syntheticTransport('resend');
  const api = bridge(pool, transport);
  await api.send(c);
  await f.restore(pool);
  await f.review('request_changes');
  assert.equal((await f.read()).desiredRevision, 2);
  const corrected = await f.publish();
  await f.sync(pool);
  const before = await storedDocument(pool, c.jobId);
  assert.equal(before.data.feedback, 'Une conclusion plus chaleureuse.');
  assert.equal(before.data.revisions.length, 2);
  await api.send(command(corrected));
  await f.restore(pool);
  await f.control.mutation(ref('requestReview'), { jobId: c.jobId, reviewToken: f.job.reviewToken, expectedRevision: 2, action: 'approve', idempotencyKey: randomUUID() });
  const final = await f.claim();
  await f.sync(pool);
  const approved = await storedDocument(pool, c.jobId);
  await api.send(command(final));
  const after = await storedDocument(pool, c.jobId);
  assert.equal(after.status, 'approved_sent');
  assert.deepEqual(after.data.revisions, before.data.revisions);
  assert.deepEqual(after.data.reviewOperations, approved.data.reviewOperations);
  assert.equal(after.publicToken, before.publicToken);
  assert.equal(after.data.approvedRevision, 2);
  assert.equal(after.data.emailReceipts.length, 3);
  assert.equal((await effect(pool, c.jobId)).length, 3);
  assert.equal(transport.sends, 3);
});

test('historical Resend receipts stay provider-bound without creating a send intent; unknown provenance fails closed', async t => {
  const db = await openTestDatabase(t);
  const f = await fixture({ paid: true });
  const claim = await f.paidFinal();
  const before = await f.seed(db.pool);
  const old = before.data.emailReceipts[0];
  let resendReads = 0;
  let cloudflareReads = 0;
  const transport = syntheticTransport('cloudflare');
  const api = bridge(db.pool, transport, { provider: 'cloudflare', readers: {
    resend: async ({ providerMessageId }) => { resendReads++; assert.equal(providerMessageId, old.providerMessageId); return { provider: 'resend', providerMessageId, outcome: 'delivered', recordedAt: new Date().toISOString(), retryable: false }; },
    cloudflare: async () => { cloudflareReads++; throw new Error('wrong_provider'); },
  } });
  const inspected = await api.inspectHistorical({ jobId: claim.jobId, providerMessageId: old.providerMessageId });
  assert.equal(inspected.provider, 'resend');
  assert.equal(inspected.outcome, 'delivered');
  assert.equal((await effect(db.pool, claim.jobId)).length, 0);
  assert.deepEqual((await storedDocument(db.pool, claim.jobId)).data.emailReceipts, before.data.emailReceipts);
  await mutateDocument(db.pool, claim.jobId, row => { delete row.data.emailReceipts[0].provider; });
  await assert.rejects(api.inspectHistorical({ jobId: claim.jobId, providerMessageId: old.providerMessageId }), /email_receipt_provenance_required/);
  await assert.rejects(api.inspectHistorical({ jobId: claim.jobId, providerMessageId: old.providerMessageId, provider: 'resend' }), /delivery_email_command_invalid/);
  assert.equal(resendReads, 1);
  assert.equal(cloudflareReads, 0);
  assert.equal(transport.sends, 0);
});

test('paid final uses real approval/permissions/editorial/payment/publication gates, never a client boolean', async t => {
  const db = await openTestDatabase(t);
  const f = await fixture({ paid: true });
  const claim = await f.paidFinal();
  const before = await f.seed(db.pool);
  const transport = syntheticTransport('resend');
  await bridge(db.pool, transport).send(command(claim));
  const after = await storedDocument(db.pool, claim.jobId);
  assert.equal(after.status, 'approved_sent');
  for (const field of ['payment', 'paidApproval', 'paidPermissions', 'editorialApproval', 'finalPublication', 'narrationReceipts', 'revisions']) assert.deepEqual(after.data[field], before.data[field]);
  assert.deepEqual(after.data.emailReceipts.slice(0, 1), before.data.emailReceipts);
  assert.equal(after.data.emailReceipts[1].provider, 'resend');
  assert.equal(transport.sends, 1);
});

for (const [name, mutate, error] of [
  ['payment', row => { row.data.payment.status = 'waived'; }, /payment_required/],
  ['approval digest', row => { row.data.paidApproval.previewDigest = 'a'.repeat(64); }, /content_approval_required/],
  ['publication consent', row => { row.data.paidPermissions.publication = false; }, /paid_permissions_required/],
  ['human editorial', row => { row.data.editorialApproval.human = false; }, /editorial_approval_required/],
  ['final publication', row => { row.data.finalPublication = null; }, /final_publication_required/],
  ['revocation', row => { row.data.revokedAtMs = Date.now(); }, /order_cancelled/],
  ['preview consent', row => { row.data.previewConsent = null; }, /preview_consent_required/],
]) test(`paid final rejects altered ${name} between preparation and admission`, async t => {
  const db = await openTestDatabase(t);
  const f = await fixture({ paid: true });
  const claim = await f.paidFinal();
  await f.seed(db.pool);
  let sends = 0;
  const transport = { async send(message, { fenceExternalEffect }) {
    await mutateDocument(db.pool, claim.jobId, mutate);
    return fenceExternalEffect({ effectMayBeIssued: true }, async () => { sends++; throw new Error('must_not_send'); });
  } };
  await assert.rejects(bridge(db.pool, transport).send(command(claim)), error);
  assert.equal(sends, 0);
  assert.equal((await effect(db.pool, claim.jobId))[0].state, 'ready');
});
