import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createLazyTallyIntakeHandler } from "../../src/http/tally-intake-handler.mjs";

test("Tally HTTP handler forwards exact raw bytes and returns a token-free acknowledgement", async () => {
  const rawBody = Buffer.from('{"eventId":"evt_001"}', "utf8");
  const calls = [];
  const handler = createLazyTallyIntakeHandler({
    processorFactory() {
      return async (input) => {
        calls.push(input);
        return { accepted: true, duplicate: false, jobId: "job_tally_001" };
      };
    },
  });
  const request = Readable.from([rawBody]);
  request.method = "POST";
  request.headers = {
    "content-type": "application/json",
    "tally-signature": "signed-value",
  };
  const response = responseHarness();

  await handler(request, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    received: true,
    duplicate: false,
    jobId: "job_tally_001",
  });
  assert.equal(Buffer.compare(calls[0].rawBody, rawBody), 0);
  assert.equal(calls[0].signature, "signed-value");
  assert.equal(response.body.includes("token"), false);
});

test("Tally HTTP handler rejects invalid methods before runtime initialization", async () => {
  let initialized = false;
  const handler = createLazyTallyIntakeHandler({
    processorFactory() {
      initialized = true;
      return async () => ({ accepted: true });
    },
  });
  const request = Readable.from([]);
  request.method = "GET";
  request.headers = {};
  const response = responseHarness();

  await handler(request, response);

  assert.equal(response.statusCode, 405);
  assert.equal(initialized, false);
});

test("Tally HTTP handler acknowledges a durably rejected signed submission", async () => {
  const handler = createLazyTallyIntakeHandler({
    processorFactory: () => async () => ({
      accepted: true,
      duplicate: false,
      rejected: true,
      reasonCode: "consent_required",
    }),
  });
  const request = Readable.from([Buffer.from('{"eventId":"evt_rejected"}')]);
  request.method = "POST";
  request.headers = {
    "content-type": "application/json",
    "tally-signature": "signed",
  };
  const response = responseHarness();

  await handler(request, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    received: true,
    duplicate: false,
    rejected: true,
    reasonCode: "consent_required",
  });
});

function responseHarness() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = "") { this.body += value; },
  };
}
