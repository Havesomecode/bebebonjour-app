import { getRequestListener } from "@hono/node-server";

import { createHostedCustomerFlowRuntime } from "../../src/customer-flow/hosted-runtime.mjs";

export const config = { runtime: "nodejs" };

const runtime = createHostedCustomerFlowRuntime();
const listener = getRequestListener(runtime.api.fetch);

export default async function handler(request, response) {
  if (
    request.method !== "GET"
    && request.method !== "HEAD"
    && !Buffer.isBuffer(request.rawBody)
  ) {
    request.rawBody = await readRestoredBody(request);
  }
  return listener(request, response);
}

function readRestoredBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  });
}
