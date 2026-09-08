import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectGeneratedPublicArtifact } from "../src/config/test-a-operator-isolation.mjs";

const EXPECTED_VERCEL_VERSION = "52.2.0";
const FUNCTION_DESTINATION = "/api/customer-flow/[...route]";
const OPERATIONS_WORKER_DESTINATION = "/api/operations/worker";
const TALLY_FUNCTION_DESTINATION = "/api/webhooks/tally";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercelCli = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vercel.cmd" : "vercel",
);
const scratchRoot = await mkdtemp(path.join(tmpdir(), "bebebonjour-vercel-routing-"));
const requestedRevision = process.env.VERCEL_ROUTING_REVISION || "";
const sourceRoot = requestedRevision
  ? path.join(scratchRoot, "revision-source")
  : path.resolve(process.env.VERCEL_ROUTING_SOURCE || projectRoot);
const buildRoot = path.join(scratchRoot, "source");
const outputRoot = path.join(scratchRoot, "output");
const workerOutputRoot = path.join(scratchRoot, "worker-output");
const globalConfigRoot = path.join(scratchRoot, "global-config");

try {
  const environment = sanitizedEnvironment();
  await writeFile(environment.NPM_CONFIG_USERCONFIG, "");
  const version = run(vercelCli, ["--version"], { environment }).trim();
  assert.match(
    version,
    new RegExp(`(?:^|\\s)${EXPECTED_VERCEL_VERSION.replaceAll(".", "\\.")}(?:$|\\s)`),
    `expected Vercel CLI ${EXPECTED_VERCEL_VERSION}, received ${JSON.stringify(version)}`,
  );

  if (requestedRevision) {
    await exportGitRevision(requestedRevision, sourceRoot, environment);
  }

  await mkdir(buildRoot, { recursive: true });
  await Promise.all([
    cp(path.join(sourceRoot, "api"), path.join(buildRoot, "api"), { recursive: true }),
    cp(path.join(sourceRoot, "generation-worker"), path.join(buildRoot, "generation-worker"), { recursive: true }),
    cp(path.join(sourceRoot, "src"), path.join(buildRoot, "src"), { recursive: true }),
    cp(path.join(sourceRoot, "package.json"), path.join(buildRoot, "package.json")),
    cp(path.join(sourceRoot, "package-lock.json"), path.join(buildRoot, "package-lock.json")),
    cp(
      path.join(sourceRoot, "vercel.generation-worker.json"),
      path.join(buildRoot, "vercel.generation-worker.json"),
    ),
    mkdir(path.join(buildRoot, ".vercel-static"), { recursive: true }),
    mkdir(path.join(buildRoot, ".vercel"), { recursive: true }),
    mkdir(globalConfigRoot, { recursive: true }),
  ]);
  await mkdir(path.join(buildRoot, "ops"), { recursive: true });
  await writeFile(path.join(buildRoot, ".vercel-static", "index.html"), "routing regression\n");
  await cp(
    path.join(sourceRoot, "ops", "test-a-hosted-provider-manifest.json"),
    path.join(buildRoot, "ops", "test-a-hosted-provider-manifest.json"),
  );

  const vercelConfig = await readOptionalJson(path.join(sourceRoot, "vercel.json")) || {};
  const localBuildConfigPath = path.join(buildRoot, "vercel.routing-test.json");
  await writeFile(localBuildConfigPath, `${JSON.stringify({
    ...vercelConfig,
    buildCommand: "true",
    installCommand: "true",
    outputDirectory: ".vercel-static",
  }, null, 2)}\n`);
  await writeFile(path.join(buildRoot, ".vercel", "project.json"), `${JSON.stringify({
    projectId: "prj_local_route_regression",
    orgId: "team_local_route_regression",
    projectName: "bebebonjour-local-route-regression",
    settings: {
      framework: null,
      installCommand: "true",
      buildCommand: "true",
      outputDirectory: ".vercel-static",
      rootDirectory: null,
      nodeVersion: "22.x",
    },
  }, null, 2)}\n`);

  run(vercelCli, [
    "build",
    "--cwd", buildRoot,
    "--global-config", globalConfigRoot,
    "--local-config", localBuildConfigPath,
    "--non-interactive",
    "--output", outputRoot,
  ], { environment });

  run(vercelCli, [
    "build",
    "--cwd", buildRoot,
    "--global-config", globalConfigRoot,
    "--local-config", path.join(buildRoot, "vercel.generation-worker.json"),
    "--non-interactive",
    "--output", workerOutputRoot,
  ], { environment });

  const [
    manifest,
    outputConfig,
    workerOutputConfig,
    functionConfig,
    operationsWorkerConfig,
    tallyFunctionConfig,
  ] = await Promise.all([
    readFile(path.join(buildRoot, "ops", "test-a-hosted-provider-manifest.json"), "utf8").then(JSON.parse),
    readFile(path.join(outputRoot, "config.json"), "utf8").then(JSON.parse),
    readFile(path.join(workerOutputRoot, "config.json"), "utf8").then(JSON.parse),
    readFile(
      path.join(
        outputRoot,
        "functions",
        "api",
        "customer-flow",
        "[...route].func",
        ".vc-config.json",
      ),
      "utf8",
    ).then(JSON.parse),
    readFile(
      path.join(
        workerOutputRoot,
        "functions",
        "generation-worker",
        "api",
        "worker.mjs.func",
        ".vc-config.json",
      ),
      "utf8",
    ).then(JSON.parse),
    readFile(
      path.join(outputRoot, "functions", "api", "webhooks", "tally.func", ".vc-config.json"),
      "utf8",
    ).then(JSON.parse),
  ]);

  assert.equal(outputConfig.version, 3);
  assert.match(functionConfig.runtime, /^nodejs22\.x$/);
  assert.match(operationsWorkerConfig.runtime, /^nodejs22\.x$/);
  assert.equal(operationsWorkerConfig.maxDuration, 300);
  assert.match(tallyFunctionConfig.runtime, /^nodejs22\.x$/);
  assert.ok(Array.isArray(outputConfig.routes), "Vercel output must contain generated routes");
  assert.ok(Array.isArray(workerOutputConfig.routes), "worker output must contain generated routes");
  assert.ok(Array.isArray(manifest.vercelApi.routes), "provider manifest must declare Vercel routes");

  for (const manifestRoute of manifest.vercelApi.routes) {
    const [, , pathname] = /^(GET|POST) (\/\S+)$/.exec(manifestRoute) || [];
    assert.ok(pathname, `invalid provider manifest route: ${manifestRoute}`);
    const probePath = pathname.replaceAll(/:[A-Za-z][A-Za-z0-9_]*/g, "job_route_probe");
    const resolved = resolveGeneratedRoute(outputConfig.routes, probePath);
    const expectedDestination = pathname === "/api/webhooks/tally"
      ? TALLY_FUNCTION_DESTINATION
      : FUNCTION_DESTINATION;
    assert.equal(resolved?.destination, expectedDestination,
      `${manifestRoute} resolved to ${JSON.stringify(resolved)} instead of ${expectedDestination}; generated routes: ${JSON.stringify(outputConfig.routes)}`);
  }

  assert.equal(
    resolveGeneratedRoute(outputConfig.routes, "/api/operations/worker")?.status,
    404,
  );
  assert.equal(
    resolveGeneratedRoute(workerOutputConfig.routes, "/api/operations/worker")?.destination,
    "generation-worker/api/worker.mjs",
  );
  const workerCustomerRoute = resolveGeneratedRoute(
    workerOutputConfig.routes,
    "/api/customer-flow/health",
  );
  assert.ok(!workerCustomerRoute || workerCustomerRoute.status === 404);

  const artifactInventory = await inspectGeneratedPublicArtifact(outputRoot);

  console.log(
    `PASS: Vercel CLI ${EXPECTED_VERCEL_VERSION} isolates ${OPERATIONS_WORKER_DESTINATION} from ${FUNCTION_DESTINATION} and ${TALLY_FUNCTION_DESTINATION}; all ${manifest.vercelApi.routes.length} customer routes resolve to their reviewed handlers.`,
  );
  console.log(`HERMES_VERIFY_RESULT=${JSON.stringify({
    status: "PASS",
    generatedArtifactFileCount: artifactInventory.fileCount,
    generatedArtifactPathInventorySha256: artifactInventory.pathInventorySha256,
    operationsWorkerMaxDuration: operationsWorkerConfig.maxDuration,
    privateOperatorReachable: false,
  })}`);
} finally {
  await rm(scratchRoot, { recursive: true, force: true });
}

