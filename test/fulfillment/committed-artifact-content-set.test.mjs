import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureCommittedArtifactContentSet } from "../../src/fulfillment/committed-artifact-content-set.mjs";
import { createHostedGenerationWorkspace } from "../../src/fulfillment/hosted-generation-workspace.mjs";
import { createLocalArtifactResolver } from "../../src/fulfillment/local-artifact-resolver.mjs";

const LIMITS = Object.freeze({
  maximumFileBytes: 1_024,
  maximumJsonBytes: 1_024,
  maximumTotalBytes: 4_096,
  maximumFiles: 8,
});

test("producer-owned content stays immutable after path and returned-buffer mutation", async (t) => {
  const fixture = await createFixture(t);
  const capability = await captureCommittedArtifactContentSet({
    ...fixture.captureOptions,
    authority: { type: "producer-owned" },
  });
  t.after(() => capability.dispose());

  assert.deepEqual(
    capability.manifest.files.map(({ path: logicalPath }) => logicalPath),
    ["bundle/page.json", "bundle/transcript.json"],
  );

  await writeFile(fixture.pagePath, '{"content":"attacker"}\n', { mode: 0o600 });
  const firstRead = capability.read("bundle/page.json");
  assert.equal(firstRead.toString("utf8"), '{"content":"trusted"}\n');
  firstRead.fill(0);
  assert.equal(
    capability.read("bundle/page.json").toString("utf8"),
    '{"content":"trusted"}\n',
  );
});

test("persisted manifest authenticates exact bytes and exact inventory before recapture", async (t) => {
  const fixture = await createFixture(t);
  const produced = await captureCommittedArtifactContentSet({
    ...fixture.captureOptions,
    authority: { type: "producer-owned" },
  });
  const expectedFiles = produced.manifest.files.map((file) => ({ ...file }));
  produced.dispose();

  const restarted = await captureCommittedArtifactContentSet({
    ...fixture.captureOptions,
    authority: { type: "persisted-manifest", files: expectedFiles },
  });
  assert.equal(restarted.read("bundle/transcript.json").toString("utf8"), '{"segments":[]}\n');
  restarted.dispose();

  await writeFile(fixture.pagePath, '{"content":"tampered"}\n', { mode: 0o600 });
  await assert.rejects(
    captureCommittedArtifactContentSet({
      ...fixture.captureOptions,
      authority: { type: "persisted-manifest", files: expectedFiles },
    }),
    /persisted manifest/u,
  );

  await writeFile(fixture.pagePath, '{"content":"trusted"}\n', { mode: 0o600 });
  await writeFile(path.join(fixture.inventoryRoot, "extra.txt"), "unexpected\n", { mode: 0o600 });
  await assert.rejects(
    captureCommittedArtifactContentSet({
      ...fixture.captureOptions,
      authority: { type: "persisted-manifest", files: expectedFiles },
    }),
    /persisted manifest/u,
  );
});

test("disposed capabilities release their owned bytes and reject later reads", async (t) => {
  const fixture = await createFixture(t);
  const capability = await captureCommittedArtifactContentSet({
    ...fixture.captureOptions,
    authority: { type: "producer-owned" },
  });
  capability.dispose();
  capability.dispose();
  assert.throws(() => capability.read("bundle/page.json"), /disposed/u);
});

