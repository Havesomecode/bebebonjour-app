import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const script = new URL("../../scripts/run-delivery-loop-worker.mjs", import.meta.url);

test("CLI validates environment and refuses unknown flags without provider calls or secret logs", async () => {
  for (const args of [["--once"], ["--send-private-data"]]) {
    await assert.rejects(exec(process.execPath, [script.pathname, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, BEBEBONJOUR_DELIVERY_LOOP_TOKEN: "PRIVATE_CONFIGURATION_TOKEN" }, timeout: 10_000,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, /PRIVATE_CONFIGURATION_TOKEN|Error:|stack/);
      const result = JSON.parse(error.stderr.trim());
      assert.equal(result.status, "error");
      assert.ok(["worker_configuration_rejected", "worker_arguments_rejected"].includes(result.code));
      return true;
    });
  }
});

test("CLI help requires no credentials and describes the real provider boundary", async () => {
  const { stdout, stderr } = await exec(process.execPath, [script.pathname, "--help"], { env: { PATH: process.env.PATH }, timeout: 10_000 });
  assert.equal(stderr, "");
  assert.match(stdout, /--once/);
  assert.match(stdout, /Codex/);
  assert.match(stdout, /BEBEBONJOUR_BACKEND_URL/);
});
