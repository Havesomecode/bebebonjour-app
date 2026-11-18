import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import Stripe from "stripe";

import {
  createStripeWebhookHandler,
  createTallyWebhookHandler,
} from "../../src/http/webhook-handlers.mjs";

const tallyRawBody = await readFile(
  new URL("../fixtures/tally-paid-submission.json", import.meta.url),
);
const tallyFieldMap = JSON.parse(
  await readFile(new URL("../fixtures/tally-field-map.json", import.meta.url), "utf8"),
);
const stripeRawBody = await readFile(
  new URL("../fixtures/stripe-payment-succeeded.json", import.meta.url),
);

function request(rawBody, headers) {
  const stream = Readable.from([rawBody]);
  stream.method = "POST";
  stream.headers = headers;
  return stream;
}

async function vercelRestoredRequest(rawBody, headers) {
  const stream = request(rawBody, headers);

  for await (const _chunk of stream) {
    // Vercel serializes the original IncomingMessage before invoking user code.
  }

  const restoredBody = new PassThrough();
  const restoredOn = restoredBody.on.bind(restoredBody);
  const originalOn = stream.on.bind(stream);
  stream.read = restoredBody.read.bind(restoredBody);
  stream.on = stream.addListener = (name, callback) => (
    name === "data" || name === "end"
      ? restoredOn(name, callback)
      : originalOn(name, callback)
  );
  restoredBody.write(rawBody);
  restoredBody.end();

  return stream;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value = "") {
      this.body = value;
    },
  };
}

test("the Vercel Tally handler reads raw bytes and returns an acknowledgement", async () => {
  const signingSecret = "test-signing-secret";
  const signature = createHmac("sha256", signingSecret)
    .update(tallyRawBody)
    .digest("base64");
  const store = {
    async ingestTallySubmission() {
      return { duplicate: false, orderId: "order_001", status: "pending_payment" };
    },
  };
  const handler = createTallyWebhookHandler({
    store,
    config: {
      signingSecret,
      normalization: {
        expectedFormId: "form_test_001",
        expectedAmount: 39,
        expectedCurrency: "EUR",
        fieldMap: tallyFieldMap,
      },
    },
  });
  const res = response();

  await handler(request(tallyRawBody, { "tally-signature": signature }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(res.body), { received: true });
});

test("the Vercel Tally handler reads a body restored by the Vercel Node adapter", async () => {
  const signingSecret = "test-signing-secret";
  const signature = createHmac("sha256", signingSecret)
    .update(tallyRawBody)
    .digest("base64");
  let persistCalls = 0;
  const handler = createTallyWebhookHandler({
    store: {
      async ingestTallySubmission() {
        persistCalls += 1;
        return { duplicate: false, orderId: "order_001", status: "pending_payment" };
      },
    },
    config: {
      signingSecret,
      normalization: {
        expectedFormId: "form_test_001",
        expectedAmount: 39,
        expectedCurrency: "EUR",
        fieldMap: tallyFieldMap,
      },
    },
  });
  const req = await vercelRestoredRequest(tallyRawBody, { "tally-signature": signature });
  const res = response();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(persistCalls, 1);
  assert.deepEqual(JSON.parse(res.body), { received: true });
});

test("the Vercel Stripe handler reads raw bytes and returns an acknowledgement", async () => {
  const signingSecret = "whsec_test_secret";
  const stripe = new Stripe("webhook-signature-test-only");
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: stripeRawBody.toString("utf8"),
    secret: signingSecret,
  });
  const store = {
    async ingestStripePayment() {
      return { duplicate: false, paymentId: "pi_test_001", status: "succeeded" };
    },
  };
  const handler = createStripeWebhookHandler({
    store,
    config: {
      signingSecret,
      normalization: {
        expectedAmountMinor: 3900,
        expectedCurrency: "EUR",
      },
    },
  });
  const res = response();

  await handler(request(stripeRawBody, { "stripe-signature": signature }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { received: true });
});
