import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON_BINARY = "/usr/bin/python3";
const HELPER_PATH = fileURLToPath(new URL("../../scripts/lib/secure-filesystem-snapshot.py", import.meta.url));
const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 30_000;

export async function readBoundedFileFromRoot({
  rootPath,
  filePath,
  maximumBytes,
  privateDirectories = false,
  immutableFile = false,
  afterRootOpened,
}) {
  const relativePath = relativeChild(rootPath, filePath);
  const result = await withBoundRoot(rootPath, privateDirectories, afterRootOpened, (rootHandle) => runHelper(
    rootHandle.fd,
    {
      operation: "read_file",
      relativePath,
      maximumBytes,
      privateDirectories,
      exactMode: immutableFile ? 0o400 : null,
    },
  ));
  if (result && Object.keys(result).join("\0") === "missing" && result.missing === true) return null;
  if (
    !result
    || Object.keys(result).join("\0") !== "dataBase64"
    || typeof result.dataBase64 !== "string"
  ) {
    throw boundaryError();
  }
  const bytes = Buffer.from(result.dataBase64, "base64");
  if (bytes.byteLength > maximumBytes || bytes.toString("base64") !== result.dataBase64) {
    throw boundaryError();
  }
  return Object.freeze({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export async function collectArtifactSnapshotFromRoot({
  rootPath,
  inventoryRoot,
  inventoryPrefix = "",
  excludedPaths = [],
  pagePath,
  pageManifestPath = null,
  transcriptPath,
  transcriptManifestPath = null,
  requiredPaths = [],
  maximumFileBytes,
  maximumJsonBytes,
  maximumTotalBytes,
  maximumFiles,
  afterRootOpened,
}) {
  const request = {
    operation: "collect",
    inventoryRoot: relativeChildOrSelf(rootPath, inventoryRoot),
    inventoryPrefix,
    excludedPaths: [...excludedPaths],
    pagePath: relativeChild(rootPath, pagePath),
    pageManifestPath,
    transcriptPath: relativeChild(rootPath, transcriptPath),
    transcriptManifestPath,
    requiredPaths: requiredPaths.map((candidate) => relativeChild(rootPath, candidate)),
    maximumFileBytes,
    maximumTotalBytes,
    maximumFiles,
  };
  const result = await withBoundRoot(rootPath, false, afterRootOpened, (rootHandle) => runHelper(rootHandle.fd, request));
  if (result && Object.keys(result).join("\0") === "missing" && result.missing === true) return null;
  if (
    !result
    || Object.keys(result).sort().join("\0") !== "files\0pageDigest\0transcriptDigest"
    || !Array.isArray(result.files)
    || typeof result.pageDigest !== "string"
    || typeof result.transcriptDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(result.pageDigest)
    || !/^[a-f0-9]{64}$/u.test(result.transcriptDigest)
  ) {
    throw boundaryError();
  }
  const seen = new Set();
  for (const file of result.files) {
    if (
      !file
      || Object.keys(file).sort().join("\0") !== "bytes\0path\0sha256"
      || typeof file.path !== "string"
      || file.path === ""
      || seen.has(file.path)
      || !Number.isInteger(file.bytes)
      || file.bytes < 0
      || typeof file.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(file.sha256)
    ) {
      throw boundaryError();
    }
    seen.add(file.path);
  }
  return Object.freeze({
    files: result.files.map((file) => Object.freeze({ ...file })),
    pageDigest: result.pageDigest,
    transcriptDigest: result.transcriptDigest,
  });
}

async function withBoundRoot(rootPath, privateDirectories, afterRootOpened, action) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath) {
    throw boundaryError();
  }
  let handle;
  try {
    handle = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const [opened, pathname] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(rootPath, { bigint: true }),
    ]);
    assertRootMetadata(opened, privateDirectories);
    assertRootMetadata(pathname, privateDirectories);
    if (opened.dev !== pathname.dev || opened.ino !== pathname.ino) throw boundaryError();
    if (afterRootOpened !== undefined) {
      if (typeof afterRootOpened !== "function") throw boundaryError();
      await afterRootOpened();
    }
    return await action(handle);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.message === "Secure filesystem boundary rejected.") throw error;
    throw boundaryError();
  } finally {
    await handle?.close();
  }
}

function assertRootMetadata(metadata, privateDirectories) {
  const forbiddenMode = privateDirectories ? 0o077n : 0o022n;
  if (
    !metadata.isDirectory()
    || Number(metadata.mode & forbiddenMode) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw boundaryError();
  }
}

function runHelper(rootFd, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BINARY, [HELPER_PATH], {
      stdio: ["pipe", "pipe", "pipe", rootFd],
      windowsHide: true,
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
    });
    const stdout = [];
    let stdoutBytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(boundaryError());
    };
    const timer = setTimeout(fail, HELPER_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
        fail();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || signal !== null) {
        reject(boundaryError());
        return;
      }
      try {
        const raw = Buffer.concat(stdout, stdoutBytes).toString("utf8");
        if (raw !== `${raw.trim()}\n`) throw boundaryError();
        resolve(JSON.parse(raw));
      } catch {
        reject(boundaryError());
      }
    });
    child.stdin.on("error", fail);
    child.stdin.end(JSON.stringify(request));
  });
}

function relativeChild(root, candidate) {
  const relative = relativeChildOrSelf(root, candidate);
  if (relative === "") throw boundaryError();
  return relative;
}

function relativeChildOrSelf(root, candidate) {
  if (
    typeof candidate !== "string"
    || !path.isAbsolute(candidate)
    || path.resolve(candidate) !== candidate
  ) {
    throw boundaryError();
  }
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw boundaryError();
  return relative.split(path.sep).join("/");
}

function boundaryError() {
  return new Error("Secure filesystem boundary rejected.");
}
