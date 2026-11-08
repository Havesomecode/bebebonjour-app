import { createHash } from 'node:crypto';
import * as current from './current-loop/convex/deliveryLoop.js';
import { isPaid } from './current-loop/convex/deliveryLoopPaidPolicy.js';
import { emailPayload } from './current-loop/email-payload.mjs';
import { assertEmailInspectionTransition, createPostgresEmailEffects, emailInspectionObservation, emailPayloadDigest } from './email-effects.mjs';
import { transaction } from './database.mjs';

const fail = code => { throw new Error(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const key = c => `bebe-loop:${c.jobId}:${c.revision}:${c.stage}`;
function command(input) {
  if (!input || Object.keys(input).sort().join(',') !== 'jobId,leaseToken,revision,stage'
    || !/^job_[A-Za-z0-9_-]{1,124}$/.test(input.jobId) || !Number.isSafeInteger(input.revision) || input.revision < 1
    || !['draft_email', 'final_email'].includes(input.stage) || typeof input.leaseToken !== 'string'
    || input.leaseToken.length < 16 || input.leaseToken.length > 200) fail('delivery_email_command_invalid');
  return { ...input };
}

// Deliberately limited Convex context: these three original handlers only need
// the by_job_id lookup and patch. There is no claim, scheduler or intake adapter.
async function context(db, jobId) {
  const row = (await db.query('SELECT document FROM bb_candidate.delivery_loop_jobs WHERE job_id=$1 FOR UPDATE', [jobId])).rows[0]?.document;
  const query = table => ({ withIndex(index, filter) {
    let requested;
    filter({ eq(field, value) { if (field !== 'jobId') fail('delivery_control_context_invalid'); requested = value; return this; } });
    if (table !== 'deliveryLoopJobs' || index !== 'by_job_id' || requested !== jobId) fail('delivery_control_context_invalid');
    return { async unique() { return row; } };
  } });
  return { row, db: { query, async patch(id, fields) {
    if (!row || id !== row._id || Object.keys(fields).sort().join(',') !== 'data,status') fail('delivery_control_context_invalid');
    Object.assign(row, fields);
    await db.query('UPDATE bb_candidate.delivery_loop_jobs SET document=$2 WHERE job_id=$1', [jobId, row]);
  } } };
}

export function createDeliveryLoopEmailBridge({ pool, mode, workerToken, provider, transport, readers = {} }) {
  if (mode !== 'synthetic' || typeof workerToken !== 'string' || workerToken.length < 32
    || !['resend', 'cloudflare'].includes(provider) || typeof transport?.send !== 'function') fail('delivery_email_configuration_invalid');
  const identity = c => ({ ...c, workerToken });
  async function authorize(db, input) {
    const c = command({ jobId: input.jobId, leaseToken: input.leaseToken, revision: input.revision, stage: input.stage });
    const ctx = await context(db, c.jobId);
    // Reuse the original server identity + capability + revision + paid gates.
    const job = await current.authorizeProvider._handler(ctx, identity(c));
    if (job.intake.fictional !== true || !job.intake.customer.email.endsWith('.test')) fail('email_synthetic_job_required');
    if (job.intake.customer.consent !== true) fail('consent_required');
    if (isPaid(ctx.row) && !job.previewConsent?.acceptedAtMs) fail('preview_consent_required');
    if (job.latestRevision !== c.revision || !job.revisions.some(r => r.revision === c.revision)) fail('email_publication_required');
    if (!isPaid(ctx.row) && c.stage === 'final_email' && job.approvedRevision !== c.revision) fail('content_approval_required');
    if (input.expiresAt !== undefined && Date.parse(input.expiresAt) !== job.leaseExpiresAtMs) fail('email_intent_mismatch');
    const message = emailPayload(job, c.stage, c.revision);
    const sourceReceipt = job.emailReceipts.find(r => r.revision === c.revision && r.stage === c.stage);
    if (job.effectStartedAtMs !== null || sourceReceipt) {
      const prior = (await db.query('SELECT * FROM bb_candidate.email_effects WHERE job_id=$1 AND revision=$2 AND stage=$3', [c.jobId, c.revision, c.stage])).rows[0];
      if (!prior || prior.delivery_loop_job_id !== c.jobId || prior.historical_job_id !== null
        || !prior.admitted_at || !prior.execution_id || prior.state === 'ready'
        || prior.lease_token_digest !== digest(c.leaseToken) || prior.payload_digest !== emailPayloadDigest(message)
        || (sourceReceipt && (prior.provider !== sourceReceipt.provider || prior.provider_message_id !== sourceReceipt.providerMessageId))) fail('email_reconciliation_required');
    }
    return { message, job, async fence() { await current.fence._handler(ctx, identity(c)); } };
  }
  const ledger = createPostgresEmailEffects({ pool, readers, control: { authorize } });
  async function complete(c, receipt) {
    return transaction(pool, async db => {
      const ctx = await context(db, c.jobId);
      const persisted = (await db.query('SELECT * FROM bb_candidate.email_effects WHERE idempotency_key=$1 FOR UPDATE', [key(c)])).rows[0];
      if (!persisted || persisted.delivery_loop_job_id !== c.jobId || persisted.historical_job_id !== null
        || persisted.lease_token_digest !== digest(c.leaseToken) || !['accepted', 'delivered'].includes(persisted.state)
        || JSON.stringify(persisted.receipt) !== JSON.stringify(receipt)) fail('email_reconciliation_required');
      await current.completeEmail._handler(ctx, { ...identity(c), provider: receipt.provider, providerMessageId: receipt.providerMessageId });
      return receipt;
    });
  }
  return Object.freeze({
    async send(input) {
      const c = command(input);
      const { job, message } = await transaction(pool, db => authorize(db, c));
      const intent = { ...c, provider, idempotencyKey: key(c), payloadDigest: emailPayloadDigest(message),
        expiresAt: new Date(job.leaseExpiresAtMs).toISOString() };
      await ledger.prepare(intent);
      const receipt = await ledger.send(intent, message, transport);
      // A durable provider receipt precedes current-loop completion. If this
      // commit fails, reconcile the same receipt; never open another admission.
      return complete(c, receipt);
    },
    async reconcile(input) {
      const c = command(input);
      // Server authentication is still the original read handler. This path
      // cannot issue anything, renew a capability or overwrite an uncertain row.
      const receipt = await transaction(pool, async db => {
        const ctx = await context(db, c.jobId);
        await current.read._handler(ctx, { workerToken, jobId: c.jobId });
        const row = (await db.query('SELECT * FROM bb_candidate.email_effects WHERE idempotency_key=$1 FOR UPDATE', [key(c)])).rows[0];
        if (!row || row.job_id !== c.jobId || row.revision !== c.revision || row.stage !== c.stage
          || row.lease_token_digest !== digest(c.leaseToken)) fail('email_intent_mismatch');
        if (!row.receipt || !['accepted', 'delivered'].includes(row.state)) fail('email_reconciliation_required');
        return row.receipt;
      });
      return complete(c, receipt);
    },
    async inspectHistorical(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'jobId,providerMessageId'
        || !/^job_[A-Za-z0-9_-]{1,124}$/.test(input.jobId) || typeof input.providerMessageId !== 'string'
        || !/^[\x21-\x7e]{1,998}$/.test(input.providerMessageId)) fail('delivery_email_command_invalid');
      const boundReceipt = async db => {
        const ctx = await context(db, input.jobId);
        const job = await current.read._handler(ctx, { workerToken, jobId: input.jobId });
        const matches = job.emailReceipts.filter(r => r.providerMessageId === input.providerMessageId);
        if (matches.length !== 1) fail('email_receipt_not_bound');
        const receipt = matches[0];
        if (!['resend', 'cloudflare'].includes(receipt.provider)) fail('email_receipt_provenance_required');
        const found = await db.query('SELECT 1 FROM bb_candidate.email_effects WHERE job_id=$1 AND revision=$2 AND stage=$3', [input.jobId, receipt.revision, receipt.stage]);
        if (found.rowCount) fail('email_receipt_in_ledger');
        return { ctx, receipt };
      };
      const { receipt } = await transaction(pool, boundReceipt);
      const reader = readers[receipt.provider];
      if (typeof reader !== 'function') fail('email_inspection_unavailable');
      let result;
      try { result = await reader({ providerMessageId: receipt.providerMessageId }); }
      catch { fail('email_inspection_unavailable'); }
      const observation = emailInspectionObservation(receipt, result);
      return transaction(pool, async db => {
        const bound = await boundReceipt(db);
        if (JSON.stringify(bound.receipt) !== JSON.stringify(receipt)) fail('email_receipt_not_bound');
        const observations = bound.ctx.row.data.emailReceiptInspections ||= [];
        const index = observations.findIndex(o => o.provider === receipt.provider && o.providerMessageId === receipt.providerMessageId);
        assertEmailInspectionTransition(observations[index], observation);
        if (index < 0) observations.push(observation); else observations[index] = observation;
        if (new TextEncoder().encode(JSON.stringify(bound.ctx.row.data)).byteLength > 850000) fail('job_capacity_reached');
        await bound.ctx.db.patch(bound.ctx.row._id, { status: bound.ctx.row.status, data: bound.ctx.row.data });
        return observation;
      });
    },
    async inspect(input) {
      const c = command(input);
      // Validate the original capability binding without selecting a new provider.
      await transaction(pool, async db => {
        const ctx = await context(db, c.jobId);
        await current.read._handler(ctx, { workerToken, jobId: c.jobId });
        const row = (await db.query('SELECT lease_token_digest FROM bb_candidate.email_effects WHERE idempotency_key=$1', [key(c)])).rows[0];
        if (!row || row.lease_token_digest !== digest(c.leaseToken)) fail('email_intent_mismatch');
      });
      return ledger.inspect({ jobId: c.jobId, idempotencyKey: key(c) });
    },
  });
}
