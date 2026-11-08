import { isDeepStrictEqual } from "node:util";
import {
  claimStageTransition, commandReplayDigest, completeStageTransition, confirmDeliveryTransition,
  createJobAggregate, failStageTransition, fenceExternalEffectTransition, markExternalEffectStartedTransition,
  queueDeliveryTransition, reconcileDeliveryTransition, recordPaymentTransition, recordReviewDecisionTransition,
  recoverFailedPrepareReviewTransition, resumeRetryTransition,
} from "../../src/fulfillment/job-machine.mjs";
import { transaction } from "./database.mjs";

export function createPostgresFulfillmentStore({ pool }) {
  async function change(jobId, transition) {
    return transaction(pool, async (db) => {
      const current = (await db.query("SELECT aggregate FROM bb_candidate.fulfillment_jobs WHERE job_id=$1 FOR UPDATE", [jobId])).rows[0]?.aggregate;
      if (!current) throw new Error("Unknown fulfillment job.");
      const next = transition(structuredClone(current));
      if (next.jobId !== jobId) throw new Error("Fulfillment identity cannot change.");
      if (next.version !== current.version) {
        if (next.version !== current.version + 1) throw new Error("Fulfillment version must increment exactly once.");
        await db.query("UPDATE bb_candidate.fulfillment_jobs SET aggregate=$2 WHERE job_id=$1", [jobId, next]);
      }
      return next;
    });
  }
  return {
    authority: "postgresql-synthetic-candidate",
    async getJob(jobId) {
      return (await pool.query("SELECT aggregate FROM bb_candidate.fulfillment_jobs WHERE job_id=$1", [jobId])).rows[0]?.aggregate || null;
    },
    async createJob(input, context) {
      const aggregate = createJobAggregate(input, context);
      const row = await pool.query("INSERT INTO bb_candidate.fulfillment_jobs(job_id,aggregate) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING aggregate", [input.jobId, aggregate]);
      if (row.rowCount) return row.rows[0].aggregate;
      const existing = await this.getJob(input.jobId);
      const event = existing.events.find((e) => e.commandId === context.commandId);
      if (event?.type === "job_created" && event.commandDigest === commandReplayDigest("job_created", { commandId: context.commandId, input })) return existing;
      throw new Error("Fulfillment job creation replay conflict.");
    },
    async getReviewApproval(id) {
      return (await pool.query("SELECT approval FROM bb_candidate.review_approvals WHERE approval_id=$1", [id])).rows[0]?.approval || null;
    },
    async saveReviewApproval(approval) {
      const row = await pool.query("INSERT INTO bb_candidate.review_approvals(approval_id,approval) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING approval", [approval.approvalId, approval]);
      const saved = row.rows[0]?.approval || await this.getReviewApproval(approval.approvalId);
      if (!isDeepStrictEqual(saved, approval)) throw new Error("Review approval replay conflict.");
      return saved;
    },
    recordPayment: (id, payment, at) => change(id, (a) => recordPaymentTransition(a, payment, at)),
    recordReviewDecision: (id, decision, at) => change(id, (a) => recordReviewDecisionTransition(a, decision, at)),
    async claimStage(id, claim, at) {
      let acquired = false;
      const aggregate = await change(id, (current) => {
        const replay = current.events.some((event) => event.commandId === claim.commandId);
        const next = claimStageTransition(current, claim, at);
        acquired = !replay;
        return next;
      });
      return { aggregate, acquired };
    },
    markExternalEffectStarted: (id, command, at) => change(id, (a) => markExternalEffectStartedTransition(a, command, at)),
    fenceExternalEffect: (id, command, at) => change(id, (a) => fenceExternalEffectTransition(a, command, at)),
    completeStage: (id, completion, at) => change(id, (a) => completeStageTransition(a, completion, at)),
    failStage: (id, failure, policy, at) => change(id, (a) => failStageTransition(a, failure, policy, at)),
    recoverFailedPrepareReview: (id, recovery, at) => change(id, (a) => recoverFailedPrepareReviewTransition(a, recovery, at)),
    resumeRetry: (id, command, at) => change(id, (a) => resumeRetryTransition(a, command, at)),
    queueDelivery: (id, command, at) => change(id, (a) => queueDeliveryTransition(a, command, at)),
    confirmDelivery: (id, confirmation, at) => change(id, (a) => confirmDeliveryTransition(a, confirmation, at)),
    reconcileDelivery: (id, command, at) => change(id, (a) => reconcileDeliveryTransition(a, command, at)),
  };
}
