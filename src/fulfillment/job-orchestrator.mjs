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

    async recordReviewDecision(jobId, decision, workerAuthority) {
      const aggregate = await requireJob(store, jobId, workerAuthority);
      const verifier = handlers.verify_review_decision;
      if (typeof verifier !== "function") {
        throw new Error("A trusted review decision verifier is required.");
      }
      const verified = await verifier(Object.freeze({
        job: statusFromAggregate(aggregate),
        decision: structuredClone(decision),
      }));
      return statusFromAggregate(await store.recordReviewDecision(jobId, verified, clock(), workerAuthority));
    },

    async queueDelivery(jobId, command, workerAuthority) {
      return statusFromAggregate(await store.queueDelivery(jobId, command, clock(), workerAuthority));
    },

    async resumeRetry(jobId, command, workerAuthority) {
      if (typeof command?.commandId !== "string" || command.commandId.trim() === "") {
        throw new Error("Retry resume requires a commandId.");
      }
      return statusFromAggregate(await store.resumeRetry(jobId, command, clock(), workerAuthority));
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

    async runExpectedStage(jobId, expectedStage, options = {}) {
      if (typeof expectedStage !== "string" || expectedStage.trim() === "") {
        throw new Error("An exact expected fulfillment stage is required.");
      }
      return this.runNext(jobId, expectedStage, options);
    },

    async runNext(jobId, expectedStage = null, options = {}) {
      const operationsCommandId = normalizeOperationsCommandId(options.operationsCommandId);
      const workerAuthority = options.workerAuthority;
      const operationsEffectBoundary = options.operationsEffectBoundary;
      if (operationsEffectBoundary !== undefined && typeof operationsEffectBoundary !== "function") {
        throw new Error("operationsEffectBoundary must be a function when provided.");
      }
      if (operationsEffectBoundary && !operationsCommandId) {
        throw new Error("operationsEffectBoundary requires operationsCommandId provenance.");
      }
      let aggregate = await requireJob(store, jobId, workerAuthority);
      assertExpectedStageAuthority(aggregate, expectedStage);
      const now = clock();
      const expiredAttempt = findExpiredRunningAttempt(aggregate, now);
      if (expiredAttempt) {
        aggregate = await store.failStage(jobId, {
          commandId: `expire:${expiredAttempt.attemptId}`,
          stage: expiredAttempt.stage,
          leaseToken: expiredAttempt.leaseToken,
          retryable: true,
          reasonCode: "lease_expired",
        }, retryPolicy, now, workerAuthority);
        return statusFromAggregate(aggregate);
      }
      if (aggregate.state === "retry_wait") {
        if (Date.parse(now) < Date.parse(aggregate.retry.availableAt)) return null;
        aggregate = await store.resumeRetry(jobId, {
          commandId: operationsCommandId || `resume:${jobId}:${aggregate.retry.stage}:${aggregate.retry.availableAt}`,
        }, now, workerAuthority);
      }

      const stage = nextStageForState(aggregate);
      if (!stage) {
        if (expectedStage !== null) {
          throw new Error(`Expected stage ${expectedStage} is not eligible while job is ${aggregate.state}.`);
        }
        return null;
      }
      if (expectedStage !== null && stage !== expectedStage) {
        throw new Error(`Expected stage ${expectedStage} does not match eligible stage ${stage}.`);
      }
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
        operationsCommandId,
      }, clock(), workerAuthority);
      aggregate = claim.aggregate;
      if (!claim.acquired) return null;
      const attempt = [...aggregate.stageAttempts].reverse().find(
        (entry) => entry.stage === stage && entry.status === "running",
      );
      const externalEffectStage = stage === "publish" || stage === "deliver";
      const priorEffectAttempt = externalEffectStage && aggregate.stageAttempts.find(
        (entry) => entry.attemptId !== attempt.attemptId
          && entry.stage === stage
          && entry.revisionId === attempt.revisionId
          && entry.idempotencyKey === attempt.idempotencyKey
          && typeof entry.effectStartedAt === "string",
      );
      const reconciliationOnly = Boolean(priorEffectAttempt);

      const failAttempt = async (error, at = clock()) => {
        const classification = hasLeaseExpired(attempt, at)
          ? { retryable: true, reasonCode: "lease_expired" }
          : classifyFailure(error);
        const failed = await store.failStage(jobId, {
          commandId: `fail:${attempt.attemptId}:${classification.reasonCode}`,
          stage,
          leaseToken,
          ...classification,
        }, retryPolicy, at, workerAuthority);
        return statusFromAggregate(failed);
      };

      let result;
      try {
        let effectFenceNumber = 0;
        const fenceExternalEffect = externalEffectStage
          ? async ({ effectMayBeIssued = false } = {}, providerMutation) => {
            if (typeof providerMutation !== "function") {
              throw new Error("External-effect fencing requires the exact provider mutation callback.");
            }
            await store.fenceExternalEffect(jobId, {
              commandId: `effect-fence:${attempt.attemptId}:${effectFenceNumber += 1}`,
              stage,
              attemptId: attempt.attemptId,
              leaseToken,
              leaseMs,
              effectMayBeIssued,
            }, clock(), workerAuthority);
            aggregate = await store.getJob(jobId, workerAuthority);
            const fencedAttempt = aggregate?.stageAttempts.find(
              (entry) => entry.attemptId === attempt.attemptId,
            );
            const checkedAt = clock();
            if (
              fencedAttempt?.status !== "running"
              || fencedAttempt.leaseToken !== leaseToken
              || Date.parse(checkedAt) >= Date.parse(fencedAttempt.leaseExpiresAt)
            ) {
              throw new Error("Provider mutation requires current unexpired stage ownership.");
            }
            attempt.leaseExpiresAt = fencedAttempt.leaseExpiresAt;
            attempt.effectStartedAt = fencedAttempt.effectStartedAt;
            return providerMutation();
          }
          : null;
        const stageContext = Object.freeze({
          job: statusFromAggregate(aggregate),
          stage,
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          attemptStartedAt: attempt.startedAt,
          priorEffectStartedAt: priorEffectAttempt?.effectStartedAt,
          idempotencyKey: attempt.idempotencyKey,
          operationsCommandId: attempt.operationsCommandId || null,
          ...(options.workerAuthority
            ? { artifactReadAuthority: normalizeWorkerAuthority(options.workerAuthority) }
            : {}),
          reconciliationOnly,
          fenceExternalEffect,
          async assertStageOwnership() {
            const checkedAt = clock();
            const current = await requireJob(store, jobId, workerAuthority);
            const running = [...current.stageAttempts].reverse().find(
              (entry) => entry.attemptId === attempt.attemptId,
            );
            if (
              running?.status !== "running"
              || running.leaseToken !== leaseToken
              || Date.parse(checkedAt) >= Date.parse(running.leaseExpiresAt)
            ) {
              throw new Error("Stage output requires current unexpired stage ownership.");
            }
          },
          leaseToken,
          operation: externalEffectStage
            ? externalEffectInputFromAggregate(aggregate, stage)
            : null,
        });
        let stageInvoked = false;
        const invokeStage = async () => {
          if (stageInvoked) throw new Error("Operations effect boundary cannot invoke a stage twice.");
          stageInvoked = true;
          return handler(stageContext);
        };
        result = operationsEffectBoundary
          ? await operationsEffectBoundary(Object.freeze({
            jobId,
            stage,
            attemptId: attempt.attemptId,
            operationsCommandId,
          }), invokeStage)
          : await invokeStage();
        if (!stageInvoked) {
          throw new Error("Operations effect boundary did not invoke the claimed stage.");
        }
      } catch (error) {
        if (error?.reasonCode === "active_claim_expired") throw error;
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
        }, completedAt, workerAuthority);
        return statusFromAggregate(completed);
      } catch (error) {
        return failAttempt(error);
      }
    },
  };
}

