import { createHash, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { bodyLimit } from "hono/body-limit";
import { createCustomerFlowHttpApi } from "../../src/customer-flow/http-api.mjs";
import { createCustomerFlowService } from "../../src/customer-flow/service.mjs";
import { createStripeCheckoutWebhookProcessor, StripeCheckoutWebhookError } from "../../src/customer-flow/stripe-checkout-webhook.mjs";
import { createStripeTestPaymentGateway } from "../../src/customer-flow/stripe-test-gateway.mjs";
import { createFulfillmentOrchestrator } from "../../src/fulfillment/job-orchestrator.mjs";
import { createPool } from "./database.mjs";
import { createPostgresCustomerStore } from "./customer-store.mjs";
import { createPostgresFulfillmentStore } from "./fulfillment-store.mjs";
import { encryptionKey } from "./private-response.mjs";

const same = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export function loadConfig(env) {
  if (env.BB_CANDIDATE_MODE !== "synthetic") throw new Error("Only explicit synthetic candidate mode is supported.");
  const required = (name, min = 1) => {
    const value = env[name];
    if (typeof value !== "string" || value.length < min) throw new Error(`Missing or invalid ${name}.`);
    return value;
  };
  const databaseUrl = required("DATABASE_URL");
  const database = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || database.pathname.length < 2) throw new Error("A PostgreSQL database URL is required.");
  const tokenEncryptionKey = required("CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY");
  encryptionKey(tokenEncryptionKey);
  const testAccessToken = required("CUSTOMER_FLOW_TEST_ACCESS_TOKEN", 32);
  const apiKey = required("STRIPE_SECRET_KEY");
  if (!apiKey.startsWith("sk_test_")) throw new Error("Only Stripe test credentials are supported.");
  const webhookSecret = required("STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET", 12);
  if (!webhookSecret.startsWith("whsec_")) throw new Error("A Stripe webhook signing secret is required.");
  const allowedOrigins = JSON.parse(required("CUSTOMER_FLOW_ALLOWED_ORIGINS"));
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.length > 10) throw new Error("Explicit origins are required.");
  const safeUrl = (value) => {
    const url = new URL(value);
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Unsafe application URL.");
    return url;
  };
  for (const origin of allowedOrigins) if (typeof origin !== "string" || safeUrl(origin).origin !== origin) throw new Error("Origins must be exact URLs.");
  const successUrl = required("STRIPE_CHECKOUT_SUCCESS_URL");
  const cancelUrl = required("STRIPE_CHECKOUT_CANCEL_URL");
  for (const value of [successUrl, cancelUrl]) {
    const url = safeUrl(value);
    if (url.protocol !== "https:" || !allowedOrigins.includes(url.origin)) throw new Error("Checkout redirects must use an allowed HTTPS origin.");
  }
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  return Object.freeze({ databaseUrl, tokenEncryptionKey, testAccessToken, allowedOrigins,
    stripe: { apiKey, webhookSecret, successUrl, cancelUrl }, port });
}

export function createCandidateRuntime({ config, pool = createPool(config.databaseUrl), stripe = new Stripe(config.stripe.apiKey, { maxNetworkRetries: 2, timeout: 10_000 }) }) {
  const customerStore = createPostgresCustomerStore({ pool, tokenEncryptionKey: config.tokenEncryptionKey });
  const fulfillmentStore = createPostgresFulfillmentStore({ pool });
  const fulfillmentOrchestrator = createFulfillmentOrchestrator({ store: fulfillmentStore, handlers: {},
    clock: () => new Date().toISOString(), tokenFactory: () => { throw new Error("Workers are not activated."); },
    retryPolicy: { leaseMsByStage: {}, maxAttemptsByStage: {}, backoffMsByStage: {} } });
  const paymentGateway = createStripeTestPaymentGateway({ stripe, ...config.stripe });
  const service = createCustomerFlowService({ store: customerStore, paymentGateway,
    fulfillmentOrchestrator, atomicFulfillment: true, syntheticOnly: true });
  const api = createCustomerFlowHttpApi({ service, allowedOrigins: config.allowedOrigins,
    pathPrefix: "/api/customer-flow", authorizeRequest: (request) => same(request.header("x-test-a-access-token") || "", config.testAccessToken) });
  const processor = createStripeCheckoutWebhookProcessor({ stripe, signingSecret: config.stripe.webhookSecret,
    service, eventStore: customerStore });
  api.post("/api/customer-flow/webhooks/stripe", bodyLimit({ maxSize: 64_000,
    onError: (c) => c.json({ received: false, error: "request_too_large" }, 413) }), async (c) => {
    c.header("Cache-Control", "no-store");
    const signature = c.req.header("stripe-signature");
    if (!signature) return c.json({ received: false, error: "signature_required" }, 400);
    try { return c.json(await processor(new Uint8Array(await c.req.arrayBuffer()), signature)); }
    catch (error) {
      if (error instanceof StripeCheckoutWebhookError) return c.json({ received: false, error: "invalid_webhook" }, 400);
      throw error;
    }
  });
  const health = async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      await pool.query("SELECT 1 FROM bb_candidate.customer_jobs LIMIT 0");
      await pool.query("SELECT 1 FROM bb_candidate.fulfillment_jobs LIMIT 0");
      await pool.query("SELECT 1 FROM bb_candidate.submissions LIMIT 0");
      await pool.query("SELECT 1 FROM bb_candidate.provider_events LIMIT 0");
      await pool.query("SELECT 1 FROM bb_candidate.review_approvals LIMIT 0");
      return c.json({ ok: true, persistence: "postgresql", mode: "synthetic" });
    } catch { return c.json({ ok: false }, 503); }
  };
  api.get("/healthz", health);
  api.get("/api/customer-flow/health", health);
  let closed = false;
  return { api, service, customerStore, fulfillmentStore, fulfillmentOrchestrator,
    async close() { if (!closed) { closed = true; if (!pool.ending) await pool.end(); } } };
}
