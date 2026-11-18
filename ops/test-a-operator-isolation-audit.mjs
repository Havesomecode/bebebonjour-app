import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestAOperatorIsolationInventory } from "../src/config/test-a-operator-isolation.mjs";

const BASELINE_COMMIT = "9c8721d3a3c10657fbcca4eb6020aca5e4b2888f";
const EVIDENCE_RELATIVE_PATH = "ops/test-a-operator-isolation-review-evidence.json";
const EXCLUDED_WORKTREE_PATHS = new Set(["ops/.tmp-hermes-simulate-test-payment.mjs"]);
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.join(rootPath, EVIDENCE_RELATIVE_PATH);

const isolation = await createTestAOperatorIsolationInventory({ rootPath });
const changedPaths = changedPathsFromBaseline();
const candidateReviewInputs = [...new Set([
  ...isolation.reviewInputs,
  ...changedPaths,
])]
  .filter((filePath) => filePath !== EVIDENCE_RELATIVE_PATH)
  .sort();
const reviewInputs = [];
for (const filePath of candidateReviewInputs) {
  try {
    await access(path.join(rootPath, filePath));
    reviewInputs.push(filePath);
  } catch {
    // Deleted paths remain in changedPaths/pathAllowlist but have no bytes to hash.
  }
}
const pathAllowlist = [...new Set([
  ...changedPaths,
  ...reviewInputs,
  EVIDENCE_RELATIVE_PATH,
])].sort();
const reviewedFileDigests = await Promise.all(reviewInputs.map(async (filePath) => ({
  path: filePath,
  sha256: createHash("sha256").update(await readFile(path.join(rootPath, filePath))).digest("hex"),
})));
const generatedEvidence = {
  auditId: "test-a-operator-isolation-successor-2026-08-26",
  baselineCommit: BASELINE_COMMIT,
  candidateBoundary: {
    changedPaths,
    pathAllowlist,
    reviewedFileDigests,
  },
  isolation: {
    generationInvocation: isolation.generationInvocation,
    generationModuleGraph: isolation.generationModuleGraph,
    privateInvocation: isolation.privateInvocation,
    publicEntrypoints: isolation.publicEntrypoints,
    publicModuleGraph: isolation.publicModuleGraph,
    privateCapabilityModules: isolation.privateCapabilityModules,
    packageCommandReferences: isolation.packageCommandReferences,
    publicCapabilityMarkers: isolation.publicCapabilityMarkers,
  },
  providerMutation: "none",
};

if (process.argv.includes("--write-evidence")) {
  await writeFile(evidencePath, `${JSON.stringify(generatedEvidence, null, 2)}\n`);
}

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
if (JSON.stringify(evidence) !== JSON.stringify(generatedEvidence)) {
  throw new Error("TEST-A operator isolation evidence does not match the exact current review boundary.");
}

process.stdout.write(`HERMES_VERIFY_RESULT=${JSON.stringify({
  status: "PASS",
  baselineCommit: BASELINE_COMMIT,
  changedPathCount: changedPaths.length,
  pathAllowlistCount: pathAllowlist.length,
  reviewInputCount: reviewInputs.length,
  privateInvocation: isolation.privateInvocation,
  publicEntrypointCount: isolation.publicEntrypoints.length,
  providerMutation: "none",
})}\n`);

function changedPathsFromBaseline() {
  const diffPaths = git(["diff", "--name-only", BASELINE_COMMIT, "--"]);
  const untrackedPaths = git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([
    ...lines(diffPaths),
    ...lines(untrackedPaths),
    EVIDENCE_RELATIVE_PATH,
  ])].filter((filePath) => !EXCLUDED_WORKTREE_PATHS.has(filePath)).sort();
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: rootPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function lines(value) {
  return value.split(/\r?\n/u).filter(Boolean);
}
