import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON_BINARY = "/usr/bin/python3";
const HELPER_PATH = fileURLToPath(new URL("../../scripts/lib/secure-filesystem-snapshot.py", import.meta.url));
// A bounded read may return one 64 MiB file as base64 plus its JSON envelope.
const MAX_HELPER_OUTPUT_BYTES = 88 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 30_000;
const NATIVE_MAX_REQUEST_BYTES = 64 * 1024;
const NATIVE_MAX_FILE_BYTES = 64 * 1024 * 1024;
const NATIVE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const NATIVE_MAX_FILES = 8_192;
const DEFAULT_RUNTIME = Object.freeze({ spawnImpl: spawn });

export function createSecureFilesystemSnapshot(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  if (typeof spawnImpl !== "function" || Object.keys(options).some((key) => key !== "spawnImpl")) {
    throw boundaryError();
  }
  const runtime = Object.freeze({ spawnImpl });
  return Object.freeze({
    readBoundedFileFromRoot: (input) => readBoundedFileFromRootWithRuntime(input, runtime),
    collectArtifactSnapshotFromRoot: (input) => collectArtifactSnapshotFromRootWithRuntime(input, runtime),
  });
}

export function readBoundedFileFromRoot(input) {
  return readBoundedFileFromRootWithRuntime(input, DEFAULT_RUNTIME);
}

