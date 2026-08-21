import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import Stripe from "stripe";

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

test("Vercel catch-all completes Node responses and preserves Stripe raw bytes", async (t) => {
  Object.assign(process.env, environment);
  const entrypoint = await import("../../api/customer-flow/[...route].mjs");

  assert.equal(entrypoint.config.runtime, "nodejs");
  assert.equal(typeof entrypoint.default, "function");

  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      request.rawBody = Buffer.concat(chunks);
      await entrypoint.default(request, response);
      if (!response.writableEnded) {
        response.statusCode = 500;
        response.end("handler returned without ending the Node response");
      }
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const health = await fetch(`${baseUrl}/api/customer-flow/health`);
  assert.equal(health.status, 200, await health.text());

  const rawBody = Buffer.from(
    '{\n  "id": "evt_adapter_contract",\n  "type": "adapter.contract",\n  "data": {"object": {}}\n}\n',
    "utf8",
  );
  const stripe = new Stripe("webhook-signature-test-only");
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawBody.toString("utf8"),
    secret: environment.STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET,
  });
  const webhook = await fetch(`${baseUrl}/api/customer-flow/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: rawBody,
  });
  const webhookBody = await webhook.json();

  assert.equal(webhook.status, 200, JSON.stringify(webhookBody));
  assert.deepEqual(webhookBody, {
    received: true,
    ignored: true,
    eventType: "adapter.contract",
  });
});
