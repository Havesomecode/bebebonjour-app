import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const audit = spawnSync(process.execPath, ["ops/test-a-consolidated-candidate-audit.mjs"], {
  cwd: new URL("../../", import.meta.url),
  encoding: "utf8",
});

test("successor consolidated audit binds the complete reviewed source boundary", () => {
  assert.equal(audit.status, 0, `${audit.stdout}${audit.stderr}`);
  const marker = audit.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith("HERMES_VERIFY_RESULT="));
  assert.ok(marker, audit.stdout);
  const result = JSON.parse(marker.slice("HERMES_VERIFY_RESULT=".length));
  assert.equal(result.status, "PASS");
  assert.equal(result.baselineCommit, "82be6b29eab9245400e928623ec15a3f1ae1ca27");
  assert.ok(result.changedPathCount > 0);
  assert.ok(result.pathAllowlistCount > 20);
  assert.equal(result.pathAllowlistCount, result.changedPathCount);
  assert.ok(result.reviewInputCount > 20);
  assert.ok(result.reviewInputCount >= result.pathAllowlistCount);
  assert.equal(result.controlCount, 7);
  assert.equal(result.focusedTestFileCount, 28);
  assert.match(result.reviewedManifestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.providerMutation, "none-during-audit");
  const evidence = JSON.parse(readFileSync(
    new URL("../../ops/test-a-consolidated-candidate-evidence.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    evidence.candidateBoundary.changedPaths.includes("ops/.tmp-hermes-simulate-test-payment.mjs"),
    false,
  );
});
