import { ConvexHttpClient } from "convex/browser";

import {
  loadCustomerFlowConvexConfig,
  loadTallyIntakeConfig,
} from "../config/hosted-customer-flow-config.mjs";
import { createFulfillmentOrchestrator } from "../fulfillment/job-orchestrator.mjs";
import { createConvexCustomerFlowStore } from "../persistence/convex-customer-flow-store.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";
import { createHostedAbuseBudget } from "../http/abuse-budget.mjs";
import { createCustomerFlowService, createCustomerFlowId } from "./service.mjs";
import { createTallyIntakeProcessor } from "./tally-intake-webhook.mjs";

export function createHostedTallyIntakeProcessor(options = {}) {
  const environment = options.environment || process.env;
  const convexConfig = loadCustomerFlowConvexConfig(environment);
  const tallyConfig = loadTallyIntakeConfig(environment);
  const client = options.convexClient || new ConvexHttpClient(convexConfig.url);
  const now = options.now || (() => new Date().toISOString());
  const createId = options.createId || createCustomerFlowId;
  const customerStore = createConvexCustomerFlowStore({
    client,
    backendToken: convexConfig.backendToken,
    tokenEncryptionKey: convexConfig.tokenEncryptionKey,
  });
  const fulfillmentStore = createConvexFulfillmentStore({
    client,
    backendToken: convexConfig.backendToken,
  });
  const fulfillmentOrchestrator = createFulfillmentOrchestrator({
    store: fulfillmentStore,
    handlers: {},
    clock: now,
    tokenFactory: createId,
    retryPolicy: {
      leaseMsByStage: {},
      maxAttemptsByStage: {},
      backoffMsByStage: {},
    },
  });
  const service = createCustomerFlowService({
    store: customerStore,
    paymentGateway: {
      async createCheckoutSession() {
        throw new Error("Checkout is not available from the Tally intake runtime.");
      },
    },
    fulfillmentOrchestrator,
    syntheticOnly: false,
    enqueueWorkItem: true,
    atomicFulfillment: true,
    now,
    createId,
  });
  const process = createTallyIntakeProcessor({
    service,
    eventStore: customerStore,
    config: tallyConfig,
  });
  const consumeBudget = createHostedAbuseBudget({ client, backendToken: convexConfig.backendToken });
  return async (input) => {
    await consumeBudget("tally");
    return process(input);
  };
}
