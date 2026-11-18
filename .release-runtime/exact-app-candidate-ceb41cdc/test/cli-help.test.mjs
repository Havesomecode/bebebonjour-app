import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/announce.mjs", import.meta.url));

test("CLI documents narration staging and explicit narration approval", () => {
  const result = spawnSync(process.execPath, [cliPath, "help"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /announce tts --input <page\.json> --approval <approval\.json> --prepared <dir> --output <review-dir>/,
  );
  assert.match(
    result.stdout,
    /announce approve-narration --review <review\.json> --prepared <dir> --output <dir> --reviewer <id> --acknowledge <ar,fr>/,
  );
});
