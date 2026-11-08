import { createHash, randomUUID } from "node:crypto";
import { transaction } from "./database.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw Object.assign(new Error(code), { reasonCode: code, retryable: false }); };
const messageId = (value) => typeof value === "string" && /^[\x21-\x7e]{1,998}$/.test(value);

export function emailPayloadDigest(message) {
  function canonical(value, depth = 0) {
    if (depth > 10) fail("email_payload_invalid");
    if (value === null || ["string", "boolean"].includes(typeof value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]));
    }
    fail("email_payload_invalid");
  }
  const text = JSON.stringify(canonical(message));
  if (Buffer.byteLength(text) > 64_000) fail("email_payload_invalid");
  return digest(text);
}

function normalize(intent) {
  if (!intent || !/^job_[A-Za-z0-9_-]{1,124}$/.test(intent.jobId || "")
      || !Number.isSafeInteger(intent.revision) || intent.revision < 1
      || !["draft_email", "final_email"].includes(intent.stage)
      || !["cloudflare", "resend"].includes(intent.provider)
      || intent.idempotencyKey !== `bebe-loop:${intent.jobId}:${intent.revision}:${intent.stage}`
      || !/^[a-f0-9]{64}$/.test(intent.payloadDigest || "")
      || typeof intent.leaseToken !== "string" || intent.leaseToken.length < 32 || intent.leaseToken.length > 512
      || !Number.isFinite(Date.parse(intent.expiresAt))) fail("email_intent_invalid");
  return { jobId: intent.jobId, revision: intent.revision, stage: intent.stage, provider: intent.provider,
    idempotencyKey: intent.idempotencyKey, payloadDigest: intent.payloadDigest,
    leaseDigest: digest(intent.leaseToken), expiresAt: new Date(intent.expiresAt).toISOString() };
}
function assertBinding(row, intent) {
  if (!row || row.job_id !== intent.jobId || row.revision !== intent.revision || row.stage !== intent.stage
      || row.provider !== intent.provider || row.idempotency_key !== intent.idempotencyKey
      || row.payload_digest !== intent.payloadDigest || row.lease_token_digest !== intent.leaseDigest
      || row.expires_at.toISOString() !== intent.expiresAt) fail("email_intent_conflict");
}
function publicEffect(row) {
  return row ? { state: row.state, provider: row.provider, receipt: row.receipt, inspection: row.inspection } : null;
}

