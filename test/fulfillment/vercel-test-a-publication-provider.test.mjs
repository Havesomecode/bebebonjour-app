import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createExternalEffectStageHandlers } from "../../src/fulfillment/external-effect-stage-handlers.mjs";
import { createFulfillmentOrchestrator } from "../../src/fulfillment/job-orchestrator.mjs";
import { createLocalArtifactResolver } from "../../src/fulfillment/local-artifact-resolver.mjs";
import { createVercelTestAPublicationProvider } from "../../src/fulfillment/vercel-test-a-publication-provider.mjs";
import { createLocalTestFulfillmentStore } from "../../src/persistence/local-test-fulfillment-store.mjs";

const JOB_ID = "job_test_001";
const REVISION_ID = "r1";
const IDEMPOTENCY_KEY = `bb_${"e".repeat(64)}`;
const STABLE_ORIGIN = "https://test-a-announcements.example.test";
const CREATED_DEPLOYMENT_ORIGIN = "https://dpl-test-a-001.vercel.app";
const EXISTING_DEPLOYMENT_ORIGIN = "https://dpl-test-a-existing.vercel.app";
const LATER_DEPLOYMENT_ORIGIN = "https://dpl-match-later.vercel.app";
const PUBLICATION_CACHE_CONTROL = "private, no-store, max-age=0";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

