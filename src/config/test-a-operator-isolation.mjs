import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const PRIVATE_OPERATOR_MARKERS = Object.freeze([
  "operator-runner-test-a",
  "persist-test-a-generation-approval",
  "run-test-a-generation",
  "test-a-generation-approval-startup",
  "test-a-generation-startup",
  "test-a-operator-startup",
  "test-a-operator-runtime-identity",
]);
const GENERATION_WORKER_MARKERS = Object.freeze(["test-a-generation-runner"]);
const PRIVATE_CAPABILITY_MODULES = Object.freeze([
  "ops/persist-test-a-generation-approval.mjs",
  "ops/run-test-a-operator.mjs",
  "ops/run-test-a-generation.mjs",
  "src/fulfillment/hosted-generation-workspace.mjs",
  "src/fulfillment/job-scoped-generation-approval.mjs",
  "src/fulfillment/local-prepare-review-stage-handler.mjs",
  "src/fulfillment/operator-runner-test-a.mjs",
  "src/fulfillment/test-a-generation-approval-startup.mjs",
  "src/fulfillment/test-a-generation-runner.mjs",
  "src/fulfillment/test-a-generation-startup.mjs",
  "src/fulfillment/test-a-operator-runtime-identity.mjs",
  "src/fulfillment/test-a-operator-startup.mjs",
  "src/operations/production-generation-worker.mjs",
  "src/persistence/convex-generation-artifact-store.mjs",
]);
const OPERATIONS_WORKER_GENERATION_MODULES = Object.freeze([
  "src/fulfillment/hosted-generation-workspace.mjs",
  "src/fulfillment/local-prepare-review-stage-handler.mjs",
  "src/fulfillment/test-a-generation-runner.mjs",
  "src/operations/production-generation-worker.mjs",
  "src/persistence/convex-generation-artifact-store.mjs",
]);
const REVIEW_ROOT_INPUTS = Object.freeze([
  ".env.example",
  "ops/test-a-hosted-provider-manifest.json",
  "package-lock.json",
  "package.json",
  "scripts/verify-vercel-routing.mjs",
  "vercel.json",
]);

