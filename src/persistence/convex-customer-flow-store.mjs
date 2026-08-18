import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const DEFAULT_FUNCTIONS = Object.freeze({
  createJob: "customerFlow:createJob",
  readJob: "customerFlow:readJob",
  replaceJob: "customerFlow:replaceJob",
  readProviderEvent: "customerFlow:readProviderEvent",
  recordProviderEvent: "customerFlow:recordProviderEvent",
  claimProviderEvent: "customerFlow:claimProviderEvent",
  completeProviderEvent: "customerFlow:completeProviderEvent",
});

export function createConvexCustomerFlowStore(options = {}) {
  const client = options.client;
  const backendToken = options.backendToken;
  const tokenEncryptionKey = parseEncryptionKey(options.tokenEncryptionKey);
  const functions = { ...DEFAULT_FUNCTIONS, ...options.functions };
  if (typeof client?.mutation !== "function") {
    throw new Error("A Convex client with mutation support is required.");
  }
  if (typeof backendToken !== "string" || backendToken.length < 32) {
    throw new Error("A high-entropy Convex backend token is required.");
  }

  return {
    async createJob(job, idempotencyKey, response, requestDigest) {
      if (!tokenEncryptionKey) {
        throw new Error("A 32-byte customer-flow token encryption key is required.");
      }
      const result = await client.mutation(functions.createJob, {
        backendToken,
        job,
        idempotencyKey: idempotencyKey || null,
        response: sealResponse(response, tokenEncryptionKey),
        requestDigest,
      });
      if (result.conflict) return result;
      return { ...result, response: openResponse(result.response, tokenEncryptionKey) };
    },

    readJob(jobId) {
      return client.query(functions.readJob, { backendToken, jobId });
    },

    async updateJob(jobId, update) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await client.query(functions.readJob, { backendToken, jobId });
        if (!current) return null;
        const next = update(structuredClone(current));
        if (!next || next.jobId !== jobId) {
          throw new Error("Customer-flow updates must preserve the canonical job id.");
        }
        next.version = current.version + 1;
        const result = await client.mutation(functions.replaceJob, {
          backendToken,
          job: next,
          expectedVersion: current.version,
        });
        if (result.updated) return result.job;
      }
      throw new Error("Convex customer-flow update conflicted repeatedly.");
    },

    readProviderEvent(providerEventId) {
      return client.query(functions.readProviderEvent, { backendToken, providerEventId });
    },

    claimProviderEvent(providerEventId, fingerprint) {
      return client.mutation(functions.claimProviderEvent, {
        backendToken,
        providerEventId,
        fingerprint,
      });
    },

    completeProviderEvent(providerEventId, fingerprint, result) {
      return client.mutation(functions.completeProviderEvent, {
        backendToken,
        providerEventId,
        fingerprint,
        result,
      });
    },

    recordProviderEvent(providerEventId, event) {
      return client.mutation(functions.recordProviderEvent, {
        backendToken,
        providerEventId,
        event,
      });
    },
  };
}

function parseEncryptionKey(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("Customer-flow token encryption key must be base64 for exactly 32 bytes.");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("Customer-flow token encryption key must be base64 for exactly 32 bytes.");
  }
  return key;
}

function sealResponse(response, key) {
  if (typeof response?.intakeToken !== "string" || response.intakeToken.length < 8) {
    throw new Error("Customer-flow response requires a private intake token.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(responseBinding(response));
  const ciphertext = Buffer.concat([
    cipher.update(response.intakeToken, "utf8"),
    cipher.final(),
  ]);
  const intakeTokenCiphertext = [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
  const { intakeToken: _intakeToken, ...publicResponse } = response;
  return { ...publicResponse, intakeTokenCiphertext };
}

function openResponse(response, key) {
  const parts = String(response?.intakeTokenCiphertext || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Persisted customer-flow response ciphertext is invalid.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
    decipher.setAAD(responseBinding(response));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    const intakeToken = Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const { intakeTokenCiphertext: _ciphertext, ...publicResponse } = response;
    return { ...publicResponse, intakeToken };
  } catch (error) {
    throw new Error("Persisted customer-flow response ciphertext could not be authenticated.", {
      cause: error,
    });
  }
}

function responseBinding(response) {
  return Buffer.from(`${String(response?.jobId || "")}\0${String(response?.status || "")}`, "utf8");
}
