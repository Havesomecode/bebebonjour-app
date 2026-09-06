import { OperationsCommandError } from "./operations-command-error.mjs";

export { OperationsCommandError } from "./operations-command-error.mjs";

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u;
const EXTERNAL_EFFECT_ACTIONS = new Set([
  "create_checkout",
  "generate",
  "generate_narration",
  "publish",
  "deliver",
]);
const ALL_ACTIONS = new Set([
  "create_checkout", "generate", "approve_content", "request_content_changes", "reject_content",
  "render", "generate_narration", "approve_narration", "request_narration_changes", "reject_narration",
  "publish", "queue_delivery", "deliver", "retry", "reconcile",
]);

export function createOperationsCommandWorker(options = {}) {
  const { queue, handlers } = options;
  for (const method of ["claimCommands", "fenceCommand", "completeCommand", "failCommand"]) {
    if (typeof queue?.[method] !== "function") throw new Error(`Operations queue ${method} is required.`);
  }
  if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
    throw new Error("Operations command handlers are required.");
  }
  const enabledActions = Object.keys(handlers).sort();
  if (enabledActions.some((action) => !ALL_ACTIONS.has(action))) {
    throw new Error("Operations worker action scope is invalid.");
  }


  return Object.freeze({
    async runOnce(input = {}) {
      assertRunInput(input);
      const claimed = await queue.claimCommands({
        workerId: input.workerId,
        actions: enabledActions,
        limit: input.limit,
        leaseMs: input.leaseMs,
      });
      if (!Array.isArray(claimed)) throw new Error("Operations queue claim response is invalid.");

      let completed = 0;
      let failed = 0;
      let expired = 0;
      for (let command of claimed) {
        let preflight;
        try {
          preflight = await queue.fenceCommand({
            commandId: command.commandId,
            workerId: input.workerId,
            leaseToken: requiredLeaseToken(command),
            leaseMs: input.leaseMs,
            effectMayBeIssued: false,
          });
        } catch {
          expired += 1;
          continue;
        }
        if (preflight?.active !== true) {
          if (preflight?.command?.state === "completed") completed += 1;
          else expired += 1;
          continue;
        }
        if (preflight.command) command = preflight.command;
        const handler = handlers[command.action];
        if (typeof handler !== "function") {
          await fail(queue, command, input.workerId, "unsupported_action", false);
          failed += 1;
          continue;
        }

        let outcome;
        try {
          let effectFenceCount = 0;
          const fenceExternalEffect = EXTERNAL_EFFECT_ACTIONS.has(command.action)
            ? async (providerMutation) => {
                if (effectFenceCount !== 0) {
                  throw new OperationsCommandError("effect_fence_already_used");
                }
                if (typeof providerMutation !== "function") {
                  throw new OperationsCommandError("invalid_effect_fence");
                }
                effectFenceCount += 1;
                const fenced = await queue.fenceCommand({
                  commandId: command.commandId,
                  workerId: input.workerId,
                  leaseToken: requiredLeaseToken(command),
                  leaseMs: input.leaseMs,
                  effectMayBeIssued: true,
                });
                if (fenced?.active !== true) {
                  throw new OperationsCommandError("active_claim_expired");
                }
                if (fenced.command) command = fenced.command;
                return providerMutation(Object.freeze({
                  idempotencyKey: command.commandId,
                  fencingToken: requiredLeaseToken(command),
                  leaseExpiresAtMs: command.claim.leaseExpiresAtMs,
                }));
              }
            : null;
          outcome = await handler({
            commandId: command.commandId,
            jobId: command.jobId,
            action: command.action,
            expectedState: command.expectedState,
            expectedVersion: command.expectedVersion,
            payload: structuredClone(command.payload),
            fenceExternalEffect,
            workerAuthority: Object.freeze({
              commandId: command.commandId,
              workerId: input.workerId,
              leaseToken: requiredLeaseToken(command),
            }),
          });
          if (EXTERNAL_EFFECT_ACTIONS.has(command.action) && effectFenceCount < 1) {
            throw new OperationsCommandError("effect_fence_required");
          }
          assertOutcome(outcome);
        } catch (error) {
          const classified = classifyFailure(error);
          if (classified.reasonCode === "active_claim_expired") {
            expired += 1;
            continue;
          }
          await fail(queue, command, input.workerId, classified.reasonCode, classified.retryable);
          failed += 1;
          continue;
        }

        try {
          await queue.completeCommand({
            commandId: command.commandId,
            workerId: input.workerId,
            leaseToken: requiredLeaseToken(command),
            outcome,
          });
          completed += 1;
        } catch {
          try {
            await fail(queue, command, input.workerId, "command_completion_rejected", false);
            failed += 1;
          } catch {
            expired += 1;
          }
        }
      }
      return {
        claimed: claimed.length,
        completed,
        failed,
        ...(expired > 0 ? { expired } : {}),
      };
    },
  });
}

async function fail(queue, command, workerId, reasonCode, retryable) {
  await queue.failCommand({
    commandId: command.commandId,
    workerId,
    leaseToken: requiredLeaseToken(command),
    reasonCode,
    retryable,
  });
}

function classifyFailure(error) {
  return error instanceof OperationsCommandError
    ? { reasonCode: error.reasonCode, retryable: error.retryable }
    : { reasonCode: "operation_failed", retryable: false };
}

function requiredLeaseToken(command) {
  const value = command?.claim?.leaseToken;
  if (typeof value !== "string" || value.length < 8) {
    throw new Error("Claimed operations command is missing its lease token.");
  }
  return value;
}

function assertRunInput(input) {
  if (!WORKER_ID.test(input.workerId || "")) throw new Error("Operations worker id is invalid.");

  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) {
    throw new Error("Operations worker claim limit is invalid.");
  }
  if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 600_000) {
    throw new Error("Operations worker lease is invalid.");
  }
}

function assertOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationsCommandError("invalid_handler_outcome");
  }
}
