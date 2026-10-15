import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fsPromises, { chmod, mkdir, mkdtemp, open, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
  const largeSnapshot = await portableSnapshot.readBoundedFileFromRoot({
    ...input,
    maximumBytes: 4 * 1024 * 1024,
  });
  assert.equal(largeSnapshot.bytes.byteLength, 3_200_000);
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

test("portable collection rejects mutation after an earlier file was locally validated", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-node-mutation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = path.join(root, "artifacts");
  await mkdir(inventory, { recursive: true, mode: ROOT_MODE });
  const pagePath = path.join(inventory, "a.txt");
  const transcriptPath = path.join(inventory, "b.txt");
  await writeFile(pagePath, "trusted-a\n", { mode: 0o600 });
  await writeFile(transcriptPath, "trusted-b\n", { mode: 0o600 });

  const probe = await open(pagePath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = fileHandlePrototype.read;
  let mutated = false;
  fileHandlePrototype.read = async function patchedRead(...args) {
    const openedPath = await readlink(`/proc/self/fd/${this.fd}`);
    if (!mutated && openedPath === transcriptPath) {
      await writeFile(pagePath, "mutated-a\n", { mode: 0o600 });
      mutated = true;
    }
    return originalRead.apply(this, args);
  };
  t.after(() => {
    fileHandlePrototype.read = originalRead;
  });

  const portableSnapshot = createSecureFilesystemSnapshot({ spawnImpl: unavailableHelperSpawn });
  await assert.rejects(
    portableSnapshot.collectArtifactSnapshotFromRoot({
      rootPath: root,
      inventoryRoot: inventory,
      pagePath,
      transcriptPath,
      maximumFileBytes: 1_024,
      maximumJsonBytes: 1_024,
      maximumTotalBytes: 4_096,
      maximumFiles: 4,
    }),
    /Secure filesystem boundary rejected/u,
  );
  assert.equal(mutated, true);
});

test("portable collection rejects mutation after an earlier file was revalidated", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-node-revalidation-mutation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = path.join(root, "artifacts");
  await mkdir(inventory, { recursive: true, mode: ROOT_MODE });
  const pagePath = path.join(inventory, "a.txt");
  const transcriptPath = path.join(inventory, "b.txt");
  await writeFile(pagePath, "trusted-a\n", { mode: 0o600 });
  await writeFile(transcriptPath, "trusted-b\n", { mode: 0o600 });

  const probe = await open(pagePath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = fileHandlePrototype.read;
  let transcriptReads = 0;
  let mutated = false;
  fileHandlePrototype.read = async function patchedRead(...args) {
    const openedPath = await readlink(`/proc/self/fd/${this.fd}`);
    if (openedPath === transcriptPath) {
      transcriptReads += 1;
      // Each bounded capture reads data and then EOF; call three starts b.txt's revalidation.
      if (transcriptReads === 3) {
        await writeFile(pagePath, "mutated-a\n", { mode: 0o600 });
        mutated = true;
      }
    }
    return originalRead.apply(this, args);
  };
  t.after(() => {
    fileHandlePrototype.read = originalRead;
  });

  const portableSnapshot = createSecureFilesystemSnapshot({ spawnImpl: unavailableHelperSpawn });
  await assert.rejects(
    portableSnapshot.collectArtifactSnapshotFromRoot({
      rootPath: root,
      inventoryRoot: inventory,
      pagePath,
      transcriptPath,
      maximumFileBytes: 1_024,
      maximumJsonBytes: 1_024,
      maximumTotalBytes: 4_096,
      maximumFiles: 4,
    }),
    /Secure filesystem boundary rejected/u,
  );
  assert.equal(mutated, true);
});

test("portable collection rejects persistent first-revalidation mutations when timestamps alias", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-node-coarse-revalidation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = path.join(root, "artifacts");
  await mkdir(inventory, { mode: ROOT_MODE });
  const pagePath = path.join(inventory, "a.txt");
  const transcriptPath = path.join(inventory, "b.txt");
  await writeFile(pagePath, "trusted-a\n", { mode: 0o600 });
  await writeFile(transcriptPath, "trusted-b\n", { mode: 0o600 });

  const probe = await open(pagePath, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  const originalStat = prototype.stat;
  const originalLstat = fsPromises.lstat;
  function coarseFileMetadata(metadata) {
    if (metadata.isFile()) {
      metadata.mtimeNs = 0n;
      metadata.ctimeNs = 0n;
    }
    return metadata;
  }
  prototype.stat = async function patchedStat(...args) {
    return coarseFileMetadata(await originalStat.apply(this, args));
  };
  fsPromises.lstat = async (...args) => coarseFileMetadata(await originalLstat(...args));
  syncBuiltinESMExports();
  let transcriptReads = 0;
  let pageReads = 0;
  let metadataBefore;
  let metadataAfter;
  let pageReadsAtMutation;
  prototype.read = async function patchedRead(...args) {
    const openedPath = await readlink(`/proc/self/fd/${this.fd}`);
    if (openedPath === pagePath) pageReads += 1;
    if (openedPath === transcriptPath && ++transcriptReads === 3) {
      // Data/EOF twice: a.txt was already captured and content-revalidated.
      pageReadsAtMutation = pageReads;
      metadataBefore = coarseFileMetadata(await originalLstat(pagePath, { bigint: true }));
      await writeFile(pagePath, "mutated-a\n", { mode: 0o600 });
      metadataAfter = coarseFileMetadata(await originalLstat(pagePath, { bigint: true }));
    }
    return originalRead.apply(this, args);
  };
  t.after(() => {
    prototype.read = originalRead;
    prototype.stat = originalStat;
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
  });

  const portableSnapshot = createSecureFilesystemSnapshot({ spawnImpl: unavailableHelperSpawn });
  await assert.rejects(
    portableSnapshot.collectArtifactSnapshotFromRoot({
      rootPath: root,
      inventoryRoot: inventory,
      pagePath,
      transcriptPath,
      maximumFileBytes: 1_024,
      maximumJsonBytes: 1_024,
      maximumTotalBytes: 4_096,
      maximumFiles: 4,
    }),
    /Secure filesystem boundary rejected/u,
  );
  assert.equal(pageReadsAtMutation, 4);
  assert.ok(metadataAfter, "same-size mutation must execute");
  for (const key of ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"]) {
    assert.equal(metadataBefore[key], metadataAfter[key], `${key} must alias across the mutation`);
  }
});

test("Python collection revalidates bytes when metadata cannot distinguish a same-size mutation", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-python-mutation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = path.join(root, "artifacts");
  await mkdir(inventory, { mode: ROOT_MODE });
  const pagePath = path.join(inventory, "a.txt");
  const transcriptPath = path.join(inventory, "b.txt");
  await writeFile(pagePath, "trusted-a\n", { mode: 0o600 });
  await writeFile(transcriptPath, "trusted-b\n", { mode: 0o600 });
  let mutated = false;
  const snapshot = createSecureFilesystemSnapshot({
    spawnImpl(binary, [helper], options) {
      const child = spawn(binary, ["-c", `
import os, stat, sys
sys.dont_write_bytecode = True
namespace = {"__name__": "snapshot_test"}
with open(sys.argv[1]) as source:
    exec(compile(source.read(), sys.argv[1], "exec"), namespace)
original_fingerprint = namespace["fingerprint"]
def coarse_fingerprint(metadata):
    result = original_fingerprint(metadata)
    return result[:-2] + (0, 0) if stat.S_ISREG(metadata.st_mode) else result
namespace["fingerprint"] = coarse_fingerprint
original_read = os.read
mutated = False
def read_with_mutation(descriptor, maximum):
    global mutated
    if not mutated and os.readlink(f"/proc/self/fd/{descriptor}").endswith("/artifacts/b.txt"):
        target = os.open("artifacts/a.txt", os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, dir_fd=3)
        try:
            os.write(target, b"mutated-a\\n")
        finally:
            os.close(target)
        mutated = True
        sys.stderr.write("snapshot mutation injected\\n")
    return original_read(descriptor, maximum)
os.read = read_with_mutation
namespace["main"]()
`, helper], options);
      child.stderr.on("data", (chunk) => {
        if (chunk.toString().includes("snapshot mutation injected")) mutated = true;
      });
      return child;
    },
  });
  await assert.rejects(snapshot.collectArtifactSnapshotFromRoot({
    rootPath: root,
    inventoryRoot: inventory,
    pagePath,
    transcriptPath,
    maximumFileBytes: 1_024,
    maximumJsonBytes: 1_024,
    maximumTotalBytes: 4_096,
    maximumFiles: 4,
  }), { message: "Secure filesystem boundary rejected." });
  assert.equal(mutated, true);
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
