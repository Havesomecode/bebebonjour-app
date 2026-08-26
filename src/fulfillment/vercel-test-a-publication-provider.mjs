import { createHash } from "node:crypto";

const VERCEL_API_ORIGIN = "https://api.vercel.com";
const PUBLICATION_CACHE_CONTROL = "private, no-store, max-age=0";
const PENDING_STATES = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);
const TERMINAL_FAILURE_STATES = new Set(["ERROR", "CANCELED", "DELETED", "BLOCKED"]);

export function createVercelTestAPublicationProvider(options = {}) {
  const token = requireString(options.token, "Vercel TEST-A publication token");
  const teamId = requireIdentifier(options.teamId, "Vercel TEST-A team id");
  const projectId = requireIdentifier(options.projectId, "Vercel TEST-A project id");
  const projectName = requireProjectName(options.projectName);
  const stableOrigin = exactHttpsOrigin(options.stableOrigin);
  const stableHostname = new URL(stableOrigin).hostname;
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

    const configurationBytes = vercelConfigurationBytes(canaryJobId, resolved.entrypointPath);
    const publicationManifest = publicationManifestFor(request, resolved.files, configurationBytes);
    const generatedFiles = [
      {
        publicPath: `announcements/${canaryJobId}/.publication.json`,
        bytes: publicationManifestBytes(publicationManifest),
      },
      {
        publicPath: "vercel.json",
        bytes: configurationBytes,
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
    const deploymentOrigin = exactVercelDeploymentOrigin(ready?.url);
    await verifyProviderDeploymentEvidence(deploymentId, deploymentOrigin, request, resolved);
    const deploymentUrl = `${deploymentOrigin}/announcements/${encodeURIComponent(canaryJobId)}`;
    await verifyPublication(deploymentUrl, request, resolved, {
      label: "Selected Vercel deployment",
      finalMessage: "Selected Vercel deployment could not be verified before alias assignment.",
      retryMismatches: false,
    });
    const aliasResponse = await vercelRequest(
      `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases?${teamQuery}`,
      {
        method: "POST",
        body: JSON.stringify({ alias: stableHostname }),
      },
      new Set([200]),
    );
    await verifyAliasMutationResponse(aliasResponse, deploymentId);
    await verifyProviderAliasEvidence(deploymentId);
    await verifyPublication(stableUrl, request, resolved, {
      label: "Stable TEST-A publication",
      finalMessage: "Stable TEST-A publication could not be verified after alias assignment.",
      retryMismatches: true,
    });
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

  async function verifyPublication(publicationUrl, request, resolved, verification) {
    const configurationBytes = vercelConfigurationBytes(request.jobId, resolved.entrypointPath);
    const expectedManifest = publicationManifestFor(request, resolved.files, configurationBytes);
    const expectedManifestBytes = publicationManifestBytes(expectedManifest);
    let lastError;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      try {
        const manifestResponse = await publicFetch(`${publicationUrl}/.publication.json`, verification);
        const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
        if (!manifestBytes.equals(expectedManifestBytes)) {
          throw publicationMismatch(
            `${verification.label} raw publication manifest bytes or Vercel configuration do not match the exact approved operation.`,
            verification,
          );
        }
        for (const file of resolved.files) {
          const response = await publicFetch(`${publicationUrl}/${encodePublicPath(file.publicPath)}`, verification);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.byteLength !== file.bytes.byteLength || sha256(bytes) !== file.sha256) {
            throw publicationMismatch(`${verification.label} bytes do not match ${file.publicPath}.`, verification);
          }
        }
        const index = resolved.files.find(({ publicPath }) => publicPath === resolved.entrypointPath);
        const canonicalUrl = `${publicationUrl}/${resolved.entrypointPath.slice(0, -"index.html".length)}`;
        const redirectResponse = await fetchImpl(publicationUrl, { method: "GET", redirect: "manual" });
        const redirectTarget = redirectResponse.headers.get("location");
        if (
          ![307, 308].includes(redirectResponse.status)
          || !redirectTarget
          || new URL(redirectTarget, publicationUrl).href !== canonicalUrl
        ) {
          throw publicationMismatch(`${verification.label} did not return its exact language redirect.`, verification);
        }
        const canonicalResponse = await publicFetch(canonicalUrl, verification);
        const canonicalBytes = Buffer.from(await canonicalResponse.arrayBuffer());
        if (canonicalBytes.byteLength !== index.bytes.byteLength || sha256(canonicalBytes) !== index.sha256) {
          throw publicationMismatch(
            `${verification.label} URL does not resolve the exact approved index bytes.`,
            verification,
          );
        }
        return;
      } catch (error) {
        lastError = error;
        if (error?.retryable === false) throw error;
        if (attempt + 1 < maxPollAttempts) await wait(pollIntervalMs);
      }
    }
    throw providerError(verification.finalMessage, true, lastError);
  }

  async function verifyProviderDeploymentEvidence(deploymentId, deploymentOrigin, request, resolved) {
    const deployment = await vercelEvidenceJson(
      `/v13/deployments/${encodeURIComponent(deploymentId)}?${teamQuery}`,
    );
    let providerDeploymentOrigin;
    try {
      providerDeploymentOrigin = exactVercelDeploymentOrigin(deployment?.url);
    } catch (error) {
      throw providerError("Vercel provider deployment evidence is malformed.", false, error);
    }
    if (
      (deployment?.id || deployment?.uid) !== deploymentId
      || deployment.projectId !== projectId
      || deployment.readyState !== "READY"
      || !metadataMatches(deployment.meta, request)
      || providerDeploymentOrigin !== deploymentOrigin
    ) {
      throw providerError(
        "Vercel provider deployment evidence does not match the exact READY TEST-A deployment.",
        false,
      );
    }

    const inventory = await vercelEvidenceJson(
      `/v6/deployments/${encodeURIComponent(deploymentId)}/files?${teamQuery}`,
    );
    const files = flattenDeploymentFiles(inventory);
    const expectedPaths = [
      ...resolved.files.map(({ publicPath }) => `announcements/${canaryJobId}/${publicPath}`),
      `announcements/${canaryJobId}/.publication.json`,
      "vercel.json",
    ].sort();
    const actualPaths = files.map(({ path }) => path).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw providerError(
        "Vercel provider deployment inventory does not match the exact approved file set.",
        false,
      );
    }

    const configurationFile = files.find(({ path }) => path === "vercel.json");
    const configurationEvidence = await vercelEvidenceJson(
      `/v8/deployments/${encodeURIComponent(deploymentId)}/files/${encodeURIComponent(configurationFile.uid)}?${teamQuery}`,
    );
    const configurationBytes = decodeProviderFileContents(configurationEvidence);
    const expectedConfigurationBytes = vercelConfigurationBytes(request.jobId, resolved.entrypointPath);
    if (!configurationBytes.equals(expectedConfigurationBytes)) {
      throw providerError(
        "Vercel provider configuration evidence does not match the exact approved routing and header configuration.",
        false,
      );
    }
  }

  async function verifyProviderAliasEvidence(deploymentId) {
    let alias;
    try {
      alias = await vercelEvidenceJson(
        `/v4/aliases/${encodeURIComponent(stableHostname)}`
        + `?projectId=${encodeURIComponent(projectId)}&${teamQuery}`,
      );
    } catch (error) {
      throw providerError(
        `Vercel provider alias evidence could not be read: ${error.message}`,
        error?.retryable === true,
      );
    }
    if (
      alias?.alias !== stableHostname
      || alias.deploymentId !== deploymentId
      || alias.projectId !== projectId
    ) {
      throw providerError(
        "Vercel provider alias evidence does not match the exact TEST-A hostname, deployment, and project.",
        false,
      );
    }
  }

  async function verifyAliasMutationResponse(response, deploymentId) {
    let alias;
    try {
      alias = await response.json();
    } catch (error) {
      throw providerError("Vercel alias assignment returned a malformed response.", false, error);
    }
    if (
      !alias
      || typeof alias !== "object"
      || Array.isArray(alias)
      || alias.alias !== stableHostname
      || alias.deploymentId !== deploymentId
      || alias.projectId !== projectId
    ) {
      throw providerError(
        "Vercel alias assignment does not match the exact TEST-A hostname, deployment, and project.",
        false,
      );
    }
  }

  async function publicFetch(url, verification) {
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", redirect: "error" });
    } catch (error) {
      throw providerError(`${verification.label} read-back failed.`, true, error);
    }
    if (!response?.ok) {
      throw providerError(`${verification.label} read-back returned HTTP ${response?.status}.`, true);
    }
    if (!verification.retryMismatches && response.headers.get("cache-control") !== PUBLICATION_CACHE_CONTROL) {
      throw publicationMismatch(
        `${verification.label} did not return the exact private cache policy.`,
        verification,
      );
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

  async function vercelEvidenceJson(resource) {
    const response = await vercelRequest(resource, { method: "GET" }, new Set([200]));
    try {
      return await response.json();
    } catch (error) {
      throw providerError("Vercel returned malformed provider deployment evidence.", false, error);
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

function publicationManifestFor(request, files, configurationBytes) {
  return {
    schemaVersion: "1.0",
    jobId: request.jobId,
    revisionId: request.revisionId,
    artifactSetId: request.artifactSetId,
    artifactManifestDigest: request.artifactManifestDigest,
    idempotencyKey: request.idempotencyKey,
    vercelConfiguration: {
      sha256: sha256(configurationBytes),
      bytes: configurationBytes.byteLength,
    },
    files: files.map((file) => ({
      path: file.publicPath,
      sha256: file.sha256,
      bytes: file.bytes.byteLength,
    })),
  };
}

function publicationManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function flattenDeploymentFiles(inventory) {
  if (!Array.isArray(inventory)) {
    throw providerError("Vercel provider deployment inventory is malformed.", false);
  }
  const files = [];
  const seenPaths = new Set();
  let nodeCount = 0;
  const visit = (nodes, parentPath, depth) => {
    if (!Array.isArray(nodes) || depth > 100) {
      throw providerError("Vercel provider deployment inventory is malformed.", false);
    }
    for (const node of nodes) {
      nodeCount += 1;
      if (
        nodeCount > 10_000
        || !node
        || typeof node !== "object"
        || typeof node.name !== "string"
        || node.name.length === 0
        || node.name === "."
        || node.name === ".."
        || /[\\/]/u.test(node.name)
        || !Number.isSafeInteger(node.mode)
        || node.mode < 0
      ) {
        throw providerError("Vercel provider deployment inventory is malformed.", false);
      }
      const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
      if (seenPaths.has(currentPath)) {
        throw providerError("Vercel provider deployment inventory is malformed.", false);
      }
      seenPaths.add(currentPath);
      if (node.type === "directory") {
        visit(node.children, currentPath, depth + 1);
        continue;
      }
      if (
        node.type !== "file"
        || typeof node.uid !== "string"
        || !/^[A-Za-z0-9_-]{1,160}$/u.test(node.uid)
        || node.children !== undefined
      ) {
        throw providerError("Vercel provider deployment inventory is malformed.", false);
      }
      files.push({ path: currentPath, uid: node.uid });
    }
  };
  visit(inventory, "", 0);
  return files;
}

function decodeProviderFileContents(evidence) {
  if (
    evidence?.encoding !== "base64"
    || typeof evidence.content !== "string"
    || evidence.content.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(evidence.content)
  ) {
    throw providerError("Vercel provider configuration evidence is malformed.", false);
  }
  const bytes = Buffer.from(evidence.content, "base64");
  if (bytes.toString("base64") !== evidence.content) {
    throw providerError("Vercel provider configuration evidence is malformed.", false);
  }
  return bytes;
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
      headers: [{ key: "cache-control", value: PUBLICATION_CACHE_CONTROL }],
    }],
  };
}

function vercelConfigurationBytes(jobId, entrypointPath) {
  return Buffer.from(`${JSON.stringify(vercelConfiguration(jobId, entrypointPath), null, 2)}\n`, "utf8");
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

function exactVercelDeploymentOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw providerError("Vercel deployment did not include its immutable URL.", true);
  }
  let url;
  try {
    const normalized = value.includes("://") ? value : `https://${value}`;
    url = new URL(normalized);
  } catch (error) {
    throw providerError("Vercel deployment returned an invalid immutable URL.", true, error);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.hostname.endsWith(".vercel.app")
  ) {
    throw providerError("Vercel deployment returned an invalid immutable HTTPS origin.", true);
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

function publicationMismatch(message, verification, cause) {
  return providerError(message, verification.retryMismatches, cause);
}
