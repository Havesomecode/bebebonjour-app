import { createHostedTallyIntakeProcessor } from "../customer-flow/hosted-tally-intake.mjs";
import { TallyIntakeError } from "../customer-flow/tally-intake.mjs";
import { CustomerFlowError } from "../customer-flow/service.mjs";

const MAX_BODY_BYTES = 1_000_000;

export function createLazyTallyIntakeHandler(options = {}) {
  let processor;
  let initializationFailed = false;

  return async function tallyIntakeHandler(request, response) {
    if (String(request.method || "GET").toUpperCase() !== "POST") {
      return sendJson(response, 405, { received: false, error: "method_not_allowed" });
    }
    const contentType = header(request, "content-type");
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return sendJson(response, 415, { received: false, error: "unsupported_media_type" });
    }

    let rawBody;
    try {
      rawBody = await readRawBody(request, MAX_BODY_BYTES);
    } catch (error) {
      const statusCode = error.code === "body_too_large" ? 413 : 400;
      return sendJson(response, statusCode, { received: false, error: error.code || "invalid_body" });
    }

    if (!processor && !initializationFailed) {
      try {
        processor = options.processor
          || options.processorFactory?.()
          || createHostedTallyIntakeProcessor(options);
      } catch {
        initializationFailed = true;
      }
    }
    if (!processor) {
      return sendJson(response, 503, { received: false, error: "webhook_unavailable" });
    }

    try {
      const result = await processor({
        rawBody,
        signature: header(request, "tally-signature"),
      });
      return sendJson(response, 200, {
        received: true,
        duplicate: result.duplicate,
        ...(result.rejected === true
          ? { rejected: true, reasonCode: result.reasonCode }
          : { jobId: result.jobId }),
      });
    } catch (error) {
      // Never reflect arbitrary provider exception codes or messages (PII and
      // secrets may be embedded). Only our bounded domain errors are public.
      const trusted = error instanceof TallyIntakeError || error instanceof CustomerFlowError;
      const statusCode = trusted && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode : error?.code === "abuse_control_unavailable" && trusted ? 503 : 500;
      const errorCode = trusted && /^[a-z_]{1,64}$/.test(error.code)
        ? error.code : "webhook_processing_failed";
      if (trusted && error.code === "rate_limited") {
        response.setHeader?.("retry-after", String(error.retryAfterSeconds));
      }
      return sendJson(response, statusCode, { received: false, error: errorCode });
    }
  };
}

async function readRawBody(request, maximumBytes) {
  if (Buffer.isBuffer(request.body)) {
    if (request.body.length > maximumBytes) throw bodyError("body_too_large");
    return request.body;
  }
  if (typeof request.body === "string") {
    const body = Buffer.from(request.body, "utf8");
    if (body.length > maximumBytes) throw bodyError("body_too_large");
    return body;
  }
  if (typeof request[Symbol.asyncIterator] !== "function") throw bodyError("invalid_body");

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumBytes) throw bodyError("body_too_large");
    chunks.push(buffer);
  }
  if (total === 0) throw bodyError("invalid_body");
  return Buffer.concat(chunks);
}

function header(request, name) {
  if (typeof request.headers?.get === "function") return request.headers.get(name) || "";
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : String(value || "");
}

function sendJson(response, statusCode, body) {
  response.setHeader?.("cache-control", "no-store");
  response.setHeader?.("x-content-type-options", "nosniff");
  const serialized = JSON.stringify(body);
  if (typeof response.status === "function" && typeof response.json === "function") {
    return response.status(statusCode).json(body);
  }
  response.statusCode = statusCode;
  response.setHeader?.("content-type", "application/json; charset=utf-8");
  response.end(serialized);
  return undefined;
}

function bodyError(code) {
  return Object.assign(new Error(code), { code });
}
