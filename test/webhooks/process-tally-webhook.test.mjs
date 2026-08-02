import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { processTallyWebhook } from "../../src/webhooks/process-tally-webhook.mjs";

const rawBody = await readFile(
  new URL("../fixtures/tally-paid-submission.json", import.meta.url),
);
const fieldMap = JSON.parse(
  await readFile(new URL("../fixtures/tally-field-map.json", import.meta.url), "utf8"),
);
const signingSecret = "test-signing-secret";
const signature = createHmac("sha256", signingSecret).update(rawBody).digest("base64");

function recordingStore() {
  const calls = [];
  return {
    calls,
    async ingestTallySubmission(normalized, evidence) {
      calls.push({ method: "ingest", normalized, evidence });
      return { duplicate: false, orderId: "order_001", status: "pending_payment" };
    },
    async recordRejectedProviderEvent(rejection) {
      calls.push({ method: "reject", rejection });
      return { duplicate: false, rejected: true };
    },
  };
}

const config = {
  signingSecret,
  normalization: {
    expectedFormId: "form_test_001",
    expectedAmount: 39,
    expectedCurrency: "EUR",
    fieldMap,
  },
};

test("a signed paid Tally webhook is persisted once", async () => {
  const store = recordingStore();

  const result = await processTallyWebhook({ rawBody, signature, config, store });

  assert.deepEqual(result, {
    duplicate: false,
    orderId: "order_001",
    status: "pending_payment",
  });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].method, "ingest");
  assert.equal(store.calls[0].normalized.source.eventId, "evt_tally_001");
  assert.equal(store.calls[0].normalized.payment.paymentId, "pi_test_001");
  assert.equal(
    store.calls[0].evidence.payloadSha256,
    createHash("sha256").update(rawBody).digest("hex"),
  );
});

test("an invalid Tally webhook signature performs no persistence", async () => {
  const store = recordingStore();

  await assert.rejects(
    processTallyWebhook({ rawBody, signature: "invalid", config, store }),
    (error) => error.statusCode === 401 && /signature/i.test(error.message),
  );
  assert.equal(store.calls.length, 0);
});

test("a signed business-invalid Tally webhook is durably rejected without raw payload persistence", async () => {
  const event = JSON.parse(rawBody.toString("utf8"));
  event.data.formId = "unexpected_form";
  const invalidBody = Buffer.from(JSON.stringify(event), "utf8");
  const invalidSignature = createHmac("sha256", signingSecret).update(invalidBody).digest("base64");
  const store = recordingStore();

  const result = await processTallyWebhook({
    rawBody: invalidBody,
    signature: invalidSignature,
    config,
    store,
  });

  assert.deepEqual(result, { duplicate: false, rejected: true });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].method, "reject");
  assert.deepEqual(store.calls[0].rejection, {
    provider: "tally",
    eventId: "evt_tally_001",
    reasonCode: "normalization_failed",
    payloadSha256: createHash("sha256").update(invalidBody).digest("hex"),
  });
});
