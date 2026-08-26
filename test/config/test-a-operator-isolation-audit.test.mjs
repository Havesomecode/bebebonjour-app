import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const audit = spawnSync(process.execPath, ["ops/test-a-operator-isolation-audit.mjs"], {
  cwd: new URL("../../", import.meta.url),
  encoding: "utf8",
});

test("successor operator-isolation audit binds the complete reviewed source boundary", () => {
  assert.equal(audit.status, 0, `${audit.stdout}${audit.stderr}`);
  const marker = audit.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith("HERMES_VERIFY_RESULT="));
  assert.ok(marker, audit.stdout);
  const result = JSON.parse(marker.slice("HERMES_VERIFY_RESULT=".length));
  assert.equal(result.status, "PASS");
  assert.equal(result.baselineCommit, "9c8721d3a3c10657fbcca4eb6020aca5e4b2888f");
  assert.ok(result.changedPathCount > 0);
  assert.ok(result.pathAllowlistCount > 29);
  assert.equal(result.reviewInputCount, result.pathAllowlistCount - 1);
  assert.equal(result.providerMutation, "none");
});
