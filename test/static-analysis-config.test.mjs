import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

test("repository exposes pinned canonical lint and typecheck gates", async () => {
  assert.equal(packageJson.scripts.lint, "eslint . --max-warnings=0");
  assert.equal(packageJson.scripts.typecheck, "tsc --project tsconfig.json --noEmit");
  assert.match(packageJson.devDependencies.eslint, /^\d+\.\d+\.\d+$/u);
  assert.match(packageJson.devDependencies.typescript, /^\d+\.\d+\.\d+$/u);

  await access(new URL("eslint.config.js", root));

  const tsconfig = JSON.parse(await readFile(new URL("tsconfig.json", root), "utf8"));
  assert.equal(tsconfig.compilerOptions.allowJs, true);
  assert.equal(tsconfig.compilerOptions.checkJs, true);
  assert.equal(tsconfig.compilerOptions.noEmit, true);
});

test("canonical configurations reject obvious lint and type regressions", () => {
  const lint = spawnSync(
    process.execPath,
    ["node_modules/eslint/bin/eslint.js", "--no-ignore", "fixtures/static-analysis/invalid-lint.mjs"],
    { cwd: rootPath, encoding: "utf8" },
  );
  assert.notEqual(lint.status, 0);
  assert.match(`${lint.stdout}\n${lint.stderr}`, /no-constant-binary-expression/u);

  const typecheck = spawnSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--project", "fixtures/static-analysis/tsconfig.json"],
    { cwd: rootPath, encoding: "utf8" },
  );
  assert.notEqual(typecheck.status, 0);
  assert.match(`${typecheck.stdout}\n${typecheck.stderr}`, /TS2322/u);
});
