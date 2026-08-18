import { randomUUID } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import Stripe from "stripe";

import { loadHostedCustomerFlowConfig } from "../config/hosted-customer-flow-config.mjs";
import { createFulfillmentOrchestrator } from "../fulfillment/job-orchestrator.mjs";
import { createConvexCustomerFlowStore } from "../persistence/convex-customer-flow-store.mjs";
import { createConvexFulfillmentStore } from "../persistence/convex-fulfillment-store.mjs";
import { createHostedCustomerFlowHttpApi } from "./hosted-http-api.mjs";
import { createCustomerFlowService } from "./service.mjs";
import { createStripeCheckoutWebhookProcessor } from "./stripe-checkout-webhook.mjs";
import { createStripeTestPaymentGateway } from "./stripe-test-gateway.mjs";

export function createHostedCustomerFlowRuntime(options = {}) {
  const config = loadHostedCustomerFlowConfig(options.environment || process.env);
  const convexClient = options.convexClient || new ConvexHttpClient(config.convex.url);
  const stripe = options.stripe || new Stripe(config.stripe.secretKey, { maxNetworkRetries: 2 });
  const now = options.now || (() => new Date().toISOString());
  const createId = options.createId || ((label) => `${label}_${randomUUID()}`);

  const customerStore = createConvexCustomerFlowStore({
    client: convexClient,
    backendToken: config.convex.backendToken,
    tokenEncryptionKey: config.convex.tokenEncryptionKey,
  });
  const fulfillmentStore = createConvexFulfillmentStore({
    client: convexClient,
    backendToken: config.convex.backendToken,
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
  const paymentGateway = createStripeTestPaymentGateway({
    stripe,
    apiKey: config.stripe.secretKey,
    successUrl: config.stripe.successUrl,
    cancelUrl: config.stripe.cancelUrl,
  });
  const serviceOptions = {
    store: customerStore,
    paymentGateway,
    fulfillmentOrchestrator,
    syntheticOnly: true,
    now,
  };
  serviceOptions.createId = createId;
  const service = createCustomerFlowService(serviceOptions);
  const stripeProcessor = createStripeCheckoutWebhookProcessor({
    stripe,
    signingSecret: config.stripe.webhookSecret,
    service,
    eventStore: customerStore,
  });
  const api = createHostedCustomerFlowHttpApi({
    service,
    stripeProcessor,
    testAccessToken: config.testAccessToken,
    allowedOrigins: config.allowedOrigins,
  });
  return {
    api,
    service,
    fulfillmentOrchestrator,
  };
}
