const fs = require("node:fs");
const path = require("node:path");
const { Module, createRequire } = require("node:module");
const { createHash } = require("node:crypto");

// Local Convex 1.44.0 build API only. Never invoke the CLI main entrypoint.
(async () => {
  const root = path.resolve(process.argv[2] || ".");
  const output = process.argv[3];
  if (!output) throw Error("Usage: node ops/bundle-installation-offline.cjs SOURCE_ROOT OUTPUT_JSON");
  process.chdir(root);
  const requireAt = createRequire(path.join(root, "package.json"));
  const cliPath = path.join(root, "node_modules/convex/dist/cli.bundle.cjs");
  const source = fs.readFileSync(cliPath, "utf8");
  if (source.split("void main();").length !== 2) throw Error("Pinned CLI entrypoint changed");
  const mod = new Module(cliPath);
  mod.filename = cliPath;
  mod.paths = requireAt.resolve.paths("convex");
  mod._compile(source.replace("void main();", "module.exports = { nodeFs, readProjectConfig, configFromProjectConfig, bundleSchema, isComponentDirectory, componentGraph, bundleDefinitions, bundleImplementations };"), cliPath);
  const api = mod.exports;
  const ctx = { fs: api.nodeFs, deprecationMessagePrinted: false, crash: async e => { throw Error(e.printedMessage || "Offline bundle failed", { cause: e.errForSentry }); }, registerCleanup: () => "offline", removeCleanup: () => null, bigBrainAuth: () => null };
  const { projectConfig, configPath } = await api.readProjectConfig(ctx);
  await api.configFromProjectConfig(ctx, projectConfig, configPath, false);
  await api.bundleSchema(ctx, path.join(root, projectConfig.functions), []);
  const directory = api.isComponentDirectory(ctx, path.join(root, projectConfig.functions), true);
  if (directory.kind !== "ok" || directory.component.isRootWithoutConfig) throw Error("Recovered production root config is required");
  const { components, dependencyGraph } = await api.componentGraph(ctx, root, directory.component, false, false);
  const definitions = await api.bundleDefinitions(ctx, root, dependencyGraph, directory.component, [...components.values()], false, false);
  if (definitions.appDefinitionSpecWithoutImpls.dependencies.length || definitions.componentDefinitionSpecsWithoutImpls.length) throw Error("Unexpected component dependency");
  const { appImplementation } = await api.bundleImplementations({ ctx, rootComponentDirectory: directory.component, componentDirectories: [...components.values()].filter(d => !d.isRoot), nodeExternalPackages: projectConfig.node.externalPackages, extraConditions: [], verbose: false, includeSourcesContent: false });
  const modules = [...appImplementation.functions, appImplementation.schema, definitions.appDefinitionSpecWithoutImpls.definition];
  const result = { modules: modules.map(m => ({ path: m.path, environment: m.environment, hash: createHash("sha256").update(m.source).update(m.sourceMap || "").digest("hex"), source: m.source, sourceMap: m.sourceMap })), definitions };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`INSTALLATION_OFFLINE_BUNDLE_PASS modules=${modules.length} root_dependencies=0 child_components=0 NO_RELEASE_APPROVAL`);
})().catch(error => { console.error(error); process.exitCode = 1; });
