import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const DEFAULT_FUNCTIONS = Object.freeze({
  initialize: "generation:initializeCodexAuthState",
  claim: "generation:claimCodexAuthState",
  commit: "generation:commitCodexAuthState",
  release: "generation:releaseCodexAuthState",
});
const MAX_AUTH_BYTES = 64 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const LEASE_TOKEN = /^codex_auth_lease_[a-f0-9]{32}$/u;
const ENVELOPE = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16,131072})$/u;

export class CodexAuthStateError extends Error {
  constructor(reasonCode, { retryable }) {
    super(reasonCode);
    this.name = "CodexAuthStateError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

export function createConvexCodexAuthStateStore(options = {}) {
  const client = options.client;
  const authorization = requireAuthorization(options.authorization);
  const jobId = requireJobId(options.jobId);
  const key = requireEncryptionKey(options.encryptionKey);
  const authLeaseMs = requireLeaseMs(options.authLeaseMs);
  const functions = { ...DEFAULT_FUNCTIONS, ...(options.functions || {}) };
  if (typeof client?.mutation !== "function") {
    throw safeError("composition_auth_configuration_rejected", false);
  }

  return Object.freeze({
    async initialize(authJson) {
      const bytes = validateCodexAuthJson(authJson);
      const encrypted = encryptAuthState(bytes, key, 1);
      let result;
      try {
        result = await client.mutation(functions.initialize, {
          ...authorization,
          jobId,
          ...encrypted,
        });
      } catch {
        throw safeError("composition_auth_initialization_failed", true);
      }
      if (
        typeof result?.initialized !== "boolean"
        || result.version !== 1
      ) {
        throw safeError("composition_auth_initialization_failed", true);
      }
      return Object.freeze({ initialized: result.initialized, version: result.version });
    },

    async claim() {
      let value;
      try {
        value = await client.mutation(functions.claim, {
          ...authorization,
          jobId,
          authLeaseMs,
        });
      } catch {
        throw safeError("composition_auth_restore_failed", true);
      }
      if (value?.acquired === false) throw safeError("composition_auth_busy", true);
      assertClaim(value);
      let authJson;
      try {
        authJson = decryptAuthState(value, key);
      } catch {
        try {
          await client.mutation(functions.release, {
            ...authorization,
            jobId,
            authLeaseToken: value.authLeaseToken,
            expectedVersion: value.version,
          });
        } catch {
          // The short durable lease still prevents a concurrent stale writer.
        }
        throw safeError("composition_auth_restore_failed", true);
      }
      return Object.freeze({
        authJson,
        version: value.version,
        authLeaseToken: value.authLeaseToken,
        leaseExpiresAtMs: value.leaseExpiresAtMs,
      });
    },

    async commit(lease, authJson) {
      assertLease(lease);
      const bytes = validateCodexAuthJson(authJson);
      const encrypted = encryptAuthState(bytes, key, lease.version + 1);
      let result;
      try {
        result = await client.mutation(functions.commit, {
          ...authorization,
          jobId,
          authLeaseToken: lease.authLeaseToken,
          expectedVersion: lease.version,
          ...encrypted,
        });
      } catch {
        throw safeError("composition_auth_writeback_failed", true);
      }
      if (
        result?.committed !== true
        || result.version !== lease.version + 1
        || result.plaintextDigest !== encrypted.plaintextDigest
      ) {
        throw safeError("composition_auth_writeback_failed", true);
      }
      return Object.freeze({ version: result.version });
    },

    async release(lease) {
      assertLease(lease);
      try {
        const result = await client.mutation(functions.release, {
          ...authorization,
          jobId,
          authLeaseToken: lease.authLeaseToken,
          expectedVersion: lease.version,
        });
        if (result?.released !== true) throw new Error("release rejected");
      } catch {
        throw safeError("composition_auth_release_failed", true);
      }
      return Object.freeze({ released: true });
    },
  });
}

function encryptAuthState(bytes, key, version) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(authStateBinding(version));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    envelope: [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join("."),
    plaintextDigest: sha256(bytes),
  };
}

function decryptAuthState(value, key) {
  const match = ENVELOPE.exec(value.envelope || "");
  if (!match || !DIGEST.test(value.plaintextDigest || "")) throw new Error("invalid envelope");
  const [, ivText, tagText, ciphertextText] = match;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAAD(authStateBinding(value.version));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]);
  const actualDigest = Buffer.from(sha256(plaintext), "hex");
  const expectedDigest = Buffer.from(value.plaintextDigest, "hex");
  if (!timingSafeEqual(actualDigest, expectedDigest)) throw new Error("digest mismatch");
  return validateCodexAuthJson(plaintext.toString("utf8")).toString("utf8");
}

export function validateCodexAuthJson(value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUTH_BYTES) {
    throw safeError("composition_auth_state_rejected", false);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw safeError("composition_auth_state_rejected", false);
  }
  if (
    parsed?.auth_mode !== "chatgpt"
    || typeof parsed?.tokens?.access_token !== "string"
    || parsed.tokens.access_token === ""
    || typeof parsed.tokens.refresh_token !== "string"
    || parsed.tokens.refresh_token === ""
    || typeof parsed.last_refresh !== "string"
    || parsed.last_refresh === ""
  ) {
    throw safeError("composition_auth_state_rejected", false);
  }
  return bytes;
}

function authStateBinding(version) {
  return Buffer.from(`bebebonjour:codex-auth-state:primary:v${version}`, "utf8");
}

function assertClaim(value) {
  if (
    value?.acquired !== true
    || !Number.isInteger(value.version)
    || value.version < 1
    || !ENVELOPE.test(value.envelope || "")
    || !DIGEST.test(value.plaintextDigest || "")
    || !LEASE_TOKEN.test(value.authLeaseToken || "")
    || !Number.isFinite(value.leaseExpiresAtMs)
    || value.leaseExpiresAtMs <= Date.now()
  ) {
    throw safeError("composition_auth_restore_failed", true);
  }
}

function assertLease(value) {
  if (
    !Number.isInteger(value?.version)
    || value.version < 1
    || !LEASE_TOKEN.test(value?.authLeaseToken || "")
    || !Number.isFinite(value?.leaseExpiresAtMs)
  ) {
    throw safeError("composition_auth_configuration_rejected", false);
  }
}

function requireAuthorization(value) {
  const keys = ["commandId", "leaseToken", "workerId", "workerToken"];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== keys.join("\0")
    || typeof value.workerToken !== "string"
    || Buffer.byteLength(value.workerToken, "utf8") < 32
    || typeof value.workerId !== "string"
    || value.workerId === ""
    || typeof value.commandId !== "string"
    || value.commandId === ""
    || typeof value.leaseToken !== "string"
    || value.leaseToken.length < 8
  ) {
    throw safeError("composition_auth_configuration_rejected", false);
  }
  return Object.freeze({ ...value });
}

function requireJobId(value) {
  if (typeof value !== "string" || !/^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value)) {
    throw safeError("composition_auth_configuration_rejected", false);
  }
  return value;
}

function requireEncryptionKey(value) {
  if (typeof value !== "string") throw safeError("composition_auth_configuration_rejected", false);
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value) {
    throw safeError("composition_auth_configuration_rejected", false);
  }
  return key;
}

function requireLeaseMs(value) {
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw safeError("composition_auth_configuration_rejected", false);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(reasonCode, retryable) {
  return new CodexAuthStateError(reasonCode, { retryable });
}
