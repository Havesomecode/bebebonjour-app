import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  collectArtifactSnapshotFromRoot,
  createSecureFilesystemSnapshot,
  readBoundedFileFromRoot,
} from "../../src/fulfillment/secure-filesystem-snapshot.mjs";

const ROOT_MODE = 0o700;

function unavailableHelperSpawn() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
  return child;
}

test("bounded reads stay available when the deployment runtime has no Python helper", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-node-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "generation-input.json");
  await writeFile(filePath, "trusted\n", { mode: 0o600 });
  const portableSnapshot = createSecureFilesystemSnapshot({ spawnImpl: unavailableHelperSpawn });
  const input = {
    rootPath: root,
    filePath,
    maximumBytes: 1024,
  };

  if (process.platform !== "linux") {
    await assert.rejects(portableSnapshot.readBoundedFileFromRoot(input), /Secure filesystem boundary rejected/u);
    return;
  }
  const snapshot = await portableSnapshot.readBoundedFileFromRoot(input);

  assert.equal(snapshot.bytes.toString("utf8"), "trusted\n");
  await chmod(filePath, 0o4400);
  await assert.rejects(
    portableSnapshot.readBoundedFileFromRoot({ ...input, privateDirectories: true, immutableFile: true }),
    /Secure filesystem boundary rejected/u,
  );
  await assert.rejects(
    portableSnapshot.readBoundedFileFromRoot({ ...input, maximumBytes: (64 * 1024 * 1024) + 1 }),
    /Secure filesystem boundary rejected/u,
  );
  await chmod(filePath, 0o600);
  await writeFile(filePath, Buffer.alloc(3_200_000), { mode: 0o600 });
  await assert.rejects(
    portableSnapshot.readBoundedFileFromRoot({ ...input, maximumBytes: 4 * 1024 * 1024 }),
    /Secure filesystem boundary rejected/u,
  );
});

test("artifact collection stays available when the deployment runtime has no Python helper", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-node-collection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = path.join(root, "artifacts", "current");
  await mkdir(inventory, { recursive: true, mode: ROOT_MODE });
  const pagePath = path.join(inventory, "page.json");
  const transcriptPath = path.join(inventory, "transcript.json");
  await writeFile(pagePath, "{}\n", { mode: 0o600 });
  await writeFile(transcriptPath, "[]\n", { mode: 0o600 });
  const portableSnapshot = createSecureFilesystemSnapshot({ spawnImpl: unavailableHelperSpawn });
  const input = {
    rootPath: root,
    inventoryRoot: inventory,
    inventoryPrefix: "",
    pagePath,
    transcriptPath,
    maximumFileBytes: 1_024,
    maximumJsonBytes: 1_024,
    maximumTotalBytes: 4_096,
    maximumFiles: 8,
  };

  if (process.platform !== "linux") {
    await assert.rejects(
      portableSnapshot.collectArtifactSnapshotFromRoot(input),
      /Secure filesystem boundary rejected/u,
    );
    return;
  }
  const snapshot = await portableSnapshot.collectArtifactSnapshotFromRoot(input);

  assert.deepEqual(snapshot.files.map(({ path: filePath }) => filePath), ["page.json", "transcript.json"]);
  assert.equal(snapshot.pageDigest, snapshot.files[0].sha256);
  assert.equal(snapshot.transcriptDigest, snapshot.files[1].sha256);
});

test("portable fallback rejects root substitution after authority binding", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-node-bound-root-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "authority");
  const movedRoot = path.join(parent, "authority-original");
  const substitute = path.join(parent, "substitute");
  await mkdir(root, { mode: ROOT_MODE });
  await mkdir(substitute, { mode: ROOT_MODE });
  await writeFile(path.join(root, "approval.json"), "trusted\n", { mode: 0o400 });
  await writeFile(path.join(substitute, "approval.json"), "substitute\n", { mode: 0o400 });
  const portableSnapshot = createSecureFilesystemSnapshot({ spawnImpl: unavailableHelperSpawn });

  await assert.rejects(
    portableSnapshot.readBoundedFileFromRoot({
      rootPath: root,
      filePath: path.join(root, "approval.json"),
      maximumBytes: 1024,
      privateDirectories: true,
      immutableFile: true,
      async afterRootOpened() {
        await rename(root, movedRoot);
        await symlink(substitute, root);
      },
    }),
    /Secure filesystem boundary rejected/u,
  );
});

