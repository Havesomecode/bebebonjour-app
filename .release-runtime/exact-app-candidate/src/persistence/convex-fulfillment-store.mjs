import {
  claimStageTransition,
  commandReplayDigest,
  completeStageTransition,
  confirmDeliveryTransition,
  createJobAggregate,
  failStageTransition,
  queueDeliveryTransition,
  reconcileDeliveryTransition,
  recordPaymentTransition,
  recordReviewDecisionTransition,
  resumeRetryTransition,
} from "../fulfillment/job-machine.mjs";

const DEFAULT_FUNCTIONS = Object.freeze({
  createJob: "fulfillment:createJob",
  getJob: "fulfillment:getJob",
  replaceJob: "fulfillment:replaceJob",
});

export function createConvexFulfillmentStore(options = {}) {
  const client = options.client;
  const backendToken = options.backendToken;
  const functions = { ...DEFAULT_FUNCTIONS, ...options.functions };
  if (!client?.query || !client?.mutation) {
    throw new Error("A Convex client with query and mutation methods is required.");
  }
  if (typeof backendToken !== "string" || backendToken.length < 32) {
    throw new Error("A Convex backend token of at least 32 characters is required.");
  }

  async function change(jobId, transition) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await client.query(functions.getJob, { backendToken, jobId });
      if (!current) throw new Error(`Unknown fulfillment job: ${jobId}`);
      const next = transition(structuredClone(current));
      if (next.version === current.version) return structuredClone(next);
      const result = await client.mutation(functions.replaceJob, {
        backendToken,
        jobId,
        expectedVersion: current.version,
        aggregate: next,
      });
      if (result.updated) return structuredClone(result.aggregate);
    }
    throw new Error("Convex fulfillment update conflicted repeatedly.");
  }

  return {
    authority: "hosted-convex-test",

    async createJob(input, context) {
      const aggregate = createJobAggregate(input, context);
      const result = await client.mutation(functions.createJob, {
        backendToken,
        jobId: input.jobId,
        aggregate,
      });
      if (result.created) return structuredClone(result.aggregate);

      const existing = result.aggregate;
      const event = existing.events.find((entry) => entry.commandId === context.commandId);
      const expectedDigest = commandReplayDigest("job_created", {
        commandId: context.commandId,
        input,
      });
      if (event?.type === "job_created" && event.commandDigest === expectedDigest) {
        return structuredClone(existing);
      }
      if (event) throw new Error("Command replay does not match its original operation and payload.");
      throw new Error(`Fulfillment job already exists: ${input.jobId}`);
    },

    getJob(jobId) {
      return client.query(functions.getJob, { backendToken, jobId });
    },

    recordPayment(jobId, payment, at) {
      return change(jobId, (aggregate) => recordPaymentTransition(aggregate, payment, at));
    },

    recordReviewDecision(jobId, decision, at) {
      return change(jobId, (aggregate) => recordReviewDecisionTransition(aggregate, decision, at));
    },

    async claimStage(jobId, claim, at) {
      let acquired = false;
      const aggregate = await change(jobId, (current) => {
        const replay = current.events.some((event) => event.commandId === claim.commandId);
        const next = claimStageTransition(current, claim, at);
        acquired = !replay;
        return next;
      });
      return { aggregate, acquired };
    },

    completeStage(jobId, completion, at) {
      return change(jobId, (aggregate) => completeStageTransition(aggregate, completion, at));
    },

    failStage(jobId, failure, policy, at) {
      return change(jobId, (aggregate) => failStageTransition(aggregate, failure, policy, at));
    },

    resumeRetry(jobId, command, at) {
      return change(jobId, (aggregate) => resumeRetryTransition(aggregate, command, at));
    },

    queueDelivery(jobId, command, at) {
      return change(jobId, (aggregate) => queueDeliveryTransition(aggregate, command, at));
    },

    confirmDelivery(jobId, confirmation, at) {
      return change(jobId, (aggregate) => confirmDeliveryTransition(aggregate, confirmation, at));
    },

    reconcileDelivery(jobId, reconciliation, at) {
      return change(jobId, (aggregate) => reconcileDeliveryTransition(aggregate, reconciliation, at));
    },
  };
}
