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

function fixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN = workerToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./generation.js": () => import("../../convex/generation.js"),
  });
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

test("Convex keeps editorial approval immutable and worker-readable", async () => {
  const convex = fixture();
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
  assert.deepEqual(await convex.query(readEditorialApproval, { workerToken, jobId }), approval);
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
    convex.query(readEditorialApproval, { workerToken: "wrong", jobId }),
    /authorization/u,
  );
});

test("Convex commits a bounded artifact set only after every blob exists", async () => {
  const convex = fixture();
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
    workerToken,
    jobId,
    artifactSet,
  }), { created: true, artifactSet });
  const readback = await convex.query(readArtifactSet, {
    workerToken,
    jobId,
    revisionId: "r1",
    kind: "private_review",
  });
  assert.deepEqual(readback.artifactSet, artifactSet);
  assert.equal(readback.files.length, 1);
  assert.equal(readback.files[0].storageId, storageId);
  assert.match(readback.files[0].url, /^https:\/\//u);

  await assert.rejects(
    convex.mutation(commitArtifactSet, {
      workerToken,
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
      workerToken,
      jobId,
      artifactSet: {
        ...artifactSet,
        revisionId: "r2",
        manifestRef: `jobs/${jobId}/revisions/r2/manifests/private_review.json`,
        files: [{ ...artifactSet.files[0], storageId: "not-a-convex-storage-id" }],
      },
    }),
  );
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