export async function createTestAOperatorIsolationInventory(options) {
  const rootPath = path.resolve(options?.rootPath || ".");
  const publicEntrypoints = (await listFiles(path.join(rootPath, "api")))
    .filter((filePath) => filePath.endsWith(".mjs"))
    .map((filePath) => relativePath(rootPath, filePath))
    .sort();
  const publicModuleGraph = await traceLocalModuleGraph(rootPath, publicEntrypoints);
  const operationsWorkerEntrypoint = "api/operations/worker.mjs";
  const operationsWorkerModuleGraph = await traceLocalModuleGraph(rootPath, [operationsWorkerEntrypoint]);
  const customerPublicModuleGraph = await traceLocalModuleGraph(
    rootPath,
    publicEntrypoints.filter((entrypoint) => entrypoint !== operationsWorkerEntrypoint),
  );
  const privateInvocation = "ops/run-test-a-operator.mjs";
  const privateModuleGraph = await traceLocalModuleGraph(rootPath, [privateInvocation]);
  const generationInvocation = "ops/run-test-a-generation.mjs";
  const generationModuleGraph = await traceLocalModuleGraph(rootPath, [generationInvocation]);
  const generationApprovalInvocation = "ops/persist-test-a-generation-approval.mjs";
  const generationApprovalModuleGraph = await traceLocalModuleGraph(
    rootPath,
    [generationApprovalInvocation],
  );

  for (const privateModule of PRIVATE_CAPABILITY_MODULES) {
    if (customerPublicModuleGraph.includes(privateModule)) {
      throw new Error(`Public route graph imports private TEST-A operator module ${privateModule}.`);
    }
    if (
      operationsWorkerModuleGraph.includes(privateModule)
      && !OPERATIONS_WORKER_GENERATION_MODULES.includes(privateModule)
    ) {
      throw new Error(`Operations worker imports private TEST-A operator module ${privateModule}.`);
    }
  }

  const publicCapabilityMarkers = [];
  for (const modulePath of customerPublicModuleGraph) {
    const source = await readFile(path.join(rootPath, modulePath), "utf8");
    for (const marker of [...PRIVATE_OPERATOR_MARKERS, ...GENERATION_WORKER_MARKERS]) {
      if (source.includes(marker)) publicCapabilityMarkers.push({ marker, path: modulePath });
    }
  }
  for (const modulePath of operationsWorkerModuleGraph) {
    const source = await readFile(path.join(rootPath, modulePath), "utf8");
    for (const marker of PRIVATE_OPERATOR_MARKERS) {
      if (source.includes(marker)) publicCapabilityMarkers.push({ marker, path: modulePath });
    }
  }
  if (publicCapabilityMarkers.length > 0) {
    const leak = publicCapabilityMarkers[0];
    throw new Error(`Public route graph exposes private TEST-A operator capability marker ${leak.marker}.`);
  }

  const packageJson = JSON.parse(await readFile(path.join(rootPath, "package.json"), "utf8"));
  const packageCommandReferences = [
    ...findPrivateInvocationPackageCommands(packageJson, privateInvocation),
    ...findPrivateInvocationPackageCommands(packageJson, generationInvocation),
    ...findPrivateInvocationPackageCommands(packageJson, generationApprovalInvocation),
  ];
  if (packageCommandReferences.length > 0) {
    throw new Error("Package command surface exposes the private TEST-A operator invocation.");
  }

  const nonTestModules = (
    await Promise.all(["api", "bin", "ops", "scripts", "src"].map(async (directory) => (
      listFiles(path.join(rootPath, directory))
    )))
  ).flat().filter((filePath) => filePath.endsWith(".mjs"));
  const startupImporters = [];
  for (const filePath of nonTestModules) {
    const source = await readFile(filePath, "utf8");
    if (
      staticImportSpecifiers(source)
        .some((specifier) => specifier.endsWith("/test-a-operator-startup.mjs"))
    ) {
      startupImporters.push(relativePath(rootPath, filePath));
    }
  }
  if (startupImporters.length !== 1 || startupImporters[0] !== privateInvocation) {
    throw new Error("Private TEST-A operator startup must have exactly one non-test invocation.");
  }
  const generationStartupImporters = [];
  for (const filePath of nonTestModules) {
    const source = await readFile(filePath, "utf8");
    if (
      staticImportSpecifiers(source)
        .some((specifier) => specifier.endsWith("/test-a-generation-startup.mjs"))
    ) {
      generationStartupImporters.push(relativePath(rootPath, filePath));
    }
  }
  if (
    generationStartupImporters.length !== 1
    || generationStartupImporters[0] !== generationInvocation
  ) {
    throw new Error("Private TEST-A generation startup must have exactly one non-test invocation.");
  }
  const generationApprovalStartupImporters = [];
  for (const filePath of nonTestModules) {
    const source = await readFile(filePath, "utf8");
    if (staticImportSpecifiers(source).some(
      (specifier) => specifier.endsWith("/test-a-generation-approval-startup.mjs"),
    )) {
      generationApprovalStartupImporters.push(relativePath(rootPath, filePath));
    }
  }
  if (
    generationApprovalStartupImporters.length !== 1
    || generationApprovalStartupImporters[0] !== generationApprovalInvocation
  ) {
    throw new Error("Private TEST-A generation approval startup must have exactly one non-test invocation.");
  }

  return Object.freeze({
    generationApprovalInvocation,
    generationApprovalModuleGraph,
    generationInvocation,
    generationModuleGraph,
    customerPublicModuleGraph,
    operationsWorkerEntrypoint,
    operationsWorkerGenerationModules: [...OPERATIONS_WORKER_GENERATION_MODULES],
    operationsWorkerModuleGraph,
    packageCommandReferences,
    privateCapabilityModules: [...PRIVATE_CAPABILITY_MODULES],
    privateInvocation,
    privateModuleGraph,
    publicCapabilityMarkers,
    publicEntrypoints,
    publicModuleGraph,
    reviewInputs: [...new Set([
      ...REVIEW_ROOT_INPUTS,
      ...publicModuleGraph,
      ...privateModuleGraph,
      ...generationModuleGraph,
      ...generationApprovalModuleGraph,
    ])].sort(),
  });
}

