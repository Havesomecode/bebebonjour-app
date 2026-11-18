import { loadCustomerFlowConvexConfig } from "../config/hosted-customer-flow-config.mjs";
import { createCustomerFlowRuntime } from "../customer-flow/service.mjs";
import { createStripeTestPaymentGateway } from "../customer-flow/stripe-test-gateway.mjs";
import { createConvexCustomerFlowStore } from "../persistence/convex-customer-flow-store.mjs";

// Only the Operations effect fence may call this capability in production.
// The backend token is never returned to the operator or Tally webhook.
export function createProductionCheckoutWorker({ client, environment = {}, stripe } = {}) {
  const { backendToken } = loadCustomerFlowConvexConfig(environment);
  const customerStore = createConvexCustomerFlowStore({ client, backendToken });
  const paymentGateway = createStripeTestPaymentGateway({
    ...(stripe ? { stripe } : { apiKey: environment.STRIPE_SECRET_KEY }),
    successUrl: environment.STRIPE_CHECKOUT_SUCCESS_URL,
    cancelUrl: environment.STRIPE_CHECKOUT_CANCEL_URL,
  });
  const { operationsCheckout } = createCustomerFlowRuntime({
    store: customerStore,
    paymentGateway,
    syntheticOnly: false,
  });
  return Object.freeze({ operationsCheckout, customerStore });
}
