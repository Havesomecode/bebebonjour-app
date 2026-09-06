import assert from "node:assert/strict";
import test from "node:test";

import { createOperationsWorkerHttpHandler } from "../../src/http/operations-worker-handler.mjs";

function responseCapture() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = "") { this.body += String(value); },
  };
}

const successfulResult = {
  status: "ok",
  protocolVersion: "1.0",
  workerId: "production-worker-1",
  enabledActionCount: 0,
  claimed: 0,
  completed: 0,
  failed: 0,
};

test("worker HTTP boundary authenticates one cron GET and returns bounded output", async () => {
  let calls = 0;
  const handler = createOperationsWorkerHttpHandler({
    cronSecret: "cron-secret-with-at-least-thirty-two-bytes",
    async runWorker() { calls += 1; return successfulResult; },
  });
  const unauthorized = responseCapture();
  await handler({ method: "GET", headers: { authorization: "Bearer wrong" } }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls, 0);

  const response = responseCapture();
  await handler({
    method: "GET",
    headers: { authorization: "Bearer cron-secret-with-at-least-thirty-two-bytes" },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(JSON.parse(response.body), successfulResult);
  assert.equal(calls, 1);
});

test("worker HTTP boundary rejects methods and hides runtime failures", async () => {
  const handler = createOperationsWorkerHttpHandler({
    cronSecret: "cron-secret-with-at-least-thirty-two-bytes",
    async runWorker() { throw new Error("provider details must not escape"); },
  });
  const method = responseCapture();
  await handler({ method: "POST", headers: {} }, method);
  assert.equal(method.statusCode, 405);

  const failed = responseCapture();
  await handler({
    method: "GET",
    headers: { authorization: "Bearer cron-secret-with-at-least-thirty-two-bytes" },
  }, failed);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(JSON.parse(failed.body), { status: "error", code: "worker_failed_safely" });
  assert.equal(failed.body.includes("provider details"), false);
});
