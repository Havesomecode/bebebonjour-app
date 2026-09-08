import { OperationsCommandError } from "./operations-command-error.mjs";

const STAGE_ACTIONS = Object.freeze({
  generate: Object.freeze({ stage: "prepare_review", kind: "private_review", code: "review_prepared", external: true }),
  render: Object.freeze({ stage: "render_approved", kind: "prepared_bundle", code: "release_rendered", external: false }),
  generate_narration: Object.freeze({ stage: "generate_tts", kind: "narration_review", code: "narration_prepared", external: true }),
  publish: Object.freeze({ stage: "publish", external: true }),
  deliver: Object.freeze({ stage: "deliver", external: true }),
});

const REVIEW_ACTIONS = Object.freeze({
  approve_content: Object.freeze({ decisionType: "content", outcome: "approved" }),
  request_content_changes: Object.freeze({ decisionType: "content", outcome: "request_changes" }),
  reject_content: Object.freeze({ decisionType: "content", outcome: "rejected" }),
  approve_narration: Object.freeze({ decisionType: "narration", outcome: "approved" }),
  request_narration_changes: Object.freeze({ decisionType: "narration", outcome: "request_changes" }),
  reject_narration: Object.freeze({ decisionType: "narration", outcome: "rejected" }),
});

export function createOperationsActionHandlers({
  operationsCheckout,
  customerStore,
  fulfillmentOrchestrator,
  fulfillmentStore,
  authorizeReviewDecision,
  reconcileExternalEffect,
  enabledActions,
}) {
  const scope = normalizeActionScope(enabledActions);
  if (scope.has("create_checkout")) {
    requireMethod(operationsCheckout, "createCheckout");
    requireMethod(customerStore, "readJob");
  }
  if ([...scope].some((action) => Object.hasOwn(STAGE_ACTIONS, action))) {
    requireMethod(fulfillmentOrchestrator, "runExpectedStage");
  }
  if ([...scope].some((action) => Object.hasOwn(REVIEW_ACTIONS, action))) {
    requireMethod(fulfillmentOrchestrator, "recordReviewDecision");
  }
  if (scope.has("queue_delivery")) requireMethod(fulfillmentOrchestrator, "queueDelivery");
  if (scope.has("retry")) requireMethod(fulfillmentOrchestrator, "resumeRetry");
  if ([...scope].some((action) => action !== "create_checkout")) {
    requireMethod(fulfillmentStore, "getJob");
  }
  if ([...scope].some((action) => Object.hasOwn(REVIEW_ACTIONS, action))
    && typeof authorizeReviewDecision !== "function") {
    throw new Error("Operations review commands require a trusted review authorization capability.");
  }
  if (scope.has("reconcile") && typeof reconcileExternalEffect !== "function") {
    throw new Error("Operations reconciliation requires a trusted provider reconciliation capability.");
  }

  const handlers = {
    async create_checkout(command) {
      return requireEffectBoundary(command, async () => {
        await operationsCheckout.createCheckout(command.jobId, command.commandId);
        const customer = await customerStore.readJob(command.jobId);
        const checkout = customer?.payment?.checkout;
        if (checkout?.operationsCommandId !== command.commandId) {
          throw commandError("checkout_provenance_missing", false);
        }
        return {
          code: "checkout_available",
          checkoutSessionId: checkout.sessionId,
          checkoutUrl: checkout.checkoutUrl,
          jobVersion: customer.version,
        };
      });
    },

    async queue_delivery(command) {
      command = { ...command, action: "queue_delivery" };
      await fulfillmentOrchestrator.queueDelivery(command.jobId, {
        commandId: command.commandId,
        revisionId: command.payload.revisionId,
        publicationId: command.payload.publicationId,
      }, command.workerAuthority);
      return projectOutcome(command, await fulfillmentStore.getJob(command.jobId, command.workerAuthority));
    },

    async retry(command) {
      command = { ...command, action: "retry" };
      await fulfillmentOrchestrator.resumeRetry(
        command.jobId,
        { commandId: command.commandId },
        command.workerAuthority,
      );
      return projectOutcome(command, await fulfillmentStore.getJob(command.jobId, command.workerAuthority));
    },

    async reconcile(command) {
      await reconcileExternalEffect(Object.freeze({
        commandId: command.commandId,
        jobId: command.jobId,
        sourceCommandId: command.payload.sourceCommandId,
        providerStatus: command.payload.providerStatus,
      }));
      const aggregate = await fulfillmentStore.getJob(command.jobId, command.workerAuthority);
      return {
        code: "reconciled",
        jobVersion: aggregate.version,
        reconciledState: aggregate.state,
        sourceCommandId: command.payload.sourceCommandId,
        providerStatus: command.payload.providerStatus,
      };
    },
  };

  for (const [action, contract] of Object.entries(STAGE_ACTIONS)) {
    handlers[action] = async (command) => {
      command = { ...command, action };
      const options = {
        operationsCommandId: command.commandId,
        workerAuthority: command.workerAuthority,
      };
      if (contract.external) {
        options.operationsEffectBoundary = (_stage, invokeStage) => requireEffectBoundary(command, invokeStage);
      }
      await fulfillmentOrchestrator.runExpectedStage(command.jobId, contract.stage, options);
      return projectOutcome(command, await fulfillmentStore.getJob(command.jobId, command.workerAuthority));
    };
  }

  for (const [action, contract] of Object.entries(REVIEW_ACTIONS)) {
    handlers[action] = async (command) => {
      command = { ...command, action };
      const decision = await authorizeReviewDecision(Object.freeze({
        commandId: command.commandId,
        jobId: command.jobId,
        expectedVersion: command.expectedVersion,
        payload: structuredClone(command.payload),
        workerAuthority: command.workerAuthority,
        ...contract,
      }));
      if (decision?.commandId !== command.commandId
        || decision?.operationsCommandId !== command.commandId
        || decision?.decisionType !== contract.decisionType
        || decision?.outcome !== contract.outcome) {
        throw commandError("review_authorization_invalid", false);
      }
      await fulfillmentOrchestrator.recordReviewDecision(
        command.jobId,
        decision,
        command.workerAuthority,
      );
      return projectOutcome(command, await fulfillmentStore.getJob(command.jobId, command.workerAuthority));
    };
  }

  return Object.freeze(Object.fromEntries([...scope].map((action) => [action, handlers[action]])));
}

