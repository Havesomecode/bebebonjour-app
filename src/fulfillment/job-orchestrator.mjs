import {
  EDITORIAL_POLICY_VERSION,
  externalEffectInputFromAggregate,
  nextStageForState,
  statusFromAggregate,
} from "./job-machine.mjs";

export { EDITORIAL_POLICY_VERSION };

export function createFulfillmentOrchestrator(options) {
  const store = options?.store;
  if (!store || typeof store.getJob !== "function") {
    throw new Error("A fulfillment store is required.");
  }
  const handlers = options.handlers || {};
  const clock = options.clock;
  const tokenFactory = options.tokenFactory;
  const retryPolicy = options.retryPolicy;
  if (typeof clock !== "function" || typeof tokenFactory !== "function") {
    throw new Error("Explicit clock and tokenFactory dependencies are required.");
  }
  assertRetryPolicyShape(retryPolicy);

  return {
    async createJob(input, context) {
      return statusFromAggregate(await store.createJob(input, {
        commandId: context.commandId,
        at: clock(),
      }));
    },

    async status(jobId) {
      const aggregate = await requireJob(store, jobId);
      return statusFromAggregate(aggregate);
    },

    async recordPayment(jobId, payment) {
      return statusFromAggregate(await store.recordPayment(jobId, payment, clock()));
    },

    async recordReviewDecision(jobId, decision) {
      return statusFromAggregate(await store.recordReviewDecision(jobId, decision, clock()));
    },

    async queueDelivery(jobId, command) {
      return statusFromAggregate(await store.queueDelivery(jobId, command, clock()));
    },

    async confirmDelivery(jobId, confirmation) {
      const aggregate = await requireJob(store, jobId);
      const verifier = handlers.verify_delivery_confirmation;
      if (typeof verifier !== "function") {
        throw new Error("A trusted delivery confirmation verifier is required.");
      }
      const verified = await verifier(Object.freeze({
        job: statusFromAggregate(aggregate),
        confirmation: structuredClone(confirmation),
      }));
      return statusFromAggregate(await store.confirmDelivery(jobId, verified, clock()));
    },

    async reconcileDelivery(jobId, command = {}) {
      const aggregate = await requireJob(store, jobId);
      if (aggregate.state === "complete") return statusFromAggregate(aggregate);
      if (aggregate.state !== "sent") {
        throw new Error(`Cannot reconcile delivery while job is ${aggregate.state}; expected sent.`);
      }
      const handler = handlers.reconcile_delivery;
      if (typeof handler !== "function") {
        throw new Error("No fulfillment handler is configured for delivery reconciliation.");
      }
      if (typeof command.commandId !== "string" || command.commandId.trim() === "") {
        throw new Error("Delivery reconciliation requires a commandId.");
      }
      const operation = externalEffectInputFromAggregate(aggregate, "deliver");
      const outcome = await handler(Object.freeze({
        job: statusFromAggregate(aggregate),
        stage: "reconcile_delivery",
        operation,
      }));
      return statusFromAggregate(await store.reconcileDelivery(jobId, {
        commandId: command.commandId,
        providerMessageId: outcome.providerMessageId,
        outcome: outcome.outcome,
        recordedAt: outcome.recordedAt,
        retryable: outcome.retryable,
        reasonCode: outcome.reasonCode,
      }, clock()));
    },

    async runNext(jobId) {
      let aggregate = await requireJob(store, jobId);
      const now = clock();
      const expiredAttempt = findExpiredRunningAttempt(aggregate, now);
      if (expiredAttempt) {
        aggregate = await store.failStage(jobId, {
          commandId: `expire:${expiredAttempt.attemptId}`,
          stage: expiredAttempt.stage,
          leaseToken: expiredAttempt.leaseToken,
          retryable: true,
          reasonCode: "lease_expired",
        }, retryPolicy, now);
        return statusFromAggregate(aggregate);
      }
      if (aggregate.state === "retry_wait") {
        if (Date.parse(now) < Date.parse(aggregate.retry.availableAt)) return null;
        aggregate = await store.resumeRetry(jobId, {
          commandId: `resume:${jobId}:${aggregate.retry.stage}:${aggregate.retry.availableAt}`,
        }, now);
      }

      const stage = nextStageForState(aggregate);
      if (!stage) return null;
      const handler = handlers[stage];
      if (typeof handler !== "function") {
        throw new Error(`No fulfillment handler is configured for stage ${stage}.`);
      }
      const leaseMs = configuredStageNumber(retryPolicy.leaseMsByStage, stage, "lease duration");
      const maxAttempts = configuredStageNumber(retryPolicy.maxAttemptsByStage, stage, "attempt limit");
      const attemptNumber = aggregate.stageAttempts.filter(
        (attempt) => attempt.stage === stage && attempt.revisionId === aggregate.currentRevisionId,
      ).length + 1;
      const leaseToken = tokenFactory(`${jobId}:${aggregate.currentRevisionId || "unassigned"}:${stage}:${attemptNumber}`);
      let operationBinding = null;
      if (stage === "deliver") {
        const priorAttempt = [...aggregate.stageAttempts].reverse().find(
          (attempt) => attempt.stage === stage && attempt.revisionId === aggregate.currentRevisionId,
        );
        if (priorAttempt && !priorAttempt.operationBinding) {
          throw new Error("A delivery retry is missing its persisted exact target binding.");
        }
        operationBinding = priorAttempt?.operationBinding || null;
        if (!operationBinding) {
          const prepareDelivery = handlers.prepare_delivery;
          if (typeof prepareDelivery !== "function") {
            throw new Error("Delivery requires a persisted target-binding adapter.");
          }
          operationBinding = await prepareDelivery(Object.freeze({
            job: statusFromAggregate(aggregate),
            stage: "prepare_delivery",
          }));
        }
      }
      const claim = await store.claimStage(jobId, {
        commandId: `claim:${jobId}:${aggregate.currentRevisionId || "unassigned"}:${stage}:${attemptNumber}`,
        stage,
        leaseToken,
        leaseMs,
        maxAttempts,
        operationBinding,
      }, clock());
      aggregate = claim.aggregate;
      if (!claim.acquired) return null;
      const attempt = [...aggregate.stageAttempts].reverse().find(
        (entry) => entry.stage === stage && entry.status === "running",
      );

      const failAttempt = async (error, at = clock()) => {
        const classification = hasLeaseExpired(attempt, at)
          ? { retryable: true, reasonCode: "lease_expired" }
          : classifyFailure(error);
        const failed = await store.failStage(jobId, {
          commandId: `fail:${attempt.attemptId}:${classification.reasonCode}`,
          stage,
          leaseToken,
          ...classification,
        }, retryPolicy, at);
        return statusFromAggregate(failed);
      };

      let result;
      try {
        result = await handler(Object.freeze({
          job: statusFromAggregate(aggregate),
          stage,
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          idempotencyKey: attempt.idempotencyKey,
          leaseToken,
          operation: stage === "publish" || stage === "deliver"
            ? externalEffectInputFromAggregate(aggregate, stage)
            : null,
        }));
      } catch (error) {
        return failAttempt(error);
      }

      const completedAt = clock();
      if (hasLeaseExpired(attempt, completedAt)) {
        return failAttempt(new Error("Stage handler finished after its lease expired."), completedAt);
      }
      try {
        const completed = await store.completeStage(jobId, {
          commandId: `complete:${attempt.attemptId}`,
          stage,
          leaseToken,
          result,
        }, completedAt);
        return statusFromAggregate(completed);
      } catch (error) {
        return failAttempt(error);
      }
    },
  };
}

