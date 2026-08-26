import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const PUBLIC_CAPABILITY_MARKERS = Object.freeze([
  "operator-runner-test-a",
  "test-a-operator-startup",
  "test-a-operator-runtime-identity",
]);
const PRIVATE_CAPABILITY_MODULES = Object.freeze([
  "ops/run-test-a-operator.mjs",
  "src/fulfillment/operator-runner-test-a.mjs",
  "src/fulfillment/test-a-operator-runtime-identity.mjs",
  "src/fulfillment/test-a-operator-startup.mjs",
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
  const privateInvocation = PRIVATE_CAPABILITY_MODULES[0];
  const privateModuleGraph = await traceLocalModuleGraph(rootPath, [privateInvocation]);

  for (const privateModule of PRIVATE_CAPABILITY_MODULES) {
    if (publicModuleGraph.includes(privateModule)) {
      throw new Error(`Public route graph imports private TEST-A operator module ${privateModule}.`);
    }
  }

  const publicCapabilityMarkers = [];
  for (const modulePath of publicModuleGraph) {
    const source = await readFile(path.join(rootPath, modulePath), "utf8");
    for (const marker of PUBLIC_CAPABILITY_MARKERS) {
      if (source.includes(marker)) publicCapabilityMarkers.push({ marker, path: modulePath });
    }
  }
  if (publicCapabilityMarkers.length > 0) {
    const leak = publicCapabilityMarkers[0];
    throw new Error(`Public route graph exposes private TEST-A operator capability marker ${leak.marker}.`);
  }

  const packageJson = JSON.parse(await readFile(path.join(rootPath, "package.json"), "utf8"));
  const packageCommandReferences = findPrivateInvocationPackageCommands(packageJson, privateInvocation);
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

  return Object.freeze({
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
    for (const marker of PUBLIC_CAPABILITY_MARKERS) {
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