async function fixture(t) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-publication-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const revisionRoot = path.join(rootPath, "jobs", JOB_ID, "revisions", REVISION_ID);
  const preparedRoot = path.join(revisionRoot, "prepared");
  const manifestPath = path.join(revisionRoot, "manifests", "prepared_bundle.json");
  const index = Buffer.from("<!doctype html><title>TEST-A exact bytes</title>", "utf8");
  const asset = Buffer.from([0, 1, 2, 3, 4, 255]);
  const files = [
    {
      path: "deploy/canary/fr/index.html",
      sha256: sha256(index),
      bytes: index.byteLength,
      storageId: `local-test:sha256:${sha256(index)}`,
    },
    {
      path: "deploy/canary/_assets/build/canary.bin",
      sha256: sha256(asset),
      bytes: asset.byteLength,
      storageId: `local-test:sha256:${sha256(asset)}`,
    },
  ];
  const persistedManifest = {
    schemaVersion: "1.0",
    kind: "prepared_bundle",
    revisionId: REVISION_ID,
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(persistedManifest, null, 2)}\n`, "utf8");
  await Promise.all([
    mkdir(path.join(preparedRoot, "deploy", "canary", "fr"), { recursive: true }),
    mkdir(path.join(preparedRoot, "deploy", "canary", "_assets", "build"), { recursive: true }),
    mkdir(path.dirname(manifestPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(preparedRoot, "deploy", "canary", "fr", "index.html"), index),
    writeFile(path.join(preparedRoot, "deploy", "canary", "_assets", "build", "canary.bin"), asset),
    writeFile(manifestPath, manifestBytes),
  ]);
  const request = {
    jobId: JOB_ID,
    environment: "test",
    product: "announcement-page",
    revisionId: REVISION_ID,
    artifactSetId: "artifact-set-test-001",
    artifactManifestDigest: sha256(manifestBytes),
    artifactSet: {
      artifactSetId: "artifact-set-test-001",
      kind: "prepared_bundle",
      revisionId: REVISION_ID,
      pageDigest: "b".repeat(64),
      transcriptDigest: "c".repeat(64),
      assetManifestDigest: sha256(manifestBytes),
      manifestRef: `jobs/${JOB_ID}/revisions/${REVISION_ID}/manifests/prepared_bundle.json`,
      files,
    },
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  return { asset, index, manifestPath, preparedRoot, request, rootPath };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function aliasMutationResponse(overrides = {}) {
  return {
    uid: "alias_created",
    alias: new URL(STABLE_ORIGIN).hostname,
    created: "2026-08-26T14:00:00.000Z",
    ...overrides,
  };
}

function publicationJsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "cache-control": PUBLICATION_CACHE_CONTROL,
      "content-type": "application/json",
    },
  });
}

function publicationManifestBytes(body) {
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function exactPublicationManifestResponse(body) {
  return publicationBytesResponse(publicationManifestBytes(body));
}

function publicationBytesResponse(body) {
  return new Response(body, { headers: { "cache-control": PUBLICATION_CACHE_CONTROL } });
}

function vercelConfigurationBytes() {
  return Buffer.from(`${JSON.stringify({
    redirects: [{
      source: `/announcements/${JOB_ID}`,
      destination: `/announcements/${JOB_ID}/fr/`,
      permanent: false,
    }],
    headers: [{
      source: `/announcements/${JOB_ID}/(.*)`,
      headers: [{ key: "cache-control", value: PUBLICATION_CACHE_CONTROL }],
    }],
  }, null, 2)}\n`, "utf8");
}

function createProvider({ calls, fixtureValue, fetchImpl }) {
  return createVercelTestAPublicationProvider({
    token: "vercel_test_token",
    teamId: "team_test_a",
    projectId: "prj_test_a_announcements",
    projectName: "bebebonjour-test-a-announcements",
    stableOrigin: STABLE_ORIGIN,
    canaryJobId: JOB_ID,
    canaryRevisionId: REVISION_ID,
    artifactResolver: createLocalArtifactResolver({ rootPath: fixtureValue.rootPath }),
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return fetchImpl(String(url), init);
    },
    pollIntervalMs: 0,
    maxPollAttempts: 3,
  });
}

function publicManifestFor(value) {
  const configurationBytes = vercelConfigurationBytes();
  return {
    schemaVersion: "1.0",
    jobId: JOB_ID,
    revisionId: REVISION_ID,
    artifactSetId: value.request.artifactSetId,
    artifactManifestDigest: value.request.artifactManifestDigest,
    idempotencyKey: IDEMPOTENCY_KEY,
    vercelConfiguration: {
      sha256: sha256(configurationBytes),
      bytes: configurationBytes.byteLength,
    },
    files: value.request.artifactSet.files.map((file) => ({
      path: file.path.slice("deploy/canary/".length),
      sha256: file.sha256,
      bytes: file.bytes,
    })),
  };
}

function publicationReadbackResponse(url, value, manifest, origin, index = value.index) {
  if (url === `${origin}/announcements/${JOB_ID}/.publication.json`) {
    return exactPublicationManifestResponse(manifest);
  }
  if (url === `${origin}/announcements/${JOB_ID}`) {
    return new Response(null, {
      status: 307,
      headers: { location: `/announcements/${JOB_ID}/fr/` },
    });
  }
  if (
    url === `${origin}/announcements/${JOB_ID}/fr/`
    || url === `${origin}/announcements/${JOB_ID}/fr/index.html`
  ) return publicationBytesResponse(index);
  if (url === `${origin}/announcements/${JOB_ID}/_assets/build/canary.bin`) {
    return publicationBytesResponse(value.asset);
  }
  return null;
}

function deploymentFileTreeFor(value, manifest, options = {}) {
  const file = (name, bytes) => ({
    name,
    type: "file",
    mode: 33188,
    uid: sha1(bytes),
  });
  const configurationBytes = options.configurationBytes || vercelConfigurationBytes();
  const files = [
    {
      name: "announcements",
      type: "directory",
      mode: 16877,
      children: [{
        name: JOB_ID,
        type: "directory",
        mode: 16877,
        children: [
          {
            name: "fr",
            type: "directory",
            mode: 16877,
            children: [file("index.html", value.index)],
          },
          {
            name: "_assets",
            type: "directory",
            mode: 16877,
            children: [{
              name: "build",
              type: "directory",
              mode: 16877,
              children: [file("canary.bin", value.asset)],
            }],
          },
          file(".publication.json", publicationManifestBytes(manifest)),
        ],
      }],
    },
    file("vercel.json", configurationBytes),
    ...(options.extraFiles || []),
    ...(options.duplicateDirectory
      ? [
          { name: "duplicate", type: "directory", mode: 16877, children: [] },
          { name: "duplicate", type: "directory", mode: 16877, children: [] },
        ]
      : []),
  ].filter((entry) => !(options.omitConfiguration && entry.name === "vercel.json"));
  return { configurationBytes, files };
}

function deploymentEvidenceResponse(url, value, manifest, deployment, options = {}) {
  const parsed = new URL(url);
  const deploymentId = deployment.id || deployment.uid;
  const request = options.request || value.request;
  if (parsed.pathname === `/v13/deployments/${deploymentId}`) {
    return jsonResponse({
      id: deploymentId,
      url: options.omitDeploymentUrl ? undefined : new URL(deployment.origin).hostname,
      projectId: "prj_test_a_announcements",
      readyState: options.deploymentReadyState ?? "READY",
      meta: {
        bbCanaryJobId: request.jobId,
        bbRevisionId: request.revisionId,
        bbArtifactSetId: request.artifactSetId,
        bbArtifactManifestDigest: request.artifactManifestDigest,
        bbIdempotencyKey: request.idempotencyKey,
      },
    });
  }
  const tree = deploymentFileTreeFor(value, manifest, options);
  if (parsed.pathname === `/v6/deployments/${deploymentId}/files`) {
    return jsonResponse(options.inventoryEvidence ?? tree.files);
  }
  const configurationUid = sha1(tree.configurationBytes);
  if (parsed.pathname === `/v8/deployments/${deploymentId}/files/${configurationUid}`) {
    if (options.configurationStatus) return jsonResponse({}, options.configurationStatus);
    return jsonResponse({
      content: options.configurationContent ?? tree.configurationBytes.toString("base64"),
      encoding: options.configurationEncoding ?? "base64",
    });
  }
  return null;
}

function aliasEvidenceResponse(url, deploymentId, overrides = {}) {
  const parsed = new URL(url);
  if (parsed.pathname !== `/v4/aliases/${new URL(STABLE_ORIGIN).hostname}`) return null;
  assert.equal(parsed.searchParams.get("projectId"), "prj_test_a_announcements");
  assert.equal(parsed.searchParams.get("teamId"), "team_test_a");
  return jsonResponse({
    alias: new URL(STABLE_ORIGIN).hostname,
    deploymentId,
    projectId: "prj_test_a_announcements",
    ...overrides,
  });
}

test("Vercel TEST-A provider resolves exact source bytes before one scoped alias mutation", async (t) => {
  const value = await fixture(t);
  const calls = [];
  let publicationManifest;
  const uploadedBodies = [];
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url, init) {
      if (url.includes("/v7/deployments")) return jsonResponse({ deployments: [], pagination: { next: null } });
      if (url.includes("/v2/files")) {
        uploadedBodies.push(Buffer.from(await new Response(init.body).arrayBuffer()));
        return jsonResponse({});
      }
      if (url.includes("/v13/deployments") && init.method === "POST") {
        const payload = JSON.parse(init.body);
        publicationManifest = JSON.parse(
          uploadedBodies.find((body) => body.includes(Buffer.from("artifactManifestDigest"))).toString("utf8"),
        );
        const uploadedConfiguration = uploadedBodies.find((body) => body.includes(Buffer.from("redirects")));
        assert.deepEqual(publicationManifest.vercelConfiguration, {
          sha256: sha256(uploadedConfiguration),
          bytes: uploadedConfiguration.byteLength,
        });
        assert.deepEqual(uploadedConfiguration, vercelConfigurationBytes());
        assert.equal(payload.project, "prj_test_a_announcements");
        assert.equal(payload.target, undefined);
        assert.equal(payload.meta.bbArtifactSetId, value.request.artifactSetId);
        assert.equal(payload.meta.bbArtifactManifestDigest, value.request.artifactManifestDigest);
        assert.ok(payload.files.every(({ file }) => file.startsWith(`announcements/${JOB_ID}/`) || file === "vercel.json"));
        return jsonResponse({
          id: "dpl_test_a_001",
          url: new URL(CREATED_DEPLOYMENT_ORIGIN).hostname,
          readyState: "QUEUED",
        });
      }
      const evidenceResponse = publicationManifest && deploymentEvidenceResponse(
        url,
        value,
        publicationManifest,
        { id: "dpl_test_a_001", origin: CREATED_DEPLOYMENT_ORIGIN },
      );
      if (evidenceResponse) return evidenceResponse;
      const immutableResponse = publicationReadbackResponse(
        url,
        value,
        publicationManifest,
        CREATED_DEPLOYMENT_ORIGIN,
      );
      if (immutableResponse) return immutableResponse;
      if (url.includes("/v2/deployments/dpl_test_a_001/aliases")) {
        assert.deepEqual(JSON.parse(init.body), { alias: "test-a-announcements.example.test" });
        return jsonResponse(aliasMutationResponse());
      }
      const aliasEvidence = aliasEvidenceResponse(url, "dpl_test_a_001");
      if (aliasEvidence) return aliasEvidence;
      if (url === `${STABLE_ORIGIN}/announcements/${JOB_ID}/.publication.json`) {
        return exactPublicationManifestResponse(publicationManifest);
      }
      if (url === `${STABLE_ORIGIN}/announcements/${JOB_ID}`) {
        return new Response(null, {
          status: 307,
          headers: { location: `/announcements/${JOB_ID}/fr/` },
        });
      }
      if (url === `${STABLE_ORIGIN}/announcements/${JOB_ID}/fr/`) return new Response(value.index);
      if (url === `${STABLE_ORIGIN}/announcements/${JOB_ID}/fr/index.html`) return new Response(value.index);
      if (url === `${STABLE_ORIGIN}/announcements/${JOB_ID}/_assets/build/canary.bin`) return new Response(value.asset);
      throw new Error(`Unexpected fetch: ${init.method || "GET"} ${url}`);
    },
  });

  const receipt = await provider.publish(value.request);

  assert.deepEqual(receipt, {
    provider: "vercel",
    providerReceiptId: "dpl_test_a_001",
    stableUrl: `${STABLE_ORIGIN}/announcements/${JOB_ID}`,
    revisionId: REVISION_ID,
    artifactSetId: value.request.artifactSetId,
    artifactManifestDigest: value.request.artifactManifestDigest,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.ok(uploadedBodies.some((body) => body.equals(value.index)));
  assert.ok(uploadedBodies.some((body) => body.equals(value.asset)));
  const configurationUpload = uploadedBodies.find((body) => body.includes(Buffer.from('"redirects"')));
  assert.deepEqual(JSON.parse(configurationUpload), {
    redirects: [{
      source: `/announcements/${JOB_ID}`,
      destination: `/announcements/${JOB_ID}/fr/`,
      permanent: false,
    }],
    headers: [{
      source: `/announcements/${JOB_ID}/(.*)`,
      headers: [{ key: "cache-control", value: "private, no-store, max-age=0" }],
    }],
  });
  const detailIndex = calls.findIndex(({ url, init }) => (
    url.includes("/v13/deployments/dpl_test_a_001") && init.method === "GET"
  ));
  const inventoryIndex = calls.findIndex(({ url }) => url.includes("/v6/deployments/dpl_test_a_001/files"));
  const configurationIndex = calls.findIndex(({ url }) => url.includes("/v8/deployments/dpl_test_a_001/files/"));
  const immutableReadIndex = calls.findIndex(({ url }) => (
    url === `${CREATED_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/.publication.json`
  ));
  const aliasMutationIndex = calls.findIndex(({ url }) => url.includes("/v2/deployments/dpl_test_a_001/aliases"));
  const aliasEvidenceIndex = calls.findIndex(({ url }) => url.includes("/v4/aliases/"));
  const stableReadIndex = calls.findIndex(({ url }) => url.startsWith(STABLE_ORIGIN));
  assert.ok(detailIndex >= 0 && detailIndex < inventoryIndex);
  assert.ok(inventoryIndex < configurationIndex);
  assert.ok(configurationIndex < immutableReadIndex);
  assert.ok(immutableReadIndex < aliasMutationIndex);
  assert.ok(aliasMutationIndex < aliasEvidenceIndex);
  assert.ok(aliasEvidenceIndex < stableReadIndex);
  assert.equal(calls.filter(({ url }) => url.includes("/v2/deployments/dpl_test_a_001/aliases")).length, 1);
});

test("Vercel TEST-A provider reconciles a fully aliased deployment without provider mutation", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const publicManifest = publicManifestFor(value);
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url, init) {
      if (url.includes("/v7/deployments")) {
        return jsonResponse({ deployments: [{
          uid: "dpl_test_a_existing",
          url: new URL(EXISTING_DEPLOYMENT_ORIGIN).hostname,
          projectId: "prj_test_a_announcements",
          readyState: "READY",
          meta: {
            bbCanaryJobId: JOB_ID,
            bbRevisionId: REVISION_ID,
            bbArtifactSetId: value.request.artifactSetId,
            bbArtifactManifestDigest: value.request.artifactManifestDigest,
            bbIdempotencyKey: IDEMPOTENCY_KEY,
          },
        }], pagination: { next: null } });
      }
      const evidenceResponse = deploymentEvidenceResponse(url, value, publicManifest, {
        uid: "dpl_test_a_existing",
        origin: EXISTING_DEPLOYMENT_ORIGIN,
      });
      if (evidenceResponse) return evidenceResponse;
      if (url.includes("/v2/deployments/dpl_test_a_existing/aliases")) {
        return jsonResponse(aliasMutationResponse({ uid: "alias_existing" }));
      }
      const aliasEvidence = aliasEvidenceResponse(url, "dpl_test_a_existing");
      if (aliasEvidence) return aliasEvidence;
      if (url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/.publication.json`) {
        return exactPublicationManifestResponse(publicManifest);
      }
      if (url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}`) {
        return new Response(null, {
          status: 307,
          headers: { location: `/announcements/${JOB_ID}/fr/` },
        });
      }
      if (
        url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/fr/`
        || url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/fr/index.html`
      ) return publicationBytesResponse(value.index);
      if (url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/_assets/build/canary.bin`) {
        return publicationBytesResponse(value.asset);
      }
      if (url.endsWith("/.publication.json")) return exactPublicationManifestResponse(publicManifest);
      if (url.endsWith(`/announcements/${JOB_ID}`)) {
        return new Response(null, {
          status: 307,
          headers: { location: `/announcements/${JOB_ID}/fr/` },
        });
      }
      if (url.endsWith(`/announcements/${JOB_ID}/fr/`) || url.endsWith("/fr/index.html")) return new Response(value.index);
      if (url.endsWith("/_assets/build/canary.bin")) return new Response(value.asset);
      throw new Error(`Unexpected fetch: ${init.method || "GET"} ${url}`);
    },
  });

  const receipt = await provider.reconcile(value.request);

  assert.equal(receipt.providerReceiptId, "dpl_test_a_existing");
  assert.equal(calls.filter(({ url, init }) => url.includes("/v13/deployments") && init.method === "POST").length, 0);
  assert.equal(calls.filter(({ url }) => url.includes("/v2/files")).length, 0);
  const immutableReadIndexes = calls
    .map(({ url }, index) => (url.startsWith(EXISTING_DEPLOYMENT_ORIGIN) ? index : -1))
    .filter((index) => index >= 0);
  const aliasMutationIndex = calls.findIndex(({ url }) => url.includes("/v2/deployments/dpl_test_a_existing/aliases"));
  const aliasEvidenceIndex = calls.findIndex(({ url }) => url.includes("/v4/aliases/"));
  const stableReadIndex = calls.findIndex(({ url }) => url.startsWith(STABLE_ORIGIN));
  assert.ok(immutableReadIndexes.length >= 5, "the selected deployment manifest, redirect, and files must be read back");
  assert.equal(aliasMutationIndex, -1, "reconciliation must not assign the alias");
  assert.ok(immutableReadIndexes.every((index) => index < aliasEvidenceIndex), "all immutable deployment verification must precede alias evidence");
  assert.ok(stableReadIndex > aliasEvidenceIndex, "stable publication verification must follow provider alias evidence");
});

