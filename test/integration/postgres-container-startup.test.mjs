import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const missingImage = "registry.invalid/bebebonjour/postgres:missing";

async function createDockerProcessDouble(t) {
  const directory = await mkdtemp(join(tmpdir(), "bebebonjour-docker-double-"));
  const executable = join(directory, "docker");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] !== "run") process.exit(0);
if (process.env.FAKE_DOCKER_FAILURE === "missing-image") {
  process.stdout.write("Unable to find image '${missingImage}' locally\\n");
  process.stderr.write("docker: Error response from daemon: manifest for ${missingImage} not found: manifest unknown\\n");
} else if (process.env.FAKE_DOCKER_FAILURE === "unrelated-image") {
  process.stdout.write("docker startup stdout marker\\n");
  process.stderr.write("docker: Error response from daemon: manifest for registry.invalid/unrelated/postgres:missing not found: manifest unknown\\n");
} else {
  process.stdout.write("docker startup stdout marker\\n");
  process.stderr.write("docker: Error response from daemon: Conflict. The container name is already in use.\\n");
}
process.exit(125);
`,
  );
  await chmod(executable, 0o755);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runIntegrationStartup({ dockerDirectory, failure, file, testName }) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    FAKE_DOCKER_FAILURE: failure,
    PATH: `${dockerDirectory}${delimiter}${process.env.PATH || ""}`,
    POSTGRES_TEST_IMAGE: missingImage,
    RUN_DB_TESTS: "1",
  };
  delete env.NODE_TEST_CONTEXT;

  return spawnSync(
    process.execPath,
    ["--test", `--test-name-pattern=${testName}`, file],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 30_000,
    },
  );
}

const startupSites = [
  {
    file: "test/integration/fulfillment-database.test.mjs",
    testName: "same-transaction eligibility cycles use a monotonic per-order ordinal",
  },
  {
    file: "test/integration/fulfillment-database.test.mjs",
    testName: "provider ordering and retries create one review job and generation run per valid order",
  },
  {
    file: "test/integration/fulfillment-end-to-end.test.mjs",
    testName: "a synthetic paid order reaches review_required through both webhook handlers",
  },
];

test("every PostgreSQL integration startup explains an unavailable configured image", async (t) => {
  const dockerDirectory = await createDockerProcessDouble(t);

  for (const startupSite of startupSites) {
    const result = runIntegrationStartup({
      dockerDirectory,
      failure: "missing-image",
      ...startupSite,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;

    assert.notEqual(
      result.status,
      0,
      `${startupSite.testName} unexpectedly passed\n${output}${result.error?.message || ""}`,
    );
    assert.ok(output.includes(missingImage));
    assert.match(output, /docker image inspect/);
    assert.match(output, /docker pull/);
    assert.match(output, /POSTGRES_TEST_IMAGE/);
    assert.match(output, /manifest unknown/);
  }
});

test("other Docker startup failures retain their output without misdiagnosing the image", async (t) => {
  const dockerDirectory = await createDockerProcessDouble(t);
  const result = runIntegrationStartup({
    dockerDirectory,
    failure: "container-conflict",
    ...startupSites[0],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;

  assert.notEqual(result.status, 0, `${output}${result.error?.message || ""}`);
  assert.match(output, /Failed to start PostgreSQL test container/);
  assert.match(output, /docker startup stdout marker/);
  assert.match(output, /container name is already in use/i);
  assert.doesNotMatch(output, /PostgreSQL test image .* is unavailable/);
});

test("an unavailable unrelated image does not blame the configured PostgreSQL image", async (t) => {
  const dockerDirectory = await createDockerProcessDouble(t);
  const result = runIntegrationStartup({
    dockerDirectory,
    failure: "unrelated-image",
    ...startupSites[0],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;

  assert.notEqual(result.status, 0, `${output}${result.error?.message || ""}`);
  assert.match(output, /Failed to start PostgreSQL test container/);
  assert.match(output, /registry\.invalid\/unrelated\/postgres:missing/);
  assert.doesNotMatch(output, /PostgreSQL test image .* is unavailable/);
});
