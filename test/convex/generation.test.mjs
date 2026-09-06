import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";

import schema from "../../convex/schema.js";

const saveEditorialApproval = makeFunctionReference("generation:saveEditorialApproval");
const readEditorialApproval = makeFunctionReference("generation:readEditorialApproval");
const commitArtifactSet = makeFunctionReference("generation:commitArtifactSet");
const readArtifactSet = makeFunctionReference("generation:readArtifactSet");

const backendToken = "backend-token-at-least-thirty-two-characters";
const workerToken = "worker-token-at-least-thirty-two-characters_";
const jobId = "job_generation_storage_001";
const authority = Object.freeze({
  workerToken,
  workerId: "generation-worker-1",
  commandId: "command_generation_storage_001",
  leaseToken: "generation-storage-lease-token",
});

function fixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./generation.js": () => import("../../convex/generation.js"),
    "./http.js": () => import("../../convex/http.js"),
  });
}

function artifactRequest(overrides = {}) {
  const parameters = new URLSearchParams({
    jobId,
    revisionId: "r1",
    kind: "private_review",
    path: "review.json",
    ...overrides.parameters,
  });
  return {
    path: `/generation/artifact?${parameters}`,
    init: {
      method: "GET",
      headers: {
        authorization: `Bearer ${authority.workerToken}`,
        "x-bebebonjour-worker-id": authority.workerId,
        "x-bebebonjour-command-id": authority.commandId,
        "x-bebebonjour-lease-token": authority.leaseToken,
        ...overrides.headers,
      },
    },
  };
}

function editorialApproval(reference = "kanban:t_reviewed_generation") {
  const sourceEvidence = { kind: "kanban_human_decision", reference };
  const record = {
    schemaVersion: "1.0",
    approvalType: "job_scoped_editorial_policy",
    jobId,
    policy: {
      id: "unknown_name_general_wishes",
      preserveSubmittedName: true,
      meaningAllowed: false,
      scripturalNameAssociationAllowed: false,
      genericBlessingsAllowed: true,
      maxStage: "content_review_required",
    },
    sourceEvidence,
    sourceDigest: sha256(JSON.stringify(sourceEvidence)),
  };
  return { record, recordDigest: sha256(`${JSON.stringify(record, null, 2)}\n`) };
}

async function seedClaim(convex) {
  await convex.run((context) => context.db.insert("customerFlowOperationsCommands", {
    commandId: authority.commandId,
    jobId,
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: 3,
    payload: {},
    requestedAt: new Date().toISOString(),
    requestedBy: "primary_operator",
    state: "running",
    attempts: 1,
    claim: {
      workerId: authority.workerId,
      leaseToken: authority.leaseToken,
      claimedAtMs: Date.now(),
      leaseExpiresAtMs: Date.now() + 600_000,
      effectStartedAtMs: Date.now(),
    },
    lastFailureReason: null,
    outcome: null,
    updatedAt: new Date().toISOString(),
  }));
}

test("Convex keeps editorial approval immutable and claim-scoped", async () => {
  const convex = fixture();
  await seedClaim(convex);
  const approval = editorialApproval();
  await assert.rejects(
    convex.mutation(saveEditorialApproval, {
      backendToken,
      jobId,
      approval: { ...approval, recordDigest: "0".repeat(64) },
    }),
    /editorial approval is invalid/u,
  );
  assert.deepEqual(await convex.mutation(saveEditorialApproval, {
    backendToken,
    jobId,
    approval,
  }), { created: true, approval });
  assert.deepEqual(await convex.query(readEditorialApproval, { ...authority, jobId }), approval);
  assert.deepEqual(await convex.mutation(saveEditorialApproval, {
    backendToken,
    jobId,
    approval,
  }), { created: false, approval });
  await assert.rejects(
    convex.mutation(saveEditorialApproval, {
      backendToken,
      jobId,
      approval: editorialApproval("kanban:t_tampered_generation"),
    }),
    /immutable/u,
  );
  await assert.rejects(
    convex.query(readEditorialApproval, { ...authority, workerToken: "wrong", jobId }),
    /authorization/u,
  );
});

test("Convex commits and streams a bounded private artifact set only for the active claim", async () => {
  const convex = fixture();
  await seedClaim(convex);
  const bytes = Buffer.from("private review artifact\n");
  const storageId = await convex.run((context) => context.storage.store(new Blob([bytes])));
  const storageMetadata = await convex.run((context) => context.db.system.get(storageId));
  assert.equal(storageMetadata.sha256, Buffer.from(sha256(bytes), "hex").toString("base64"));
  const artifactSet = {
    kind: "private_review",
    revisionId: "r1",
    pageDigest: "1".repeat(64),
    transcriptDigest: "2".repeat(64),
    assetManifestDigest: "3".repeat(64),
    manifestRef: `jobs/${jobId}/revisions/r1/manifests/private_review.json`,
    files: [{
      path: "review.json",
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      storageId,
    }],
  };
  assert.deepEqual(await convex.mutation(commitArtifactSet, {
    ...authority,
    jobId,
    artifactSet,
  }), { created: true, artifactSet });
  const readback = await convex.query(readArtifactSet, {
    ...authority,
    jobId,
    revisionId: "r1",
    kind: "private_review",
  });
  assert.deepEqual(readback.artifactSet, artifactSet);
  assert.equal(readback.files.length, 1);
  assert.equal(readback.files[0].storageId, storageId);
  assert.equal(Object.hasOwn(readback.files[0], "url"), false);
  const request = artifactRequest();
  const response = await convex.fetch(request.path, request.init);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  const replay = artifactRequest({
    headers: { "x-bebebonjour-lease-token": "replayed-lease-token" },
  });
  assert.equal((await convex.fetch(replay.path, replay.init)).status, 403);
  const missingAuthentication = artifactRequest({ headers: { authorization: "" } });
  assert.equal(
    (await convex.fetch(missingAuthentication.path, missingAuthentication.init)).status,
    403,
  );

  await assert.rejects(
    convex.mutation(commitArtifactSet, {
      ...authority,
      jobId,
      artifactSet: {
        ...artifactSet,
        revisionId: "r2",
        manifestRef: `jobs/${jobId}/revisions/r2/manifests/private_review.json`,
        files: [{ ...artifactSet.files[0], sha256: "5".repeat(64) }],
      },
    }),
    /blob does not match/u,
  );

  await assert.rejects(
    convex.mutation(commitArtifactSet, {
      ...authority,
      jobId,
      artifactSet: {
        ...artifactSet,
        revisionId: "r2",
        manifestRef: `jobs/${jobId}/revisions/r2/manifests/private_review.json`,
        files: [{ ...artifactSet.files[0], storageId: "not-a-convex-storage-id" }],
      },
    }),
  );

  await convex.run(async (context) => {
    const command = await context.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_command_id", (query) => query.eq("commandId", authority.commandId))
      .unique();
    await context.db.patch(command._id, { state: "completed", claim: null });
  });
  assert.equal((await convex.fetch(request.path, request.init)).status, 403);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