test("Vercel TEST-A provider rejects undocumented or unbound alias responses before read-back", async (t) => {
  const exactAlias = aliasMutationResponse({ uid: "alias_existing" });
  const cases = [
    { name: "undocumented 201", response: () => jsonResponse(exactAlias, 201), error: /HTTP 201/ },
    {
      name: "409 alias conflict",
      response: () => jsonResponse(exactAlias, 409),
      error: /HTTP 409/,
    },
    { name: "missing body", response: () => new Response(null, { status: 200 }), error: /malformed response/ },
    { name: "malformed body", response: () => new Response("{", { status: 200 }), error: /malformed response/ },
    { name: "missing uid", response: () => jsonResponse({ ...exactAlias, uid: undefined }), error: /does not match/ },
    { name: "missing alias", response: () => jsonResponse({ ...exactAlias, alias: undefined }), error: /does not match/ },
    { name: "missing created", response: () => jsonResponse({ ...exactAlias, created: undefined }), error: /does not match/ },
    { name: "mismatched alias", response: () => jsonResponse({ ...exactAlias, alias: "other.example.test" }), error: /does not match/ },
    { name: "mismatched deployment", response: () => jsonResponse({ ...exactAlias, deploymentId: "dpl_other" }), error: /does not match/ },
    { name: "mismatched project", response: () => jsonResponse({ ...exactAlias, projectId: "prj_other" }), error: /does not match/ },
    { name: "invalid uid", response: () => jsonResponse({ ...exactAlias, uid: [exactAlias.uid, "alias_other"] }), error: /does not match/ },
    { name: "invalid created", response: () => jsonResponse({ ...exactAlias, created: "not-a-date" }), error: /does not match/ },
    { name: "invalid calendar date", response: () => jsonResponse({ ...exactAlias, created: "2026-02-30T14:00:00.000Z" }), error: /does not match/ },
    { name: "invalid old deployment", response: () => jsonResponse({ ...exactAlias, oldDeploymentId: ["dpl_old"] }), error: /does not match/ },
    { name: "ambiguous response", response: () => jsonResponse([exactAlias, exactAlias]), error: /does not match/ },
  ];

  for (const aliasCase of cases) {
    await t.test(aliasCase.name, async (subtest) => {
      const value = await fixture(subtest);
      const calls = [];
      const publicManifest = publicManifestFor(value);
      const deployment = {
        uid: "dpl_test_a_existing",
        origin: EXISTING_DEPLOYMENT_ORIGIN,
      };
      const provider = createProvider({
        calls,
        fixtureValue: value,
        async fetchImpl(url, init) {
          if (url.includes("/v7/deployments")) {
            return jsonResponse({
              deployments: [{
                uid: deployment.uid,
                url: new URL(deployment.origin).hostname,
                projectId: "prj_test_a_announcements",
                readyState: "READY",
                meta: {
                  bbCanaryJobId: JOB_ID,
                  bbRevisionId: REVISION_ID,
                  bbArtifactSetId: value.request.artifactSetId,
                  bbArtifactManifestDigest: value.request.artifactManifestDigest,
                  bbIdempotencyKey: IDEMPOTENCY_KEY,
                },
              }],
              pagination: { next: null },
            });
          }
          const providerEvidence = deploymentEvidenceResponse(
            url,
            value,
            publicManifest,
            deployment,
          );
          if (providerEvidence) return providerEvidence;
          const immutableResponse = publicationReadbackResponse(
            url,
            value,
            publicManifest,
            deployment.origin,
          );
          if (immutableResponse) return immutableResponse;
          if (url.includes(`/v2/deployments/${deployment.uid}/aliases`)) {
            return aliasCase.response();
          }
          throw new Error(`Unexpected fetch after alias assignment: ${init.method || "GET"} ${url}`);
        },
      });

      await assert.rejects(provider.publish(value.request), (error) => {
        assert.match(error.message, aliasCase.error);
        assert.equal(error.retryable, false);
        return true;
      });
      assert.equal(calls.some(({ url }) => url.includes("/v4/aliases/")), false);
      assert.equal(calls.some(({ url }) => url.startsWith(STABLE_ORIGIN)), false);
    });
  }
});