async function readBoundedFileFromRootWithRuntime({
  rootPath,
  filePath,
  maximumBytes,
  privateDirectories = false,
  immutableFile = false,
  afterRootOpened,
}, runtime) {
  const relativePath = relativeChild(rootPath, filePath);
  const request = {
      operation: "read_file",
      relativePath,
      maximumBytes,
      privateDirectories,
      exactMode: immutableFile ? 0o400 : null,
    };
  const result = await withBoundRoot(rootPath, privateDirectories, afterRootOpened, async (rootHandle, rootMetadata) => {
    try {
      return await runHelper(rootHandle.fd, request, runtime);
    } catch (error) {
      if (error?.code !== "HERMES_HELPER_UNAVAILABLE") throw error;
      return runNativeReadHelper(rootHandle, rootMetadata, rootPath, request);
    }
  });
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

export function collectArtifactSnapshotFromRoot(input) {
  return collectArtifactSnapshotFromRootWithRuntime(input, DEFAULT_RUNTIME);
}

async function collectArtifactSnapshotFromRootWithRuntime({
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
}, runtime) {
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
  const result = await withBoundRoot(
    rootPath,
    false,
    afterRootOpened,
    async (rootHandle, rootMetadata) => {
      try {
        return await runHelper(rootHandle.fd, request, runtime);
      } catch (error) {
        if (error?.code !== "HERMES_HELPER_UNAVAILABLE") throw error;
        return runNativeCollectHelper(rootHandle, rootMetadata, rootPath, request);
      }
    },
  );
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
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.message === "Secure filesystem boundary rejected.") throw error;
    throw boundaryError();
  }
  try {
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
    return await action(handle, opened);
  } catch (error) {
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

function runHelper(rootFd, request, runtime) {
  return new Promise((resolve, reject) => {
    const child = runtime.spawnImpl(PYTHON_BINARY, [HELPER_PATH], {
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
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error?.code === "ENOENT") {
        const unavailable = new Error("Secure filesystem helper is unavailable.");
        unavailable.code = "HERMES_HELPER_UNAVAILABLE";
        reject(unavailable);
        return;
      }
      reject(boundaryError());
    });
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

async function runNativeCollectHelper(rootHandle, rootMetadata, rootPath, request) {
  const openedHandles = [];
  let root;
  try {
    assertNativeCollectionRequest(request);
    assertNativeRequestSize(request);
    root = await nativeRootBinding(rootHandle, rootMetadata, rootPath, false);
    const directoryCache = new Map([["", root]]);
    const inventoryPaths = [];
    const traversal = { directories: 0, entries: 0 };
    await collectNativeInventory(
      root,
      request.inventoryRoot,
      "",
      request,
      traversal,
      inventoryPaths,
      openedHandles,
      directoryCache,
    );

    const cache = new Map();
    let totalBytes = 0;
    async function readItem(relativePath) {
      if (cache.has(relativePath)) return cache.get(relativePath);
      if (cache.size >= request.maximumFiles) throw boundaryError();
      const captured = await captureNativeFile(root, relativePath, {
        maximumBytes: request.maximumFileBytes,
        exactMode: null,
      }, openedHandles, directoryCache);
      const { bytes } = captured;
      totalBytes += bytes.byteLength;
      if (totalBytes > request.maximumTotalBytes) throw boundaryError();
      const item = Object.freeze({
        rootPath: relativePath,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        metadata: captured.metadata,
      });
      cache.set(relativePath, item);
      return item;
    }

    const excluded = new Set(request.excludedPaths);
    const files = [];
    const represented = new Map();
    for (const inventoryRelativePath of inventoryPaths) {
      if (excluded.has(inventoryRelativePath)) continue;
      const rootRelativePath = joinRelative(request.inventoryRoot, inventoryRelativePath);
      const item = await readItem(rootRelativePath);
      const logicalPath = joinRelative(request.inventoryPrefix, inventoryRelativePath);
      const projected = { path: logicalPath, bytes: item.bytes, sha256: item.sha256 };
      files.push(projected);
      represented.set(logicalPath, projected);
    }

    const page = await readItem(request.pagePath);
    const transcript = await readItem(request.transcriptPath);
    for (const requiredPath of request.requiredPaths) await readItem(requiredPath);
    representNativeDigest(files, represented, page, request.pageManifestPath, request);
    representNativeDigest(files, represented, transcript, request.transcriptManifestPath, request);
    if (files.length === 0 || files.length !== represented.size) throw boundaryError();
    await validateNativeHandles(root, openedHandles);
    await validateNativeCollectedFiles(root, cache.values(), openedHandles, directoryCache, request.maximumFileBytes);
    await validateNativeHandles(root, openedHandles);
    files.sort((left, right) => compareCodePointStrings(left.path, right.path));
    return finalizeNativeResponse({ files, pageDigest: page.sha256, transcriptDigest: transcript.sha256 });
  } catch (error) {
    if (error?.code === "ENOENT" && root) {
      await validateNativeHandles(root, openedHandles);
      return { missing: true };
    }
    if (error?.message === "Secure filesystem boundary rejected.") throw error;
    throw boundaryError();
  } finally {
    await closeNativeHandles(openedHandles);
  }
}

function assertNativeCollectionRequest(request) {
  if (!boundedNativeInteger(request.maximumFileBytes, NATIVE_MAX_FILE_BYTES)
    || !boundedNativeInteger(request.maximumTotalBytes, NATIVE_MAX_TOTAL_BYTES)
    || !boundedNativeInteger(request.maximumFiles, NATIVE_MAX_FILES)) throw boundaryError();
  if (
    typeof request.inventoryPrefix !== "string"
    || !Array.isArray(request.excludedPaths)
    || !Array.isArray(request.requiredPaths)
  ) {
    throw boundaryError();
  }
  if (request.inventoryPrefix !== "") relativeParts(request.inventoryPrefix);
  for (const value of [...request.excludedPaths, ...request.requiredPaths]) relativeParts(value);
}

async function collectNativeInventory(
  root,
  directoryRelativePath,
  inventoryPrefix,
  request,
  traversal,
  files,
  openedHandles,
  directoryCache,
) {
  const directory = await openNativeDirectory(root, directoryRelativePath, openedHandles, directoryCache);
  traversal.directories += 1;
  if (traversal.directories > request.maximumFiles) throw boundaryError();
  const entries = [];
  const iterator = await opendir(directory.descriptorPath);
  for await (const entry of iterator) {
    traversal.entries += 1;
    if (traversal.entries > request.maximumFiles * 2) throw boundaryError();
    entries.push(entry);
  }
  entries.sort((left, right) => compareCodePointStrings(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === "" || entry.name === "." || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\0")) {
      throw boundaryError();
    }
    const candidate = path.join(directory.descriptorPath, entry.name);
    const pathname = await lstat(candidate, { bigint: true });
    const relativePath = joinRelative(inventoryPrefix, entry.name);
    if (pathname.isDirectory()) {
      await collectNativeInventory(
        root,
        joinRelative(directoryRelativePath, entry.name),
        relativePath,
        request,
        traversal,
        files,
        openedHandles,
        directoryCache,
      );
    } else if (pathname.isFile()) {
      if (request.excludedPaths.includes(relativePath)) continue;
      if (files.length >= request.maximumFiles) throw boundaryError();
      assertNativeRegularFile(pathname, request.maximumFileBytes, null);
      files.push(relativePath);
    } else {
      throw boundaryError();
    }
  }
}

function representNativeDigest(files, represented, item, configuredManifestPath, request) {
  let manifestPath = configuredManifestPath;
  if (manifestPath === null) {
    const prefix = request.inventoryRoot === "" ? "" : `${request.inventoryRoot}/`;
    if (!item.rootPath.startsWith(prefix)) throw boundaryError();
    const inventoryRelativePath = item.rootPath.slice(prefix.length);
    manifestPath = joinRelative(request.inventoryPrefix, inventoryRelativePath);
  }
  relativeParts(manifestPath);
  const projected = { path: manifestPath, bytes: item.bytes, sha256: item.sha256 };
  const existing = represented.get(manifestPath);
  if (existing === undefined) {
    if (configuredManifestPath === null) throw boundaryError();
    files.push(projected);
    represented.set(manifestPath, projected);
  } else if (
    existing.bytes !== projected.bytes
    || existing.sha256 !== projected.sha256
    || existing.path !== projected.path
  ) {
    throw boundaryError();
  }
}

function joinRelative(left, right) {
  return left === "" ? right : `${left}/${right}`;
}

async function runNativeReadHelper(rootHandle, rootMetadata, rootPath, request) {
  const openedHandles = [];
  let root;
  try {
    assertNativeReadRequest(request);
    assertNativeRequestSize(request);
    root = await nativeRootBinding(rootHandle, rootMetadata, rootPath, request.privateDirectories);
    const bytes = await readNativeFile(root, request.relativePath, request, openedHandles);
    await validateNativeHandles(root, openedHandles);
    return finalizeNativeResponse({ dataBase64: bytes.toString("base64") });
  } catch (error) {
    if (error?.code === "ENOENT" && root) {
      await validateNativeHandles(root, openedHandles);
      return { missing: true };
    }
    if (error?.message === "Secure filesystem boundary rejected.") throw error;
    throw boundaryError();
  } finally {
    await closeNativeHandles(openedHandles);
  }
}

function relativeParts(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("/")) throw boundaryError();
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\0"))) {
    throw boundaryError();
  }
  return parts;
}

function assertNativeReadRequest(request) {
  if (
    !boundedNativeInteger(request.maximumBytes, NATIVE_MAX_FILE_BYTES)
    || typeof request.privateDirectories !== "boolean"
    || (request.exactMode !== null
      && (!Number.isInteger(request.exactMode) || request.exactMode < 0 || request.exactMode > 0o777))
  ) {
    throw boundaryError();
  }
}

function boundedNativeInteger(value, maximum) {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function assertNativeRequestSize(request) {
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > NATIVE_MAX_REQUEST_BYTES) throw boundaryError();
}

function finalizeNativeResponse(response) {
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_HELPER_OUTPUT_BYTES) throw boundaryError();
  return response;
}

