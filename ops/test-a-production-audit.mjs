import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const evidencePath = fileURLToPath(new URL("./test-a-publication-regression-audit.json", import.meta.url));
const expectedBaselineCommit = "413bd608d9a227d2d57a8135a0cfebae9404cb92";
const testFiles = [
  "test/fulfillment/exact-revision-publication-adapter.test.mjs",
  "test/fulfillment/vercel-test-a-publication-provider.test.mjs",
];
const expectedControls = [
  "nested-artifact-set-binding",
  "exact-publication-manifest-bytes",
  "provider-ready-deployment-evidence",
  "provider-exact-file-inventory",
  "immutable-deployment-pre-alias-verification",
  "provider-alias-readback",
  "global-exact-deployment-uniqueness",
  "deployment-pagination-progress",
];
const expectedPathAllowlist = [
  "ops/test-a-production-audit.mjs",
  "ops/test-a-publication-regression-audit.json",
  "src/fulfillment/vercel-test-a-publication-provider.mjs",
  "test/fulfillment/vercel-test-a-publication-provider.test.mjs",
];
const expectedReviewedFiles = expectedPathAllowlist.slice(2);

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
const controlIds = evidence.controls?.map(({ id }) => id);
if (JSON.stringify(controlIds) !== JSON.stringify(expectedControls)) {
  throw new Error("TEST-A production audit controls do not match the reviewed evidence manifest.");
}
if (
  evidence.baselineCommit !== expectedBaselineCommit
  || JSON.stringify(evidence.candidateBoundary?.pathAllowlist) !== JSON.stringify(expectedPathAllowlist)
) {
  throw new Error("TEST-A production audit candidate boundary does not match the reviewed baseline and path allowlist.");
}
const changedFilesRun = spawnSync("git", ["diff", "--name-only", expectedBaselineCommit, "--"], {
  cwd: rootPath,
  encoding: "utf8",
});
if (changedFilesRun.status !== 0) {
  process.stderr.write(changedFilesRun.stderr);
  process.exit(changedFilesRun.status ?? 1);
}
const changedFiles = changedFilesRun.stdout.trim().split(/\r?\n/u).filter(Boolean);
if (JSON.stringify(changedFiles) !== JSON.stringify(expectedPathAllowlist)) {
  throw new Error("TEST-A production audit found files outside the reviewed candidate boundary.");
}
const reviewedFileDigests = evidence.candidateBoundary?.reviewedFileDigests;
if (
  !Array.isArray(reviewedFileDigests)
  || JSON.stringify(reviewedFileDigests.map(({ path }) => path)) !== JSON.stringify(expectedReviewedFiles)
) {
  throw new Error("TEST-A production audit reviewed-file digest list does not match the expected source boundary.");
}
for (const reviewedFile of reviewedFileDigests) {
  const bytes = await readFile(new URL(`../${reviewedFile.path}`, import.meta.url));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== reviewedFile.sha256) {
    throw new Error(`TEST-A production audit digest mismatch for ${reviewedFile.path}.`);
  }
}

const testRun = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: rootPath,
  encoding: "utf8",
  env: { ...process.env, RUN_DB_TESTS: "0" },
});
if (testRun.status !== 0) {
  process.stderr.write(testRun.stdout);
  process.stderr.write(testRun.stderr);
  process.exit(testRun.status ?? 1);
}

process.stdout.write(`${JSON.stringify({
  auditId: evidence.auditId,
  status: "PASS",
  controls: expectedControls,
  changedFiles,
  reviewedFileDigests,
  targetedTestFiles: testFiles,
  providerMutation: "none; all provider boundaries use test doubles",
}, null, 2)}\n`);
