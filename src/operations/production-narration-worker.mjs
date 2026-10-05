import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";

import { requireReviewedNarrationEnvironment } from "../config/test-a-hosted-provider-manifest.mjs";
import {
  generateNarration as generateNarrationMedia,
  readBoundedResponse,
} from "../narration/narration-media.mjs";
import { createOperationsCommandWorker } from "./operations-command-worker.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const MAX_PAGE_BYTES = 1024 * 1024;
const WORK_TIMEOUT_MS = 210_000;
const HTTP_TIMEOUT_MS = 20_000;

export const NARRATION_WORKER_POLICY = Object.freeze({
  workerId: "hosted-narration-worker",
  actions: Object.freeze(["generate_narration"]),
  limit: 1,
  leaseMs: 300_000,
});

export function requireNarrationWorkerEnvironment(environment = process.env) {
  const reviewed = requireReviewedNarrationEnvironment(environment);
  const convexUrl = exactHttpsOrigin(reviewed.CONVEX_URL, "CONVEX_URL");
  const convexSiteUrl = exactHttpsOrigin(
    reviewed.CONVEX_SITE_URL,
    "CONVEX_SITE_URL",
  );
  if (convexUrl === convexSiteUrl) {
    throw new Error("Narration Convex API and site origins must be distinct.");
  }
  const workerToken = requiredSecret(
    reviewed.BEBEBONJOUR_TTS_WORKER_TOKEN,
    "BEBEBONJOUR_TTS_WORKER_TOKEN",
  );
  const apiKey = requiredSecret(reviewed.OPENAI_API_KEY, "OPENAI_API_KEY");
  const cronSecret = requiredSecret(reviewed.CRON_SECRET, "CRON_SECRET");
  if (new Set([workerToken, apiKey, cronSecret]).size !== 3) {
    throw new Error("Narration worker credentials must be distinct.");
  }
  return Object.freeze({
    CONVEX_URL: convexUrl,
    CONVEX_SITE_URL: convexSiteUrl,
    BEBEBONJOUR_TTS_WORKER_TOKEN: workerToken,
    OPENAI_API_KEY: apiKey,
    CRON_SECRET: cronSecret,
  });
}

export function createProductionNarrationWorker(options = {}) {
  const environment = requireNarrationWorkerEnvironment(
    options.environment || process.env,
  );
  const fetchImpl = options.fetch || globalThis.fetch;
  const generateNarration =
    options.generateNarration || generateNarrationMedia;
  if (typeof fetchImpl !== "function" || typeof generateNarration !== "function") {
    throw new Error("Narration worker dependencies are invalid.");
  }
  const client =
    options.client ||
    new ConvexHttpClient(environment.CONVEX_URL, {
      logger: false,
      fetch: (url, init) =>
        fetchImpl(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        }),
    });
  for (const method of ["query", "mutation", "action"]) {
    if (typeof client?.[method] !== "function") {
      throw new Error("Narration worker Convex client is invalid.");
    }
  }

  const workerToken = environment.BEBEBONJOUR_TTS_WORKER_TOKEN;
  const queue = {
    claimCommands: (args) =>
      client.mutation("operations:claimCommands", { workerToken, ...args }),
    fenceCommand: (args) =>
      client.mutation("operations:fenceCommand", { workerToken, ...args }),
    completeCommand: (args) =>
      client.mutation("operations:completeCommand", { workerToken, ...args }),
    failCommand: (args) =>
      client.mutation("operations:failCommand", { workerToken, ...args }),
  };
  const commandWorker = createOperationsCommandWorker({
    queue,
    handlers: {
      generate_narration: async ({
        jobId,
        commandId,
        fenceExternalEffect,
        workerAuthority,
      }) => {
        const auth = { workerToken, jobId, ...workerAuthority };
        let begun = false;
        try {
          await client.action("narrationRuntime:advance", {
            ...auth,
            operation: "begin",
          });
          begun = true;
          const signal = AbortSignal.timeout(WORK_TIMEOUT_MS);
          const prepared = await client.query("narration:readPrepared", auth);
          const page = await readApprovedPage({
            environment,
            fetchImpl,
            signal,
            auth,
            prepared,
          });
          const artifactSet = await fenceExternalEffect(async () => {
            await client.action("narrationRuntime:advance", {
              ...auth,
              operation: "fence",
            });
            return generateNarration({
              jobId,
              prepared,
              page,
              apiKey: environment.OPENAI_API_KEY,
              idempotencyKey: commandId,
              signal,
              fetch: fetchImpl,
              upload: (path, bytes, contentType) =>
                uploadArtifact({
                  environment,
                  client,
                  fetchImpl,
                  signal,
                  auth,
                  path,
                  bytes,
                  contentType,
                }),
            });
          });
          const outcome = await client.action("narrationRuntime:advance", {
            ...auth,
            operation: "complete",
            artifactSet,
          });
          begun = false;
          return outcome;
        } catch (error) {
          if (begun) {
            await client
              .action("narrationRuntime:advance", {
                ...auth,
                operation: "fail",
              })
              .catch(() => {});
          }
          throw new Error("narration_generation_failed", { cause: error });
        }
      },
    },
  });

  return Object.freeze({
    async runOnce(jobId) {
      if (jobId !== undefined && !JOB_ID.test(jobId)) {
        throw new Error("Narration worker job scope is invalid.");
      }
      const health = await client.query("operations:workerHealth", {
        workerToken,
      });
      if (
        health?.protocolVersion !== "1.0" ||
        health?.scope !== "narration_generation"
      ) {
        throw new Error("Narration worker health protocol mismatch.");
      }
      const result = await commandWorker.runOnce({
        workerId: NARRATION_WORKER_POLICY.workerId,
        limit: NARRATION_WORKER_POLICY.limit,
        leaseMs: NARRATION_WORKER_POLICY.leaseMs,
        ...(jobId ? { jobId } : {}),
      });
      return Object.freeze({
        status: "ok",
        protocolVersion: health.protocolVersion,
        workerId: NARRATION_WORKER_POLICY.workerId,
        enabledActionCount: NARRATION_WORKER_POLICY.actions.length,
        ...result,
      });
    },
  });
}