test("portable artifact collection matches the Python helper and enforces file bounds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-node-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage");
  const inventory = path.join(stage, "deploy");
  await mkdir(path.join(inventory, "assets"), { recursive: true, mode: ROOT_MODE });
  const pagePath = path.join(stage, "page.json");
  const transcriptPath = path.join(inventory, "transcript.json");
  const requiredPath = path.join(stage, "review.json");
  await writeFile(pagePath, "{}\n", { mode: 0o600 });
  await writeFile(transcriptPath, "[]\n", { mode: 0o600 });
  await writeFile(requiredPath, "{}\n", { mode: 0o600 });
  await writeFile(path.join(inventory, "assets", "kept.txt"), "kept\n", { mode: 0o600 });
  await writeFile(path.join(inventory, "assets", "Z.txt"), "Z\n", { mode: 0o600 });
  await writeFile(path.join(inventory, "assets", "a.txt"), "a\n", { mode: 0o600 });
  await writeFile(path.join(inventory, "assets", "é.txt"), "accent\n", { mode: 0o600 });
  await writeFile(path.join(inventory, "excluded.txt"), "excluded\n", { mode: 0o600 });
  const input = {
    rootPath: root,
    inventoryRoot: inventory,
    inventoryPrefix: "deploy",
    excludedPaths: ["excluded.txt"],
    pagePath,
    pageManifestPath: "approved/page.json",
    transcriptPath,
    transcriptManifestPath: null,
    requiredPaths: [requiredPath],
    maximumFileBytes: 1_024,
    maximumJsonBytes: 1_024,
    maximumTotalBytes: 4_096,
    maximumFiles: 12,
  };
  const expected = await collectArtifactSnapshotFromRoot(input);
  const portableSnapshot = createSecureFilesystemSnapshot({ spawnImpl: unavailableHelperSpawn });

  if (process.platform !== "linux") {
    await assert.rejects(
      portableSnapshot.collectArtifactSnapshotFromRoot(input),
      /Secure filesystem boundary rejected/u,
    );
    return;
  }
  assert.deepEqual(await portableSnapshot.collectArtifactSnapshotFromRoot(input), expected);
  await assert.rejects(
    portableSnapshot.collectArtifactSnapshotFromRoot({ ...input, maximumFiles: 1 }),
    /Secure filesystem boundary rejected/u,
  );
  await assert.rejects(
    portableSnapshot.collectArtifactSnapshotFromRoot({ ...input, inventoryPrefix: "x".repeat(70_000) }),
    /Secure filesystem boundary rejected/u,
  );
});

test("portable collection reuses descriptor-bound directories under a bounded file-descriptor budget", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-node-descriptors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = path.join(root, "artifacts", "current", "assets");
  await mkdir(inventory, { recursive: true, mode: ROOT_MODE });
  for (let index = 0; index < 110; index += 1) {
    await writeFile(path.join(inventory, `asset-${String(index).padStart(3, "0")}.txt`), `${index}\n`, {
      mode: 0o600,
    });
  }
  const pagePath = path.join(inventory, "page.json");
  const transcriptPath = path.join(inventory, "transcript.json");
  await writeFile(pagePath, "{}\n", { mode: 0o600 });
  await writeFile(transcriptPath, "[]\n", { mode: 0o600 });
  const portableSnapshot = createSecureFilesystemSnapshot({ spawnImpl: unavailableHelperSpawn });
  const input = {
    rootPath: root,
    inventoryRoot: inventory,
    pagePath,
    transcriptPath,
    maximumFileBytes: 1_024,
    maximumJsonBytes: 1_024,
    maximumTotalBytes: 64 * 1_024,
    maximumFiles: 128,
  };

  if (process.platform !== "linux") {
    await assert.rejects(
      portableSnapshot.collectArtifactSnapshotFromRoot(input),
      /Secure filesystem boundary rejected/u,
    );
    return;
  }
  const snapshot = await portableSnapshot.collectArtifactSnapshotFromRoot(input);
  assert.equal(snapshot.files.length, 112);
});

test("descriptor-relative reads stay bound to the opened root across ancestor substitution", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-bound-root-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "authority");
  const movedRoot = path.join(parent, "authority-original");
  const substitute = path.join(parent, "substitute");
  for (const directory of [root, substitute]) {
    await mkdir(path.join(directory, "approvals"), { recursive: true, mode: ROOT_MODE });
  }
  const relative = path.join("approvals", "approval.json");
  await writeFile(path.join(root, relative), "trusted\n", { mode: 0o400 });
  await writeFile(path.join(substitute, relative), "substitute\n", { mode: 0o400 });

  const snapshot = await readBoundedFileFromRoot({
    rootPath: root,
    filePath: path.join(root, relative),
    maximumBytes: 1024,
    privateDirectories: true,
    immutableFile: true,
    async afterRootOpened() {
      await rename(root, movedRoot);
      await symlink(substitute, root);
    },
  });

  assert.equal(snapshot.bytes.toString("utf8"), "trusted\n");
});

test("artifact collection rejects a substituted stage ancestor after binding the workspace root", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-bound-collection-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const stage = path.join(root, "revisions", "r1", "prepared");
  const inventory = path.join(stage, "deploy");
  const substitute = path.join(parent, "substitute");
  await mkdir(inventory, { recursive: true, mode: ROOT_MODE });
  await mkdir(substitute, { recursive: true, mode: ROOT_MODE });
  await writeFile(path.join(inventory, "page.json"), "{}\n", "utf8");
  await writeFile(path.join(inventory, "transcript.json"), "{}\n", "utf8");
  await writeFile(path.join(substitute, "page.json"), "{\"attacker\":true}\n", "utf8");
  await writeFile(path.join(substitute, "transcript.json"), "{}\n", "utf8");

  await assert.rejects(
    collectArtifactSnapshotFromRoot({
      rootPath: root,
      inventoryRoot: inventory,
      inventoryPrefix: "deploy",
      excludedPaths: [],
      pagePath: path.join(inventory, "page.json"),
      pageManifestPath: null,
      transcriptPath: path.join(inventory, "transcript.json"),
      transcriptManifestPath: null,
      requiredPaths: [],
      maximumFileBytes: 1_024,
      maximumJsonBytes: 1_024,
      maximumTotalBytes: 4_096,
      maximumFiles: 8,
      async afterRootOpened() {
        await rename(stage, `${stage}-original`);
        await symlink(substitute, stage, "dir");
      },
    }),
    /Secure filesystem boundary rejected/u,
  );
});