test("Vercel TEST-A provider alias evidence fails closed when malformed, mismatched, or unavailable", async (t) => {
  const cases = [
    { name: "mismatched hostname", overrides: { alias: "other.example.test" } },
    { name: "mismatched deployment", overrides: { deploymentId: "dpl_other" } },
    { name: "mismatched project", overrides: { projectId: "prj_other" } },
    {
      name: "incomplete response",
      overrides: { alias: undefined, deploymentId: undefined, projectId: undefined },
    },
    {
      name: "malformed JSON response",
      response: () => new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    },
    {
      name: "unavailable response",
      response: () => jsonResponse({ error: "unavailable" }, 503),
      retryable: true,
    },
  ];

  for (const aliasCase of cases) {
    await t.test(aliasCase.name, async (subtest) => {
      const value = await fixture(subtest);
      const calls = [];
      const publicManifest = publicManifestFor(value);
      const deployment = {
        uid: "dpl_test_a_existing",
        origin: EXISTING_DEPLOYMENT_ORIGIN,
      };
      const provider = createProvider({
        calls,
        fixtureValue: value,
        async fetchImpl(url, init) {
          if (url.includes("/v7/deployments")) {
            return jsonResponse({
              deployments: [{
                uid: deployment.uid,
                url: new URL(deployment.origin).hostname,
                projectId: "prj_test_a_announcements",
                readyState: "READY",
                meta: {
                  bbCanaryJobId: JOB_ID,
                  bbRevisionId: REVISION_ID,
                  bbArtifactSetId: value.request.artifactSetId,
                  bbArtifactManifestDigest: value.request.artifactManifestDigest,
                  bbIdempotencyKey: IDEMPOTENCY_KEY,
                },
              }],
              pagination: { next: null },
            });
          }
          const providerEvidence = deploymentEvidenceResponse(
            url,
            value,
            publicManifest,
            deployment,
          );
          if (providerEvidence) return providerEvidence;
          const immutableResponse = publicationReadbackResponse(
            url,
            value,
            publicManifest,
            deployment.origin,
          );
          if (immutableResponse) return immutableResponse;
          if (url.includes(`/v2/deployments/${deployment.uid}/aliases`)) {
            return jsonResponse(aliasMutationResponse({ uid: "alias_existing" }));
          }
          if (new URL(url).pathname.startsWith("/v4/aliases/") && aliasCase.response) {
            return aliasCase.response();
          }
          const aliasEvidence = aliasEvidenceResponse(url, deployment.uid, aliasCase.overrides);
          if (aliasEvidence) return aliasEvidence;
          const stableResponse = publicationReadbackResponse(
            url,
            value,
            publicManifest,
            STABLE_ORIGIN,
          );
          if (stableResponse) return stableResponse;
          throw new Error(`Unexpected fetch: ${init.method || "GET"} ${url}`);
        },
      });

      await assert.rejects(provider.reconcile(value.request), (error) => {
        assert.match(error.message, /provider alias evidence/i);
        assert.equal(error.retryable, aliasCase.retryable ?? false);
        return true;
      });
      assert.equal(calls.filter(({ url }) => url.includes("/v4/aliases/")).length, 1);
      assert.equal(calls.some(({ url }) => url.startsWith(STABLE_ORIGIN)), false);
    });
  }
});

