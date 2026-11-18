import { timingSafeEqual } from "node:crypto";

import { runOperationsWorkerCommand } from "../operations/operations-worker-startup.mjs";

export function createOperationsWorkerHttpHandler(options = {}) {
  const runWorker = options.runWorker || (() => runOperationsWorkerCommand());
  const cronSecret = options.cronSecret || process.env.CRON_SECRET;
  if (typeof cronSecret !== "string" || Buffer.byteLength(cronSecret, "utf8") < 32) {
    throw new Error("Operations worker cron secret is invalid.");
  }
  return async function operationsWorkerHandler(request, response) {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ status: "error", code: "method_not_allowed" }));
      return;
    }
    if (!validBearer(request.headers?.authorization, cronSecret)) {
      response.statusCode = 401;
      response.end(JSON.stringify({ status: "error", code: "unauthorized" }));
      return;
    }
    try {
      const result = await runWorker();
      response.statusCode = 200;
      response.end(JSON.stringify(result));
    } catch {
      response.statusCode = 500;
      response.end(JSON.stringify({ status: "error", code: "worker_failed_safely" }));
    }
  };
}

export function createLazyOperationsWorkerHttpHandler(options = {}) {
  let handler;
  return async function lazyOperationsWorkerHandler(request, response) {
    try {
      handler ||= createOperationsWorkerHttpHandler(options);
      return await handler(request, response);
    } catch {
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.statusCode = 500;
      response.end(JSON.stringify({ status: "error", code: "worker_configuration_rejected" }));
    }
  };
}

function validBearer(value, secret) {
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(typeof value === "string" ? value : "", "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
