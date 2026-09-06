import { createHash } from "node:crypto";

const DIGEST = /^[a-f0-9]{64}$/u;
const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const REVISION_ID = /^r[1-9][0-9]*$/u;
const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export function createConvexGenerationArtifactStore(options = {}) {
  const client = options.client;
  const authorization = options.authorization;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const artifactReadOrigin = convexSiteOrigin(options.convexUrl);
  if (!client
    || typeof client.query !== "function"
    || typeof client.mutation !== "function") {
    throw new Error("Convex generation storage requires a query and mutation client.");
  }
  if (!authorization
    || typeof authorization !== "object"
    || Array.isArray(authorization)
    || Object.keys(authorization).sort().join("\0") !== "commandId\0leaseToken\0workerId\0workerToken"
    || typeof authorization.workerToken !== "string"
    || Buffer.byteLength(authorization.workerToken, "utf8") < 32) {
    throw new Error("Convex generation storage claim authorization is invalid.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Convex generation storage requires fetch.");
  }

  return Object.freeze({
    async readEditorialApproval(jobId) {
      assertJobId(jobId);
      const approval = await client.query("generation:readEditorialApproval", { ...authorization, jobId });
      if (!approval) throw new Error("The job-scoped editorial approval is not provisioned.");
      return structuredClone(approval);
    },

    async readArtifactSet(jobId, revisionId, kind = "private_review") {
      assertJobId(jobId);
      assertRevisionId(revisionId);
      assertKind(kind);
      const value = await client.query("generation:readArtifactSet", {
        ...authorization,
        jobId,
        revisionId,
        kind,
      });
      if (value === null) return null;
      assertArtifactReadback(value, { jobId, revisionId, kind });
      return structuredClone(value);
    },

    async uploadArtifactSet({ jobId, artifactSet, readArtifact }) {
      assertJobId(jobId);
      assertArtifactSet(artifactSet, {
        jobId,
        revisionId: artifactSet?.revisionId,
        kind: "private_review",
      });
      if (typeof readArtifact !== "function") {
        throw new Error("Convex generation artifact upload requires a bounded artifact reader.");
      }

      let totalBytes = 0;
      const uploadedFiles = [];
      for (const file of artifactSet.files) {
        const bytes = Buffer.from(await readArtifact(file));
        if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
          throw new Error("Generated artifact bytes do not match their collected manifest.");
        }
        totalBytes += bytes.byteLength;
        if (bytes.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
          throw new Error("Generated artifact bytes exceed the hosted storage boundary.");
        }
        const uploadUrl = await client.mutation("generation:createArtifactUploadUrl", {
          ...authorization,
          jobId,
        });
        const response = await fetchImpl(uploadUrl, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
        });
        if (!response?.ok) throw new Error("Convex generation artifact upload failed.");
        const payload = await response.json();
        if (typeof payload?.storageId !== "string" || payload.storageId.trim() === "") {
          throw new Error("Convex generation artifact upload returned an invalid storage id.");
        }
        uploadedFiles.push({ ...file, storageId: payload.storageId });
      }

      const manifest = {
        schemaVersion: "1.0",
        kind: artifactSet.kind,
        revisionId: artifactSet.revisionId,
        files: uploadedFiles,
      };
      const hostedArtifactSet = {
        kind: artifactSet.kind,
        revisionId: artifactSet.revisionId,
        pageDigest: artifactSet.pageDigest,
        transcriptDigest: artifactSet.transcriptDigest,
        assetManifestDigest: sha256(`${JSON.stringify(manifest, null, 2)}\n`),
        manifestRef: artifactSet.manifestRef,
        files: uploadedFiles,
      };
      const committed = await client.mutation("generation:commitArtifactSet", {
        ...authorization,
        jobId,
        artifactSet: hostedArtifactSet,
      });
      if (!committed?.artifactSet) {
        throw new Error("Convex generation artifact commit failed.");
      }
      assertArtifactSet(committed.artifactSet, { ...hostedArtifactSet, jobId });
      if (JSON.stringify(committed.artifactSet) !== JSON.stringify(hostedArtifactSet)) {
        throw new Error("Convex generation artifact commit readback diverged.");
      }
      return structuredClone(hostedArtifactSet);
    },

    async downloadArtifact(file, artifactSet) {
      assertFile(file);
      assertArtifactSet(artifactSet, {
        jobId: inferJobId(artifactSet?.manifestRef),
        revisionId: artifactSet?.revisionId,
        kind: "private_review",
      });
      const url = new URL("/generation/artifact", artifactReadOrigin);
      url.searchParams.set("jobId", inferJobId(artifactSet.manifestRef));
      url.searchParams.set("revisionId", artifactSet.revisionId);
      url.searchParams.set("kind", artifactSet.kind);
      url.searchParams.set("path", file.path);
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${authorization.workerToken}`,
          "x-bebebonjour-worker-id": authorization.workerId,
          "x-bebebonjour-command-id": authorization.commandId,
          "x-bebebonjour-lease-token": authorization.leaseToken,
        },
      });
      if (!response?.ok) {
        throw new Error("Convex generation artifact readback was not authorized.");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error("Convex generation artifact readback does not match its durable manifest.");
      }
      return bytes;
    },
  });
}

function convexSiteOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Convex generation storage requires an exact Convex deployment origin.");
  }
  if (
    url.protocol !== "https:"
    || url.origin !== value
    || !url.hostname.endsWith(".convex.cloud")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("Convex generation storage requires an exact Convex deployment origin.");
  }
  url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return url.origin;
}

function assertArtifactReadback(record, expected) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Convex generation artifact readback is invalid.");
  }
  assertArtifactSet(record.artifactSet, expected);
  if (
    !Array.isArray(record.files)
    || record.files.length !== record.artifactSet.files.length
    || record.files.some((file, index) => (
      JSON.stringify(file) !== JSON.stringify(record.artifactSet.files[index])
    ))
  ) {
    throw new Error("Convex generation artifact readback does not match the durable manifest.");
  }
  for (const file of record.files) assertFile(file);
}

function assertArtifactSet(value, expected) {
  const keys = [
    "assetManifestDigest",
    "files",
    "kind",
    "manifestRef",
    "pageDigest",
    "revisionId",
    "transcriptDigest",
  ];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== keys.join("\0")
    || value.kind !== expected.kind
    || value.revisionId !== expected.revisionId
    || !DIGEST.test(value.pageDigest || "")
    || !DIGEST.test(value.transcriptDigest || "")
    || !DIGEST.test(value.assetManifestDigest || "")
    || value.manifestRef !== `jobs/${expected.jobId || inferJobId(value.manifestRef)}/revisions/${value.revisionId}/manifests/${value.kind}.json`
    || !Array.isArray(value.files)
    || value.files.length === 0
    || value.files.length > MAX_FILES
  ) {
    throw new Error("Convex generation artifact set is invalid.");
  }
  let totalBytes = 0;
  const paths = new Set();
  for (const file of value.files) {
    assertFile(file);
    totalBytes += file.bytes;
    if (paths.has(file.path) || totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Convex generation artifact inventory is invalid.");
    }
    paths.add(file.path);
  }
}

function assertFile(file) {
  const keys = ["bytes", "path", "sha256", "storageId"];
  if (
    !file
    || typeof file !== "object"
    || Array.isArray(file)
    || Object.keys(file).sort().join("\0") !== keys.sort().join("\0")
    || !safeRelativePath(file.path)
    || !Number.isInteger(file.bytes)
    || file.bytes < 0
    || file.bytes > MAX_FILE_BYTES
    || !DIGEST.test(file.sha256 || "")
    || typeof file.storageId !== "string"
    || file.storageId.trim() === ""
  ) {
    throw new Error("Convex generation artifact file is invalid.");
  }
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function inferJobId(manifestRef) {
  return typeof manifestRef === "string" ? manifestRef.split("/")[1] : "";
}

function assertJobId(value) {
  if (typeof value !== "string" || !JOB_ID.test(value)) throw new Error("Generation storage job id is invalid.");
}

function assertRevisionId(value) {
  if (typeof value !== "string" || !REVISION_ID.test(value)) {
    throw new Error("Generation storage revision id is invalid.");
  }
}

function assertKind(value) {
  if (value !== "private_review") throw new Error("Generation storage artifact kind is invalid.");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