test("Vercel TEST-A reconciliation rejects mismatched immutable deployment bytes before alias mutation", async (t) => {
  const value = await fixture(t);
  const calls = [];
  let indexReadCount = 0;
  const publicManifest = publicManifestFor(value);
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url) {
      if (url.includes("/v7/deployments")) {
        return jsonResponse({ deployments: [{
          uid: "dpl_test_a_existing",
          url: new URL(EXISTING_DEPLOYMENT_ORIGIN).hostname,
          projectId: "prj_test_a_announcements",
          readyState: "READY",
          meta: {
            bbCanaryJobId: JOB_ID,
            bbRevisionId: REVISION_ID,
            bbArtifactSetId: value.request.artifactSetId,
            bbArtifactManifestDigest: value.request.artifactManifestDigest,
            bbIdempotencyKey: IDEMPOTENCY_KEY,
          },
        }], pagination: { next: null } });
      }
      const evidenceResponse = deploymentEvidenceResponse(url, value, publicManifest, {
        uid: "dpl_test_a_existing",
        origin: EXISTING_DEPLOYMENT_ORIGIN,
      });
      if (evidenceResponse) return evidenceResponse;
      if (url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/.publication.json`) {
        return exactPublicationManifestResponse(publicManifest);
      }
      if (url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}`) {
        return new Response(null, {
          status: 307,
          headers: { location: `/announcements/${JOB_ID}/fr/` },
        });
      }
      if (
        url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/fr/`
        || url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/fr/index.html`
      ) {
        indexReadCount += 1;
        return publicationBytesResponse(indexReadCount === 1 ? "wrong deployment bytes" : value.index);
      }
      if (url === `${EXISTING_DEPLOYMENT_ORIGIN}/announcements/${JOB_ID}/_assets/build/canary.bin`) {
        return publicationBytesResponse(value.asset);
      }
      if (url.includes("/aliases")) return jsonResponse({ uid: "alias_must_not_happen" });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(provider.reconcile(value.request), /deployment.*verified|deployment bytes/i);
  assert.equal(calls.filter(({ url }) => url.includes("/aliases")).length, 0);
  assert.equal(indexReadCount, 1, "an immutable byte mismatch must not be retried into success");
});

test("Vercel TEST-A reconciliation rejects a semantically equal manifest with different raw bytes", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const publicManifest = publicManifestFor(value);
  const deployment = {
    uid: "dpl_test_a_existing",
    origin: EXISTING_DEPLOYMENT_ORIGIN,
    projectId: "prj_test_a_announcements",
    readyState: "READY",
    meta: {
      bbCanaryJobId: JOB_ID,
      bbRevisionId: REVISION_ID,
      bbArtifactSetId: value.request.artifactSetId,
      bbArtifactManifestDigest: value.request.artifactManifestDigest,
      bbIdempotencyKey: IDEMPOTENCY_KEY,
    },
  };
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url) {
      if (url.includes("/v7/deployments")) {
        return jsonResponse({
          deployments: [{ ...deployment, url: new URL(deployment.origin).hostname }],
          pagination: { next: null },
        });
      }
      const evidenceResponse = deploymentEvidenceResponse(url, value, publicManifest, deployment);
      if (evidenceResponse) return evidenceResponse;
      if (url === `${deployment.origin}/announcements/${JOB_ID}/.publication.json`) {
        return publicationJsonResponse(publicManifest);
      }
      const immutableResponse = publicationReadbackResponse(
        url,
        value,
        publicManifest,
        deployment.origin,
      );
      if (immutableResponse) return immutableResponse;
      if (url.includes("/aliases")) throw new Error("raw publication manifest mismatch reached alias mutation");
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(provider.reconcile(value.request), /raw publication manifest bytes/i);
  assert.equal(calls.filter(({ url }) => url.includes("/aliases")).length, 0);
});

test("Vercel TEST-A reconciliation rejects mismatched provider configuration evidence", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const publicManifest = publicManifestFor(value);
  const deployment = {
    uid: "dpl_test_a_existing",
    origin: EXISTING_DEPLOYMENT_ORIGIN,
    projectId: "prj_test_a_announcements",
    readyState: "READY",
    meta: {
      bbCanaryJobId: JOB_ID,
      bbRevisionId: REVISION_ID,
      bbArtifactSetId: value.request.artifactSetId,
      bbArtifactManifestDigest: value.request.artifactManifestDigest,
      bbIdempotencyKey: IDEMPOTENCY_KEY,
    },
  };
  const mismatchedConfiguration = Buffer.from("{\"redirects\":[]}\n", "utf8");
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url) {
      if (url.includes("/v7/deployments")) {
        return jsonResponse({
          deployments: [{ ...deployment, url: new URL(deployment.origin).hostname }],
          pagination: { next: null },
        });
      }
      const evidenceResponse = deploymentEvidenceResponse(
        url,
        value,
        publicManifest,
        deployment,
        { configurationBytes: mismatchedConfiguration },
      );
      if (evidenceResponse) return evidenceResponse;
      const immutableResponse = publicationReadbackResponse(url, value, publicManifest, deployment.origin);
      if (immutableResponse) return immutableResponse;
      if (url.includes("/aliases")) throw new Error("configuration evidence mismatch reached alias mutation");
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(provider.reconcile(value.request), /provider configuration evidence/i);
  assert.equal(calls.filter(({ url }) => url.includes("/aliases")).length, 0);
});

test("Vercel TEST-A reconciliation rejects an unexpected provider inventory file", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const publicManifest = publicManifestFor(value);
  const deployment = {
    uid: "dpl_test_a_existing",
    origin: EXISTING_DEPLOYMENT_ORIGIN,
    projectId: "prj_test_a_announcements",
    readyState: "READY",
    meta: {
      bbCanaryJobId: JOB_ID,
      bbRevisionId: REVISION_ID,
      bbArtifactSetId: value.request.artifactSetId,
      bbArtifactManifestDigest: value.request.artifactManifestDigest,
      bbIdempotencyKey: IDEMPOTENCY_KEY,
    },
  };
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url) {
      if (url.includes("/v7/deployments")) {
        return jsonResponse({
          deployments: [{ ...deployment, url: new URL(deployment.origin).hostname }],
          pagination: { next: null },
        });
      }
      const evidenceResponse = deploymentEvidenceResponse(url, value, publicManifest, deployment, {
        extraFiles: [{ name: "unexpected.txt", type: "file", mode: 33188, uid: "unexpected-file-id" }],
      });
      if (evidenceResponse) return evidenceResponse;
      const immutableResponse = publicationReadbackResponse(url, value, publicManifest, deployment.origin);
      if (immutableResponse) return immutableResponse;
      if (url.includes("/aliases")) throw new Error("unexpected inventory file reached alias mutation");
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(provider.reconcile(value.request), /provider deployment inventory/i);
  assert.equal(calls.filter(({ url }) => url.includes("/aliases")).length, 0);
});

