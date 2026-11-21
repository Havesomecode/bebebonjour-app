import assert from 'node:assert/strict';
import test from 'node:test';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../support/legacy-schema.mjs';
import { signPersistedReviewApproval } from '../../src/fulfillment/persisted-review-decision.mjs';
import { enqueueCanonicalCompletionSuccessor } from '../../convex/operations.js';
import { canonicalConfig } from '../../convex/canonicalCompletionScope.js';

const jobId = 'job_fictional_scope_123';
const revisionId = 'r2';
const manifestDigest = 'a'.repeat(64);
const token = 'fictional-completion-token-at-least-32-bytes';
const workerId = 'canonical-test-completion-worker';
const origin = 'https://fictional-private.example.test';
const recipient = 'fictional@inbox.example.test';
const hmacKey = 'fictional-approval-hmac-key-at-least-32-bytes';
const commandId = 'command_fictional_scope_publish';
const paymentCorrelation = { project: 'bebebonjour', product: 'announcement-page', environment: 'test',
  jobId, intakeDigest: 'b'.repeat(64) };
function aggregate() {
  return {
    jobId, environment: 'test', product: 'announcement-page', narrationRequired: false,
    intakeDigest: 'b'.repeat(64), currentRevisionId: revisionId, version: 7, state: 'publish_ready',
    paymentCorrelation, payment: { providerPaymentId: 'pi_fictional_scope', providerEventId: 'evt_fictional_scope',
      correlation: paymentCorrelation },
    updatedAt: new Date().toISOString(),
    stageAttempts: [{ stage: 'prepare_review', status: 'completed', attemptId: 'attempt_fictional_content' }],
    artifactSets: [
      { kind: 'private_review', revisionId, pageDigest: 'c'.repeat(64), transcriptDigest: 'd'.repeat(64), assetManifestDigest: 'e'.repeat(64) },
      { kind: 'prepared_bundle', revisionId, assetManifestDigest: manifestDigest, files: [{ storageId: 'storage_fictional', path: 'deploy/fr/index.html', bytes: 2, sha256: 'f'.repeat(64) }] },
    ], reviewDecisions: [],
  };
}
async function setup({ paid = true } = {}) {
  const job = aggregate();
  const decision = { decisionType: 'content', revisionId, outcome: 'approved', policyVersion: 'editorial-v1', rubricVersion: 'content-v1',
    reviewer: { id: 'reviewer_123', role: 'editorial_reviewer', competencies: ['content_review'] },
    decidedAt: '2026-09-25T12:00:00.000Z', artifactDigests: { pageDigest: 'c'.repeat(64), transcriptDigest: 'd'.repeat(64), assetManifestDigest: 'e'.repeat(64) }, reasons: [] };
  const approval = signPersistedReviewApproval({ hmacKey, job, decision });
  job.reviewDecisions.push({ ...approval.decision, approvalId: approval.approvalId });
  Object.assign(process.env, {
    BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN: token,
    BEBEBONJOUR_CANONICAL_COMPLETION_JOB_ID: jobId,
    BEBEBONJOUR_CANONICAL_COMPLETION_REVISION_ID: revisionId,
    BEBEBONJOUR_CANONICAL_COMPLETION_MANIFEST_DIGEST: manifestDigest,
    BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT: recipient,
    BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID: approval.approvalId,
    BEBEBONJOUR_APPROVAL_HMAC_KEY: hmacKey,
    CANONICAL_PUBLICATION_ORIGIN: origin,
  });
  const convex = convexTest(schema, {
    './_generated/server.js': () => import('convex/server'),
    './operations.js': () => import('../../convex/operations.js'),
    './fulfillment.js': () => import('../../convex/fulfillment.js'),
  });
  await convex.run(async ({ db }) => {
    if (paid) await db.insert('customerFlowJobs', { jobId, job: {
      jobId, intakeDigest: job.intakeDigest, payment: { status: 'paid',
        paymentIntentId: job.payment.providerPaymentId, acceptedEventId: job.payment.providerEventId },
    } });
    await db.insert('fulfillmentJobs', { jobId, aggregate: job });
    await db.insert('fulfillmentReviewApprovals', { approvalId: approval.approvalId, approval });
    await db.insert('customerFlowOperationsCommands', {
      commandId, jobId, action: 'publish', expectedState: 'publish_ready', expectedVersion: 7,
      payload: { revisionId, artifactManifestDigest: manifestDigest }, requestedAt: new Date().toISOString(), requestedBy: 'primary_operator',
      state: 'pending', attempts: 0, claim: null, lastFailureReason: null, outcome: null, updatedAt: new Date().toISOString(),
    });
  });
  return { convex, job, approval, query: (name, args) => convex.query(makeFunctionReference(name), args),
    mutation: (name, args) => convex.mutation(makeFunctionReference(name), args) };
}
const claimArgs = { workerToken: token, workerId, jobId, actions: ['publish', 'queue_delivery', 'deliver'], limit: 1, leaseMs: 300_000 };
test('canonical publication rejects an unpaid fictional job even with a signed content approval', async () => {
  const fixture = await setup({ paid: false });
  await assert.rejects(fixture.mutation('operations:queueCanonicalPublication', { workerToken: token, jobId }), /paid|payment/i);
  await assert.rejects(fixture.mutation('operations:claimCommands', claimArgs), /paid|payment/i);
});
test('configured exact approved release bootstraps one durable publication command', async () => {
  const fixture = await setup();
  await fixture.convex.run(async ({ db }) => {
    const manual = await db.query('customerFlowOperationsCommands').first();
    await db.delete(manual._id);
  });
  assert.equal(await fixture.mutation('operations:queueCanonicalPublication', { workerToken: token, jobId }), true);
  assert.equal(await fixture.mutation('operations:queueCanonicalPublication', { workerToken: token, jobId }), false);
  const commands = await fixture.convex.run(({ db }) => db.query('customerFlowOperationsCommands').collect());
  assert.equal(commands.length, 1);
  assert.equal(commands[0].requestedBy, 'automatic_canonical_completion');
  assert.deepEqual(commands[0].payload, { revisionId, artifactManifestDigest: manifestDigest });
  assert.equal((await fixture.mutation('operations:claimCommands', claimArgs))[0].commandId, commands[0].commandId);
});
test('canonical publication bootstrap refuses missing signed approval', async () => {
  const fixture = await setup();
  await fixture.convex.run(async ({ db }) => {
    const row = await db.query('fulfillmentReviewApprovals').first();
    await db.patch(row._id, { approval: { ...row.approval, signature: '0'.repeat(64) } });
  });
  await assert.rejects(fixture.mutation('operations:queueCanonicalPublication', { workerToken: token, jobId }), /signature|approval/i);
});
test('published release and delivery queue enqueue exact successors once', async () => {
  const fixture = await setup();
  const publication = { status: 'published', revisionId, artifactManifestDigest: manifestDigest,
    stableUrl: `${origin}/announcements/${jobId}`, providerReceiptId: 'publication_fictional_1' };
  const publishing = { ...fixture.job, state: 'publishing', version: 8 };
  const published = { ...publishing, state: 'published', version: 9,
    publishedRevisionId: revisionId, publication };
  const deliveryQueued = { ...published, state: 'delivery_queued', version: 10 };
  const config = canonicalConfig();
  assert.equal(await fixture.convex.run(ctx => enqueueCanonicalCompletionSuccessor(ctx, config,
    { action: 'publish' }, publishing, published)), true);
  assert.equal(await fixture.convex.run(ctx => enqueueCanonicalCompletionSuccessor(ctx, config,
    { action: 'publish' }, publishing, published)), false);
  assert.equal(await fixture.convex.run(ctx => enqueueCanonicalCompletionSuccessor(ctx, config,
    { action: 'queue_delivery' }, published, deliveryQueued)), true);
  const commands = await fixture.convex.run(({ db }) => db.query('customerFlowOperationsCommands').collect());
  assert.equal(commands.filter(c => c.action === 'queue_delivery').length, 1);
  assert.equal(commands.filter(c => c.action === 'deliver').length, 1);
  assert.deepEqual(commands.find(c => c.action === 'deliver').payload,
    { revisionId, publicationId: 'publication_fictional_1', artifactManifestDigest: manifestDigest });
  assert.equal(await fixture.convex.run(ctx => enqueueCanonicalCompletionSuccessor(ctx, config,
    { action: 'queue_delivery' }, publishing, deliveryQueued)), false);
});

