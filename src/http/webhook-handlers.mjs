import { WebhookRequestError } from "../webhooks/errors.mjs";
import { processStripeWebhook } from "../webhooks/process-stripe-webhook.mjs";
import { processTallyWebhook } from "../webhooks/process-tally-webhook.mjs";

const MAX_WEBHOOK_BYTES = 1_000_000;

export function createTallyWebhookHandler(options) {
  return createWebhookHandler({
    ...options,
    provider: "Tally",
    signatureHeader: "tally-signature",
    processWebhook: processTallyWebhook,
  });
}

export function createStripeWebhookHandler(options) {
  return createWebhookHandler({
    ...options,
    provider: "Stripe",
    signatureHeader: "stripe-signature",
    processWebhook: processStripeWebhook,
  });
}

function createWebhookHandler({
  config,
  logger = console,
  processWebhook,
  provider,
  signatureHeader,
  store,
}) {
  return async function webhookHandler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return sendJson(response, 405, { received: false, error: "Method not allowed." });
    }

    try {
      const rawBody = await readRawBody(request);
      const signature = headerValue(request.headers, signatureHeader);
      await processWebhook({ rawBody, signature, config, store });
      return sendJson(response, 200, { received: true });
    } catch (error) {
      if (error instanceof WebhookRequestError) {
        return sendJson(response, error.statusCode, {
          received: false,
          error: error.message,
        });
      }

      logger.error(`${provider} webhook persistence failed.`, {
        name: error?.name,
        message: error?.message,
      });
      return sendJson(response, 500, {
        received: false,
        error: "Webhook persistence failed.",
      });
    }
  };
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) return;

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_WEBHOOK_BYTES) {
        settled = true;
        reject(new WebhookRequestError(413, "Webhook body is too large."));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new WebhookRequestError(400, "Webhook request was aborted."));
    });
  });
}

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
