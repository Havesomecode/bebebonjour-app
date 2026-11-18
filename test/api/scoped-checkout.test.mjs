import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createScopedCheckoutHandler } from "../../src/http/scoped-checkout-handler.mjs";

const jobId = "job_ac41c7b1-f532-430e-8a88-fb1aaa268a6d";
const operatorToken = "fictional-operator-token-of-at-least-32-characters";
const backendToken = "fictional-backend-token-of-at-least-32-characters";
const environment = {
  BEBEBONJOUR_CHECKOUT_JOB_ID: jobId,
  BEBEBONJOUR_OPERATIONS_TOKEN: operatorToken,
  CUSTOMER_FLOW_BACKEND_TOKEN: backendToken,
};
function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}
function signedRequest(id = jobId) {
  return {
    method: "POST", body: { jobId: id },
    headers: { authorization: `Bearer ${createHmac("sha256", operatorToken).update(`checkout-handoff:v1:${id}`).digest("hex")}` },
  };
}

test("scoped checkout route never exposes a login bypass or arbitrary-job operation", async () => {
  let calls = 0;
  const handler = createScopedCheckoutHandler({ environment, handoff: async (id) => {
    calls += 1;
    assert.equal(id, jobId);
    return { jobId: id, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_fictional" };
  } });
  for (const request of [
    { ...signedRequest(), method: "GET" },
    { ...signedRequest(), headers: {} },
    { ...signedRequest(), headers: { authorization: "Bearer " + "a".repeat(64) } },
    { ...signedRequest(), headers: { authorization: `Bearer ${createHmac("sha256", backendToken).update(`checkout-handoff:v1:${jobId}`).digest("hex")}` } },
    signedRequest("job_other-fictional"),
  ]) {
    const result = response();
    await handler(request, result);
    assert.notEqual(result.statusCode, 200);
  }
  assert.equal(calls, 0);
  const accepted = response();
  await handler(signedRequest(), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.body, { jobId, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_fictional" });
  assert.equal(calls, 1);
});

test("scoped checkout route fails closed without explicit job and configured authority", async () => {
  const handler = createScopedCheckoutHandler({ environment: {}, handoff: async () => { throw new Error("must not run"); } });
  const result = response();
  await handler(signedRequest(), result);
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, { code: "checkout_unavailable" });
});
