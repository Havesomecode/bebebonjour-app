import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  generationOperatorErrorCode,
  runTestAGenerationCommand,
} from "../../src/fulfillment/test-a-generation-startup.mjs";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const environment = Object.freeze({
  CONVEX_URL: "https://test-a.convex.cloud",
  CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-at-least-32-characters",
});

async function privateRoot(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-generation-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "artifacts");
  await mkdir(root, { mode: 0o700 });
  return root;
}

function approvalFor(jobId, overrides = {}) {
  const sourceEvidence = {
    kind: "kanban_human_decision",
    reference: "kanban:t_synthetic_authority",
  };
  return {
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
    sourceDigest: createHash("sha256")
      .update(JSON.stringify(sourceEvidence))
      .digest("hex"),
    ...overrides,
  };
}

async function writeApproval(root, approval, name = "approval.json") {
  const approvalPath = path.join(root, "approvals", name);
  await mkdir(path.dirname(approvalPath), { recursive: true, mode: 0o700 });
  await writeFile(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o400 });
  return approvalPath;
}

test("generation startup accepts one validated job id and an existing private root outside the repository", async (t) => {
  const artifactRoot = await privateRoot(t);
  const approvalPath = await writeApproval(
    artifactRoot,
    approvalFor("job_generation_only_001"),
  );
  const calls = [];
  const result = await runTestAGenerationCommand({
    argv: ["job_generation_only_001", artifactRoot, approvalPath],
    environment: {
      ...environment,
      PATH: "/usr/bin:/bin",
      HOME: "/private/operator-home",
      TMPDIR: "/private/operator-tmp",
      __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
    },
    repositoryRoot: rootPath,
    createRunner(options) {
      calls.push(options);
      return {
        async generate(jobId) {
          return { jobId, outcome: "generated", state: "content_review_required" };
        },
      };
    },
  });

  assert.deepEqual(result, {
    jobId: "job_generation_only_001",
    outcome: "generated",
    state: "content_review_required",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].environment, environment);
  assert.equal(calls[0].artifactRoot, await realpath(artifactRoot));
  assert.equal(calls[0].editorialApproval.record.jobId, "job_generation_only_001");
  assert.equal(calls[0].editorialApproval.record.policy.id, "unknown_name_general_wishes");
  assert.match(calls[0].editorialApproval.recordDigest, /^[a-f0-9]{64}$/u);
});

test("generation startup rejects missing, mismatched, broadened, writable, and unsafe approval records before runner construction", async (t) => {
  const artifactRoot = await privateRoot(t);
  const jobId = "job_valid_approval_001";
  const validPath = await writeApproval(artifactRoot, approvalFor(jobId), "valid.json");
  let constructions = 0;
  const createRunner = () => {
    constructions += 1;
    return {};
  };

  const invalidPaths = [];
  invalidPaths.push(path.join(artifactRoot, "approvals", "missing.json"));
  invalidPaths.push(await writeApproval(
    artifactRoot,
    approvalFor("job_different_approval_001"),
    "mismatched.json",
  ));
  invalidPaths.push(await writeApproval(artifactRoot, approvalFor(jobId, {
    policy: {
      ...approvalFor(jobId).policy,
      meaningAllowed: true,
    },
  }), "broadened.json"));
  const nonCanonicalPath = path.join(artifactRoot, "approvals", "noncanonical.json");
  await writeFile(nonCanonicalPath, JSON.stringify(approvalFor(jobId)), { mode: 0o400 });
  invalidPaths.push(nonCanonicalPath);
  const writablePath = await writeApproval(artifactRoot, approvalFor(jobId), "writable.json");
  await chmod(writablePath, 0o600);
  invalidPaths.push(writablePath);
  const outsideRoot = await privateRoot(t);
  invalidPaths.push(await writeApproval(outsideRoot, approvalFor(jobId), "outside.json"));
  const linkedPath = path.join(artifactRoot, "approvals", "linked.json");
  await symlink(validPath, linkedPath);
  invalidPaths.push(linkedPath);
  const hardLinkedPath = path.join(artifactRoot, "approvals", "hard-linked.json");
  await link(validPath, hardLinkedPath);
  invalidPaths.push(hardLinkedPath);
  const fifoPath = path.join(artifactRoot, "approvals", "blocking.pipe");
  const fifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr || fifo.error?.message);
  invalidPaths.push(fifoPath);

  for (const approvalPath of invalidPaths) {
    await assert.rejects(
      runTestAGenerationCommand({
        argv: [jobId, artifactRoot, approvalPath],
        environment,
        repositoryRoot: rootPath,
        createRunner,
      }),
      /generation_approval_rejected/,
    );
  }
  assert.equal(constructions, 0);
});

