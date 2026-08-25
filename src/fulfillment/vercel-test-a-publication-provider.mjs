import { createHash } from "node:crypto";

const VERCEL_API_ORIGIN = "https://api.vercel.com";
const PENDING_STATES = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);
const TERMINAL_FAILURE_STATES = new Set(["ERROR", "CANCELED", "DELETED", "BLOCKED"]);

export function createVercelTestAPublicationProvider(options = {}) {
  const token = requireString(options.token, "Vercel TEST-A publication token");
  const teamId = requireIdentifier(options.teamId, "Vercel TEST-A team id");
  const projectId = requireIdentifier(options.projectId, "Vercel TEST-A project id");
  const projectName = requireProjectName(options.projectName);
  const stableOrigin = exactHttpsOrigin(options.stableOrigin);
  const canaryJobId = requireIdentifier(options.canaryJobId, "TEST-A canary job id");
  const canaryRevisionId = requireIdentifier(options.canaryRevisionId, "TEST-A canary revision id");
  const artifactResolver = options.artifactResolver;
  if (typeof artifactResolver?.resolve !== "function") {
    throw new Error("A TEST-A publication artifact resolver is required.");
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required for Vercel publication.");
  const pollIntervalMs = nonNegativeInteger(options.pollIntervalMs, 1_000);
  const maxPollAttempts = positiveInteger(options.maxPollAttempts, 30);
  const stableUrl = `${stableOrigin}/announcements/${encodeURIComponent(canaryJobId)}`;
  const teamQuery = `teamId=${encodeURIComponent(teamId)}`;

  async function reconcile(request) {
    assertCanaryRequest(request, canaryJobId, canaryRevisionId);
    const resolved = await artifactResolver.resolve(request);
    const deployment = await findExactDeployment(request);
    if (!deployment) return null;
    return finalizeDeployment(deployment, request, resolved);
  }

  async function publish(request) {
    assertCanaryRequest(request, canaryJobId, canaryRevisionId);
    const resolved = await artifactResolver.resolve(request);
    const existing = await findExactDeployment(request);
    if (existing) return finalizeDeployment(existing, request, resolved);

    const publicationManifest = publicationManifestFor(request, resolved.files);
    const generatedFiles = [
      {
        publicPath: `announcements/${canaryJobId}/.publication.json`,
        bytes: Buffer.from(`${JSON.stringify(publicationManifest, null, 2)}\n`, "utf8"),
      },
      {
        publicPath: "vercel.json",
        bytes: Buffer.from(`${JSON.stringify(vercelConfiguration(canaryJobId, resolved.entrypointPath), null, 2)}\n`, "utf8"),
      },
    ];
    const deploymentFiles = [
      ...resolved.files.map((file) => ({
        publicPath: `announcements/${canaryJobId}/${file.publicPath}`,
        bytes: file.bytes,
      })),
      ...generatedFiles,
    ];
    const uploaded = [];
    for (const file of deploymentFiles) {
      const sha = sha1(file.bytes);
      await vercelRequest(`/v2/files?${teamQuery}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-vercel-digest": sha,
        },
        body: file.bytes,
      }, new Set([200, 201, 409]));
      uploaded.push({ file: file.publicPath, sha, size: file.bytes.byteLength });
    }

    const deployment = await vercelJson(`/v13/deployments?${teamQuery}`, {
      method: "POST",
      body: JSON.stringify({
        name: projectName,
        project: projectId,
        files: uploaded,
        meta: metadataFor(request),
        projectSettings: { framework: null },
      }),
    }, new Set([200, 201]));
    const deploymentId = deployment?.id || deployment?.uid;
    requireIdentifier(deploymentId, "Vercel deployment id");
    return finalizeDeployment({ ...deployment, uid: deploymentId }, request, resolved);
  }

  async function findExactDeployment(request) {
    let until;
    let exactDeployment = null;
    const seenCursors = new Set();
    for (let page = 0; page < 100; page += 1) {
      const cursorQuery = until === undefined ? "" : `&until=${encodeURIComponent(until)}`;
      const result = await vercelJson(
        `/v7/deployments?projectId=${encodeURIComponent(projectId)}&limit=100${cursorQuery}&${teamQuery}`,
        { method: "GET" },
      );
      const matches = (Array.isArray(result?.deployments) ? result.deployments : []).filter((deployment) => (
        deployment?.projectId === projectId && metadataMatches(deployment.meta, request)
      ));
      if (matches.length > 1 || (matches.length === 1 && exactDeployment)) {
        throw providerError("Vercel returned multiple deployments for one exact TEST-A publication operation.", false);
      }
      if (matches.length === 1) exactDeployment = matches[0];
      const next = result?.pagination?.next;
      if (next === null || next === undefined) return exactDeployment;
      const nextNumber = Number(next);
      const nextCursor = String(next);
      if (
        !Number.isSafeInteger(nextNumber)
        || nextNumber < 0
        || seenCursors.has(nextCursor)
        || (until !== undefined && nextNumber >= Number(until))
      ) {
        throw providerError("Vercel returned an invalid deployment pagination cursor.", true);
      }
      seenCursors.add(nextCursor);
      until = nextCursor;
    }
    throw providerError("Vercel deployment reconciliation exceeded its bounded page limit.", true);
  }

  async function finalizeDeployment(deployment, request, resolved) {
    const ready = await waitForReady(deployment);
    const deploymentId = requireIdentifier(ready?.uid || ready?.id, "Vercel deployment id");
    if (ready.projectId && ready.projectId !== projectId) {
      throw providerError("Vercel deployment resolved outside the configured TEST-A project.", false);
    }
    const aliasResponse = await vercelRequest(
      `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases?${teamQuery}`,
      {
        method: "POST",
        body: JSON.stringify({ alias: new URL(stableOrigin).hostname }),
      },
      new Set([200, 201, 409]),
    );
    await aliasResponse.arrayBuffer();
    await verifyStablePublication(request, resolved);
    return {
      provider: "vercel",
      providerReceiptId: deploymentId,
      stableUrl,
      revisionId: request.revisionId,
      artifactSetId: request.artifactSetId,
      artifactManifestDigest: request.artifactManifestDigest,
      idempotencyKey: request.idempotencyKey,
    };
  }

  async function waitForReady(initial) {
    let deployment = initial;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const state = deployment?.readyState || deployment?.state;
      if (state === "READY") return deployment;
      if (TERMINAL_FAILURE_STATES.has(state)) {
        throw providerError(`Vercel TEST-A deployment ended in ${state}.`, false);
      }
      if (state && !PENDING_STATES.has(state)) {
        throw providerError("Vercel TEST-A deployment returned an unknown readiness state.", true);
      }
      if (attempt > 0 || state) await wait(pollIntervalMs);
      const deploymentId = requireIdentifier(deployment?.uid || deployment?.id, "Vercel deployment id");
      deployment = await vercelJson(
        `/v13/deployments/${encodeURIComponent(deploymentId)}?${teamQuery}`,
        { method: "GET" },
      );
    }
    throw providerError("Vercel TEST-A deployment did not become ready within the bounded poll window.", true);
  }

  async function verifyStablePublication(request, resolved) {
    let lastError;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      try {
        const manifestResponse = await publicFetch(`${stableUrl}/.publication.json`);
        const manifest = JSON.parse(Buffer.from(await manifestResponse.arrayBuffer()).toString("utf8"));
        const expectedManifest = publicationManifestFor(request, resolved.files);
        if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
          throw providerError("Stable publication manifest does not match the exact approved operation.", true);
        }
        for (const file of resolved.files) {
          const response = await publicFetch(`${stableUrl}/${encodePublicPath(file.publicPath)}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.byteLength !== file.bytes.byteLength || sha256(bytes) !== file.sha256) {
            throw providerError(`Stable publication bytes do not match ${file.publicPath}.`, true);
          }
        }
        const index = resolved.files.find(({ publicPath }) => publicPath === resolved.entrypointPath);
        const canonicalUrl = `${stableUrl}/${resolved.entrypointPath.slice(0, -"index.html".length)}`;
        const redirectResponse = await fetchImpl(stableUrl, { redirect: "manual" });
        const redirectTarget = redirectResponse.headers.get("location");
        if (
          ![307, 308].includes(redirectResponse.status)
          || !redirectTarget
          || new URL(redirectTarget, stableOrigin).href !== canonicalUrl
        ) {
          throw providerError("Stable TEST-A publication did not return its exact language redirect.", true);
        }
        const stableResponse = await publicFetch(canonicalUrl);
        const stableBytes = Buffer.from(await stableResponse.arrayBuffer());
        if (stableBytes.byteLength !== index.bytes.byteLength || sha256(stableBytes) !== index.sha256) {
          throw providerError("Stable TEST-A URL does not resolve the exact approved index bytes.", true);
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < maxPollAttempts) await wait(pollIntervalMs);
      }
    }
    throw providerError("Stable TEST-A publication could not be verified after alias assignment.", true, lastError);
  }

  async function publicFetch(url) {
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", redirect: "error" });
    } catch (error) {
      throw providerError("Stable TEST-A publication read-back failed.", true, error);
    }
    if (!response?.ok) {
      throw providerError(`Stable TEST-A publication read-back returned HTTP ${response?.status}.`, true);
    }
    return response;
  }

  async function vercelJson(resource, init, allowedStatuses = new Set([200])) {
    const response = await vercelRequest(resource, init, allowedStatuses);
    try {
      return await response.json();
    } catch (error) {
      throw providerError("Vercel returned an invalid JSON response.", true, error);
    }
  }

  async function vercelRequest(resource, init, allowedStatuses) {
    let response;
    try {
      response = await fetchImpl(`${VERCEL_API_ORIGIN}${resource}`, {
        ...init,
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body && !Buffer.isBuffer(init.body) ? { "content-type": "application/json" } : {}),
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      throw providerError("Vercel TEST-A publication request failed.", true, error);
    }
    if (!allowedStatuses.has(response?.status)) {
      const retryable = !response || response.status === 408 || response.status === 429 || response.status >= 500;
      throw providerError(`Vercel TEST-A publication returned HTTP ${response?.status}.`, retryable);
    }
    return response;
  }

  return Object.freeze({ reconcile, publish });
}

