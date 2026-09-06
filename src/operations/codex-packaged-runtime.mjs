import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const EXPECTED_PACKAGE_VERSION = "0.146.0";
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_BINARY_BYTES = 320 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const MANIFEST_KEYS = [
  "archiveBytes",
  "archiveSha256",
  "binaryBytes",
  "binarySha256",
  "packageVersion",
  "schemaVersion",
  "targetTriple",
];
const DEFAULT_ARCHIVE_DIRECTORY = new URL(
  "../../.codex-runtime/",
  import.meta.url,
);

export async function materializePackagedCodexRuntime(options = {}) {
  const archiveDirectory = path.resolve(
    options.archiveDirectory || fileURLToPath(DEFAULT_ARCHIVE_DIRECTORY),
  );
  const destinationRoot = path.resolve(options.destinationRoot || "");
  let runtimeRoot = null;
  try {
    await assertPlainDirectory(archiveDirectory);
    await assertPlainDirectory(destinationRoot);
    const archivePath = path.join(archiveDirectory, "codex.gz");
    const manifestPath = path.join(archiveDirectory, "manifest.json");
    const manifest = await readManifest(manifestPath);
    await assertArchive(archivePath, manifest);

    runtimeRoot = path.join(destinationRoot, `codex-runtime-${randomUUID()}`);
    await mkdir(runtimeRoot, { mode: 0o700 });
    const executable = path.join(runtimeRoot, "codex");
    const binaryHash = createHash("sha256");
    let binaryBytes = 0;
    const boundAndHash = new Transform({
      transform(chunk, _encoding, callback) {
        binaryBytes += chunk.byteLength;
        if (binaryBytes > MAX_BINARY_BYTES || binaryBytes > manifest.binaryBytes) {
          callback(invalidRuntime());
          return;
        }
        binaryHash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      boundAndHash,
      createWriteStream(executable, { flags: "wx", mode: 0o700 }),
    );
    if (
      binaryBytes !== manifest.binaryBytes
      || binaryHash.digest("hex") !== manifest.binarySha256
    ) {
      throw invalidRuntime();
    }
    await chmod(executable, 0o700);
    return executable;
  } catch (error) {
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
    if (error?.reasonCode === "composition_runtime_invalid") throw error;
    throw invalidRuntime();
  }
}

async function readManifest(manifestPath) {
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4_096) {
    throw invalidRuntime();
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !manifest
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || Object.keys(manifest).sort().join("\0") !== MANIFEST_KEYS.join("\0")
    || manifest.schemaVersion !== "1.0"
    || manifest.packageVersion !== EXPECTED_PACKAGE_VERSION
    || manifest.targetTriple !== expectedTargetTriple()
    || !Number.isInteger(manifest.archiveBytes)
    || manifest.archiveBytes < 1
    || manifest.archiveBytes > MAX_ARCHIVE_BYTES
    || !Number.isInteger(manifest.binaryBytes)
    || manifest.binaryBytes < 1
    || manifest.binaryBytes > MAX_BINARY_BYTES
    || !DIGEST.test(manifest.archiveSha256 || "")
    || !DIGEST.test(manifest.binarySha256 || "")
  ) {
    throw invalidRuntime();
  }
  return manifest;
}

function expectedTargetTriple() {
  const target = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "linux:x64": "x86_64-unknown-linux-musl",
  }[`${process.platform}:${process.arch}`];
  if (!target) throw invalidRuntime();
  return target;
}

async function assertArchive(archivePath, manifest) {
  const metadata = await lstat(archivePath);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size !== manifest.archiveBytes
  ) {
    throw invalidRuntime();
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) digest.update(chunk);
  if (digest.digest("hex") !== manifest.archiveSha256) throw invalidRuntime();
}

async function assertPlainDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalidRuntime();
}

function invalidRuntime() {
  const error = new Error("composition_runtime_invalid");
  error.name = "CodexPackagedRuntimeError";
  error.reasonCode = "composition_runtime_invalid";
  error.retryable = false;
  return error;
}