function resolveGeneratedRoute(routes, pathname) {
  for (const route of routes) {
    if (route.handle || typeof route.src !== "string") continue;
    const match = new RegExp(route.src).exec(pathname);
    if (!match) continue;
    if (typeof route.status === "number") return { status: route.status };
    if (typeof route.dest === "string") {
      return { destination: route.dest.split("?", 1)[0] };
    }
  }
  return null;
}

function sanitizedEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("VERCEL_") || name === "NODE_AUTH_TOKEN" || name === "NPM_TOKEN") {
      delete environment[name];
    }
  }
  environment.CI = "1";
  environment.NPM_CONFIG_USERCONFIG = path.join(scratchRoot, "empty-npmrc");
  environment.VERCEL_TELEMETRY_DISABLED = "1";
  return environment;
}

function run(command, args, { environment }) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} exited ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function exportGitRevision(revision, destination, environment) {
  assert.match(revision, /^[0-9a-f]{40}$/, "VERCEL_ROUTING_REVISION must be a full commit SHA");
  await mkdir(destination, { recursive: true });
  const archive = spawnSync("git", ["archive", "--format=tar", revision], {
    cwd: projectRoot,
    env: environment,
    maxBuffer: 100 * 1024 * 1024,
  });
  if (archive.error) throw archive.error;
  assert.equal(archive.status, 0, archive.stderr?.toString("utf8"));
  const extraction = spawnSync("tar", ["-x", "-C", destination], {
    cwd: projectRoot,
    env: environment,
    input: archive.stdout,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (extraction.error) throw extraction.error;
  assert.equal(extraction.status, 0, extraction.stderr?.toString("utf8"));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
