import assert from "node:assert/strict";
import test from "node:test";

import {
  FulfillmentApiError,
  createFulfillmentClient,
} from "../src/fulfillment-client.js";

const canonicalHostedApiBaseUrl = "https://bebebonjour-fulfillment.vercel.app/api/customer-flow";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("first-party intake posts sensitive fields only in a JSON body", async () => {
  const calls = [];
  const intake = {
    customer: { email: "synthetic.parent@example.test", consent: true },
    baby: { firstName: "Amal Test", gender: "girl" },
  };
  const client = createFulfillmentClient({
    baseUrl: "http://127.0.0.1:8787",
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(201, {
        jobId: "job_test_001",
        intakeToken: "tok_test_private",
        status: "payment_pending",
      });
    },
  });

  const result = await client.submitIntake(intake);

  assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/intakes");
  assert.equal(calls[0].url.includes("Amal"), false);
  assert.equal(calls[0].url.includes("synthetic.parent"), false);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), intake);
  assert.deepEqual(result, {
    jobId: "job_test_001",
    intakeToken: "tok_test_private",
    status: "payment_pending",
  });
});

test("status and checkout authenticate with the opaque token instead of putting it in a URL", async () => {
  const calls = [];
  const client = createFulfillmentClient({
    baseUrl: "http://127.0.0.1:8787",
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.endsWith("/checkout")) {
        return jsonResponse(200, {
          sessionId: "cs_test_001",
          checkoutUrl: "http://127.0.0.1:4173/test-checkout/job_test_001",
        });
      }
      return jsonResponse(200, {
        jobId: "job_test_001",
        status: "payment_pending",
        payment: "pending",
        review: "not_ready",
        delivery: "not_ready",
      });
    },
  });

  await client.getStatus("job_test_001", "tok_test_private");
  await client.createCheckout("job_test_001", "tok_test_private");

  assert.deepEqual(calls.map(({ url, options }) => ({
    url,
    method: options.method,
    authorization: options.headers.authorization,
    cache: options.cache,
  })), [
    {
      url: "http://127.0.0.1:8787/v1/jobs/job_test_001/status",
      method: "GET",
      authorization: "Bearer tok_test_private",
      cache: "no-store",
    },
    {
      url: "http://127.0.0.1:8787/v1/jobs/job_test_001/checkout",
      method: "POST",
      authorization: "Bearer tok_test_private",
      cache: "no-store",
    },
  ]);
  assert.equal(calls.some(({ url }) => url.includes("tok_test_private")), false);
});

test("TEST-A client rejects non-loopback API origins", () => {
  for (const baseUrl of ["", "https://api.example.test", "http://192.0.2.10:8787"]) {
    assert.throws(
      () => createFulfillmentClient({ baseUrl }),
      /loopback HTTP origin/i,
    );
  }
});

test("hosted API uses the candidate route prefix for the exact approved HTTPS origin", async () => {
  const calls = [];
  const client = createFulfillmentClient({
    baseUrl: canonicalHostedApiBaseUrl,
    getTestAccessToken: () => "test-access-token-at-least-32-characters",
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return jsonResponse(201, {
        jobId: "job_test_001",
        intakeToken: "tok_test_private",
        status: "payment_pending",
      });
    },
  });

  await client.submitIntake({ schemaVersion: "1.0" });

  assert.equal(
    calls[0].url,
    `${canonicalHostedApiBaseUrl}/v1/intakes`,
  );
});

test("hosted commands reuse one in-memory TEST-A access token", async () => {
  const calls = [];
  let tokenRequests = 0;
  const client = createFulfillmentClient({
    baseUrl: canonicalHostedApiBaseUrl,
    getTestAccessToken() {
      tokenRequests += 1;
      return "test-access-token-at-least-32-characters";
    },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.endsWith("/v1/intakes")) {
        return jsonResponse(201, {
          jobId: "job_test_001",
          intakeToken: "tok_test_private",
          status: "payment_pending",
        });
      }
      return jsonResponse(200, {
        jobId: "job_test_001",
        status: "payment_pending",
        payment: "pending",
        review: "not_ready",
        delivery: "not_ready",
      });
    },
  });

  await client.submitIntake({ schemaVersion: "1.0" });
  await client.getStatus("job_test_001", "tok_test_private");

  assert.equal(tokenRequests, 1);
  assert.deepEqual(
    calls.map(({ options }) => options.headers["x-test-a-access-token"]),
    [
      "test-access-token-at-least-32-characters",
      "test-access-token-at-least-32-characters",
    ],
  );
});

test("hosted API stops before the request when interactive TEST-A access is missing", async () => {
  let fetchCalls = 0;
  const client = createFulfillmentClient({
    baseUrl: canonicalHostedApiBaseUrl,
    getTestAccessToken: () => null,
    async fetchImpl() {
      fetchCalls += 1;
      return jsonResponse(500, {});
    },
  });

  await assert.rejects(
    client.submitIntake({ schemaVersion: "1.0" }),
    (error) => error instanceof FulfillmentApiError
      && error.statusCode === 401
      && error.code === "test_access_required"
      && error.message === "Le jeton d’accès TEST-A est requis pour continuer.",
  );
  assert.equal(fetchCalls, 0);
});

test("equal noncanonical HTTPS and landing-self overrides cannot enable the hosted client", () => {
  for (const origin of ["https://api.example.test", "https://www.bebebonjour.com"]) {
    assert.throws(
      () => createFulfillmentClient({
        baseUrl: `${origin}/api/customer-flow`,
        approvedHostedOrigin: origin,
      }),
      /canonical hosted API base URL/i,
    );
  }
});

test("an ambiguous intake failure keeps one idempotency key across automatic and manual retries", async () => {
  const calls = [];
  let createdIds = 0;
  const client = createFulfillmentClient({
    baseUrl: "http://127.0.0.1:8787",
    createId: () => `request-${createdIds += 1}`,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (calls.length <= 2) throw new TypeError("connection reset after write");
      return jsonResponse(201, {
        jobId: "job_test_001",
        intakeToken: "tok_test_private",
        status: "payment_pending",
      });
    },
  });

  const intake = { schemaVersion: "1.0" };
  await assert.rejects(client.submitIntake(intake), FulfillmentApiError);
  await client.submitIntake(intake);

  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(
    ({ options }) => options.headers["idempotency-key"],
  )).size, 1);
});

test("API failures expose only the stable server error and tolerate invalid JSON", async () => {
  const client = createFulfillmentClient({
    baseUrl: "http://127.0.0.1:8787",
    async fetchImpl() {
      return new Response("upstream stack and sensitive payload", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    },
  });

  await assert.rejects(
    client.submitIntake({}),
    (error) => error instanceof FulfillmentApiError
      && error.statusCode === 503
      && error.code === "request_failed"
      && error.message === "Le service est momentanément indisponible. Réessayez.",
  );
});
