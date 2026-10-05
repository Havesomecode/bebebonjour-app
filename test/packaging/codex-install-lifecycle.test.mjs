import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const source = new URL("../../", import.meta.url);

test("a clean dependency install packages a materializable pinned Codex without provider access", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebe-codex-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "src", "operations"), { recursive: true });
  await mkdir(path.join(root, "home"));
  await mkdir(path.join(root, "destination"));
  for (const file of [
    "package.json", "package-lock.json", "scripts/package-codex-runtime.mjs",
    "src/operations/codex-packaged-runtime.mjs",
  ]) {
    await cp(new URL(file, source), path.join(root, file));
  }
  const environment = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    HOME: path.join(root, "home"),
    TMPDIR: os.tmpdir(),
    NPM_CONFIG_CACHE: process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || path.join(os.homedir(), ".npm"),
    NPM_CONFIG_USERCONFIG: "/dev/null",
    CI: "1",
  };
  execFileSync("npm", ["ci", "--omit=dev", "--offline", "--no-audit", "--no-fund"], {
    cwd: root, env: environment, timeout: 150_000, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  const manifest = JSON.parse(await readFile(path.join(root, ".codex-runtime", "manifest.json"), "utf8"));
  assert.equal(manifest.packageVersion, "0.146.0");
  assert.ok(manifest.archiveBytes > 0);
  const { materializePackagedCodexRuntime } = await import(pathToFileURL(path.join(root, "src/operations/codex-packaged-runtime.mjs")));
  const executable = await materializePackagedCodexRuntime({ destinationRoot: path.join(root, "destination") });
  const version = execFileSync(executable, ["--version"], {
    cwd: root, env: environment, timeout: 10_000, encoding: "utf8",
  }).trim();
  assert.equal(version, "codex-cli 0.146.0");
});
