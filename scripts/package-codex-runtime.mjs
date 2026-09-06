import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip, constants as zlibConstants } from "node:zlib";

const CODEX_VERSION = "0.146.0";
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_BINARY_BYTES = 320 * 1024 * 1024;
const TARGETS = Object.freeze({
  "darwin:arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
  "darwin:x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  "linux:arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  "linux:x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
});
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIRECTORY = path.join(PROJECT_ROOT, ".codex-runtime");
const require = createRequire(import.meta.url);

const target = TARGETS[`${process.platform}:${process.arch}`];
if (!target) throw new Error("Unsupported Codex packaging platform.");
const [platformPackage, targetTriple] = target;
const mainManifest = JSON.parse(await readFile(
  require.resolve("@openai/codex/package.json"),
  "utf8",
));
if (mainManifest.version !== CODEX_VERSION) {
  throw new Error("Installed Codex version does not match the pinned runtime version.");
}
const platformManifestPath = require.resolve(`${platformPackage}/package.json`);
const platformManifest = JSON.parse(await readFile(platformManifestPath, "utf8"));
if (platformManifest.version !== `${CODEX_VERSION}-${process.platform}-${process.arch}`) {
  throw new Error("Installed Codex platform package does not match the pinned runtime.");
}
const executable = path.join(
  path.dirname(platformManifestPath),
  "vendor",
  targetTriple,
  "bin",
  "codex",
);
const executableMetadata = await lstat(executable);
if (
  !executableMetadata.isFile()
  || executableMetadata.isSymbolicLink()
  || executableMetadata.size < 1
  || executableMetadata.size > MAX_BINARY_BYTES
) {
  throw new Error("Installed Codex executable is invalid.");
}

await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
await mkdir(OUTPUT_DIRECTORY, { recursive: true, mode: 0o700 });
const archivePath = path.join(OUTPUT_DIRECTORY, "codex.gz");
const temporaryArchivePath = `${archivePath}.${randomUUID()}.tmp`;
const binaryHash = createHash("sha256");
const archiveHash = createHash("sha256");
let binaryBytes = 0;
let archiveBytes = 0;
const hashBinary = new Transform({
  transform(chunk, _encoding, callback) {
    binaryBytes += chunk.byteLength;
    binaryHash.update(chunk);
    callback(null, chunk);
  },
});
const hashArchive = new Transform({
  transform(chunk, _encoding, callback) {
    archiveBytes += chunk.byteLength;
    archiveHash.update(chunk);
    callback(null, chunk);
  },
});
try {
  await pipeline(
    createReadStream(executable),
    hashBinary,
    createGzip({ level: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY }),
    hashArchive,
    createWriteStream(temporaryArchivePath, { flags: "wx", mode: 0o600 }),
  );
  await rename(temporaryArchivePath, archivePath);
} catch (error) {
  await rm(temporaryArchivePath, { force: true }).catch(() => {});
  throw error;
}
if (
  binaryBytes < 1
  || binaryBytes > MAX_BINARY_BYTES
  || archiveBytes < 1
  || archiveBytes > MAX_ARCHIVE_BYTES
) {
  await rm(archivePath, { force: true });
  throw new Error("Packaged Codex runtime exceeds the reviewed Vercel bounds.");
}
const manifest = {
  schemaVersion: "1.0",
  packageVersion: CODEX_VERSION,
  targetTriple,
  binaryBytes,
  binarySha256: binaryHash.digest("hex"),
  archiveBytes,
  archiveSha256: archiveHash.digest("hex"),
};
await writeFile(
  path.join(OUTPUT_DIRECTORY, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
console.log(JSON.stringify({
  status: "packaged",
  packageVersion: CODEX_VERSION,
  binaryBytes,
  archiveBytes,
}));
