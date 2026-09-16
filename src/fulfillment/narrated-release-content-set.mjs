import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildIdFromPage } from "../../scripts/lib/common.mjs";
import { captureCommittedArtifactContentSet } from "./committed-artifact-content-set.mjs";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 2_048;
const DIGEST = /^[a-f0-9]{64}$/u;

/**
 * Commit the exact public projection reviewed by the narration operator.
 *
 * The content-approved prepared bundle stays immutable. Narration generation
 * writes only review artifacts. This capability overlays the reviewed
 * transcript and audio on the prepared deploy tree without creating a mutable
 * third directory or exposing private review metadata to publication.
 */
export async function captureNarratedReleaseContentSet(input) {
  const maximumFileBytes = input.maximumFileBytes ?? MAX_FILE_BYTES;
  const maximumJsonBytes = input.maximumJsonBytes ?? MAX_JSON_BYTES;
  const maximumTotalBytes = input.maximumTotalBytes ?? MAX_TOTAL_BYTES;
  const maximumFiles = input.maximumFiles ?? MAX_FILES;
  const prepared = await captureCommittedArtifactContentSet({
    authority: { type: "producer-owned" },
    rootPath: input.rootPath,
    inventoryRoot: input.preparedRoot,
    inventoryPrefix: "",
    excludedPaths: ["job.json"],
    pagePath: path.join(input.preparedRoot, "artifacts", "current", "page.json"),
    pageManifestPath: null,
    transcriptPath: path.join(input.preparedRoot, "artifacts", "current", "transcript.json"),
    transcriptManifestPath: null,
    requiredPaths: [],
    maximumFileBytes,
    maximumJsonBytes,
    maximumTotalBytes,
    maximumFiles,
  });
  if (!prepared) return null;

  let narration;
  try {
    narration = await captureCommittedArtifactContentSet({
      authority: { type: "producer-owned" },
      rootPath: input.rootPath,
      inventoryRoot: input.narrationArtifactsRoot,
      inventoryPrefix: "artifacts",
      excludedPaths: [],
      pagePath: input.approvedPagePath,
      pageManifestPath: "approved/page.json",
      transcriptPath: path.join(input.narrationArtifactsRoot, "transcript.json"),
      transcriptManifestPath: "artifacts/transcript.json",
      requiredPaths: [],
      maximumFileBytes,
      maximumJsonBytes,
      maximumTotalBytes,
      maximumFiles,
    });
    if (!narration) return null;
    return composeNarratedRelease({
      prepared,
      narration,
      expectedFiles: input.expectedFiles,
      maximumFiles,
      maximumTotalBytes,
    });
  } finally {
    prepared.dispose();
    narration?.dispose();
  }
}