test("hosted upload consumes captured producer bytes after staging paths mutate", async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-hosted-commitment-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const revisionRoot = path.join(rootPath, "jobs", "job_capture_001", "revisions", "r1");
  const reviewRoot = path.join(revisionRoot, "private-review");
  const currentRoot = path.join(reviewRoot, "artifacts", "current");
  await mkdir(currentRoot, { recursive: true, mode: 0o700 });
  const pagePath = path.join(currentRoot, "page.json");
  const transcriptPath = path.join(currentRoot, "transcript.json");
  await writeFile(pagePath, '{"page":"trusted"}\n', { mode: 0o600 });
  await writeFile(transcriptPath, '{"transcript":"trusted"}\n', { mode: 0o600 });
  await writeFile(path.join(reviewRoot, "review.json"), '{"review":"trusted"}\n', { mode: 0o600 });

  const uploaded = new Map();
  const artifactStore = {
    async readArtifactSet() {
      return null;
    },
    async uploadArtifactSet({ artifactSet, readArtifact }) {
      await writeFile(pagePath, '{"page":"mutated"}\n', { mode: 0o600 });
      for (const file of artifactSet.files) uploaded.set(file.path, await readArtifact(file));
      return artifactSet;
    },
    async downloadArtifact() {
      throw new Error("not used");
    },
  };
  const workspace = createHostedGenerationWorkspace({ rootPath, artifactStore });
  const artifactSet = await workspace.collectArtifactSet({
    kind: "private_review",
    context: { job: { jobId: "job_capture_001" } },
    paths: {
      reviewRoot,
      manifestRoot: path.join(revisionRoot, "manifests"),
      revision: { revisionId: "r1" },
    },
  });

  assert.equal(artifactSet.revisionId, "r1");
  assert.equal(uploaded.get("artifacts/current/page.json").toString("utf8"), '{"page":"trusted"}\n');
  const poisoned = uploaded.get("artifacts/current/page.json");
  poisoned.fill(0);
  assert.equal((await readFile(pagePath, "utf8")), '{"page":"mutated"}\n');
});

test("publication resolves manifest-authenticated binary artifacts larger than the JSON limit", async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-large-publication-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const revisionRoot = path.join(rootPath, "jobs", "job_large_001", "revisions", "r1");
  const preparedRoot = path.join(revisionRoot, "prepared");
  const assetPath = path.join(preparedRoot, "deploy", "canary", "_assets", "large.bin");
  const indexPath = path.join(preparedRoot, "deploy", "canary", "fr", "index.html");
  const manifestPath = path.join(revisionRoot, "manifests", "prepared_bundle.json");
  await Promise.all([
    mkdir(path.dirname(assetPath), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 }),
  ]);
  const largeAsset = Buffer.alloc((5 * 1024 * 1024) + 1, 0xa5);
  const index = Buffer.from("<!doctype html><title>large</title>", "utf8");
  const files = [
    manifestFile("deploy/canary/_assets/large.bin", largeAsset),
    manifestFile("deploy/canary/fr/index.html", index),
  ];
  const manifest = {
    schemaVersion: "1.0",
    kind: "prepared_bundle",
    revisionId: "r1",
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await Promise.all([
    writeFile(assetPath, largeAsset, { mode: 0o600 }),
    writeFile(indexPath, index, { mode: 0o600 }),
    writeFile(manifestPath, manifestBytes, { mode: 0o600 }),
  ]);

  const resolver = createLocalArtifactResolver({ rootPath });
  const resolved = await resolver.resolve({
    jobId: "job_large_001",
    revisionId: "r1",
    artifactManifestDigest: sha256(manifestBytes),
    artifactSet: {
      kind: "prepared_bundle",
      revisionId: "r1",
      manifestRef: "jobs/job_large_001/revisions/r1/manifests/prepared_bundle.json",
      files,
    },
  });
  assert.equal(resolved.files.find((file) => file.publicPath === "_assets/large.bin").bytes.byteLength, largeAsset.byteLength);
});

function manifestFile(logicalPath, bytes) {
  const digest = sha256(bytes);
  return {
    path: logicalPath,
    sha256: digest,
    bytes: bytes.byteLength,
    storageId: `local-test:sha256:${digest}`,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture(t) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-committed-content-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const inventoryRoot = path.join(rootPath, "artifacts");
  await mkdir(inventoryRoot, { recursive: true, mode: 0o700 });
  const pagePath = path.join(inventoryRoot, "page.json");
  const transcriptPath = path.join(inventoryRoot, "transcript.json");
  await writeFile(pagePath, '{"content":"trusted"}\n', { mode: 0o600 });
  await writeFile(transcriptPath, '{"segments":[]}\n', { mode: 0o600 });
  return {
    rootPath,
    inventoryRoot,
    pagePath,
    transcriptPath,
    captureOptions: {
      rootPath,
      inventoryRoot,
      manifestPrefix: "bundle",
      pagePath,
      pageManifestPath: null,
      transcriptPath,
      transcriptManifestPath: null,
      excludedPaths: [],
      requiredPaths: [pagePath, transcriptPath],
      ...LIMITS,
    },
  };
}