test('novel canonical token claims only its signed exact fictional release and cannot retarget after claim', async () => {
  const fixture = await setup();
  assert.deepEqual(await fixture.query('operations:workerHealth', { workerToken: token }), { protocolVersion: '1.0', scope: 'canonical_test_completion' });
  assert.deepEqual(await fixture.query('fulfillment:getCompletionJob', { completionToken: token, jobId }), fixture.job);
  const [claimed] = await fixture.mutation('operations:claimCommands', claimArgs);
  assert.equal(claimed.commandId, commandId);
  await assert.rejects(fixture.mutation('operations:claimCommands', { ...claimArgs, jobId: 'job_real_customer' }), /scope|authorization/i);
  await assert.rejects(fixture.query('fulfillment:getCompletionJob', { completionToken: token, jobId: 'job_real_customer' }), /authorization/i);
  process.env.BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT = 'attacker@inbox.example.test';
  await assert.rejects(fixture.mutation('operations:fenceCommand', {
    workerToken: token, workerId, commandId, leaseToken: claimed.claim.leaseToken, leaseMs: 300_000, effectMayBeIssued: true,
  }), /scope|binding|configuration/i);
  await assert.rejects(fixture.query('fulfillment:getCompletionJob', { completionToken: token, jobId }), /scope|binding|configuration/i);
});

test('canonical token refuses unsigned approvals and TEST-A/owner target substitution', async () => {
  const fixture = await setup();
  await fixture.convex.run(async ({ db }) => {
    const row = await db.query('fulfillmentReviewApprovals').withIndex('by_approval_id', q => q.eq('approvalId', fixture.approval.approvalId)).unique();
    await db.patch(row._id, { approval: { ...fixture.approval, signature: '0'.repeat(64) } });
  });
  await assert.rejects(fixture.mutation('operations:claimCommands', claimArgs), /signature|approval/i);
  await assert.rejects(fixture.query('fulfillment:getCompletionJob', { completionToken: token, jobId }), /signature|approval/i);
});