function compareCodePointStrings(left, right) {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0));
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftCodePoints[index] !== rightCodePoints[index]) return leftCodePoints[index] - rightCodePoints[index];
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function assertNativeDirectory(metadata, privateDirectories) {
  const forbiddenMode = privateDirectories ? 0o077n : 0o022n;
  if (
    !metadata.isDirectory()
    || Number(metadata.mode & forbiddenMode) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw boundaryError();
  }
}

async function nativeRootBinding(rootHandle, rootMetadata, rootPath, privateDirectories) {
  if (process.platform !== "linux") throw boundaryError();
  assertNativeDirectory(rootMetadata, privateDirectories);
  const pathname = await lstat(rootPath, { bigint: true });
  assertNativeDirectory(pathname, privateDirectories);
  assertNativeFingerprint(rootMetadata, pathname);
  const descriptorPath = `/proc/self/fd/${rootHandle.fd}`;
  let current;
  try {
    current = await stat(descriptorPath, { bigint: true });
  } catch {
    throw boundaryError();
  }
  assertNativeFingerprint(rootMetadata, current);
  return Object.freeze({
    descriptorPath,
    handle: rootHandle,
    metadata: rootMetadata,
    privateDirectories,
  });
}

async function openNativeDirectory(root, relativePath, openedHandles, directoryCache) {
  let directory = root;
  const parts = relativePath === "" ? [] : relativeParts(relativePath);
  let traversed = "";
  for (const part of parts) {
    traversed = joinRelative(traversed, part);
    const cached = directoryCache?.get(traversed);
    if (cached) {
      directory = cached;
      continue;
    }
    const candidate = path.join(directory.descriptorPath, part);
    const pathname = await lstat(candidate, { bigint: true });
    assertNativeDirectory(pathname, root.privateDirectories);
    const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let metadata;
    try {
      metadata = await handle.stat({ bigint: true });
      assertNativeDirectory(metadata, root.privateDirectories);
      if (pathname.dev !== metadata.dev || pathname.ino !== metadata.ino) throw boundaryError();
    } catch (error) {
      await handle.close();
      throw error;
    }
    directory = Object.freeze({
      descriptorPath: `/proc/self/fd/${handle.fd}`,
      handle,
      metadata,
      privateDirectories: root.privateDirectories,
    });
    openedHandles.push(directory);
    directoryCache?.set(traversed, directory);
  }
  return directory;
}

