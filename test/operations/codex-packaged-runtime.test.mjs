import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { materializePackagedCodexRuntime } from "../../src/operations/codex-packaged-runtime.mjs";

const gzipAsync = promisify(gzip);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectedTargetTriple() {
  return {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "linux:x64": "x86_64-unknown-linux-musl",
  }[`${process.platform}:${process.arch}`];
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archiveDirectory = path.join(root, "archive");
  const destinationRoot = path.join(root, "destination");
  await Promise.all([
    mkdir(archiveDirectory, { mode: 0o700 }),
    mkdir(destinationRoot, { mode: 0o700 }),
  ]);
  const binary = Buffer.from("synthetic-codex-binary", "utf8");
  const archive = await gzipAsync(binary, { level: 9 });
  await writeFile(path.join(archiveDirectory, "codex.gz"), archive, { mode: 0o600 });
  await writeFile(path.join(archiveDirectory, "manifest.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    packageVersion: "0.146.0",
    targetTriple: expectedTargetTriple(),
    binaryBytes: binary.byteLength,
    binarySha256: sha256(binary),
    archiveBytes: archive.byteLength,
    archiveSha256: sha256(archive),
  }, null, 2)}\n`, { mode: 0o600 });
  return { archive, archiveDirectory, binary, destinationRoot };
}

test("packaged Codex runtime materializes one integrity-checked private executable", async (t) => {
  const context = await fixture(t);
  const executable = await materializePackagedCodexRuntime(context);

  assert.deepEqual(await readFile(executable), context.binary);
  assert.equal((await stat(executable)).mode & 0o077, 0);
  assert.equal(path.dirname(executable).startsWith(context.destinationRoot), true);
});

test("packaged Codex runtime rejects archive or manifest tampering", async (t) => {
  for (const mutate of [
    async (context) => writeFile(path.join(context.archiveDirectory, "codex.gz"), "tampered"),
    async (context) => {
      const manifestPath = path.join(context.archiveDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.binarySha256 = "0".repeat(64);
      await writeFile(manifestPath, JSON.stringify(manifest));
    },
    async (context) => {
      const manifestPath = path.join(context.archiveDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.targetTriple = manifest.targetTriple.startsWith("aarch64")
        ? manifest.targetTriple.replace("aarch64", "x86_64")
        : manifest.targetTriple.replace("x86_64", "aarch64");
      await writeFile(manifestPath, JSON.stringify(manifest));
    },
  ]) {
    const context = await fixture(t);
    await mutate(context);
    await assert.rejects(
      materializePackagedCodexRuntime(context),
      (error) => error?.reasonCode === "composition_runtime_invalid"
        && error.message === "composition_runtime_invalid",
    );
  }
});
