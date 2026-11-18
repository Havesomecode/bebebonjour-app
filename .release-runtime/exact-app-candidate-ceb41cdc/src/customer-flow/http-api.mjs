import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { CustomerFlowError } from "./service.mjs";

const MAX_BODY_BYTES = 64_000;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLIC_ERRORS = new Map([
  ["idempotency_conflict", {
    statusCode: 409,
    message: "Idempotency key was already used for another request.",
  }],
  ["invalid_checkout_session", {
    statusCode: 502,
    message: "Payment provider returned an invalid test session.",
  }],
  ["invalid_idempotency_key", {
    statusCode: 400,
    message: "Idempotency key is invalid.",
  }],
  ["invalid_intake", {
    statusCode: 400,
    message: "Submitted intake fields are invalid.",
  }],
  ["invalid_json", {
    statusCode: 400,
    message: "Request body must be valid JSON.",
  }],
  ["job_not_found", {
    statusCode: 404,
    message: "Job was not found.",
  }],
  ["request_too_large", {
    statusCode: 413,
    message: "Request body is too large.",
  }],
  ["unsupported_media_type", {
    statusCode: 415,
    message: "Content type must be application/json.",
  }],
]);

export function createCustomerFlowHttpApi({
  service,
  allowedOrigins = [],
  pathPrefix = "",
  authorizeRequest = null,
}) {
  if (!service) throw new Error("A customer-flow service is required.");
  const originAllowlist = new Set(allowedOrigins);
  const apiPath = `${normalizePathPrefix(pathPrefix)}/v1`;
  const app = new Hono();

  app.use(`${apiPath}/*`, async (context, next) => {
    const origin = context.req.header("origin") || "";
    context.header("Cache-Control", "no-store");
    context.header("Vary", "Origin");
    if (origin && !originAllowlist.has(origin)) {
      return errorResponse(context, 403, "origin_not_allowed", "Origin is not allowed.");
    }
    if (origin) context.header("Access-Control-Allow-Origin", origin);

    if (context.req.method === "OPTIONS") {
      context.header("Allow", "GET, POST, OPTIONS");
      context.header(
        "Access-Control-Allow-Headers",
        "authorization, content-type, idempotency-key, x-test-a-access-token",
      );
      context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      return context.body(null, 204);
    }

    if (authorizeRequest && !await authorizeRequest(context.req)) {
      return errorResponse(context, 401, "test_access_required", "TEST-A access is required.");
    }

    await next();
  });

  app.post(
    `${apiPath}/intakes`,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (context) => errorResponse(
        context,
        413,
        "request_too_large",
        "Request body is too large.",
      ),
    }),
    async (context) => {
      requireJson(context.req.header("content-type"));
      const intake = parseJsonBody(await context.req.text());
      const result = await service.submitIntake(intake, {
        idempotencyKey: context.req.header("idempotency-key"),
      });
      return context.json(result, 201);
    },
  );

  app.get(`${apiPath}/jobs/:jobId/status`, async (context) => {
    const jobId = validJobId(context.req.param("jobId"));
    if (!jobId) return context.notFound();
    const result = await service.getStatus(jobId, bearerToken(context.req.header("authorization")));
    return context.json(result);
  });

  app.post(`${apiPath}/jobs/:jobId/checkout`, async (context) => {
    const jobId = validJobId(context.req.param("jobId"));
    if (!jobId) return context.notFound();
    const result = await service.createCheckout(jobId, bearerToken(context.req.header("authorization")));
    return context.json(result);
  });

  app.notFound((context) => errorResponse(context, 404, "not_found", "Not found."));
  app.onError((error, context) => {
    if (error instanceof CustomerFlowError) {
      const publicError = PUBLIC_ERRORS.get(error.code);
      if (publicError?.statusCode === error.statusCode) {
        return errorResponse(context, publicError.statusCode, error.code, publicError.message);
      }
    }
    return errorResponse(context, 500, "internal_error", "Request failed.");
  });

  return app;
}

function normalizePathPrefix(value) {
  if (value === "") return "";
  if (typeof value !== "string" || !/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/.test(value)) {
    throw new Error("Customer-flow path prefix must be an absolute path without a trailing slash.");
  }
  return value;
}

function parseJsonBody(body) {
  if (typeof body !== "string") {
    throw new CustomerFlowError(400, "invalid_json", "Request body must be JSON.");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new CustomerFlowError(413, "request_too_large", "Request body is too large.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new CustomerFlowError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function requireJson(contentType) {
  const mediaType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new CustomerFlowError(415, "unsupported_media_type", "Content type must be application/json.");
  }
}

function bearerToken(authorization) {
  const match = /^Bearer +([^\s]{8,512})$/i.exec(authorization || "");
  if (!match) throw new CustomerFlowError(404, "job_not_found", "Job was not found.");
  return match[1];
}

function validJobId(value) {
  return JOB_ID_PATTERN.test(value) ? value : null;
}

function errorResponse(context, statusCode, code, message) {
  context.header("Cache-Control", "no-store");
  return context.json({ error: { code, message } }, statusCode);
}