async function openNativeFile(root, relativePath, request, openedHandles, directoryCache) {
  const parts = relativeParts(relativePath);
  const parent = await openNativeDirectory(
    root,
    parts.slice(0, -1).join("/"),
    openedHandles,
    directoryCache,
  );
  const candidate = path.join(parent.descriptorPath, parts.at(-1));
  const pathname = await lstat(candidate, { bigint: true });
  assertNativeRegularFile(pathname, request.maximumBytes, request.exactMode);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let metadata;
  try {
    metadata = await handle.stat({ bigint: true });
    assertNativeRegularFile(metadata, request.maximumBytes, request.exactMode);
    if (pathname.dev !== metadata.dev || pathname.ino !== metadata.ino) throw boundaryError();
  } catch (error) {
    await handle.close();
    throw error;
  }
  const file = Object.freeze({ handle, metadata });
  openedHandles.push(file);
  return file;
}

async function readNativeFile(root, relativePath, request, openedHandles, directoryCache) {
  return (await captureNativeFile(root, relativePath, request, openedHandles, directoryCache)).bytes;
}

async function captureNativeFile(root, relativePath, request, openedHandles, directoryCache) {
  const file = await openNativeFile(root, relativePath, request, openedHandles, directoryCache);
  try {
    const bytes = await readNativeBoundedHandle(file.handle, request.maximumBytes);
    assertNativeFingerprint(file.metadata, await file.handle.stat({ bigint: true }));
    if (BigInt(bytes.byteLength) !== file.metadata.size) throw boundaryError();
    return Object.freeze({ bytes, metadata: file.metadata });
  } finally {
    const index = openedHandles.lastIndexOf(file);
    if (index === -1) throw boundaryError();
    await file.handle.close();
    openedHandles.splice(index, 1);
  }
}

async function validateNativeCollectedFiles(root, items, openedHandles, directoryCache, maximumBytes) {
  for (const item of items) {
    const current = await captureNativeFile(root, item.rootPath, {
      maximumBytes,
      exactMode: null,
    }, openedHandles, directoryCache);
    assertNativeFingerprint(item.metadata, current.metadata);
    if (
      current.bytes.byteLength !== item.bytes
      || createHash("sha256").update(current.bytes).digest("hex") !== item.sha256
    ) {
      throw boundaryError();
    }
  }
}

function assertNativeRegularFile(metadata, maximumBytes, exactMode) {
  if (
    !Number.isInteger(maximumBytes)
    || maximumBytes < 1
    || !metadata.isFile()
    || metadata.nlink !== 1n
    || Number(metadata.mode & 0o022n) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
    || metadata.size < 0n
    || metadata.size > BigInt(maximumBytes)
    || (exactMode !== null && Number(metadata.mode & 0o7777n) !== exactMode)
  ) {
    throw boundaryError();
  }
}

async function readNativeBoundedHandle(handle, maximumBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maximumBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maximumBytes) throw boundaryError();
  return Buffer.concat(chunks, total);
}

function assertNativeFingerprint(before, after) {
  for (const key of ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"]) {
    if (before[key] !== after[key]) throw boundaryError();
  }
}

async function validateNativeHandles(root, openedHandles) {
  assertNativeFingerprint(root.metadata, await root.handle.stat({ bigint: true }));
  for (const opened of openedHandles) {
    assertNativeFingerprint(opened.metadata, await opened.handle.stat({ bigint: true }));
  }
}

async function closeNativeHandles(openedHandles) {
  for (const opened of openedHandles.reverse()) await opened.handle.close().catch(() => {});
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
