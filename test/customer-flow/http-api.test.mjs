import assert from "node:assert/strict";
import test from "node:test";

import { createCustomerFlowHttpApi } from "../../src/customer-flow/http-api.mjs";
import { CustomerFlowError } from "../../src/customer-flow/service.mjs";

function serviceStub() {
  const calls = [];
  return {
    calls,
    async submitIntake(intake) {
      calls.push({ method: "submitIntake", intake });
      return { jobId: "job_test_001", intakeToken: "private", status: "payment_pending" };
    },
    async getStatus(jobId, token) {
      calls.push({ method: "getStatus", jobId, token });
      return { jobId, status: "payment_pending" };
    },
    async createCheckout(jobId, token) {
      calls.push({ method: "createCheckout", jobId, token });
      return { sessionId: "cs_test_001", checkoutUrl: "/test-checkout" };
    },
  };
}

test("customer HTTP API exposes only intake, status, and checkout commands", async () => {
  const service = serviceStub();
  const api = createCustomerFlowHttpApi({ service, allowedOrigins: ["http://127.0.0.1:5173"] });
  const authorization = "Bearer private-token";

  const intake = await api.request("/v1/intakes", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ baby: { firstName: "Amal Test" } }),
  });
  assert.equal(intake.status, 201);
  assert.equal(intake.headers.get("cache-control"), "no-store");

  const status = await api.request("/v1/jobs/job_test_001/status", {
    method: "GET",
    headers: { authorization, origin: "http://127.0.0.1:5173" },
  });
  assert.equal(status.status, 200);

  const checkout = await api.request("/v1/jobs/job_test_001/checkout", {
    method: "POST",
    headers: { authorization, origin: "http://127.0.0.1:5173" },
  });
  assert.equal(checkout.status, 200);

  const bypass = await api.request("/v1/jobs/job_test_001/approve", {
    method: "POST",
    headers: { authorization, origin: "http://127.0.0.1:5173" },
    body: "{}",
  });
  assert.equal(bypass.status, 404);
  assert.equal(bypass.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
  assert.deepEqual(await bypass.json(), { error: { code: "not_found", message: "Not found." } });

  const preflight = await api.request("/v1/jobs/job_test_001/checkout", {
    method: "OPTIONS",
    headers: { origin: "http://127.0.0.1:5173" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.deepEqual(service.calls.map(({ method }) => method), [
    "submitIntake",
    "getStatus",
    "createCheckout",
  ]);
});

test("customer HTTP API rejects unapproved origins and oversized or malformed bodies", async () => {
  const api = createCustomerFlowHttpApi({
    service: serviceStub(),
    allowedOrigins: ["http://127.0.0.1:5173"],
  });

  const foreign = await api.request("/v1/intakes", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: "{}",
  });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error.code, "origin_not_allowed");

  const jsonp = await api.request("/v1/intakes", {
    method: "POST",
    headers: { "content-type": "application/jsonp" },
    body: "{}",
  });
  assert.equal(jsonp.status, 415);
  assert.equal((await jsonp.json()).error.code, "unsupported_media_type");

  const malformed = await api.request("/v1/intakes", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: "not-json",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_json");

  const large = await api.request("/v1/intakes", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ value: "x".repeat(65_000) }),
  });
  assert.equal(large.status, 413);
  assert.equal((await large.json()).error.code, "request_too_large");

  const lowercaseBearer = await api.request("/v1/jobs/job_test_001/status", {
    headers: { authorization: "bearer private-token" },
  });
  assert.equal(lowercaseBearer.status, 200);
});

test("customer HTTP API bounds streamed bodies and exposes only canonical errors", async () => {
  let emittedChunks = 0;
  const streamedBody = new ReadableStream({
    pull(controller) {
      emittedChunks += 1;
      controller.enqueue(new Uint8Array(1_024).fill(120));
      if (emittedChunks === 100) controller.close();
    },
  });
  const api = createCustomerFlowHttpApi({ service: serviceStub() });
  const oversized = await api.fetch(new Request("http://localhost/v1/intakes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: streamedBody,
    duplex: "half",
  }));

  assert.equal(oversized.status, 413);
  assert.ok(emittedChunks < 100, "the API must reject a streamed body before buffering it in full");

  const failingService = serviceStub();
  failingService.submitIntake = async () => {
    throw new CustomerFlowError(400, "invalid_intake", "Sensitive adapter details must not cross the boundary.");
  };
  const redactingApi = createCustomerFlowHttpApi({ service: failingService });
  const redacted = await redactingApi.request("/v1/intakes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(redacted.status, 400);
  assert.deepEqual(await redacted.json(), {
    error: { code: "invalid_intake", message: "Submitted intake fields are invalid." },
  });
});
