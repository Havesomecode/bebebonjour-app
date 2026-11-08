import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { convexTest } from 'convex-test';
import { defineSchema, defineTable, makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';

export const workerToken = 'synthetic-delivery-worker-token-over-32-characters';
export const editorialToken = 'synthetic-human-editor-token-over-32-characters';
const password = 'synthetic-complimentary-password';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const ref = name => makeFunctionReference(`deliveryLoop:${name}`);
// Only fixture tables: not a replacement production schema.
const schema = defineSchema({
  deliveryLoopJobs: defineTable({ jobId: v.string(), publicToken: v.string(), idempotencyKey: v.string(), status: v.string(), data: v.any() })
    .index('by_job_id', ['jobId']).index('by_public_token', ['publicToken']).index('by_idempotency_key', ['idempotencyKey']).index('by_status', ['status']),
  deliveryLoopIntakeThrottle: defineTable({ bucketKey: v.string(), windowStartedAtMs: v.number(), attempts: v.number() }).index('by_bucket_key', ['bucketKey']),
  deliveryLoopPaymentEvidence: defineTable(v.any()).index('by_payment_id', ['providerPaymentId']).index('by_promotion_policy', ['promotion.policyId']),
});
export async function fixture({ paid = false } = {}) {
  process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN = workerToken;
  process.env.BEBEBONJOUR_PAID_EDITORIAL_TOKEN = editorialToken;
  process.env.BEBEBONJOUR_TRIAL_PASSWORD_SHA256 = sha(password);
  process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED = 'true';
  process.env.BEBEBONJOUR_PAID_TERMS_URL = 'https://bonjour.example.test/terms';
  process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID = 'acct_synthetic';
  process.env.CONVEX_SITE_URL = 'https://bonjour.example.test';
  const control = convexTest(schema, {
    './_generated/server.js': () => import('convex/server'),
    './deliveryLoop.js': () => import('../current-loop/convex/deliveryLoop.js'),
  });
  const job = await control.mutation(ref('submit'), {
    intake: { email: `synthetic-${randomUUID()}@example.test`, babyName: 'Amal', gender: 'girl', language: 'fr', context: 'general',
      voiceEnabled: paid, consent: true, customerPermissions: true, fictional: true },
    idempotencyKey: randomUUID(), ...(paid ? { orderMode: 'paid_route_a', previewConsent: true } : { magicPassword: password }),
  });
  assert.ok(job.jobId);
  const claim = (leaseToken = randomUUID()) => control.mutation(ref('claim'), { workerToken, workerId: 'synthetic', leaseToken });
  const read = () => control.query(ref('read'), { workerToken, jobId: job.jobId });
  async function document() {
    return control.run(ctx => ctx.db.query('deliveryLoopJobs').withIndex('by_job_id', q => q.eq('jobId', job.jobId)).unique());
  }
  async function publish(emailLeaseToken) {
    const lease = await claim();
    const composition = { schemaVersion: '1.0', languages: { fr: { description: 'Un bonheur.', introLines: ['Bienvenue.'], introNarration: 'Bienvenue.', blessingLines: ['Des jours doux.'], blessingNarration: 'Des jours doux.', closingLines: ['Notre amour.'], closingNarration: 'Notre amour.' } } };
    const contentHtml = `<html><body>Version synthétique ${lease.revision}</body></html>`;
    await control.mutation(ref('publish'), { workerToken, jobId: job.jobId, leaseToken: lease.leaseToken, revision: lease.revision,
      contentHtml, contentDigest: sha(contentHtml), composition, compositionJson: JSON.stringify(composition),
      compositionReceipt: { provider: 'openai-codex-subscription', outputDigest: sha(JSON.stringify(composition)) }, audioFiles: [] });
    return claim(emailLeaseToken);
  }
  async function seed(pool) {
    const row = await document();
    await pool.query('INSERT INTO bb_candidate.delivery_loop_jobs(job_id, document) VALUES($1,$2)', [row.jobId, row]);
    return row;
  }
  async function restore(pool) {
    const row = await storedDocument(pool, job.jobId);
    await control.run(ctx => ctx.db.patch(row._id, { data: row.data, status: row.status }));
  }
  async function sync(pool) {
    const row = await document();
    const result = await pool.query('UPDATE bb_candidate.delivery_loop_jobs SET document=$2 WHERE job_id=$1', [row.jobId, row]);
    assert.equal(result.rowCount, 1);
  }
  const review = (action = 'approve') => control.mutation(ref('requestReview'), {
    jobId: job.jobId, reviewToken: job.reviewToken, expectedRevision: 1, action,
    ...(action === 'request_changes' ? { feedback: 'Une conclusion plus chaleureuse.' } : {}), idempotencyKey: randomUUID(),
  });
  async function paidFinal() {
    const draft = await publish();
    await control.mutation(ref('fence'), { ...command(draft), workerToken });
    await control.mutation(ref('completeEmail'), { ...command(draft), workerToken, provider: 'resend', providerMessageId: `historical_${randomUUID()}` });
    const preview = (await read()).revisions.at(-1);
    await review();
    await control.mutation(ref('paidPermissions'), { jobId: job.jobId, reviewToken: job.reviewToken, expectedRevision: 1,
      termsVersion: 'route-a-39-v1', termsAccepted: true, publication: true });
    await control.mutation(ref('paidEditorial'), { editorialToken, jobId: job.jobId, expectedRevision: 1,
      previewDigest: preview.contentDigest, reviewerId: 'synthetic-fixture-not-human-approval', humanReviewed: true });
    // Synthetic internal evidence only; never a claimed real Stripe settlement.
    await control.mutation(ref('recordPaymentEvidence'), { jobId: job.jobId, revision: 1, previewDigest: preview.contentDigest,
      providerPaymentId: `pi_synthetic${randomUUID().replaceAll('-', '')}`, amountMinor: 3900, currency: 'eur', livemode: true,
      settled: true, providerAccountId: 'acct_synthetic' });
    const lease = await claim();
    const id = { jobId: job.jobId, leaseToken: lease.leaseToken, revision: 1, workerToken };
    const textDigest = sha('Bienvenue.\n\nDes jours doux.\n\nNotre amour.');
    await control.mutation(ref('beginNarration'), { ...id, language: 'fr', textDigest });
    const storageId = await control.run(ctx => ctx.storage.store(new Blob([new Uint8Array(160).fill(12)], { type: 'audio/mpeg' })));
    await control.mutation(ref('recordNarration'), { ...id, language: 'fr', textDigest, storageId, provider: 'openai', model: 'synthetic-no-provider', voice: 'cedar' });
    await control.mutation(ref('publish'), { ...id, contentHtml: preview.contentHtml, contentDigest: preview.contentDigest,
      composition: preview.composition, compositionJson: preview.compositionJson, compositionReceipt: preview.compositionReceipt,
      audioFiles: [{ language: 'fr', textDigest, storageId }] });
    return claim();
  }
  return { control, job, claim, read, document, publish, seed, restore, sync, review, paidFinal };
}
export const command = claim => ({ jobId: claim.jobId, revision: claim.revision, stage: claim.stage, leaseToken: claim.leaseToken });
export async function mutateDocument(pool, jobId, mutate) {
  const row = (await pool.query('SELECT document FROM bb_candidate.delivery_loop_jobs WHERE job_id=$1', [jobId])).rows[0].document;
  mutate(row);
  await pool.query('UPDATE bb_candidate.delivery_loop_jobs SET document=$2 WHERE job_id=$1', [jobId, row]);
}
export async function storedDocument(pool, jobId) {
  return (await pool.query('SELECT document FROM bb_candidate.delivery_loop_jobs WHERE job_id=$1', [jobId])).rows[0]?.document;
}
export function syntheticTransport(provider, callback = () => {}) {
  let sends = 0;
  return {
    get sends() { return sends; },
    async send(message, { fenceExternalEffect }) {
      return fenceExternalEffect({ effectMayBeIssued: true }, async () => {
        sends++;
        await callback(message);
        return { provider, providerMessageId: `synthetic_${randomUUID()}`, idempotencyKey: message.idempotencyKey };
      });
    },
  };
}
