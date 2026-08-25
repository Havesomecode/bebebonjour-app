import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalArtifactResolver } from "../../src/fulfillment/local-artifact-resolver.mjs";
import { createVercelTestAPublicationProvider } from "../../src/fulfillment/vercel-test-a-publication-provider.mjs";

const JOB_ID = "job_test_001";
const REVISION_ID = "r1";
const IDEMPOTENCY_KEY = `bb_${"e".repeat(64)}`;
const STABLE_ORIGIN = "https://test-a-announcements.example.test";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  return {
    schemaVersion: "1.0",
    jobId: JOB_ID,
    revisionId: REVISION_ID,
    artifactSetId: value.request.artifactSetId,
    artifactManifestDigest: value.request.artifactManifestDigest,
    idempotencyKey: IDEMPOTENCY_KEY,
    files: value.request.artifactSet.files.map((file) => ({
      path: file.path.slice("deploy/canary/".length),
      sha256: file.sha256,
      bytes: file.bytes,
    })),
  };
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
        assert.equal(payload.project, "prj_test_a_announcements");
        assert.equal(payload.target, undefined);
        assert.equal(payload.meta.bbArtifactSetId, value.request.artifactSetId);
        assert.equal(payload.meta.bbArtifactManifestDigest, value.request.artifactManifestDigest);
        assert.ok(payload.files.every(({ file }) => file.startsWith(`announcements/${JOB_ID}/`) || file === "vercel.json"));
        return jsonResponse({ id: "dpl_test_a_001", readyState: "QUEUED" });
      }
      if (url.includes("/v13/deployments/dpl_test_a_001")) {
        return jsonResponse({ id: "dpl_test_a_001", projectId: "prj_test_a_announcements", readyState: "READY" });
      }
      if (url.includes("/v2/deployments/dpl_test_a_001/aliases")) {
        assert.deepEqual(JSON.parse(init.body), { alias: "test-a-announcements.example.test" });
        return jsonResponse({ uid: "alias_test_a", alias: "test-a-announcements.example.test" });
      }
      if (url === `${STABLE_ORIGIN}/announcements/${JOB_ID}/.publication.json`) {
        return jsonResponse(publicationManifest);
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
  assert.equal(calls.filter(({ url }) => url.includes("/aliases")).length, 1);
});

test("Vercel TEST-A provider reconciles the exact deployment metadata without creating another deployment", async (t) => {
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
      if (url.includes("/aliases")) return jsonResponse({ uid: "alias_existing" }, 409);
      if (url.endsWith("/.publication.json")) return jsonResponse(publicManifest);
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
      const parsed = new URL(url);
      if (parsed.pathname === "/v7/deployments" && !parsed.searchParams.has("until")) {
        return jsonResponse({ deployments: [], pagination: { next: 200 } });
      }
      if (parsed.pathname === "/v7/deployments" && parsed.searchParams.get("until") === "200") {
        return jsonResponse({ deployments: [{
          uid: "dpl_match_later",
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
      if (url.includes("/aliases")) return jsonResponse({ uid: "alias_existing" }, 409);
      if (url.endsWith("/.publication.json")) return jsonResponse(publicManifest);
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
