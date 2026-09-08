import {
  claimStageTransition,
  commandReplayDigest,
  completeStageTransition,
  confirmDeliveryTransition,
  createJobAggregate,
  failStageTransition,
  fenceExternalEffectTransition,
  markExternalEffectStartedTransition,
  queueDeliveryTransition,
  reconcileDeliveryTransition,
  recordPaymentTransition,
  recordReviewDecisionTransition,
  recoverFailedPrepareReviewTransition,
  resumeRetryTransition,
} from "../fulfillment/job-machine.mjs";

const DEFAULT_FUNCTIONS = Object.freeze({
  createJob: "fulfillment:createJob",
  getJob: "fulfillment:getJob",
  getReviewApproval: "fulfillment:getReviewApproval",
  replaceJob: "fulfillment:replaceJob",
  saveReviewApproval: "fulfillment:saveReviewApproval",
});

export function createConvexFulfillmentStore(options = {}) {
  const client = options.client;
  const authorization = options.authorization || { backendToken: options.backendToken };
  const functions = { ...DEFAULT_FUNCTIONS, ...options.functions };
  if (!client?.query || !client?.mutation) {
    throw new Error("A Convex client with query and mutation methods is required.");
  }
  if (!authorization
    || typeof authorization !== "object"
    || Array.isArray(authorization)
    || !Object.values(authorization).some((value) => typeof value === "string" && value.length >= 32)) {
    throw new Error("Convex fulfillment authorization is required.");
  }

  const authorizationFor = (authority) => ({
    ...authorization,
    ...(authority || {}),
  });

  async function change(jobId, transition, authority) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const scopedAuthorization = authorizationFor(authority);
      const current = await client.query(functions.getJob, { ...scopedAuthorization, jobId });
      if (!current) throw new Error(`Unknown fulfillment job: ${jobId}`);
      const next = transition(structuredClone(current));
      if (next.version === current.version) return structuredClone(next);
      const result = await client.mutation(functions.replaceJob, {
        ...scopedAuthorization,
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
        ...authorization,
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

    getJob(jobId, authority) {
      return client.query(functions.getJob, { ...authorizationFor(authority), jobId });
    },

    getReviewApproval(approvalId) {
      return client.query(functions.getReviewApproval, { ...authorization, approvalId });
    },

    async saveReviewApproval(approval) {
      const result = await client.mutation(functions.saveReviewApproval, {
        ...authorization,
        approval,
      });
      return structuredClone(result.approval);
    },

    recordPayment(jobId, payment, at) {
      return change(jobId, (aggregate) => recordPaymentTransition(aggregate, payment, at));
    },

    recordReviewDecision(jobId, decision, at, authority) {
      return change(jobId, (aggregate) => recordReviewDecisionTransition(aggregate, decision, at), authority);
    },

    async claimStage(jobId, claim, at, authority) {
      let acquired = false;
      const aggregate = await change(jobId, (current) => {
        const replay = current.events.some((event) => event.commandId === claim.commandId);
        const next = claimStageTransition(current, claim, at);
        acquired = !replay;
        return next;
      }, authority);
      return { aggregate, acquired };
    },

    markExternalEffectStarted(jobId, command, at, authority) {
      return change(jobId, (aggregate) => markExternalEffectStartedTransition(aggregate, command, at), authority);
    },

    fenceExternalEffect(jobId, command, at, authority) {
      return change(jobId, (aggregate) => fenceExternalEffectTransition(aggregate, command, at), authority);
    },

    completeStage(jobId, completion, at, authority) {
      return change(jobId, (aggregate) => completeStageTransition(aggregate, completion, at), authority);
    },

    failStage(jobId, failure, policy, at, authority) {
      return change(jobId, (aggregate) => failStageTransition(aggregate, failure, policy, at), authority);
    },

    recoverFailedPrepareReview(jobId, recovery, at) {
      return change(jobId, (aggregate) => recoverFailedPrepareReviewTransition(aggregate, recovery, at));
    },

    resumeRetry(jobId, command, at, authority) {
      return change(jobId, (aggregate) => resumeRetryTransition(aggregate, command, at), authority);
    },

    queueDelivery(jobId, command, at, authority) {
      return change(jobId, (aggregate) => queueDeliveryTransition(aggregate, command, at), authority);
    },

    confirmDelivery(jobId, confirmation, at) {
      return change(jobId, (aggregate) => confirmDeliveryTransition(aggregate, confirmation, at));
    },

    reconcileDelivery(jobId, reconciliation, at) {
      return change(jobId, (aggregate) => reconcileDeliveryTransition(aggregate, reconciliation, at));
    },
  };
}
