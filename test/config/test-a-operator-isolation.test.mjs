import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTestAOperatorIsolationInventory,
  findPrivateInvocationPackageCommands,
  inspectGeneratedPublicArtifact,
} from "../../src/config/test-a-operator-isolation.mjs";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("operator isolation inventory keeps TEST-A capabilities outside every public route graph", async () => {
  const inventory = await createTestAOperatorIsolationInventory({ rootPath });

  assert.deepEqual(inventory.publicEntrypoints, [
    "api/customer-flow/[...route].mjs",
    "api/operations/worker.mjs",
    "api/webhooks/tally.mjs",
  ]);
  assert.equal(inventory.privateInvocation, "ops/run-test-a-operator.mjs");
  assert.equal(inventory.generationInvocation, "ops/run-test-a-generation.mjs");
  assert.equal(
    inventory.generationApprovalInvocation,
    "ops/persist-test-a-generation-approval.mjs",
  );
  assert.ok(inventory.generationApprovalModuleGraph.includes(
    "src/fulfillment/test-a-generation-approval-startup.mjs",
  ));
  assert.ok(inventory.generationApprovalModuleGraph.includes(
    "src/fulfillment/job-scoped-generation-approval.mjs",
  ));
  assert.ok(inventory.generationModuleGraph.includes("src/fulfillment/test-a-generation-runner.mjs"));
  assert.ok(inventory.generationModuleGraph.includes("src/fulfillment/test-a-generation-startup.mjs"));
  assert.ok(inventory.generationModuleGraph.includes("src/fulfillment/local-prepare-review-stage-handler.mjs"));
  assert.ok(inventory.generationModuleGraph.includes("src/fulfillment/job-scoped-generation-approval.mjs"));
  assert.equal(inventory.generationModuleGraph.includes("src/fulfillment/operator-runner-test-a.mjs"), false);
  assert.equal(inventory.generationModuleGraph.includes("src/fulfillment/resend-delivery-adapter.mjs"), false);
  assert.equal(inventory.generationModuleGraph.includes("src/fulfillment/vercel-test-a-publication-provider.mjs"), false);
  assert.equal(inventory.operationsWorkerEntrypoint, "api/operations/worker.mjs");
  assert.ok(inventory.operationsWorkerModuleGraph.includes("src/operations/production-generation-worker.mjs"));
  assert.deepEqual(inventory.operationsWorkerGenerationModules, [
    "src/fulfillment/hosted-generation-workspace.mjs",
    "src/fulfillment/local-prepare-review-stage-handler.mjs",
    "src/fulfillment/test-a-generation-runner.mjs",
    "src/operations/production-generation-worker.mjs",
    "src/persistence/convex-generation-artifact-store.mjs",
  ]);
  assert.ok(inventory.privateModuleGraph.includes("src/fulfillment/operator-runner-test-a.mjs"));
  assert.ok(inventory.privateModuleGraph.includes("src/fulfillment/test-a-operator-startup.mjs"));
  assert.equal(inventory.privateModuleGraph.includes("src/fulfillment/test-a-operator-runtime-identity.mjs"), false);
  assert.ok(inventory.reviewInputs.includes("package-lock.json"));
  assert.ok(inventory.reviewInputs.includes("package.json"));
  assert.ok(inventory.reviewInputs.includes("vercel.json"));
  assert.ok(inventory.reviewInputs.includes("scripts/verify-vercel-routing.mjs"));
  assert.deepEqual(inventory.privateCapabilityModules, [
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
  assert.equal(
    inventory.customerPublicModuleGraph.some(
      (modulePath) => inventory.privateCapabilityModules.includes(modulePath),
    ),
    false,
  );
  assert.deepEqual(
    inventory.operationsWorkerModuleGraph.filter(
      (modulePath) => inventory.privateCapabilityModules.includes(modulePath),
    ),
    inventory.operationsWorkerGenerationModules,
  );
  assert.deepEqual(inventory.publicCapabilityMarkers, []);
  assert.deepEqual(inventory.packageCommandReferences, []);
});

test("generated public artifact inventory rejects private runner paths and capability markers", async (t) => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-public-artifact-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  await mkdir(path.join(artifactRoot, "functions", "api.func"), { recursive: true });
  await writeFile(path.join(artifactRoot, "config.json"), '{"version":3}\n');
  await writeFile(path.join(artifactRoot, "functions", "api.func", "index.mjs"), "export default true;\n");

  const inventory = await inspectGeneratedPublicArtifact(artifactRoot);
  assert.equal(inventory.fileCount, 2);
  assert.equal(inventory.files[1].path, "functions/api.func/index.mjs");
  assert.match(inventory.pathInventorySha256, /^[0-9a-f]{64}$/u);

  await writeFile(
    path.join(artifactRoot, "functions", "api.func", "index.mjs"),
    "export default () => new Response('changed public bytes');\n",
  );
  const changedBytesInventory = await inspectGeneratedPublicArtifact(artifactRoot);
  assert.equal(changedBytesInventory.pathInventorySha256, inventory.pathInventorySha256);
  assert.notDeepEqual(changedBytesInventory.files, inventory.files);

  await writeFile(
    path.join(artifactRoot, "functions", "api.func", "leak.mjs"),
    'const forbidden = "operator-runner-test-a";\n',
  );
  await assert.rejects(
    inspectGeneratedPublicArtifact(artifactRoot),
    /public artifact exposes private TEST-A operator capability marker operator-runner-test-a/,
  );
});

test("package command inspection allows syntax checks but rejects executable operator chains", () => {
  const invocation = "ops/run-test-a-operator.mjs";
  assert.deepEqual(findPrivateInvocationPackageCommands({
    scripts: { build: `node --check ./${invocation}` },
  }, invocation), []);
  assert.deepEqual(findPrivateInvocationPackageCommands({
    scripts: { unsafe: `node --check ./${invocation} && node ./${invocation} status job_test_001` },
  }, invocation), [[
    "unsafe",
    `node --check ./${invocation} && node ./${invocation} status job_test_001`,
  ]]);
});

test("artifact path inventory uses locale-independent code-unit ordering", async (t) => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-artifact-order-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  await Promise.all(["a.mjs", "z.mjs", "ä.mjs", "å.mjs"].map((fileName) => (
    writeFile(path.join(artifactRoot, fileName), "export default true;\n")
  )));

  const inventory = await inspectGeneratedPublicArtifact(artifactRoot);
  assert.deepEqual(inventory.files.map(({ path: filePath }) => filePath), [
    "a.mjs",
    "z.mjs",
    "ä.mjs",
    "å.mjs",
  ]);
});
