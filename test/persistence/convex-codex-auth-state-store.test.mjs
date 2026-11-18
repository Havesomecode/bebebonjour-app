import assert from "node:assert/strict";
import test from "node:test";

import { createConvexCodexAuthStateStore } from "../../src/persistence/convex-codex-auth-state-store.mjs";

const authorization = Object.freeze({
  workerToken: "worker-token-at-least-thirty-two-characters_",
  workerId: "generation-worker-1",
  commandId: "command_codex_auth_store_000001",
  leaseToken: "generation-command-lease-token",
});
const jobId = "job_codex_auth_store_001";
const encryptionKey = Buffer.alloc(32, 7).toString("base64url");
const alternateKey = Buffer.alloc(32, 8).toString("base64url");
const initialAuth = `${JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
    id_token: "synthetic-id-token",
  },
  last_refresh: "2026-09-01T00:00:00.000Z",
})}\n`;
const refreshedAuth = `${JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "synthetic-refreshed-access-token",
    refresh_token: "synthetic-refreshed-refresh-token",
    id_token: "synthetic-refreshed-id-token",
  },
  last_refresh: "2026-09-06T19:00:00.000Z",
})}\n`;

function fakeClient() {
  let durable = null;
  let authLeaseToken = null;
  const calls = [];
  return {
    calls,
    get durable() { return durable; },
    async mutation(name, input) {
      calls.push({ name, input: structuredClone(input) });
      if (name === "generation:initializeCodexAuthState") {
        if (!durable) durable = { version: 1, envelope: input.envelope, plaintextDigest: input.plaintextDigest };
        return { initialized: true, version: durable.version };
      }
      if (name === "generation:claimCodexAuthState") {
        authLeaseToken = "codex_auth_lease_1234567890abcdef1234567890abcdef";
        return {
          acquired: true,
          ...durable,
          authLeaseToken,
          leaseExpiresAtMs: Date.now() + 120_000,
        };
      }
      if (name === "generation:commitCodexAuthState") {
        assert.equal(input.authLeaseToken, authLeaseToken);
        durable = {
          version: input.expectedVersion + 1,
          envelope: input.envelope,
          plaintextDigest: input.plaintextDigest,
        };
        authLeaseToken = null;
        return { committed: true, version: durable.version, plaintextDigest: durable.plaintextDigest };
      }
      if (name === "generation:releaseCodexAuthState") {
        authLeaseToken = null;
        return { released: true };
      }
      throw new Error("unexpected mutation");
    },
  };
}

function createStore(client, overrides = {}) {
  return createConvexCodexAuthStateStore({
    client,
    authorization,
    jobId,
    encryptionKey,
    authLeaseMs: 120_000,
    ...overrides,
  });
}

test("auth store encrypts bootstrap and refreshed state before Convex persistence", async () => {
  const client = fakeClient();
  const store = createStore(client);

  await store.initialize(initialAuth);
  const serializedInitialize = JSON.stringify(client.calls[0]);
  assert.equal(serializedInitialize.includes("synthetic-access-token"), false);
  assert.equal(serializedInitialize.includes("synthetic-refresh-token"), false);
  assert.match(client.calls[0].input.envelope, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

  const claimed = await store.claim();
  assert.equal(claimed.authJson, initialAuth);
  assert.equal(claimed.version, 1);
  assert.match(claimed.authLeaseToken, /^codex_auth_lease_/u);

  const committed = await store.commit(claimed, refreshedAuth);
  assert.deepEqual(committed, { version: 2 });
  const serializedCommit = JSON.stringify(client.calls.at(-1));
  assert.equal(serializedCommit.includes("synthetic-refreshed-access-token"), false);
  assert.equal(serializedCommit.includes("synthetic-refreshed-refresh-token"), false);

  const refreshed = await store.claim();
  assert.equal(refreshed.authJson, refreshedAuth);
  assert.equal(refreshed.version, 2);
});

test("auth store rejects wrong encryption keys and malformed managed ChatGPT state without leaks", async () => {
  const client = fakeClient();
  const store = createStore(client);
  await store.initialize(initialAuth);

  await assert.rejects(
    createStore(client, { encryptionKey: alternateKey }).claim(),
    (error) => error?.reasonCode === "composition_auth_restore_failed"
      && error.message === "composition_auth_restore_failed",
  );
  await assert.rejects(
    store.initialize(JSON.stringify({ auth_mode: "api", tokens: { refresh_token: "secret" } })),
    (error) => error?.reasonCode === "composition_auth_state_rejected",
  );
});

test("auth store reports lease contention and writeback failure as safe retryable errors", async () => {
  const busyStore = createStore({
    async mutation() { return { acquired: false }; },
  });
  await assert.rejects(
    busyStore.claim(),
    (error) => error?.reasonCode === "composition_auth_busy" && error?.retryable === true,
  );

  const client = fakeClient();
  const store = createStore(client);
  await store.initialize(initialAuth);
  const lease = await store.claim();
  client.mutation = async (name) => {
    if (name === "generation:commitCodexAuthState") throw new Error("secret Convex detail");
    return { released: true };
  };
  await assert.rejects(
    store.commit(lease, refreshedAuth),
    (error) => error?.reasonCode === "composition_auth_writeback_failed"
      && error?.retryable === true
      && !error.message.includes("secret Convex detail"),
  );
});
