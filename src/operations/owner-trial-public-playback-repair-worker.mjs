import { randomUUID, createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { stablePrivateValue as json } from "../fulfillment/private-generation-authority.mjs";
import { createOwnerTrialPublicArtifactResolver } from "../fulfillment/owner-trial-completion-capabilities.mjs";
import { projectOwnerTrialPlayback } from "../fulfillment/owner-trial-playback-projection.mjs";
import { createVercelTestAPublicationProvider, parseAuthoritativeVercelBuildInspection } from "../fulfillment/vercel-test-a-publication-provider.mjs";
import { publicToolbarRead } from "./owner-trial-publication-supersession-worker.mjs";
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const digest = value => hash(json(value));
const reject = reason => { throw new Error(`Owner trial public playback ${reason}.`); };
function deploymentIdentity(d) {
  const id = d?.id || d?.uid;
  if (!/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(id || "") || (d.id !== undefined && d.uid !== undefined && d.id !== d.uid)) reject("conflicting deployment identity");
  return id;
}
const publicationFacts = d => ({id:deploymentIdentity(d),projectId:d.projectId,readyState:d.readyState,url:d.url,meta:{bbCanaryJobId:d.meta?.bbCanaryJobId,bbRevisionId:d.meta?.bbRevisionId,bbArtifactSetId:d.meta?.bbArtifactSetId,bbArtifactManifestDigest:d.meta?.bbArtifactManifestDigest,bbIdempotencyKey:d.meta?.bbIdempotencyKey}});
function inventoryFiles(nodes) {
  const files = [], seen = new Set(); let count = 0;
  const visit = (nodes, parent = "", depth = 0) => {
    if (!Array.isArray(nodes) || depth > 100) reject("invalid inventory");
    for (const node of nodes) {
      if (++count > 10000 || !node || typeof node.name !== "string" || !node.name || /[\\/]/u.test(node.name) || [".", ".."].includes(node.name) || !Number.isSafeInteger(node.mode) || node.mode < 0) reject("invalid inventory");
      const path = parent ? `${parent}/${node.name}` : node.name;
      if (seen.has(path)) reject("duplicate inventory"); seen.add(path);
      if (node.type === "directory") visit(node.children, path, depth + 1);
      else {
        if (node.type !== "file" || !/^[A-Za-z0-9_-]{1,160}$/u.test(node.uid || "") || node.children !== undefined) reject("invalid inventory");
        files.push({ path, uid: node.uid });
      }
    }
  };
  visit(nodes);
  return nodes.length === 1 && nodes[0].name === "src" && nodes[0].type === "directory" && nodes[0].mode === 16749 ? files.map(x => ({ ...x, path: x.path.slice(4) })) : files;
}
// Recovery-role signing is deliberately outside this module. No delivery capability.
export async function runOwnerTrialPublicPlaybackRepair(options = {}) {
  const env = options.environment || process.env, jobId = env.OWNER_TRIAL_JOB_ID;
  if (!/^job_owner_trial_[a-f0-9]{32}$/u.test(jobId || "") || (options.jobId !== undefined && options.jobId !== jobId) || typeof options.signPlaybackResult !== "function") reject("exact job and independent signer required");
  const token = env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN;
  if (typeof token !== "string" || token.length < 32 || !env.OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN) reject("worker/provider roles required");
  const inspection = parseAuthoritativeVercelBuildInspection(Buffer.from(env.OWNER_TRIAL_PUBLICATION_BUILD_INSPECTION_JSON || ""));
  const client = options.client || new ConvexHttpClient(env.CONVEX_URL);
  const resume = options.resume;
  if (resume !== undefined && (!resume || Object.keys(resume).sort().join(",") !== "attemptId,commandId,continuationSignature,deploymentId,leaseToken" || typeof resume.leaseToken !== "string" || resume.leaseToken.length < 16)) reject("exact resume identity required");
  const identity = { completionToken: token, jobId, workerId: "owner-trial-completion-worker", leaseToken: resume?.leaseToken || randomUUID() };
  const mutate = (name, args = {}) => client.mutation(`ownerTrialPublicPlaybackRepair:${name}`, { ...identity, ...args });
  const active = () => client.query("ownerTrialPublicPlaybackRepair:activeRepair", identity);
  const claimed = resume ? await active() : await mutate("claimRepair"), a = claimed.authorization, b = a.binding;
  if (resume && (!claimed.continuation || claimed.continuation.signature !== resume.continuationSignature || claimed.continuation.deploymentId !== resume.deploymentId || a.commandId !== resume.commandId || claimed.continuation.previousLifecycle.aggregate.stageAttempts.at(-1).attemptId !== resume.attemptId || claimed.lease.leaseToken !== resume.leaseToken)) reject("resume binding drift");
  const trace = [], hosts = new Set([new URL(b.origin).hostname]);
  const siteOrigin = new URL(env.CONVEX_SITE_URL || env.CONVEX_URL.replace(/\.cloud$/u, ".site")).origin;
  const teamQuery = `teamId=${encodeURIComponent(b.provider.teamId)}`;
  const baseFetch = options.fetch || globalThis.fetch;
  const uploadHashes = new Set(); let expectedUploads = [], deploymentId = resume?.deploymentId || null, creates = 0, aliases = 0, uploads = 0;
  const verifyResumeCensus = pages => {
    const census = pages.flatMap(x => x.deployments), matches = census.filter(x => x.meta?.bbIdempotencyKey === b.idempotencyKey), old = census.filter(x => deploymentIdentity(x) === b.oldDeploymentId);
    if (pages.length !== 1 || matches.length !== 1 || json(publicationFacts(matches[0])) !== json(publicationFacts(claimed.continuation.proof.deploymentDetail)) || old.length !== 1 || json(publicationFacts(old[0])) !== json(publicationFacts(a.proof.positivePublication))) reject("resume census drift");
  };
  const deploymentHost = detail => {
    const u = new URL(`https://${detail.url}`);
    if (u.origin !== `https://${detail.url}` || !u.hostname.endsWith(".vercel.app") || u.username || u.password || u.port) reject("invalid deployment host");
    hosts.add(u.hostname); return u.origin;
  };
  const guarded = async (input, init = {}) => {
    await active();
    const u = new URL(input), method = (init.method || "GET").toUpperCase(), headers = new Headers(init.headers);
    if (headers.has("cookie") || headers.has("x-vercel-protection-bypass")) reject("credential-bearing transport");
    if (u.origin === "https://api.vercel.com") {
      if (u.searchParams.get("teamId") !== b.provider.teamId || (u.searchParams.has("projectId") && u.searchParams.get("projectId") !== b.provider.projectId) || headers.get("authorization") !== `Bearer ${env.OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN}`) reject("provider scope drift");
      if (method !== "GET") {
        if (method !== "POST") reject("forbidden provider mutation");
        if (resume && ["/v2/files", "/v13/deployments"].includes(u.pathname)) reject("resume cannot upload or create");
        if (u.pathname === "/v2/files") {
          if (uploads === 0) await census(true);
          const bytes = Buffer.from(init.body);
          if (!uploadHashes.has(hash(bytes)) || headers.get("x-vercel-digest") !== hash(bytes, "sha1") || ++uploads > expectedUploads.length) reject("unapproved upload bytes");
        } else if (u.pathname === "/v13/deployments") {
          await census(true);
          const payload = JSON.parse(init.body);
          const meta = { bbCanaryJobId: jobId, bbRevisionId: b.revisionId, bbArtifactSetId: b.artifactSetId, bbArtifactManifestDigest: b.artifactManifestDigest, bbIdempotencyKey: b.idempotencyKey };
          if (creates++ !== 0 || uploads !== expectedUploads.length || json(payload) !== json({ name: b.provider.projectName, project: b.provider.projectId, files: expectedUploads, meta, projectSettings: { framework: null } })) reject("inexact create");
        } else if (u.pathname === `/v2/deployments/${deploymentId}/aliases`) {
          if (resume) {
            verifyResumeCensus(await census(false));
            const alias = await getJson(`/v4/aliases/${encodeURIComponent(new URL(b.origin).hostname)}?projectId=${encodeURIComponent(b.provider.projectId)}&${teamQuery}`);
            if (alias.alias !== new URL(b.origin).hostname || alias.projectId !== b.provider.projectId || alias.deploymentId !== b.oldDeploymentId) reject("resume alias drift");
          }
          if (!deploymentId || a.snapshot.previousDeploymentIds.includes(deploymentId) || aliases++ !== 0 || json(JSON.parse(init.body)) !== json({ alias: new URL(b.origin).hostname })) reject("inexact alias");
        } else reject("forbidden provider mutation");
      }
    } else if (u.origin === siteOrigin) {
      if (method !== "GET" || u.pathname !== "/completion/artifact" || headers.get("authorization") !== `Bearer ${token}`) reject("artifact transport scope");
    } else if (u.protocol !== "https:" || !hosts.has(u.hostname) || method !== "GET" || u.username || u.password || u.port || headers.has("authorization")) reject("public transport scope");
    await mutate("fenceRepair");
    const response = await baseFetch(input, publicToolbarRead(input, { ...init, redirect: init.redirect || "error" }, hosts));
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    trace.push({ url: u.href, method, status: response.status, responseDigest: hash(bytes), requestDigest: init.body ? hash(Buffer.from(init.body)) : null });
    if (u.origin === "https://api.vercel.com" && response.ok) {
      if (u.pathname === "/v7/deployments") {
        const page = JSON.parse(bytes.toString());
        if (!Array.isArray(page.deployments)) reject("incomplete census");
        for (const d of page.deployments) deploymentIdentity(d);
        const matches = page.deployments.filter(x => x.meta?.bbIdempotencyKey === b.idempotencyKey);
        if (matches.length > 1 || matches.some(x => !deploymentId || (x.id || x.uid) !== deploymentId)) reject("idempotency key already present");
      }
      if (method === "POST" && u.pathname === "/v13/deployments") {
        const detail = JSON.parse(bytes.toString()); deploymentId = deploymentIdentity(detail);
        if (!/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(deploymentId || "") || a.snapshot.previousDeploymentIds.includes(deploymentId) || detail.projectId !== b.provider.projectId || detail.meta?.bbIdempotencyKey !== b.idempotencyKey) reject("reused or invalid receipt");
        deploymentHost(detail);
      }
    }
    await active();
    return response;
  };
  const getJson = async path => {
    const response = await guarded(`https://api.vercel.com${path}`, { method: "GET", headers: { authorization: `Bearer ${env.OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN}` } });
    if (!response.ok) reject("provider observation failed"); return response.json();
  };
  // Complete traversal, including later pages. Commit's single-page limit is never truncated.
  const census = async absent => {
    const pages = [], cursors = new Set(), ids = new Set(); let cursor = null;
    do {
      if (pages.length >= 100) reject("incomplete census");
      const page = await getJson(`/v7/deployments?projectId=${encodeURIComponent(b.provider.projectId)}&limit=100${cursor === null ? "" : `&until=${encodeURIComponent(cursor)}`}&${teamQuery}`);
      if (!Array.isArray(page.deployments) || page.deployments.length > 100 || !page.pagination || !Object.hasOwn(page.pagination, "next")) reject("incomplete census");
      for (const d of page.deployments) {
        const id = deploymentIdentity(d);
        if (!/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(id || "") || ids.has(id) || d.projectId !== b.provider.projectId || (absent && d.meta?.bbIdempotencyKey === b.idempotencyKey)) reject("census collision or drift");
        ids.add(id);
      }
      pages.push(page); const next = page.pagination.next;
      if (next !== null && (!/^(0|[1-9]\d*)$/u.test(String(next)) || !Number.isSafeInteger(Number(next)) || cursors.has(String(next)) || (cursor !== null && Number(next) >= Number(cursor)))) reject("invalid census cursor");
      cursors.add(String(next)); cursor = next;
    } while (cursor !== null);
    return pages;
  };
  const bodyRead = async (url, expected) => {
    const response = await guarded(url, { method: "GET", cache: "no-store" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) reject("actual public bytes changed");
    return { path: expected.path, bytes: bytes.length, sha256: hash(bytes), status: response.status };
  };
  try {
    if (inspection.teamId !== b.provider.teamId || inspection.projectId !== b.provider.projectId || inspection.projectName !== b.provider.projectName || inspection.revisionId !== b.revisionId) reject("build identity drift");
    const pages = await census(!resume), positive = await getJson(`/v13/deployments/${b.oldDeploymentId}?${teamQuery}`);
    if (resume) verifyResumeCensus(pages);
    if ((!resume && digest(pages) !== a.proof.censusDigest) || digest(a.proof.positivePublication) !== a.proof.positivePublicationDigest || json(publicationFacts(positive)) !== json(publicationFacts(a.proof.positivePublication))) reject("old positive publication drift");
    if (resume) deploymentHost(claimed.continuation.proof.deploymentDetail);
    const oldOrigin = deploymentHost(positive);
    const aliasPath = `/v4/aliases/${encodeURIComponent(new URL(b.origin).hostname)}?projectId=${encodeURIComponent(b.provider.projectId)}&${teamQuery}`;
    const alias = await getJson(aliasPath);
    if (alias.alias !== new URL(b.origin).hostname || alias.projectId !== b.provider.projectId || alias.deploymentId !== b.oldDeploymentId) reject("old alias drift");
    const resolver = createOwnerTrialPublicArtifactResolver({ policy: a.snapshot.policy, token, siteOrigin, fetch: guarded, revalidate: async () => { await active(); return a.snapshot.policy; } });
    const artifact = a.snapshot.originalAggregate.artifactSets.find(x => x.kind === "narration_review" && x.artifactSetId === b.artifactSetId);
    const request = { jobId, environment: "test", product: "announcement-page", revisionId: b.revisionId, artifactSet: artifact, artifactSetId: b.artifactSetId, artifactManifestDigest: b.artifactManifestDigest, idempotencyKey: b.idempotencyKey, attemptStartedAt: claimed.lease.claimedAt, artifactReadAuthority: { workerId: identity.workerId, commandId: a.commandId, leaseToken: identity.leaseToken }, fenceExternalEffect: async (_, invoke) => { await mutate("fenceRepair"); return invoke(); } };
    const resolved = await resolver.resolve(request);
    const base = `/announcements/${jobId}`;
    const oldInventory = inventoryFiles(await getJson(`/v6/deployments/${b.oldDeploymentId}/files?${teamQuery}`));
    const oldPaths = [...resolved.files.map(x => `announcements/${jobId}/${x.publicPath}`), `announcements/${jobId}/.publication.json`, "vercel.json"].sort();
    if (json(oldInventory.map(x => x.path).sort()) !== json(oldPaths)) reject("old inventory drift");
    const configuration = Buffer.from(`${JSON.stringify({ redirects: [{ source: base, destination: `${base}/${resolved.entrypointPath.slice(0, -10)}`, permanent: false }], headers: [{ source: `${base}/(.*)`, headers: [{ key: "cache-control", value: "private, no-store, max-age=0" }] }] }, null, 2)}\n`);
    const config = await getJson(`/v8/deployments/${b.oldDeploymentId}/files/${oldInventory.find(x => x.path === "vercel.json").uid}?${teamQuery}`);
    const encoded = config.data || (config.encoding === "base64" ? config.content : null);
    if (typeof encoded !== "string" || !Buffer.from(encoded, "base64").equals(configuration)) reject("old config drift");
    for (const file of resolved.files) for (const origin of [oldOrigin, b.origin]) await bodyRead(`${origin}${base}/${file.publicPath}`, { path: file.publicPath, bytes: file.bytes.length, sha256: file.sha256 });
    const transcript = b.files.filter(x => /transcript\.json$/u.test(x.path));
    if (transcript.length !== 1) reject("exact approved transcript required");
    const url = new URL("/completion/artifact", siteOrigin);
    for (const [key, value] of Object.entries({ jobId, revisionId: b.revisionId, storageId: transcript[0].storageId })) url.searchParams.set(key, value);
    const response = await guarded(url, { headers: { authorization: `Bearer ${token}`, "x-bebebonjour-worker-id": identity.workerId, "x-bebebonjour-command-id": a.commandId, "x-bebebonjour-lease-token": identity.leaseToken }, cache: "no-store" });
    const transcriptBytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200 || response.headers.get("content-type") !== "application/octet-stream" || response.headers.get("cache-control") !== "private, no-store" || transcriptBytes.length !== transcript[0].bytes || hash(transcriptBytes) !== transcript[0].sha256) reject("approved transcript bytes drift");
    const projected = projectOwnerTrialPlayback({ files: resolved.files, transcriptBytes });
    const publicInventory = projected.map(x => ({ path: x.publicPath, bytes: x.bytes.length, sha256: hash(x.bytes) }));
    if (json(publicInventory) !== json(a.proof.correctedPublicInventory)) reject("authorized projection inventory drift");
    const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: "1.0", jobId, revisionId: b.revisionId, artifactSetId: b.artifactSetId, artifactManifestDigest: b.artifactManifestDigest, idempotencyKey: b.idempotencyKey, completionBuild: { deploymentId: inspection.deploymentId, buildId: inspection.buildId }, vercelConfiguration: { sha256: hash(configuration), bytes: configuration.length }, files: publicInventory.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) }, null, 2)}\n`);
    const fullFiles = [...projected.map(x => ({ path: `announcements/${jobId}/${x.publicPath}`, bytes: x.bytes })), { path: `announcements/${jobId}/.publication.json`, bytes: manifest }, { path: "vercel.json", bytes: configuration }];
    for (const file of fullFiles) uploadHashes.add(hash(file.bytes));
    expectedUploads = fullFiles.map(x => ({ file: x.path, sha: hash(x.bytes, "sha1"), size: x.bytes.length }));
    const provider = createVercelTestAPublicationProvider({ token: env.OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN, buildInspection: inspection, ...b.provider, stableOrigin: b.origin, canaryJobId: jobId, canaryRevisionId: b.revisionId, artifactResolver: { resolve: async () => { await active(); return { ...resolved, files: projected }; } }, fetch: guarded, requirePrivateDeploymentProtection: false, requireExistingAliasProject: true, pollIntervalMs: options.pollIntervalMs ?? 1000, maxPollAttempts: options.maxPollAttempts ?? 30 });
    // publish's exact-existing branch performs the full manifest/byte/root checks
    // before alias replacement. Resume transport forbids ALL uploads/creates,
    // including its absence fallback; reconcile cannot replace a present OLD alias.
    const result = await provider.publish(request);
    if (creates !== (resume ? 0 : 1) || (resume && uploads !== 0) || aliases !== 1 || result?.providerReceiptId !== deploymentId) reject("exact create/alias budget required");
    const fullDeploymentDetail = await getJson(`/v13/deployments/${deploymentId}?${teamQuery}`), censusPages = await census(false);
    if (censusPages.length !== 1) reject("commit requires complete single-page census");
    const matches = censusPages[0].deployments.filter(x => x.meta?.bbIdempotencyKey === b.idempotencyKey);
    if (matches.length !== 1 || json(publicationFacts(matches[0])) !== json(publicationFacts(fullDeploymentDetail)) || !censusPages[0].deployments.some(x => (x.id || x.uid) === b.oldDeploymentId)) reject("final census drift");
    const deploymentDetail = fullDeploymentDetail; // Raw census is preserved alongside exact full detail.
    const finalAlias = await getJson(aliasPath);
    if (finalAlias.alias !== new URL(b.origin).hostname || finalAlias.deploymentId !== deploymentId || finalAlias.projectId !== b.provider.projectId) reject("final alias drift");
    const byteReadbacks = [];
    for (const file of publicInventory) for (const [target, origin] of [["deployment", deploymentHost(deploymentDetail)], ["stable", b.origin]]) byteReadbacks.push({ ...await bodyRead(`${origin}${base}/${file.path}`, file), target });
    await active();
    const proof = await options.signPlaybackResult({ authorization: a, result, publicInventory, publicInventoryDigest: digest(publicInventory), deploymentDetail, fullDeploymentDetail, censusPages, censusDigest: digest(censusPages), alias: { hostname: finalAlias.alias, deploymentId: finalAlias.deploymentId, projectId: finalAlias.projectId }, byteReadbacks, completeTransportTraceDigest: digest(trace) });
    await active(); return await mutate("commitRepair", { result, proof });
  } catch (error) {
    try { await mutate("failRepair"); } catch { /* Expired/drifted authority cannot be restored by bookkeeping. */ }
    throw error;
  }
}
