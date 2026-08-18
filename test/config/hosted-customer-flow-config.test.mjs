import assert from "node:assert/strict";
import test from "node:test";

import {
  loadHostedCustomerFlowConfig,
  loadResendDeliveryConfig,
} from "../../src/config/hosted-customer-flow-config.mjs";

const environment = {
  CONVEX_URL: "https://test-a.convex.cloud",
  CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
  CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  CUSTOMER_FLOW_TEST_ACCESS_TOKEN: "test-access-token-at-least-32-characters",
  CUSTOMER_FLOW_ALLOWED_ORIGINS: '["https://bonjour.example.test"]',
  STRIPE_SECRET_KEY: "sk_test_candidate_only",
  STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET: "whsec_candidate_only",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://bonjour.example.test/suivi?checkout=success",
  STRIPE_CHECKOUT_CANCEL_URL: "https://bonjour.example.test/suivi?checkout=cancel",
  RESEND_API_KEY: "re_candidate_only",
  RESEND_FROM: "Bébé Bonjour <delivery@example.test>",
};

test("hosted customer-flow config accepts only explicit test-mode provider boundaries", () => {
  assert.deepEqual(loadHostedCustomerFlowConfig(environment), {
    convex: {
      url: environment.CONVEX_URL,
      backendToken: environment.CUSTOMER_FLOW_BACKEND_TOKEN,
      tokenEncryptionKey: environment.CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY,
    },
    testAccessToken: environment.CUSTOMER_FLOW_TEST_ACCESS_TOKEN,
    allowedOrigins: ["https://bonjour.example.test"],
    stripe: {
      secretKey: environment.STRIPE_SECRET_KEY,
      webhookSecret: environment.STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET,
      successUrl: environment.STRIPE_CHECKOUT_SUCCESS_URL,
      cancelUrl: environment.STRIPE_CHECKOUT_CANCEL_URL,
    },
  });
  assert.throws(
    () => loadHostedCustomerFlowConfig({ ...environment, STRIPE_SECRET_KEY: "sk_live_forbidden" }),
    /test-mode/i,
  );
  assert.throws(
    () => loadHostedCustomerFlowConfig({ ...environment, CUSTOMER_FLOW_ALLOWED_ORIGINS: '["http://localhost:5173"]' }),
    /HTTPS origin/i,
  );
});

test("Resend delivery credentials load only for the operator delivery runtime", () => {
  assert.deepEqual(loadResendDeliveryConfig(environment), {
    apiKey: environment.RESEND_API_KEY,
    from: environment.RESEND_FROM,
  });
  assert.doesNotThrow(() => loadHostedCustomerFlowConfig({
    ...environment,
    RESEND_API_KEY: undefined,
    RESEND_FROM: undefined,
  }));
});