async function requireJob(store, jobId) {
  const aggregate = await store.getJob(jobId);
  if (!aggregate) throw new Error(`Unknown fulfillment job: ${jobId}`);
  return aggregate;
}

function classifyFailure(error) {
  const supplied = typeof error?.reasonCode === "string" ? error.reasonCode : "stage_error";
  const reasonCode = /^[a-z0-9_]{1,64}$/.test(supplied) ? supplied : "stage_error";
  return {
    retryable: error?.retryable === true,
    reasonCode,
  };
}

function findExpiredRunningAttempt(aggregate, at) {
  const now = Date.parse(at);
  if (!Number.isFinite(now)) throw new Error("The fulfillment clock must return an ISO timestamp.");
  const attempt = [...aggregate.stageAttempts].reverse().find((entry) => entry.status === "running");
  if (!attempt || Date.parse(attempt.leaseExpiresAt) > now) return null;
  return attempt;
}

function hasLeaseExpired(attempt, at) {
  const now = Date.parse(at);
  if (!Number.isFinite(now)) throw new Error("The fulfillment clock must return an ISO timestamp.");
  return Date.parse(attempt.leaseExpiresAt) <= now;
}

function assertRetryPolicyShape(policy) {
  if (
    !policy
    || typeof policy.leaseMsByStage !== "object"
    || typeof policy.maxAttemptsByStage !== "object"
    || typeof policy.backoffMsByStage !== "object"
  ) {
    throw new Error("Explicit per-stage lease, attempt, and backoff policy is required.");
  }
}

function configuredStageNumber(values, stage, label) {
  const value = values?.[stage];
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Explicit ${label} is required for stage ${stage}.`);
  }
  return value;
}
