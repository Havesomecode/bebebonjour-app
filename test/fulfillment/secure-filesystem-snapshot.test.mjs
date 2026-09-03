import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectArtifactSnapshotFromRoot,
  readBoundedFileFromRoot,
} from "../../src/fulfillment/secure-filesystem-snapshot.mjs";

const ROOT_MODE = 0o700;

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
