import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  generationApprovalProvisioningErrorCode,
  persistTestAGenerationApproval,
} from "../../src/fulfillment/test-a-generation-approval-startup.mjs";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const JOB_ID = "job_generation_approval_001";
const environment = Object.freeze({
  CONVEX_URL: "https://test-a.convex.cloud",
  CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
});

async function privateRoot(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-approval-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "artifacts");
  await mkdir(root, { mode: 0o700 });
  return root;
}

async function approvalFixture(t) {
  const root = await privateRoot(t);
  const sourceEvidence = {
    kind: "kanban_human_decision",
    reference: "kanban:t_generation_approval_authority",
  };
  const record = {
    schemaVersion: "1.0",
    approvalType: "job_scoped_editorial_policy",
    jobId: JOB_ID,
    policy: {
      id: "unknown_name_general_wishes",
      preserveSubmittedName: true,
      meaningAllowed: false,
      scripturalNameAssociationAllowed: false,
      genericBlessingsAllowed: true,
      maxStage: "content_review_required",
    },
    sourceEvidence,
    sourceDigest: createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex"),
  };
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  const approvalPath = path.join(root, "approvals", `${JOB_ID}.json`);
  await mkdir(path.dirname(approvalPath), { recursive: true, mode: 0o700 });
  await writeFile(approvalPath, bytes, { mode: 0o400 });
  return {
    root,
    approvalPath,
    record,
    recordDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("generation approval startup persists exact immutable approval bytes through Convex", async (t) => {
  const fixture = await approvalFixture(t);
  const calls = [];
  const result = await persistTestAGenerationApproval({
    argv: [JOB_ID, fixture.root, fixture.approvalPath],
    environment,
    repositoryRoot: rootPath,
    client: {
      async mutation(name, input) {
        calls.push({ name, input });
        return {
          created: true,
          approval: {
            record: structuredClone(input.approval.record),
            recordDigest: input.approval.recordDigest,
          },
        };
      },
    },
  });

  assert.deepEqual(result, {
    status: "created",
    jobId: JOB_ID,
    recordDigest: fixture.recordDigest,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "generation:saveEditorialApproval");
  assert.equal(calls[0].input.backendToken, environment.CUSTOMER_FLOW_BACKEND_TOKEN);
  assert.deepEqual(calls[0].input.approval.record, fixture.record);
  assert.equal(calls[0].input.approval.recordDigest, fixture.recordDigest);
});

test("generation approval startup rejects invalid readback and unsafe private roots", async (t) => {
  const fixture = await approvalFixture(t);
  let mutationCount = 0;
  await assert.rejects(
    persistTestAGenerationApproval({
      argv: [JOB_ID, fixture.root, fixture.approvalPath],
      environment,
      repositoryRoot: rootPath,
      client: {
        async mutation() {
          mutationCount += 1;
          return { created: true, approval: { record: { jobId: JOB_ID }, recordDigest: "0".repeat(64) } };
        },
      },
    }),
    /persistence readback is invalid/,
  );
  assert.equal(mutationCount, 1);

  await chmod(fixture.root, 0o755);
  await assert.rejects(
    persistTestAGenerationApproval({
      argv: [JOB_ID, fixture.root, fixture.approvalPath],
      environment,
      repositoryRoot: rootPath,
      client: { mutation() { mutationCount += 1; } },
    }),
    /not an isolated private directory/,
  );
  assert.equal(mutationCount, 1);
});

test("generation approval CLI error codes never disclose raw provider messages", () => {
  const code = generationApprovalProvisioningErrorCode(
    new Error("synthetic-private@example.test Synthetic Private Name bearer-secret"),
  );
  assert.equal(code, "generation_approval_persistence_failed_safely");
  assert.doesNotMatch(code, /Synthetic Private Name|synthetic-private@example\.test|bearer-secret/u);
});