test("Vercel TEST-A provider evidence fails closed when missing, malformed, or unavailable", async (t) => {
  const cases = [
    {
      name: "incomplete deployment evidence",
      options: { omitDeploymentUrl: true },
      message: /provider deployment evidence is malformed/i,
      retryable: false,
    },
    {
      name: "deployment evidence is not READY",
      options: { deploymentReadyState: "ERROR" },
      message: /exact READY TEST-A deployment/i,
      retryable: false,
    },
    {
      name: "missing configuration inventory entry",
      options: { omitConfiguration: true },
      message: /provider deployment inventory/i,
      retryable: false,
    },
    {
      name: "malformed inventory",
      options: { inventoryEvidence: { files: [] } },
      message: /provider deployment inventory is malformed/i,
      retryable: false,
    },
    {
      name: "duplicate directory inventory paths",
      options: { duplicateDirectory: true },
      message: /provider deployment inventory is malformed/i,
      retryable: false,
    },
    {
      name: "malformed configuration contents",
      options: { configurationContent: "not-base64" },
      message: /provider configuration evidence is malformed/i,
      retryable: false,
    },
    {
      name: "unavailable configuration contents",
      options: { configurationStatus: 503 },
      message: /publication returned HTTP 503/i,
      retryable: true,
    },
  ];

  for (const evidenceCase of cases) {
    await t.test(evidenceCase.name, async (subtest) => {
      const value = await fixture(subtest);
      const calls = [];
      const publicManifest = publicManifestFor(value);
      const deployment = {
        uid: "dpl_test_a_existing",
        origin: EXISTING_DEPLOYMENT_ORIGIN,
        projectId: "prj_test_a_announcements",
        readyState: "READY",
        meta: {
          bbCanaryJobId: JOB_ID,
          bbRevisionId: REVISION_ID,
          bbArtifactSetId: value.request.artifactSetId,
          bbArtifactManifestDigest: value.request.artifactManifestDigest,
          bbIdempotencyKey: IDEMPOTENCY_KEY,
        },
      };
      const provider = createProvider({
        calls,
        fixtureValue: value,
        async fetchImpl(url) {
          if (url.includes("/v7/deployments")) {
            return jsonResponse({
              deployments: [{ ...deployment, url: new URL(deployment.origin).hostname }],
              pagination: { next: null },
            });
          }
          const evidenceResponse = deploymentEvidenceResponse(
            url,
            value,
            publicManifest,
            deployment,
            evidenceCase.options,
          );
          if (evidenceResponse) return evidenceResponse;
          if (url.includes("/aliases")) throw new Error("invalid provider evidence reached alias mutation");
          throw new Error(`Unexpected fetch: ${url}`);
        },
      });

      await assert.rejects(provider.reconcile(value.request), (error) => {
        assert.match(error.message, evidenceCase.message);
        assert.equal(error.retryable, evidenceCase.retryable);
        return true;
      });
      assert.equal(calls.filter(({ url }) => url.includes("/aliases")).length, 0);
    });
  }
});

test("Vercel TEST-A reconciliation rejects mismatched immutable deployment configuration before alias mutation", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const publicManifest = publicManifestFor(value);
  const mismatchedManifest = {
    ...publicManifest,
    vercelConfiguration: {
      ...publicManifest.vercelConfiguration,
      sha256: "0".repeat(64),
    },
  };
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url) {
      if (url.includes("/v7/deployments")) {
        return jsonResponse({ deployments: [{
          uid: "dpl_test_a_existing",
          url: new URL(EXISTING_DEPLOYMENT_ORIGIN).hostname,
          projectId: "prj_test_a_announcements",
          readyState: "READY",
          meta: {
            bbCanaryJobId: JOB_ID,
            bbRevisionId: REVISION_ID,
            bbArtifactSetId: value.request.artifactSetId,
            bbArtifactManifestDigest: value.request.artifactManifestDigest,
            bbIdempotencyKey: IDEMPOTENCY_KEY,
          },
        }], pagination: { next: null } });
      }
      const evidenceResponse = deploymentEvidenceResponse(url, value, publicManifest, {
        uid: "dpl_test_a_existing",
        origin: EXISTING_DEPLOYMENT_ORIGIN,
      });
      if (evidenceResponse) return evidenceResponse;
      const immutableResponse = publicationReadbackResponse(
        url,
        value,
        mismatchedManifest,
        EXISTING_DEPLOYMENT_ORIGIN,
      );
      if (immutableResponse) return immutableResponse;
      if (url.includes("/aliases")) return jsonResponse({ uid: "alias_must_not_happen" });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(provider.reconcile(value.request), /manifest bytes or Vercel configuration/i);
  assert.equal(calls.filter(({ url }) => url.includes("/aliases")).length, 0);
  assert.equal(calls.filter(({ url }) => url.endsWith("/.publication.json")).length, 1);
});

test("Vercel TEST-A provider rejects an absent or mismatched nested artifact-set id before provider I/O", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl() {
      throw new Error("provider I/O must not occur");
    },
  });
  const { artifactSetId: _, ...withoutArtifactSetId } = value.request.artifactSet;
  const invalidRequests = [
    { ...value.request, artifactSet: withoutArtifactSetId },
    {
      ...value.request,
      artifactSet: { ...value.request.artifactSet, artifactSetId: "artifact-set-test-002" },
    },
  ];

  for (const method of ["reconcile", "publish"]) {
    for (const invalidRequest of invalidRequests) {
      await assert.rejects(provider[method](invalidRequest), /artifact set id/i);
    }
  }
  assert.equal(calls.length, 0);
});