// Internal synthetic control-plane seam. No HTTP route or production worker
// grants intents, selects this store, or calls a real provider in this candidate.
export function createPostgresEmailEffects({ pool, readers = {} }) {
  return Object.freeze({
    async prepare(input) {
      const intent = normalize(input);
      return transaction(pool, async (db) => {
        const job = (await db.query("SELECT job FROM bb_candidate.customer_jobs WHERE job_id=$1", [intent.jobId])).rows[0]?.job;
        if (!job?.intake?.customer?.email?.toLowerCase().endsWith(".test")) fail("email_synthetic_job_required");
        await db.query(`INSERT INTO bb_candidate.email_effects
          (idempotency_key,job_id,revision,stage,provider,payload_digest,lease_token_digest,expires_at,state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready') ON CONFLICT DO NOTHING`,
        [intent.idempotencyKey, intent.jobId, intent.revision, intent.stage, intent.provider, intent.payloadDigest, intent.leaseDigest, intent.expiresAt]);
        const row = (await db.query(`SELECT * FROM bb_candidate.email_effects WHERE idempotency_key=$1
          OR (job_id=$2 AND revision=$3 AND stage=$4)`, [intent.idempotencyKey, intent.jobId, intent.revision, intent.stage])).rows[0];
        assertBinding(row, intent);
        return publicEffect(row);
      });
    },
    async readEffect(jobId, key) {
      return publicEffect((await pool.query("SELECT * FROM bb_candidate.email_effects WHERE job_id=$1 AND idempotency_key=$2", [jobId, key])).rows[0]);
    },
    async send(input, message, transport) {
      const intent = normalize(input);
      const snapshot = Object.freeze(structuredClone(message));
      if (snapshot?.idempotencyKey !== intent.idempotencyKey || emailPayloadDigest(snapshot) !== intent.payloadDigest
          || typeof transport?.send !== "function") fail("email_payload_mismatch");
      return transport.send(snapshot, { fenceExternalEffect: async (marker, issue) => {
        if (marker?.effectMayBeIssued !== true || typeof issue !== "function") fail("email_fence_invalid");
        const execution = randomUUID();
        const prior = await transaction(pool, async (db) => {
          const row = (await db.query(`SELECT e.*, e.expires_at > clock_timestamp() AS lease_valid,
            j.job->'intake'->'customer'->>'email' AS recipient FROM bb_candidate.email_effects e
            JOIN bb_candidate.customer_jobs j USING(job_id) WHERE e.idempotency_key=$1 FOR UPDATE OF e`, [intent.idempotencyKey])).rows[0];
          assertBinding(row, intent);
          if (snapshot.to !== row.recipient) fail("email_payload_mismatch");
          if (row.state === "failed") fail("email_terminal_failure");
          if (row.receipt && ["accepted", "delivered"].includes(row.state)) return row.receipt;
          if (row.state !== "ready") fail("email_reconciliation_required");
          if (!row.lease_valid) fail("email_lease_expired");
          await db.query("UPDATE bb_candidate.email_effects SET state='issued',execution_id=$2,admitted_at=clock_timestamp() WHERE idempotency_key=$1", [intent.idempotencyKey, execution]);
          return null;
        });
        if (prior) return prior;
        try {
          const receipt = await issue();
          if (!receipt || receipt.provider !== intent.provider || receipt.idempotencyKey !== intent.idempotencyKey
              || !messageId(receipt.providerMessageId) || Object.keys(receipt).some((k) => !["provider", "providerMessageId", "idempotencyKey"].includes(k))) fail("email_receipt_invalid");
          const stored = await pool.query(`UPDATE bb_candidate.email_effects SET state='accepted',provider_message_id=$3,receipt=$4
            WHERE idempotency_key=$1 AND execution_id=$2 AND state='issued' RETURNING receipt`,
          [intent.idempotencyKey, execution, receipt.providerMessageId, receipt]);
          if (stored.rowCount !== 1) fail("email_receipt_persistence_uncertain");
          return stored.rows[0].receipt;
        } catch {
          // Admission is already committed. Never reset it, including on DB loss.
          await pool.query(`UPDATE bb_candidate.email_effects SET state='reconciliation_required'
            WHERE idempotency_key=$1 AND execution_id=$2 AND state='issued'`, [intent.idempotencyKey, execution]).catch(() => {});
          fail("email_effect_uncertain");
        }
      } });
    },
    async inspect({ jobId, idempotencyKey, provider }) {
      const row = (await pool.query("SELECT * FROM bb_candidate.email_effects WHERE job_id=$1 AND idempotency_key=$2", [jobId, idempotencyKey])).rows[0];
      if (!row?.receipt || (provider !== undefined && provider !== row.provider)) fail("email_receipt_not_bound");
      const reader = readers[row.provider];
      if (typeof reader !== "function") fail("email_inspection_unavailable");
      let result;
      try { result = await reader({ providerMessageId: row.provider_message_id }); }
      catch (error) { fail(error?.reasonCode === "resend_inspection_unavailable" ? error.reasonCode : "email_inspection_unavailable"); }
      if (!result || result.providerMessageId !== row.provider_message_id
          || (result.provider !== undefined && result.provider !== row.provider)
          || !["pending", "delivered", "failed"].includes(result.outcome)
          || !Number.isFinite(Date.parse(result.recordedAt)) || typeof result.retryable !== "boolean"
          || (result.outcome === "failed" && (result.retryable !== false || !/^[a-z_]{1,64}$/.test(result.reasonCode || "")))) fail("email_inspection_unavailable");
      const observation = { provider: row.provider, providerMessageId: row.provider_message_id, outcome: result.outcome,
        recordedAt: new Date(result.recordedAt).toISOString(), retryable: result.retryable,
        reasonCode: result.outcome === "failed" ? result.reasonCode : null };
      return transaction(pool, async (db) => {
        const current = (await db.query("SELECT * FROM bb_candidate.email_effects WHERE job_id=$1 AND idempotency_key=$2 FOR UPDATE", [jobId, idempotencyKey])).rows[0];
        if (current.provider !== row.provider || current.provider_message_id !== row.provider_message_id) fail("email_receipt_not_bound");
        const previous = current.inspection;
        if ((previous && ["failed", "delivered"].includes(previous.outcome) && previous.outcome !== observation.outcome)
            || (previous && Date.parse(previous.recordedAt) > Date.parse(observation.recordedAt))) fail("email_inspection_conflict");
        const state = observation.outcome === "pending" ? "accepted" : observation.outcome;
        await db.query("UPDATE bb_candidate.email_effects SET state=$2,inspection=$3 WHERE idempotency_key=$1", [idempotencyKey, state, observation]);
        return observation;
      });
    },
  });
}

export function createResendReceiptReader({ client, clock = () => new Date().toISOString() }) {
  if (typeof client?.get !== "function" || client.baseUrl !== "https://api.resend.com") fail("resend_inspection_unavailable");
  return async ({ providerMessageId }) => {
    try {
      if (typeof providerMessageId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(providerMessageId)) fail("resend_inspection_unavailable");
      const { data, error } = await client.get(`/emails/${providerMessageId}`, {
        signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      const outcomes = { sent: "pending", queued: "pending", scheduled: "pending", delivery_delayed: "pending",
        delivered: "delivered", bounced: "failed", complained: "failed", failed: "failed", canceled: "failed" };
      if (error || data?.id !== providerMessageId || !Object.hasOwn(outcomes, data?.last_event)) fail("resend_inspection_unavailable");
      const outcome = outcomes[data.last_event];
      return { providerMessageId, outcome, recordedAt: clock(), retryable: false,
        reasonCode: outcome === "failed" ? `resend_${data.last_event}` : null };
    } catch { fail("resend_inspection_unavailable"); }
  };
}