async function requireJob(store, jobId, authority) {
  const aggregate = await store.getJob(jobId, authority);
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

const OPERATIONS_COMMAND_ID_PATTERN = /^command_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

function normalizeOperationsCommandId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !OPERATIONS_COMMAND_ID_PATTERN.test(value)) {
    throw new Error("operationsCommandId must be a valid immutable operations command identifier.");
  }
  return value;
}

function normalizeWorkerAuthority(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Completion artifact access requires worker claim authority.");
  }
  const normalized = {};
  for (const name of ["workerId", "commandId", "leaseToken"]) {
    if (typeof value[name] !== "string" || value[name].trim() === "") {
      throw new Error("Completion artifact access requires worker claim authority.");
    }
    normalized[name] = value[name];
  }
  return Object.freeze(normalized);
}

function assertExpectedStageAuthority(aggregate, expectedStage) {
  if (expectedStage === null) return;
  const running = [...aggregate.stageAttempts].reverse().find(
    (attempt) => attempt.status === "running",
  );
  const authoritativeStage = aggregate.state === "retry_wait"
    ? aggregate.retry?.stage
    : nextStageForState(aggregate) || running?.stage;
  if (authoritativeStage !== expectedStage) {
    throw new Error(`Expected stage ${expectedStage} is outside the current job authority.`);
  }
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