test("generation startup rejects unsafe ids, extra args, repository roots, symlinks, and permissive roots before runner construction", async (t) => {
  const artifactRoot = await privateRoot(t);
  let constructions = 0;
  const createRunner = () => {
    constructions += 1;
    return {};
  };
  const invalidArgv = [
    [],
    ["not-a-job", artifactRoot, "approval.json"],
    ["job_valid_001", artifactRoot],
    ["job_valid_001", artifactRoot, "approval.json", "extra"],
    ["job_valid_001", rootPath, "approval.json"],
  ];
  for (const argv of invalidArgv) {
    await assert.rejects(
      runTestAGenerationCommand({ argv, environment, repositoryRoot: rootPath, createRunner }),
      /generation_(usage|artifact_root)_rejected/,
    );
  }

  const permissive = await privateRoot(t);
  await chmod(permissive, 0o755);
  await assert.rejects(
    runTestAGenerationCommand({
      argv: ["job_valid_001", permissive, path.join(permissive, "approval.json")],
      environment,
      repositoryRoot: rootPath,
      createRunner,
    }),
    /generation_artifact_root_rejected/,
  );

  const linkParent = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-generation-link-"));
  t.after(() => rm(linkParent, { recursive: true, force: true }));
  const linked = path.join(linkParent, "linked");
  await symlink(artifactRoot, linked);
  await assert.rejects(
    runTestAGenerationCommand({
      argv: ["job_valid_001", linked, path.join(linked, "approval.json")],
      environment,
      repositoryRoot: rootPath,
      createRunner,
    }),
    /generation_artifact_root_rejected/,
  );
  assert.equal(constructions, 0);
});

test("generation startup rejects every unrecognized environment variable before runner construction", async (t) => {
  const artifactRoot = await privateRoot(t);
  const approvalPath = await writeApproval(artifactRoot, approvalFor("job_valid_001"));
  let constructions = 0;
  for (const name of [
    "BEBEBONJOUR_APPROVAL_HMAC_KEY",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "VERCEL_TOKEN",
    "CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY",
    "OPENAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "UNREVIEWED_CONFIGURATION",
  ]) {
    await assert.rejects(
      runTestAGenerationCommand({
        argv: ["job_valid_001", artifactRoot, approvalPath],
        environment: { ...environment, [name]: "forbidden-secret" },
        repositoryRoot: rootPath,
        createRunner() {
          constructions += 1;
          return {};
        },
      }),
      /generation_environment_rejected/,
      name,
    );
  }
  assert.equal(constructions, 0);
});

test("generation CLI error codes never disclose raw messages", () => {
  assert.equal(
    generationOperatorErrorCode(new Error("synthetic-private@example.test Synthetic Private Name")),
    "generation_failed_safely",
  );
  assert.doesNotMatch(
    generationOperatorErrorCode(new Error("synthetic-private@example.test Synthetic Private Name")),
    /Synthetic Private Name|synthetic-private@example\.test/u,
  );
});

test("real generation entrypoint and Hermes wrapper keep output and credential scope private", async () => {
  const wrapper = await readFile(
    new URL("../../scripts/private-generate-intake-from-hermes-secrets.sh", import.meta.url),
    "utf8",
  );
  assert.match(wrapper, /exec \/usr\/bin\/env -i/u);
  assert.match(wrapper, /\$#" -ne 2/u);
  assert.match(wrapper, /approval_path="\$2"/u);
  assert.match(wrapper, /CONVEX_URL=/u);
  assert.match(wrapper, /CUSTOMER_FLOW_BACKEND_TOKEN=/u);
  assert.doesNotMatch(wrapper, /RESEND_API_KEY|STRIPE_SECRET_KEY|VERCEL_TOKEN|APPROVAL_HMAC/u);

  const marker = "Synthetic-Private-Name-synthetic-private@example.test";
  const result = spawnSync(process.execPath, [
    "ops/run-test-a-generation.mjs",
    "job_valid_001",
    path.join(os.tmpdir(), marker),
    path.join(os.tmpdir(), marker, "approval.json"),
  ], {
    cwd: rootPath,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "generation_artifact_root_rejected\n");
  assert.doesNotMatch(result.stderr, new RegExp(marker, "u"));
});
