import { isDeepStrictEqual } from "node:util";
import { createJobAggregate } from "../../src/fulfillment/job-machine.mjs";
import { transaction } from "./database.mjs";
import { encryptionKey, sealResponse, openResponse } from "./private-response.mjs";

export function createPostgresCustomerStore({ pool, tokenEncryptionKey }) {
  const key = encryptionKey(tokenEncryptionKey);
  return {
    async createJob(job, idempotencyKey, response, requestDigest, options = {}) {
      if (options.enqueueWorkItem) throw new Error("The legacy Kanban bridge is not enabled in this candidate.");
      if (job.jobId !== response.jobId || job.version !== 1) throw new Error("Invalid initial customer job.");
      const sealed = sealResponse(response, key);
      return transaction(pool, async (db) => {
        if (idempotencyKey) {
          await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`intake:${idempotencyKey}`]);
          const existing = (await db.query("SELECT request_digest, response FROM bb_candidate.submissions WHERE idempotency_key=$1", [idempotencyKey])).rows[0];
          if (existing) return existing.request_digest !== requestDigest
            ? { conflict: true, created: false, response: null }
            : { conflict: false, created: false, response: openResponse(existing.response, key) };
        }
        const aggregate = options.fulfillmentAggregate;
        if (!aggregate || !isDeepStrictEqual(aggregate, createJobAggregate({
          jobId: job.jobId, environment: "test", product: "announcement-page", intakeDigest: job.intakeDigest,
          paymentCorrelation: { project: "bebebonjour", product: "announcement-page", environment: "test",
            jobId: job.jobId, intakeDigest: job.intakeDigest },
          narrationRequired: job.intake?.voicePreference?.enabled === true,
        }, { commandId: `customer-intake:${job.jobId}`, at: job.createdAt }))) {
          throw new Error("A canonical initial fulfillment aggregate is required.");
        }
        await db.query("INSERT INTO bb_candidate.customer_jobs(job_id,job) VALUES ($1,$2)", [job.jobId, job]);
        await db.query("INSERT INTO bb_candidate.fulfillment_jobs(job_id,aggregate) VALUES ($1,$2)", [job.jobId, aggregate]);
        if (idempotencyKey) await db.query("INSERT INTO bb_candidate.submissions(idempotency_key,job_id,request_digest,response) VALUES ($1,$2,$3,$4)", [idempotencyKey, job.jobId, requestDigest, sealed]);
        return { conflict: false, created: true, response: openResponse(sealed, key) };
      });
    },
    async readJob(jobId) {
      return (await pool.query("SELECT job FROM bb_candidate.customer_jobs WHERE job_id=$1", [jobId])).rows[0]?.job || null;
    },
    async updateJob(jobId, update) {
      return transaction(pool, async (db) => {
        const current = (await db.query("SELECT job FROM bb_candidate.customer_jobs WHERE job_id=$1 FOR UPDATE", [jobId])).rows[0]?.job;
        if (!current) return null;
        const next = update(structuredClone(current));
        if (!next || next.jobId !== jobId) throw new Error("Customer updates must preserve job identity.");
        next.version = current.version + 1;
        await db.query("UPDATE bb_candidate.customer_jobs SET job=$2 WHERE job_id=$1", [jobId, next]);
        return next;
      });
    },
    async readProviderEvent(id) {
      const row = (await pool.query("SELECT fingerprint,result FROM bb_candidate.provider_events WHERE provider_event_id=$1", [id])).rows[0];
      return row || null;
    },
    async claimProviderEvent(id, fingerprint) {
      return transaction(pool, async (db) => {
        const inserted = await db.query("INSERT INTO bb_candidate.provider_events(provider_event_id,fingerprint) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING fingerprint,result", [id, fingerprint]);
        const event = inserted.rows[0] || (await db.query("SELECT fingerprint,result FROM bb_candidate.provider_events WHERE provider_event_id=$1", [id])).rows[0];
        return { created: inserted.rowCount === 1, event };
      });
    },
    async completeProviderEvent(id, fingerprint, result) {
      return transaction(pool, async (db) => {
        const event = (await db.query("SELECT fingerprint,result FROM bb_candidate.provider_events WHERE provider_event_id=$1 FOR UPDATE", [id])).rows[0];
        if (!event || event.fingerprint !== fingerprint || event.result) return { completed: false, event: event || null };
        await db.query("UPDATE bb_candidate.provider_events SET result=$2 WHERE provider_event_id=$1", [id, result]);
        return { completed: true, event: { fingerprint, result } };
      });
    },
  };
}
