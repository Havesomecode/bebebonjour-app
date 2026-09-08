import { ConvexHttpClient } from "convex/browser";

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u;

export async function runOperationsWorkerHealth(options = {}) {
  const environment = options.environment || process.env;
  if (environment.BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS !== "") {
    throw new Error("Vercel Operations worker requires an empty action scope.");
  }
  const convexUrl = requiredHttpsOrigin(environment.CONVEX_URL, "CONVEX_URL");
  const workerToken = requiredSecret(
    environment.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN,
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
  );
  const workerId = requiredWorkerId(environment.BEBEBONJOUR_OPERATIONS_WORKER_ID);
  const client = options.client || new ConvexHttpClient(convexUrl);
  if (typeof client.query !== "function") {
    throw new Error("Operations worker Convex client is invalid.");
  }

  const health = await client.query("operations:workerHealth", { workerToken });
  if (!health
    || Object.keys(health).sort().join("\0") !== "protocolVersion\0scope"
    || health.protocolVersion !== "1.0"
    || health.scope !== "worker") {
    throw new Error("Operations worker health protocol mismatch.");
  }
  return Object.freeze({
    status: "ok",
    protocolVersion: health.protocolVersion,
    workerId,
    enabledActionCount: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
  });
}

function requiredHttpsOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  if (url.protocol !== "https:"
    || url.origin !== value
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return value;
}

function requiredSecret(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return value;
}

function requiredWorkerId(value) {
  if (typeof value !== "string" || !WORKER_ID.test(value)) {
    throw new Error("BEBEBONJOUR_OPERATIONS_WORKER_ID is invalid.");
  }
  return value;
}
