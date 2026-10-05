import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const builtFunctionRoot = process.env.GENERATION_WORKER_FUNCTION_DIRECTORY;
let functionRoot;
if (builtFunctionRoot) {
  // Vercel stores FileFsRef assets in .vc-config.json's filePathMap locally.
  // Reconstruct the actual deployment payload, not a source-root substitute.
  const buildRoot = process.env.GENERATION_WORKER_BUILD_ROOT;
  assert.ok(buildRoot, "the exact build root is required for filePathMap resolution");
  functionRoot = await mkdtemp(path.join(os.tmpdir(), "bebe-function-payload-"));
  after(() => rm(functionRoot, { recursive: true, force: true }));
  await cp(builtFunctionRoot, functionRoot, { recursive: true });
  const config = JSON.parse(await readFile(path.join(builtFunctionRoot, ".vc-config.json"), "utf8"));
  for (const [bundlePath, sourcePath] of Object.entries(config.filePathMap || {})) {
    const input = path.resolve(buildRoot, sourcePath);
    const output = path.resolve(functionRoot, bundlePath);
    assert.ok(input.startsWith(`${path.resolve(buildRoot)}${path.sep}`), "asset reference escaped the exact build root");
    assert.ok(output.startsWith(`${functionRoot}${path.sep}`), "asset target escaped the function");
    await mkdir(path.dirname(output), { recursive: true });
    await cp(input, output);
  }
}
const source = new URL("../../", import.meta.url);
const bundled = { skip: !functionRoot && "exercised by test:vercel-routing against its real built function" };
const materialFiles = [
  "data/reference-catalog.json",
  "template/runtime/app.js",
  "template/runtime/phrase-progress.mjs",
  "template/runtime/styles.css",
  "template/assets/og-image.svg",
];

test("the built generation function preserves exact composition catalog and template bytes", bundled, async () => {
  for (const file of materialFiles) {
    assert.deepEqual(await readFile(path.join(functionRoot, file)), await readFile(new URL(file, source)), file);
  }
});

test("the built generation function executes the real deterministic private-review preflight", bundled, async () => {
  const entry = await import(pathToFileURL(path.join(functionRoot, "generation-worker/api/worker.mjs")));
  assert.equal(typeof entry.default, "function");
  const { preflightPrivateReviewComposition } = await import(pathToFileURL(path.join(functionRoot, "scripts/lib/commands.mjs")));
  // Existing fictional repository fixture; no approval, auth, output or provider call is created.
  const intakeSnapshot = JSON.parse(await readFile(new URL("data/examples/bayane/intake.json", source), "utf8"));
  const result = await preflightPrivateReviewComposition({
    input: "/unused-fictional-intake.json", output: "/unused-fictional-output.json", select: "religious-bayane",
  }, { intakeSnapshot });
  assert.equal(result.state, "composition_ready");
  assert.equal(result.suggestion.id, "religious-bayane");
});

test("the built generation function materializes its own integrity-checked Codex for version only", bundled, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebe-bundled-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(path.join(functionRoot, ".vc-config.json"), "utf8"));
  assert.equal(config.runtime, "nodejs22.x");
  assert.equal(config.maxDuration, 300);
  const manifest = JSON.parse(await readFile(path.join(functionRoot, ".codex-runtime/manifest.json"), "utf8"));
  assert.equal(manifest.packageVersion, "0.146.0");
  assert.equal(createHash("sha256").update(await readFile(path.join(functionRoot, ".codex-runtime/codex.gz"))).digest("hex"), manifest.archiveSha256);
  const { materializePackagedCodexRuntime } = await import(pathToFileURL(path.join(functionRoot, "src/operations/codex-packaged-runtime.mjs")));
  const executable = await materializePackagedCodexRuntime({ destinationRoot: root });
  const version = execFileSync(executable, ["--version"], {
    cwd: root, timeout: 10_000, encoding: "utf8",
    env: { HOME: root, CODEX_HOME: root, TMPDIR: root, PATH: path.dirname(process.execPath) },
  }).trim();
  assert.equal(version, "codex-cli 0.146.0");
});