export function findPrivateInvocationPackageCommands(packageJson, privateInvocation) {
  const allowedSyntaxCheck = `node --check ./${privateInvocation}`;
  return Object.entries({
    ...(packageJson.bin || {}),
    ...(packageJson.scripts || {}),
  }).filter(([, command]) => command
    .split(/&&|\|\||[;|]/u)
    .map((segment) => segment.trim())
    .some((segment) => segment.includes(privateInvocation) && segment !== allowedSyntaxCheck));
}

export async function inspectGeneratedPublicArtifact(artifactRoot) {
  const absoluteRoot = path.resolve(artifactRoot);
  const files = await listFiles(absoluteRoot);
  const inventory = [];
  for (const filePath of files) {
    const file = await lstat(filePath);
    if (!file.isFile()) throw new Error("Generated public artifact inventory accepts regular files only.");
    const bytes = await readFile(filePath);
    const relative = relativePath(absoluteRoot, filePath);
    const text = isTextFile(relative) ? bytes.toString("utf8") : "";
    const markers = relative.startsWith("functions/api/operations/worker.func/")
      ? PRIVATE_OPERATOR_MARKERS
      : [...PRIVATE_OPERATOR_MARKERS, ...GENERATION_WORKER_MARKERS];
    for (const marker of markers) {
      if (relative.includes(marker) || text.includes(marker)) {
        throw new Error(`Generated public artifact exposes private TEST-A operator capability marker ${marker}.`);
      }
    }
    inventory.push({
      path: relative,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const canonicalBytesInventory = `${JSON.stringify(inventory)}\n`;
  const canonicalPathInventory = `${JSON.stringify(inventory.map(({ path: filePath }) => filePath))}\n`;
  return Object.freeze({
    fileCount: inventory.length,
    files: inventory,
    byteInventorySha256: createHash("sha256").update(canonicalBytesInventory).digest("hex"),
    pathInventorySha256: createHash("sha256").update(canonicalPathInventory).digest("hex"),
  });
}

async function traceLocalModuleGraph(rootPath, entrypoints) {
  const visited = new Set();
  const pending = [...entrypoints];
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (visited.has(modulePath)) continue;
    visited.add(modulePath);
    const source = await readFile(path.join(rootPath, modulePath), "utf8");
    for (const specifier of staticImportSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = await resolveLocalModule(rootPath, modulePath, specifier);
      if (!visited.has(resolved)) pending.push(resolved);
    }
  }
  return [...visited].sort();
}

function staticImportSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

async function resolveLocalModule(rootPath, importer, specifier) {
  const candidate = path.resolve(rootPath, path.dirname(importer), specifier);
  const candidates = path.extname(candidate)
    ? [candidate]
    : [`${candidate}.mjs`, `${candidate}.js`, path.join(candidate, "index.mjs")];
  for (const resolved of candidates) {
    try {
      if ((await lstat(resolved)).isFile()) return relativePath(rootPath, resolved);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Cannot resolve local import ${specifier} from ${importer}.`);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact inventory refuses symbolic link ${entryPath}.`);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function relativePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).split(path.sep).join("/");
}

function isTextFile(filePath) {
  return /\.(?:cjs|css|html|js|json|map|mjs|txt)$/u.test(filePath);
}
