import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const evidencePath = fileURLToPath(new URL("./test-a-publication-regression-audit.json", import.meta.url));
const testFiles = [
  "test/fulfillment/exact-revision-publication-adapter.test.mjs",
  "test/fulfillment/vercel-test-a-publication-provider.test.mjs",
];
const expectedControls = [
  "nested-artifact-set-binding",
  "global-exact-deployment-uniqueness",
  "deployment-pagination-progress",
];

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
const controlIds = evidence.controls?.map(({ id }) => id);
if (JSON.stringify(controlIds) !== JSON.stringify(expectedControls)) {
  throw new Error("TEST-A production audit controls do not match the reviewed evidence manifest.");
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
  targetedTestFiles: testFiles,
  providerMutation: "none; all provider boundaries use test doubles",
}, null, 2)}\n`);