function assertCanaryRequest(request, canaryJobId, canaryRevisionId) {
  if (
    request?.environment !== "test"
    || request?.product !== "announcement-page"
    || request.jobId !== canaryJobId
    || request.revisionId !== canaryRevisionId
    || request.artifactSet?.kind !== "prepared_bundle"
  ) {
    throw providerError("Publication is restricted to the configured TEST-A canary job and revision.", false);
  }
  if (
    typeof request.artifactSetId !== "string"
    || !/^[A-Za-z0-9_-]{1,160}$/.test(request.artifactSetId)
    || request.artifactSet?.artifactSetId !== request.artifactSetId
  ) {
    throw providerError("Publication artifact set id does not match the exact persisted operation.", false);
  }
}

function metadataFor(request) {
  return {
    bbCanaryJobId: request.jobId,
    bbRevisionId: request.revisionId,
    bbArtifactSetId: request.artifactSetId,
    bbArtifactManifestDigest: request.artifactManifestDigest,
    bbIdempotencyKey: request.idempotencyKey,
  };
}

function metadataMatches(metadata, request) {
  const expected = metadataFor(request);
  return Object.entries(expected).every(([key, value]) => metadata?.[key] === value);
}

function publicationManifestFor(request, files) {
  return {
    schemaVersion: "1.0",
    jobId: request.jobId,
    revisionId: request.revisionId,
    artifactSetId: request.artifactSetId,
    artifactManifestDigest: request.artifactManifestDigest,
    idempotencyKey: request.idempotencyKey,
    files: files.map((file) => ({
      path: file.publicPath,
      sha256: file.sha256,
      bytes: file.bytes.byteLength,
    })),
  };
}

function vercelConfiguration(jobId, entrypointPath) {
  return {
    redirects: [{
      source: `/announcements/${jobId}`,
      destination: `/announcements/${jobId}/${entrypointPath.slice(0, -"index.html".length)}`,
      permanent: false,
    }],
    headers: [{
      source: `/announcements/${jobId}/(.*)`,
      headers: [{ key: "cache-control", value: "private, no-store, max-age=0" }],
    }],
  };
}

function encodePublicPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function exactHttpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The Vercel TEST-A stable origin must be an exact HTTPS origin.");
  }
  return url.origin;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
  return value.trim();
}

function requireIdentifier(value, label) {
  const normalized = requireString(value, label);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function requireProjectName(value) {
  const normalized = requireString(value, "Vercel TEST-A project name");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(normalized)) {
    throw new Error("Vercel TEST-A project name is invalid.");
  }
  return normalized;
}

function nonNegativeInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("pollIntervalMs must be a non-negative integer.");
  return value;
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("maxPollAttempts must be a positive integer.");
  return value;
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function wait(milliseconds) {
  return milliseconds === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function providerError(message, retryable, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.reasonCode = retryable ? "publication_provider_unavailable" : "publication_scope_invalid";
  error.retryable = retryable;
  return error;
}
