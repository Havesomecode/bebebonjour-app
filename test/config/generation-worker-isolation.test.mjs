import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("generation worker is deployed only by its isolated Vercel project", async () => {
  const mainConfig = JSON.parse(await readFile(new URL("vercel.json", root), "utf8"));
  const workerConfig = JSON.parse(await readFile(
    new URL("vercel.generation-worker.json", root),
    "utf8",
  ));
  const manifest = JSON.parse(await readFile(
    new URL("ops/test-a-hosted-provider-manifest.json", root),
    "utf8",
  ));

  assert.equal(JSON.stringify(mainConfig).includes("operations/worker"), false);
  assert.deepEqual(workerConfig.builds, [{
    src: "generation-worker/api/worker.mjs",
    use: "@vercel/node",
    config: {
      includeFiles: [".codex-runtime/**"],
    },
  }]);
  assert.equal(
    workerConfig.installCommand,
    "npm ci && node scripts/package-codex-runtime.mjs",
  );
  assert.deepEqual(workerConfig.routes, [{
    src: "/api/operations/worker",
    dest: "generation-worker/api/worker.mjs",
  }]);
  assert.deepEqual(workerConfig.crons, [{
    path: "/api/operations/worker",
    schedule: "*/5 * * * *",
  }]);
  await access(new URL("generation-worker/api/worker.mjs", root));
  await assert.rejects(access(new URL("api/operations/worker.mjs", root)));
  assert.deepEqual(
    manifest.vercelApi.environmentVariables,
    manifest.secretStores.vercelProduction.allowed,
  );
  for (const workerVariable of manifest.secretStores.generationOperator.allowed
    .filter((name) => name !== "CONVEX_URL")) {
    assert.equal(
      manifest.vercelApi.environmentVariables.includes(workerVariable),
      false,
      `${workerVariable} must not be mounted in the customer-flow Vercel project`,
    );
  }
});