export async function runProductionNarrationWorkerCommand(options = {}) {
  return createProductionNarrationWorker(options).runOnce(options.jobId);
}

async function readApprovedPage({
  environment,
  fetchImpl,
  signal,
  auth,
  prepared,
}) {
  if (!prepared || prepared.kind !== "prepared_bundle") {
    throw new Error("Approved prepared artifact missing.");
  }
  const file = prepared.files?.find(
    (candidate) => candidate.path === "artifacts/current/page.json",
  );
  if (!file || file.sha256 !== prepared.pageDigest) {
    throw new Error("Approved page missing.");
  }
  const url = new URL("/narration/artifact", environment.CONVEX_SITE_URL);
  for (const [name, value] of Object.entries({
    mode: "worker",
    jobId: auth.jobId,
    revisionId: prepared.revisionId,
    path: file.path,
  })) {
    url.searchParams.set(name, value);
  }
  const response = await fetchImpl(url, {
    redirect: "error",
    signal,
    headers: workerHeaders(auth),
  });
  if (!response.ok) throw new Error("Approved page unavailable.");
  const raw = await readBoundedResponse(response, MAX_PAGE_BYTES, signal);
  if (raw.length !== file.bytes || hash(raw) !== file.sha256) {
    throw new Error("Approved page integrity failed.");
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Approved page is invalid JSON.");
  }
}

async function uploadArtifact({
  environment,
  client,
  fetchImpl,
  signal,
  auth,
  path,
  bytes,
  contentType,
}) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    ![
      "audio/mpeg",
      "application/json",
    ].includes(contentType) ||
    (path.endsWith(".mp3") ? contentType !== "audio/mpeg" : contentType !== "application/json")
  ) {
    throw new Error("Narration upload payload invalid.");
  }
  const uploadUrl = await client.mutation("narration:createUploadUrl", auth);
  const parsed = new URL(uploadUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== environment.CONVEX_URL ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("Storage upload origin invalid.");
  }
  const response = await fetchImpl(uploadUrl, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!response.ok) throw new Error("Durable narration upload failed.");
  const receiptBytes = await readBoundedResponse(response, 4_096, signal);
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error("Durable narration receipt invalid.");
  }
  if (
    !receipt ||
    Object.keys(receipt).join("\0") !== "storageId" ||
    typeof receipt.storageId !== "string" ||
    !receipt.storageId
  ) {
    throw new Error("Durable narration receipt invalid.");
  }
  return receipt.storageId;
}

function workerHeaders(auth) {
  return {
    authorization: ["Bearer", auth.workerToken].join(" "),
    "x-bebebonjour-worker-id": auth.workerId,
    "x-bebebonjour-command-id": auth.commandId,
    "x-bebebonjour-lease-token": auth.leaseToken,
  };
}

function exactHttpsOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
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
