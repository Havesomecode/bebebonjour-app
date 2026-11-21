import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Exercise the installed production CLI's real bundler offline. No deployment
// selection, authentication, codegen, or provider requests are involved.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = `${root}node_modules/convex/dist/cli.bundle.cjs`;
const cliSource = readFileSync(cliPath, "utf8");
assert.equal(cliSource.split("void main();").length, 2, "pinned CLI entry point");
// The distributed CLI includes its private dependencies; individual dist/cjs
// modules do not. Expose the unchanged production bundler without invoking main
// (which initializes telemetry, authentication and deployment commands).
const offlineCli = new Module(cliPath);
offlineCli.filename = cliPath;
offlineCli.paths = require.resolve.paths("convex");
offlineCli._compile(cliSource.replace("void main();", "module.exports = { nodeFs, readProjectConfig, configFromProjectConfig, bundleSchema, isComponentDirectory, componentGraph, bundleDefinitions };"), cliPath);
const { nodeFs, readProjectConfig, configFromProjectConfig, bundleSchema, isComponentDirectory, componentGraph, bundleDefinitions } = offlineCli.exports;

test("production Convex bundler separates isolate queries/mutations from Node actions", async () => {
  const ctx = {
    fs: nodeFs,
    deprecationMessagePrinted: false,
    crash: async ({ printedMessage, errForSentry }) => {
      throw new Error(printedMessage || "Convex bundling failed", { cause: errForSentry });
    },
    registerCleanup: () => "offline",
    removeCleanup: () => null,
    bigBrainAuth: () => null,
  };
  const { projectConfig, configPath } = await readProjectConfig(ctx);
  const { config } = await configFromProjectConfig(ctx, projectConfig, configPath, false);
  await assert.rejects(bundleSchema(ctx, `${root}${projectConfig.functions}`, []), /Convex bundling failed/);
  for (const path of ["abuse.js", "operations.js", "narration.js", "fulfillment.js", "generation.js", "customerFlow.js", "http.js", "automaticGeneration.js", "canonicalCompletionScope.js"]) {
    assert.equal(config.modules.find((entry) => entry.path === path)?.environment, "isolate", path);
  }
  for (const path of ["deliveryLoop.js", "deliveryLoopPaymentEvents.js", "deliveryLoopPaymentHttp.js", "deliveryLoopHttp.js", "deliveryLoopPaidPolicy.js", "deliveryLoopPaidViews.js", "deliveryLoopData.js", "deliveryLoopDataHttp.js", "deliveryLoopDataViews.js", "deliveryLoopExport.js", "deliveryLoopProviders.js", "deliveryLoopDataProviders.js"]) {
    assert.equal(config.modules.find((entry) => entry.path === path), undefined, path);
  }
  assert.equal(config.modules.find((entry) => entry.path === "narrationRuntime.js")?.environment, "node");
  for (const module of config.modules.filter((entry) => entry.environment === "isolate")) {
    assert.doesNotMatch(module.source, /(?:from\s*|import\s*\()?["']node:(?:crypto|util)["']/u);
  }
  // App definitions are bundled separately, not listed as function modules.
  const directory = isComponentDirectory(ctx, `${root}${projectConfig.functions}`, true);
  assert.equal(directory.kind, "ok");
  // Current delivered source has no component app definition. Do not import
  // an older archived config merely to satisfy historical test assumptions.
  if (directory.component.isRootWithoutConfig) return;
  const { components, dependencyGraph } = await componentGraph(ctx, root, directory.component, false, false);
  const { appDefinitionSpecWithoutImpls, componentDefinitionSpecsWithoutImpls } = await bundleDefinitions(
    ctx, root, dependencyGraph, directory.component, [...components.values()], false, false,
  );
  assert.equal(appDefinitionSpecWithoutImpls.definition.path, "convex.config.js");
  assert.equal(appDefinitionSpecWithoutImpls.definition.environment, "isolate");
  assert.ok(appDefinitionSpecWithoutImpls.definition.source.length > 0);
  assert.deepEqual(appDefinitionSpecWithoutImpls.dependencies, []);
  assert.deepEqual(componentDefinitionSpecsWithoutImpls, []);
  for (const module of config.modules.filter((entry) => entry.environment === "isolate")) {
    assert.doesNotMatch(module.source, /(?:from\s*|import\s*\()?["']node:(?:crypto|util)["']/u);
  }
});