test("Vercel TEST-A reconciliation rejects duplicate exact matches across deployment pages", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const exactDeployment = (uid) => ({
    uid,
    projectId: "prj_test_a_announcements",
    readyState: "READY",
    meta: {
      bbCanaryJobId: JOB_ID,
      bbRevisionId: REVISION_ID,
      bbArtifactSetId: value.request.artifactSetId,
      bbArtifactManifestDigest: value.request.artifactManifestDigest,
      bbIdempotencyKey: IDEMPOTENCY_KEY,
    },
  });
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url) {
      const parsed = new URL(url);
      if (parsed.pathname === "/v7/deployments" && !parsed.searchParams.has("until")) {
        return jsonResponse({ deployments: [exactDeployment("dpl_match_newer")], pagination: { next: 200 } });
      }
      if (parsed.pathname === "/v7/deployments" && parsed.searchParams.get("until") === "200") {
        return jsonResponse({ deployments: [exactDeployment("dpl_match_older")], pagination: { next: null } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(provider.reconcile(value.request), /multiple deployments/i);
  assert.equal(calls.filter(({ url }) => url.includes("/v7/deployments")).length, 2);
  assert.equal(calls.some(({ url }) => url.includes("/aliases")), false);
});

test("Vercel TEST-A reconciliation selects one exact deployment found only on a later page", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const publicManifest = publicManifestFor(value);
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url, init) {
      const immutableResponse = publicationReadbackResponse(url, value, publicManifest, LATER_DEPLOYMENT_ORIGIN);
      if (immutableResponse) return immutableResponse;
      const parsed = new URL(url);
      if (parsed.pathname === "/v7/deployments" && !parsed.searchParams.has("until")) {
        return jsonResponse({ deployments: [], pagination: { next: 200 } });
      }
      if (parsed.pathname === "/v7/deployments" && parsed.searchParams.get("until") === "200") {
        return jsonResponse({ deployments: [{
          uid: "dpl_match_later",
          url: new URL(LATER_DEPLOYMENT_ORIGIN).hostname,
          projectId: "prj_test_a_announcements",
          readyState: "READY",
          meta: {
            bbCanaryJobId: JOB_ID,
            bbRevisionId: REVISION_ID,
            bbArtifactSetId: value.request.artifactSetId,
            bbArtifactManifestDigest: value.request.artifactManifestDigest,
            bbIdempotencyKey: IDEMPOTENCY_KEY,
          },
        }], pagination: { next: null } });
      }
      const evidenceResponse = deploymentEvidenceResponse(url, value, publicManifest, {
        uid: "dpl_match_later",
        origin: LATER_DEPLOYMENT_ORIGIN,
      });
      if (evidenceResponse) return evidenceResponse;
      if (url.includes("/v2/deployments/dpl_match_later/aliases")) {
        return jsonResponse(aliasMutationResponse());
      }
      const aliasEvidence = aliasEvidenceResponse(url, "dpl_match_later");
      if (aliasEvidence) return aliasEvidence;
      if (url.endsWith("/.publication.json")) return exactPublicationManifestResponse(publicManifest);
      if (url.endsWith(`/announcements/${JOB_ID}`)) {
        return new Response(null, {
          status: 307,
          headers: { location: `/announcements/${JOB_ID}/fr/` },
        });
      }
      if (url.endsWith(`/announcements/${JOB_ID}/fr/`) || url.endsWith("/fr/index.html")) return new Response(value.index);
      if (url.endsWith("/_assets/build/canary.bin")) return new Response(value.asset);
      throw new Error(`Unexpected fetch: ${init.method || "GET"} ${url}`);
    },
  });

  const receipt = await provider.reconcile(value.request);

  assert.equal(receipt.providerReceiptId, "dpl_match_later");
  assert.equal(calls.filter(({ url }) => url.includes("/v7/deployments")).length, 2);
  const aliasMutationIndex = calls.findIndex(({ url }) => (
    url.includes("/v2/deployments/dpl_match_later/aliases")
  ));
  const aliasEvidenceIndex = calls.findIndex(({ url }) => url.includes("/v4/aliases/"));
  assert.ok(aliasMutationIndex < aliasEvidenceIndex, "exact alias assignment must be read back from Vercel");
});

test("Vercel TEST-A reconciliation returns no match only after exhausting deployment pages", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl(url) {
      const parsed = new URL(url);
      if (parsed.pathname !== "/v7/deployments") throw new Error(`Unexpected fetch: ${url}`);
      return jsonResponse({
        deployments: [],
        pagination: { next: parsed.searchParams.has("until") ? null : 200 },
      });
    },
  });

  assert.equal(await provider.reconcile(value.request), null);
  assert.equal(calls.length, 2);
});

test("Vercel TEST-A reconciliation rejects repeated, cyclic, and non-monotonic cursors", async (t) => {
  const cases = [
    { name: "repeated", cursors: [200, 200] },
    { name: "cyclic", cursors: [200, 100, 200] },
    { name: "non-monotonic", cursors: [100, 200] },
  ];

  for (const cursorCase of cases) {
    await t.test(cursorCase.name, async () => {
      const value = await fixture(t);
      const calls = [];
      let page = 0;
      const provider = createProvider({
        calls,
        fixtureValue: value,
        async fetchImpl(url) {
          if (new URL(url).pathname !== "/v7/deployments") throw new Error(`Unexpected fetch: ${url}`);
          const next = cursorCase.cursors[page];
          page += 1;
          return jsonResponse({ deployments: [], pagination: { next } });
        },
      });

      await assert.rejects(provider.reconcile(value.request), /pagination cursor/i);
      assert.equal(calls.some(({ url }) => url.includes("/aliases")), false);
    });
  }
});

test("local artifact resolution fails closed on changed source bytes before provider I/O", async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.preparedRoot, "deploy", "canary", "fr", "index.html"), "tampered");
  const calls = [];
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl() {
      throw new Error("provider I/O must not occur");
    },
  });

  await assert.rejects(provider.publish(value.request), /source bytes do not match/i);
  assert.equal(calls.length, 0);
});

test("local artifact resolution rejects stale persisted manifest and non-canary requests before mutation", async (t) => {
  const value = await fixture(t);
  await writeFile(value.manifestPath, "{}\n");
  const calls = [];
  const provider = createProvider({
    calls,
    fixtureValue: value,
    async fetchImpl() {
      throw new Error("provider I/O must not occur");
    },
  });

  await assert.rejects(provider.publish(value.request), /persisted manifest digest/i);
  await assert.rejects(provider.publish({ ...value.request, revisionId: "r2" }), /configured TEST-A canary/i);
  assert.equal(calls.length, 0);
});

