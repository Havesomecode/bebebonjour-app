// Shared effect-transition guards. Runtime adapters supply command commitments
// and strict equality; this module imports no Node-only APIs.
export function createJobEffectTransitions(withCommand, isDeepStrictEqual) {
  function recoverUnfencedNarrationEffectTransition(aggregate, recovery, at) {
    return withCommand(aggregate, recovery, "unfenced_narration_effect_recovered", at, (next) => {
      const attempt = next.stageAttempts.at(-1);
      const latestEvent = next.events.at(-1);
      const leaseExpiresAtMs = typeof attempt?.leaseExpiresAt === "string"
        ? Date.parse(attempt.leaseExpiresAt)
        : Number.NaN;
      const runningPreProviderAttempt = next.state === "tts_generating"
        && attempt?.status === "running"
        && typeof attempt.leaseToken === "string"
        && Number.isFinite(leaseExpiresAtMs)
        && new Date(leaseExpiresAtMs).toISOString() === attempt.leaseExpiresAt
        && attempt.completedAt === null
        && attempt.failure === null
        && latestEvent?.type === "stage_claimed"
        && latestEvent.state === "tts_generating";
      const failedPreProviderAttempt = next.state === "failed"
        && attempt?.status === "failed"
        && attempt.leaseToken === null
        && attempt.leaseExpiresAt === null
        && typeof attempt.completedAt === "string"
        && isDeepStrictEqual(attempt.failure, {
          retryable: false,
          reasonCode: "narration_failed",
        })
        && latestEvent?.type === "stage_failed"
        && latestEvent.state === "failed";
      if (
        attempt?.attemptId !== recovery.attemptId
        || attempt.stage !== "generate_tts"
        || attempt.operationsCommandId !== recovery.sourceCommandId
        || attempt.effectStartedAt !== null
        || (!runningPreProviderAttempt && !failedPreProviderAttempt)
      ) {
        throw new Error("Unfenced narration recovery does not bind the exact pre-provider attempt.");
      }
      attempt.status = "reconciled_absent";
      attempt.leaseToken = null;
      attempt.leaseExpiresAt = null;
      attempt.completedAt = at;
      attempt.failure = {
        retryable: true,
        reasonCode: "aggregate_effect_fence_missing",
      };
      next.state = "tts_queued";
      next.retry = null;
    }, {
      commandId: recovery.commandId,
      sourceCommandId: recovery.sourceCommandId,
      attemptId: recovery.attemptId,
    });
  }

  function failStageTransition(aggregate, failure, policy, at) {
    return withCommand(aggregate, failure, "stage_failed", at, (next) => {
      const attempt = currentRunningAttempt(next, failure.stage, failure.leaseToken);
      assertNonEmptyString(failure.reasonCode, "failure reasonCode");
      if (!/^[a-z0-9_]{1,64}$/.test(failure.reasonCode)) {
        throw new Error("Failure reasonCode must be a bounded machine-readable value.");
      }
      if (
        Date.parse(at) >= Date.parse(attempt.leaseExpiresAt)
        && (failure.reasonCode !== "lease_expired" || failure.retryable !== true)
      ) {
        throw new Error("An expired lease can only be fenced as a retryable lease_expired failure.");
      }
      const maxAttempts = configuredPositiveInteger(policy?.maxAttemptsByStage?.[failure.stage], "max attempts");
      const unresolvedExternalEffect = next.stageAttempts.some((entry) => (
          entry.stage === attempt.stage
          && entry.revisionId === attempt.revisionId
          && entry.idempotencyKey === attempt.idempotencyKey
          && typeof entry.effectStartedAt === "string"
      ));
      const retryable = failure.retryable === true
        && attempt.attemptNumber < maxAttempts
        && !(attempt.stage === "generate_tts" && unresolvedExternalEffect);
      attempt.status = retryable
        ? "retry_wait"
        : unresolvedExternalEffect
          ? "reconciliation_required"
          : "failed";
      attempt.completedAt = at;
      attempt.leaseToken = null;
      attempt.leaseExpiresAt = null;
      attempt.failure = { retryable, reasonCode: failure.reasonCode };

      if (retryable) {
        const backoffs = policy?.backoffMsByStage?.[failure.stage];
        if (!Array.isArray(backoffs) || backoffs.length < attempt.attemptNumber) {
          throw new Error(`Retry backoff for ${failure.stage} attempt ${attempt.attemptNumber} is not configured.`);
        }
        const backoffMs = configuredPositiveInteger(backoffs[attempt.attemptNumber - 1], "retry backoff");
        next.state = "retry_wait";
        next.retry = {
          stage: failure.stage,
          availableAt: new Date(Date.parse(at) + backoffMs).toISOString(),
        };
        return;
      }

      next.state = unresolvedExternalEffect ? "reconciliation_required" : "failed";
      next.retry = null;
    });
  }

  function reconcileAbsentExternalEffectTransition(aggregate, reconciliation, at) {
    return withCommand(aggregate, reconciliation, "external_effect_reconciled_absent", at, (next) => {
      requireState(next, "reconciliation_required", "reconcile absent external effect");
      const attempt = next.stageAttempts.at(-1);
      if (
        attempt?.stage !== "generate_tts"
        || attempt.status !== "reconciliation_required"
        || attempt.operationsCommandId !== reconciliation.sourceCommandId
        || typeof attempt.effectStartedAt !== "string"
        || attempt.leaseToken !== null
        || attempt.leaseExpiresAt !== null
        || typeof attempt.completedAt !== "string"
      ) {
        throw new Error("Absent narration reconciliation does not bind the unresolved provider attempt.");
      }
      attempt.status = "reconciled_absent";
      next.state = "tts_queued";
      next.retry = null;
    }, {
      commandId: reconciliation.commandId,
      sourceCommandId: reconciliation.sourceCommandId,
      providerStatus: "confirmed_absent",
    });
  }

  return { recoverUnfencedNarrationEffectTransition, failStageTransition, reconcileAbsentExternalEffectTransition };
}

function requireState(aggregate, expected, action) {
  if (aggregate.state !== expected) {
    throw new Error(`Cannot ${action} while job is ${aggregate.state}; expected ${expected}.`);
  }
}

function currentRunningAttempt(aggregate, stage, leaseToken) {
  const attempt = [...aggregate.stageAttempts].reverse().find(
    (entry) => entry.stage === stage && entry.status === "running",
  );
  if (!attempt || attempt.leaseToken !== leaseToken) {
    throw new Error("Stage completion requires the current exact lease token.");
  }
  return attempt;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

function configuredPositiveInteger(value, label) {
  assertPositiveInteger(value, label);
  return value;
}