function normalizeActionScope(enabledActions) {
  const all = [
    "create_checkout",
    ...Object.keys(STAGE_ACTIONS),
    ...Object.keys(REVIEW_ACTIONS),
    "queue_delivery",
    "retry",
    "reconcile",
  ];
  const actions = enabledActions === undefined ? all : enabledActions;
  if (!Array.isArray(actions)
    || new Set(actions).size !== actions.length
    || actions.some((action) => !all.includes(action))) {
    throw new Error("Operations worker action scope is invalid.");
  }
  return new Set(actions);
}

async function requireEffectBoundary(command, operation) {
  if (typeof command.fenceExternalEffect !== "function") {
    throw commandError("effect_fence_missing", false);
  }
  return command.fenceExternalEffect(async (effect) => {
    if (effect?.idempotencyKey !== command.commandId) {
      throw commandError("effect_idempotency_mismatch", false);
    }
    return operation(effect);
  });
}

function projectOutcome(command, aggregate) {
  if (!aggregate || !Number.isInteger(aggregate.version)) {
    throw commandError("canonical_readback_missing", true);
  }
  const stageContract = STAGE_ACTIONS[command.action];
  if (stageContract?.kind) {
    const artifact = [...(aggregate.artifactSets || [])].reverse().find((entry) => (
      entry.kind === stageContract.kind
      && entry.revisionId === aggregate.currentRevisionId
      && entry.operationsCommandId === command.commandId
    ));
    if (!artifact) throw commandError("canonical_provenance_missing", false);
    return {
      code: stageContract.code,
      revisionId: aggregate.currentRevisionId,
      artifactSetId: artifact.artifactSetId,
      jobVersion: aggregate.version,
    };
  }
  const reviewContract = REVIEW_ACTIONS[command.action];
  if (reviewContract) {
    const decision = (aggregate.reviewDecisions || []).at(-1);
    if (decision?.operationsCommandId !== command.commandId) {
      throw commandError("canonical_provenance_missing", false);
    }
    return { code: "review_recorded", decisionId: decision.decisionId, jobVersion: aggregate.version };
  }
  if (command.action === "publish") {
    const publication = aggregate.publication;
    if (publication?.operationsCommandId !== command.commandId) {
      throw commandError("canonical_provenance_missing", false);
    }
    const publicationId = publication.providerReceiptId || publication.publicationId;
    return {
      code: "published",
      publicationId,
      deploymentId: publication.deploymentId || publicationId,
      productionUrl: publication.stableUrl,
      jobVersion: aggregate.version,
    };
  }
  if (command.action === "deliver") {
    const delivery = (aggregate.deliveryAttempts || []).at(-1);
    if (delivery?.operationsCommandId !== command.commandId) {
      throw commandError("canonical_provenance_missing", false);
    }
    return {
      code: "delivery_accepted",
      deliveryAttemptId: delivery.idempotencyKey,
      providerMessageId: delivery.providerMessageId,
      jobVersion: aggregate.version,
    };
  }
  if (command.action === "queue_delivery") {
    requireEvent(aggregate, command.commandId, "delivery_queued");
    return { code: "delivery_queued", jobVersion: aggregate.version };
  }
  if (command.action === "retry") {
    requireEvent(aggregate, command.commandId, "retry_resumed");
    return { code: "retry_scheduled", jobVersion: aggregate.version };
  }
  throw commandError("unsupported_operations_action", false);
}

function requireEvent(aggregate, commandId, type) {
  if (!(aggregate.events || []).some((event) => event.commandId === commandId && event.type === type)) {
    throw commandError("canonical_provenance_missing", false);
  }
}

function commandError(reasonCode, retryable) {
  return new OperationsCommandError(reasonCode, { retryable });
}

function requireMethod(value, method) {
  if (typeof value?.[method] !== "function") {
    throw new Error(`Operations action handlers require ${method}().`);
  }
}