function composeNarratedRelease({ prepared, narration, expectedFiles, maximumFiles, maximumTotalBytes }) {
  if (prepared.manifest.pageDigest !== narration.manifest.pageDigest) {
    throw narratedReleaseError("Prepared release is not bound to the narration-approved page.");
  }
  const page = parseApprovedPage(narration.read("approved/page.json"));
  const slug = requireSafeSegment(page.slug, "approved page slug");
  const buildId = requireSafeSegment(buildIdFromPage(page), "approved page build id");
  const deployPrefix = `deploy/${slug}/`;
  const transcriptPath = `${deployPrefix}transcript.json`;
  const audioPrefix = `${deployPrefix}_assets/${buildId}/audio/`;
  const publicBytes = new Map();

  for (const file of prepared.manifest.files) {
    if (!file.path.startsWith(deployPrefix)) continue;
    if (file.path === transcriptPath || file.path.startsWith(audioPrefix)) continue;
    addPublicFile(publicBytes, file.path, prepared.read(file.path));
  }

  let hasNarratedTranscript = false;
  let narrationAudioFileCount = 0;
  let narrationAudioMediaCount = 0;
  for (const file of narration.manifest.files) {
    if (file.path === "approved/page.json") continue;
    if (file.path === "artifacts/transcript.json") {
      addPublicFile(publicBytes, transcriptPath, narration.read(file.path));
      hasNarratedTranscript = true;
      continue;
    }
    if (file.path.startsWith("artifacts/audio/")) {
      const relative = file.path.slice("artifacts/audio/".length);
      if (!relative) throw narratedReleaseError("Narration audio path is incomplete.");
      addPublicFile(publicBytes, `${audioPrefix}${relative}`, narration.read(file.path));
      narrationAudioFileCount += 1;
      if (file.path.endsWith(".mp3")) narrationAudioMediaCount += 1;
      continue;
    }
    throw narratedReleaseError(`Narration review contains a non-public artifact: ${file.path}`);
  }

  if (!hasNarratedTranscript || narrationAudioFileCount === 0 || narrationAudioMediaCount === 0) {
    throw narratedReleaseError("Narration review has no deployable transcript or audio media.");
  }
  if (![...publicBytes.keys()].some((filePath) => filePath.startsWith(deployPrefix) && filePath.endsWith("/index.html"))) {
    throw narratedReleaseError("Narrated release has no deployable HTML entry point.");
  }

  const publicPagePath = `${deployPrefix}page.json`;
  if (!publicBytes.has(publicPagePath)) {
    throw narratedReleaseError("Narrated release has no public page artifact.");
  }

  const files = [...publicBytes.entries()]
    .map(([filePath, bytes]) => Object.freeze({
      path: filePath,
      storageId: `local-test:sha256:${sha256(bytes)}`,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (files.length > maximumFiles || !Number.isSafeInteger(totalBytes) || totalBytes > maximumTotalBytes) {
    throw narratedReleaseError("Narrated release exceeds the configured content limits.");
  }
  assertExpectedFiles(files, expectedFiles);

  let disposed = false;
  return Object.freeze({
    manifest: Object.freeze({
      files: Object.freeze(files),
      pageDigest: narration.manifest.pageDigest,
      transcriptDigest: narration.manifest.transcriptDigest,
      totalBytes,
    }),
    read(filePath) {
      if (disposed) throw narratedReleaseError("Narrated release content capability is disposed.");
      const bytes = publicBytes.get(filePath);
      if (!bytes) throw narratedReleaseError(`Narrated release path is unavailable: ${filePath}`);
      return Buffer.from(bytes);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const bytes of publicBytes.values()) bytes.fill(0);
      publicBytes.clear();
    },
  });
}

function parseApprovedPage(bytes) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw narratedReleaseError("Narration-approved page is not valid JSON.");
  }
}

function requireSafeSegment(value, label) {
  if (
    typeof value !== "string"
    || value === ""
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
  ) {
    throw narratedReleaseError(`${label} is invalid.`);
  }
  return value;
}

function addPublicFile(files, filePath, bytes) {
  if (files.has(filePath)) throw narratedReleaseError(`Narrated release path collides: ${filePath}`);
  files.set(filePath, Buffer.from(bytes));
}

function assertExpectedFiles(actual, expected) {
  if (expected === undefined || expected === null) return;
  if (!Array.isArray(expected)) throw narratedReleaseError("Narrated release manifest files are invalid.");
  const normalized = expected.map((file) => {
    if (
      !file
      || typeof file.path !== "string"
      || typeof file.storageId !== "string"
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || !DIGEST.test(file.sha256 || "")
    ) {
      throw narratedReleaseError("Narrated release manifest files are invalid.");
    }
    return {
      path: file.path,
      storageId: file.storageId,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!isDeepStrictEqual(actual.map((file) => ({ ...file })), normalized)) {
    throw narratedReleaseError("Narrated release bytes do not match the persisted manifest.");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function narratedReleaseError(message) {
  const error = new Error(message);
  error.reasonCode = "artifact_content_commitment_invalid";
  error.retryable = false;
  return error;
}