test("expired publication overlap creates one deployment and one stable alias through the real adapter", async (t) => {
  const value = await fixture(t);
  const sortedFiles = [...value.request.artifactSet.files].sort((left, right) => left.path.localeCompare(right.path));
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "1.0",
    kind: "prepared_bundle",
    revisionId: REVISION_ID,
    files: sortedFiles,
  }, null, 2)}\n`, "utf8");
  await writeFile(value.manifestPath, manifestBytes);
  value.request = {
    ...value.request,
    artifactManifestDigest: sha256(manifestBytes),
    artifactSet: {
      ...value.request.artifactSet,
      assetManifestDigest: sha256(manifestBytes),
      files: sortedFiles,
    },
  };
  const store = createLocalTestFulfillmentStore({ filePath: path.join(value.rootPath, "fulfillment.json") });
  const baseResolver = createLocalArtifactResolver({ rootPath: value.rootPath });
  const uploadedBodies = [];
  const deployments = [];
  let activeRequest;
  let publicationManifest;
  let aliasDeploymentId = null;
  let deploymentCreates = 0;
  let aliasMutations = 0;
  let releaseFirstDeployment;
  let signalFirstDeploymentStarted;
  const firstDeploymentRelease = new Promise((resolve) => { releaseFirstDeployment = resolve; });
  const firstDeploymentStarted = new Promise((resolve) => { signalFirstDeploymentStarted = resolve; });

  const provider = createVercelTestAPublicationProvider({
    token: "vercel_test_token",
    teamId: "team_test_a",
    projectId: "prj_test_a_announcements",
    projectName: "bebebonjour-test-a-announcements",
    stableOrigin: STABLE_ORIGIN,
    canaryJobId: JOB_ID,
    canaryRevisionId: REVISION_ID,
    artifactResolver: {
      async resolve(request) {
        activeRequest = structuredClone(request);
        return baseResolver.resolve(request);
      },
    },
    fetch: async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v7/deployments") {
        return jsonResponse({
          deployments: deployments.map((deployment) => ({
            uid: deployment.id,
            url: new URL(deployment.origin).hostname,
            projectId: "prj_test_a_announcements",
            readyState: "READY",
            meta: deployment.meta,
          })),
          pagination: { next: null },
        });
      }
      if (parsed.pathname === "/v2/files") {
        uploadedBodies.push(Buffer.from(await new Response(init.body).arrayBuffer()));
        return jsonResponse({});
      }
      if (parsed.pathname === "/v13/deployments" && init.method === "POST") {
        deploymentCreates += 1;
        const deploymentNumber = deploymentCreates;
        if (deploymentNumber === 1) {
          signalFirstDeploymentStarted();
          await firstDeploymentRelease;
        }
        publicationManifest = JSON.parse(
          uploadedBodies.find((body) => body.includes(Buffer.from("artifactManifestDigest"))).toString("utf8"),
        );
        const payload = JSON.parse(init.body);
        const deployment = {
          id: `dpl_overlap_${deploymentNumber}`,
          origin: `https://dpl-overlap-${deploymentNumber}.vercel.app`,
          meta: payload.meta,
        };
        deployments.push(deployment);
        return jsonResponse({
          id: deployment.id,
          url: new URL(deployment.origin).hostname,
          readyState: "READY",
        });
      }
      for (const deployment of deployments) {
        const evidence = deploymentEvidenceResponse(
          url,
          value,
          publicationManifest,
          deployment,
          { request: activeRequest },
        );
        if (evidence) return evidence;
        const immutable = publicationReadbackResponse(
          url,
          value,
          publicationManifest,
          deployment.origin,
        );
        if (immutable) return immutable;
        if (parsed.pathname === `/v2/deployments/${deployment.id}/aliases`) {
          aliasMutations += 1;
          aliasDeploymentId = deployment.id;
          return jsonResponse(aliasMutationResponse({
            uid: `alias_overlap_${aliasMutations}`,
            deploymentId: deployment.id,
            projectId: "prj_test_a_announcements",
          }));
        }
      }
      if (parsed.pathname === `/v4/aliases/${new URL(STABLE_ORIGIN).hostname}`) {
        if (!aliasDeploymentId) return jsonResponse({}, 404);
        return aliasEvidenceResponse(url, aliasDeploymentId);
      }
      if (url.startsWith(STABLE_ORIGIN) && aliasDeploymentId) {
        return publicationReadbackResponse(url, value, publicationManifest, STABLE_ORIGIN);
      }
      throw new Error(`Unexpected fetch: ${init.method || "GET"} ${url}`);
    },
    pollIntervalMs: 0,
    maxPollAttempts: 3,
  });
  const externalHandlers = createExternalEffectStageHandlers({
    publicationAdapter: provider,
    deliveryAdapter: {
      async reconcile() { return null; },
      async send() { throw new Error("delivery is outside this publication regression"); },
      async status() { throw new Error("delivery is outside this publication regression"); },
    },
    resolveDeliveryTarget: async () => ({ targetRef: "unused" }),
  });
  let now = "2026-08-26T12:00:00.000Z";
  let tokenNumber = 0;
  const options = {
    store,
    handlers: {
      async prepare_review() {
        return {
          revision: { revisionId: REVISION_ID, ordinal: 1, inputDigest: "a".repeat(64) },
          artifactSet: {
            kind: "private_review",
            revisionId: REVISION_ID,
            pageDigest: value.request.artifactSet.pageDigest,
            transcriptDigest: value.request.artifactSet.transcriptDigest,
            assetManifestDigest: value.request.artifactSet.assetManifestDigest,
          },
        };
      },
      async render_approved() { return { artifactSet: value.request.artifactSet }; },
      async verify_review_decision({ decision }) { return decision; },
      ...externalHandlers,
    },
    clock: () => now,
    tokenFactory: () => `overlap-lease-${tokenNumber += 1}`,
    retryPolicy: {
      leaseMsByStage: Object.fromEntries([
        "prepare_review", "generate_tts", "render_approved", "publish", "deliver",
      ].map((stage) => [stage, 1_000])),
      maxAttemptsByStage: Object.fromEntries([
        "prepare_review", "generate_tts", "render_approved", "publish", "deliver",
      ].map((stage) => [stage, stage === "publish" ? 3 : 2])),
      backoffMsByStage: Object.fromEntries([
        "prepare_review", "generate_tts", "render_approved", "publish", "deliver",
      ].map((stage) => [stage, [1_000, 1_000]])),
    },
  };
  const firstWorker = createFulfillmentOrchestrator(options);
  const recoveryWorker = createFulfillmentOrchestrator(options);
  const job = {
    jobId: JOB_ID,
    environment: "test",
    product: "announcement-page",
    intakeDigest: "a".repeat(64),
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId: JOB_ID,
      intakeDigest: "a".repeat(64),
    },
    narrationRequired: false,
  };
  await firstWorker.createJob(job, { commandId: "create-overlap-job" });
  await firstWorker.recordPayment(JOB_ID, {
    commandId: "record-overlap-payment",
    providerEventId: "evt_overlap_payment",
    providerPaymentId: "pi_overlap_payment",
    correlation: job.paymentCorrelation,
    recordedAt: now,
  });
  await firstWorker.runNext(JOB_ID);
  await firstWorker.recordReviewDecision(JOB_ID, {
    commandId: "approve-overlap-content",
    decisionType: "content",
    revisionId: REVISION_ID,
    outcome: "approved",
    policyVersion: "bebebonjour-editorial-v1",
    rubricVersion: "bebebonjour-content-rubric-v1",
    reviewer: { id: "reviewer_overlap", role: "qualified-human-reviewer", competencies: ["editorial"] },
    decidedAt: now,
    artifactDigests: {
      pageDigest: value.request.artifactSet.pageDigest,
      transcriptDigest: value.request.artifactSet.transcriptDigest,
      assetManifestDigest: value.request.artifactSet.assetManifestDigest,
    },
    reasons: ["synthetic overlap regression"],
  });
  const ready = await firstWorker.runNext(JOB_ID);
  assert.equal(ready.state, "publish_ready", JSON.stringify(ready.stageAttempts.at(-1)?.failure));

  const firstRun = firstWorker.runNext(JOB_ID);
  await Promise.race([
    firstDeploymentStarted,
    firstRun.then((status) => {
      throw new Error(`publication returned before deployment creation: ${JSON.stringify(status)}`);
    }),
  ]);
  now = "2026-08-26T12:00:01.000Z";
  await recoveryWorker.runNext(JOB_ID);
  now = "2026-08-26T12:00:02.000Z";
  let recovered = await recoveryWorker.runNext(JOB_ID);
  releaseFirstDeployment();
  await firstRun.catch(() => undefined);
  if (recovered.state === "retry_wait") {
    now = "2026-08-26T12:00:03.000Z";
    recovered = await recoveryWorker.runNext(JOB_ID);
  }

  assert.equal(recovered.state, "published");
  assert.equal(deploymentCreates, 1);
  assert.equal(aliasMutations, 1);
});
