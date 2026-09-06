import { createConvexOperationsCommandQueue } from "../persistence/convex-operations-command-queue.mjs";
import { createOperationsActionHandlers } from "./operations-action-handlers.mjs";
import { createOperationsCommandWorker } from "./operations-command-worker.mjs";

export function createOperationsWorkerRuntime(options = {}) {
  const queue = createConvexOperationsCommandQueue({
    client: options.client,
    workerToken: options.workerToken,
  });
  const handlers = createOperationsActionHandlers({
    operationsCheckout: options.operationsCheckout,
    customerStore: options.customerStore,
    fulfillmentOrchestrator: options.fulfillmentOrchestrator,
    fulfillmentStore: options.fulfillmentStore,
    authorizeReviewDecision: options.authorizeReviewDecision,
    reconcileExternalEffect: options.reconcileExternalEffect,
    enabledActions: options.enabledActions,
  });
  return createOperationsCommandWorker({ queue, handlers });
}
