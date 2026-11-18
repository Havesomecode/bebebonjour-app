import { createHash, timingSafeEqual } from "node:crypto";

import { bodyLimit } from "hono/body-limit";

import { createCustomerFlowHttpApi } from "./http-api.mjs";
import { StripeCheckoutWebhookError } from "./stripe-checkout-webhook.mjs";

const MAX_WEBHOOK_BYTES = 64_000;
const PATH_PREFIX = "/api/customer-flow";

export function createHostedCustomerFlowHttpApi(options = {}) {
  if (typeof options.stripeProcessor !== "function") {
    throw new Error("A Stripe Checkout webhook processor is required.");
  }
  if (typeof options.testAccessToken !== "string" || options.testAccessToken.length < 32) {
    throw new Error("A high-entropy TEST-A access token is required.");
  }
  const app = createCustomerFlowHttpApi({
    service: options.service,
    allowedOrigins: options.allowedOrigins,
    pathPrefix: PATH_PREFIX,
    authorizeRequest: (request) => safeEqual(
      request.header("x-test-a-access-token") || "",
      options.testAccessToken,
    ),
  });

  app.post(
    `${PATH_PREFIX}/webhooks/stripe`,
    bodyLimit({
      maxSize: MAX_WEBHOOK_BYTES,
      onError: (context) => context.json({ received: false, error: "request_too_large" }, 413),
    }),
    async (context) => {
      const signature = context.req.header("stripe-signature");
      if (!signature) return context.json({ received: false, error: "signature_required" }, 400);
      const rawBody = new Uint8Array(await context.req.arrayBuffer());
      try {
        const result = await options.stripeProcessor(rawBody, signature);
        context.header("Cache-Control", "no-store");
        return context.json(result);
      } catch (error) {
        if (error instanceof StripeCheckoutWebhookError) {
          return context.json({ received: false, error: "invalid_webhook" }, 400);
        }
        throw error;
      }
    },
  );

  app.get(`${PATH_PREFIX}/health`, (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      boundary: "TEST-A",
      persistence: "convex-hosted",
      payment: "stripe-test-mode",
      delivery: "operator-gated-resend-test",
    });
  });

  return app;
}

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
