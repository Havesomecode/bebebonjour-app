import assert from "node:assert/strict";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";

const initializeCodexAuthState = makeFunctionReference("generation:initializeCodexAuthState");
const claimCodexAuthState = makeFunctionReference("generation:claimCodexAuthState");
const commitCodexAuthState = makeFunctionReference("generation:commitCodexAuthState");
const releaseCodexAuthState = makeFunctionReference("generation:releaseCodexAuthState");

const workerToken = "worker-token-at-least-thirty-two-characters_";

function fixture() {
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./generation.js": () => import("../../convex/generation.js"),
  });
}

function authority(number = 1) {
  return {
    workerToken,
    workerId: `generation-worker-${number}`,
    commandId: `command_codex_auth_state_00000${number}`,
    leaseToken: `generation-command-lease-token-${number}`,
    jobId: `job_codex_auth_state_00${number}`,
  };
}

async function seedClaim(convex, number = 1) {
  const value = authority(number);
  await convex.run((context) => context.db.insert("customerFlowOperationsCommands", {
    commandId: value.commandId,
    jobId: value.jobId,
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
    requestedAt: new Date().toISOString(),
    requestedBy: "primary_operator",
    state: "running",
    attempts: 1,
    claim: {
      workerId: value.workerId,
      leaseToken: value.leaseToken,
      claimedAtMs: Date.now(),
      leaseExpiresAtMs: Date.now() + 600_000,
      effectStartedAtMs: Date.now(),
    },
    lastFailureReason: null,
    outcome: null,
    updatedAt: new Date().toISOString(),
  }));
  return value;
}

const initialState = Object.freeze({
  envelope: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  plaintextDigest: "1".repeat(64),
});
const refreshedState = Object.freeze({
  envelope: "v1.DDDDDDDDDDDDDDDD.EEEEEEEEEEEEEEEEEEEEEE.FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
  plaintextDigest: "2".repeat(64),
});

test("Codex auth state is ciphertext-only, first-write initialized, and claim-scoped", async () => {
  const convex = fixture();
  const firstAuthority = await seedClaim(convex, 1);

  assert.deepEqual(await convex.mutation(initializeCodexAuthState, {
    ...firstAuthority,
    ...initialState,
  }), { initialized: true, version: 1 });
  assert.deepEqual(await convex.mutation(initializeCodexAuthState, {
    ...firstAuthority,
    ...initialState,
  }), { initialized: false, version: 1 });
  assert.deepEqual(await convex.mutation(initializeCodexAuthState, {
    ...firstAuthority,
    envelope: refreshedState.envelope,
    plaintextDigest: refreshedState.plaintextDigest,
  }), { initialized: false, version: 1 });

  const stored = await convex.run((context) => context.db.query("fulfillmentCodexAuthState").unique());
  assert.equal(stored.slot, "primary");
  assert.equal(stored.version, 1);
  assert.equal(stored.envelope, initialState.envelope);
  assert.equal(stored.plaintextDigest, initialState.plaintextDigest);
  assert.equal(JSON.stringify(stored).includes("refresh_token"), false);
  assert.equal(JSON.stringify(stored).includes("access_token"), false);
});

test("only one active generation claim can lease, rotate, and release Codex auth state", async () => {
  const convex = fixture();
  const firstAuthority = await seedClaim(convex, 1);
  const secondAuthority = await seedClaim(convex, 2);
  await convex.mutation(initializeCodexAuthState, { ...firstAuthority, ...initialState });

  const firstLease = await convex.mutation(claimCodexAuthState, {
    ...firstAuthority,
    authLeaseMs: 120_000,
  });
  assert.equal(firstLease.acquired, true);
  assert.equal(firstLease.version, 1);
  assert.equal(firstLease.envelope, initialState.envelope);
  assert.equal(firstLease.plaintextDigest, initialState.plaintextDigest);
  assert.match(firstLease.authLeaseToken, /^codex_auth_lease_[a-f0-9]{32}$/u);

  assert.deepEqual(await convex.mutation(claimCodexAuthState, {
    ...secondAuthority,
    authLeaseMs: 120_000,
  }), { acquired: false });

  await assert.rejects(
    convex.mutation(commitCodexAuthState, {
      ...firstAuthority,
      authLeaseToken: "wrong-auth-lease-token",
      expectedVersion: 1,
      ...refreshedState,
    }),
    /auth state lease/u,
  );
  assert.deepEqual(await convex.mutation(commitCodexAuthState, {
    ...firstAuthority,
    authLeaseToken: firstLease.authLeaseToken,
    expectedVersion: 1,
    ...refreshedState,
  }), {
    committed: true,
    version: 2,
    plaintextDigest: refreshedState.plaintextDigest,
  });

  const secondLease = await convex.mutation(claimCodexAuthState, {
    ...secondAuthority,
    authLeaseMs: 120_000,
  });
  assert.equal(secondLease.acquired, true);
  assert.equal(secondLease.version, 2);
  assert.equal(secondLease.envelope, refreshedState.envelope);
  assert.deepEqual(await convex.mutation(releaseCodexAuthState, {
    ...secondAuthority,
    authLeaseToken: secondLease.authLeaseToken,
    expectedVersion: 2,
  }), { released: true });
});

test("expired auth leases can be reclaimed but stale writers cannot overwrite refreshed state", async () => {
  const convex = fixture();
  const firstAuthority = await seedClaim(convex, 1);
  const secondAuthority = await seedClaim(convex, 2);
  await convex.mutation(initializeCodexAuthState, { ...firstAuthority, ...initialState });
  const firstLease = await convex.mutation(claimCodexAuthState, {
    ...firstAuthority,
    authLeaseMs: 120_000,
  });
  await convex.run(async (context) => {
    const stored = await context.db.query("fulfillmentCodexAuthState").unique();
    await context.db.patch(stored._id, {
      lease: { ...stored.lease, leaseExpiresAtMs: Date.now() - 1 },
    });
  });

  const replacement = await convex.mutation(claimCodexAuthState, {
    ...secondAuthority,
    authLeaseMs: 120_000,
  });
  assert.equal(replacement.acquired, true);
  assert.notEqual(replacement.authLeaseToken, firstLease.authLeaseToken);
  await assert.rejects(
    convex.mutation(commitCodexAuthState, {
      ...firstAuthority,
      authLeaseToken: firstLease.authLeaseToken,
      expectedVersion: 1,
      ...refreshedState,
    }),
    /auth state lease/u,
  );
});
