import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_SUBSCRIPTION_ADAPTER_VERSION,
  CODEX_SUBSCRIPTION_PROVIDER,
  codexSubscriptionCompositionSchema,
} from "../../scripts/lib/codex-subscription-composition.mjs";
import { createCodexSubscriptionComposer } from "../../src/fulfillment/codex-subscription-composer.mjs";
import { materializePackagedCodexRuntime } from "../../src/operations/codex-packaged-runtime.mjs";

const RUN_PROVIDER_TEST = process.env.RUN_CODEX_STRICT_RESPONSE_FORMAT_TEST === "1";
const PACKAGE_VERSION = "0.146.0";
const MODEL = "gpt-5.6-sol";
const SYNTHETIC_INTAKE = Object.freeze({
  schemaVersion: "1.0",
  baby: {
    firstName: "Aélio-Z",
    nameArabic: "أيليو",
    gender: "girl",
  },
  languages: ["ar", "fr"],
  context: { religion: "islam" },
  notes: { specificDemands: "Keep the announcement warm, restrained, and private." },
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertStrictResponseSchema(value, location = "$") {
  assert.equal(Boolean(value) && typeof value === "object" && !Array.isArray(value), true);
  if (Object.hasOwn(value, "const")) {
    const expectedType = value.const === null
      ? "null"
      : Array.isArray(value.const)
        ? "array"
        : typeof value.const;
    assert.equal(value.type, expectedType, `${location} const requires an explicit matching type`);
  }
  if (value.type === "object") {
    assert.equal(value.additionalProperties, false, `${location} must reject additional properties`);
    const properties = value.properties || {};
    assert.deepEqual(
      [...(value.required || [])].sort(),
      Object.keys(properties).sort(),
      `${location} must require every declared property`,
    );
    for (const [name, property] of Object.entries(properties)) {
      assertStrictResponseSchema(property, `${location}.properties.${name}`);
    }
  }
  if (value.type === "array") assertStrictResponseSchema(value.items, `${location}.items`);
  for (const [name, definition] of Object.entries(value.$defs || {})) {
    assertStrictResponseSchema(definition, `${location}.$defs.${name}`);
  }
}

test("pinned packaged Codex response schema satisfies the strict OpenAI boundary", async () => {
  const [packageManifest, lockManifest, schemaSource, evidence] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../schemas/codex-subscription-composition.schema.json", import.meta.url)),
    readFile(
      new URL("../../ops/codex-response-schema-compatibility-evidence.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);

  assert.equal(packageManifest.dependencies["@openai/codex"], PACKAGE_VERSION);
  assert.equal(lockManifest.packages["node_modules/@openai/codex"].version, PACKAGE_VERSION);
  assert.equal(codexSubscriptionCompositionSchema.properties.schemaVersion.type, "string");
  assert.equal(codexSubscriptionCompositionSchema.properties.schemaVersion.const, "1.0");
  assertStrictResponseSchema(codexSubscriptionCompositionSchema);
  assert.deepEqual(evidence.correction.schemaVersionProperty, { type: "string", const: "1.0" });
  assert.equal(evidence.correction.schemaSourceSha256, sha256(schemaSource));
  assert.equal(
    evidence.correction.serializedSchemaSha256,
    sha256(`${JSON.stringify(codexSubscriptionCompositionSchema, null, 2)}\n`),
  );
  assert.equal(evidence.packagedRuntime.packageVersion, PACKAGE_VERSION);
  assert.equal(evidence.syntheticProviderProbe.status, "PASS");
  assert.equal(evidence.syntheticProviderProbe.fixture, "synthetic-only");
  assert.equal(evidence.syntheticProviderProbe.provider, CODEX_SUBSCRIPTION_PROVIDER);
  assert.equal(evidence.syntheticProviderProbe.adapterVersion, CODEX_SUBSCRIPTION_ADAPTER_VERSION);
  assert.equal(evidence.privacyAndReleaseBoundary.persistedProviderContent, false);
  assert.equal(evidence.privacyAndReleaseBoundary.persistedCredentials, false);
  assert.equal(evidence.privacyAndReleaseBoundary.pendingOperationsCommandConsumed, false);
  assert.equal(evidence.privacyAndReleaseBoundary.liveCustomerDataAccessed, false);
});

test("packaged Codex 0.146.0 accepts and enforces the production response schema", {
  skip: RUN_PROVIDER_TEST ? false : "set RUN_CODEX_STRICT_RESPONSE_FORMAT_TEST=1 for the synthetic provider probe",
  timeout: 360_000,
}, async (t) => {
  const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-schema-probe-"));
  t.after(() => rm(destinationRoot, { recursive: true, force: true }));
  const executable = await materializePackagedCodexRuntime({ destinationRoot });
  const composer = createCodexSubscriptionComposer({
    executable,
    model: MODEL,
    timeoutMs: 300_000,
  });

  const readiness = await composer.readiness();
  assert.equal(readiness.cliVersion, PACKAGE_VERSION);
  assert.equal(readiness.provider, CODEX_SUBSCRIPTION_PROVIDER);
  assert.equal(readiness.model, MODEL);

  const receipt = await composer.compose(SYNTHETIC_INTAKE);
  assert.equal(receipt.metadata.adapterVersion, CODEX_SUBSCRIPTION_ADAPTER_VERSION);
  assert.equal(receipt.metadata.provider, CODEX_SUBSCRIPTION_PROVIDER);
  assert.equal(receipt.metadata.model, MODEL);

  process.stdout.write(`CODEX_STRICT_RESPONSE_FORMAT_RESULT=${JSON.stringify({
    status: "PASS",
    packageVersion: readiness.cliVersion,
    provider: receipt.metadata.provider,
    model: receipt.metadata.model,
    adapterVersion: receipt.metadata.adapterVersion,
    schemaSha256: sha256(`${JSON.stringify(codexSubscriptionCompositionSchema, null, 2)}\n`),
    requestDigest: receipt.metadata.requestDigest,
    outputDigest: receipt.metadata.outputDigest,
    fixture: "synthetic-only",
  })}\n`);
});
