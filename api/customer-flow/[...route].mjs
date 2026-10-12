import { getRequestListener } from "@hono/node-server";

import { createHostedCustomerFlowRuntime } from "../../src/customer-flow/hosted-runtime.mjs";

export const config = { runtime: "nodejs" };

const runtime = createHostedCustomerFlowRuntime();
const listener = getRequestListener(runtime.api.fetch);
const MAX_BODY_BYTES = 64_000;

export default async function handler(request, response) {
  if (
    request.method !== "GET"
    && request.method !== "HEAD"
    && !Buffer.isBuffer(request.rawBody)
  ) {
    try {
      request.rawBody = await readRestoredBody(request);
    } catch {
      return rejectBody(response, 413, "request_too_large");
    }
  }
  if (Buffer.isBuffer(request.rawBody) && request.rawBody.length > MAX_BODY_BYTES) {
    return rejectBody(response, 413, "request_too_large");
  }
  return listener(request, response);
}

function rejectBody(response, status, code) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify({ error: { code, message: "Request body is too large." } }));
}

function readRestoredBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new Error("request_too_large"));
        return;
      }
      chunks.push(buffer);
    });
  });
}
