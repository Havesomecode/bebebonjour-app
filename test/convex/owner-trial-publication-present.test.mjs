import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../../convex/schema.js";
import { claimStageTransition, fenceExternalEffectTransition, failStageTransition } from "../../src/fulfillment/job-machine.mjs";
import { createOwnerTrialPublicArtifactResolver } from "../../src/fulfillment/owner-trial-completion-capabilities.mjs";
import { createVercelTestAPublicationProvider, parseAuthoritativeVercelBuildInspection } from "../../src/fulfillment/vercel-test-a-publication-provider.mjs";

const operatorToken = "offline-trial-completion-operator-at-least-32-bytes";
const completionToken = "offline-trial-completion-worker-at-least-32-bytes";
const workerToken = "offline-trial-generation-worker-at-least-32-bytes";
const hmacKey = "offline-trial-review-signing-key-at-least-32-bytes";
const workerId = "owner-trial-completion-worker";
const origin = "https://owner-trial.example.invalid";
const sha = value => createHash("sha256").update(value).digest("hex");
const actions = ["publish", "queue_delivery", "deliver"];
const modules = Object.fromEntries(["ownerTrial", "ownerTrialRuntime", "ownerTrialCompletion", "ownerTrialPublicationSupersession", "ownerTrialPublicPlaybackRepair", "ownerTrialCompletionContinuation", "ownerTrialPublicationRecovery", "ownerTrialPublicationPresent", "operations", "http", "fulfillment"]
  .map(name => [`./${name}.js`, () => import(`../../convex/${name}.js`)]));

async function fixture({ publicDeclaredBytes, publicAssets = false, publicNarration = false, runtimeAssets = false, fullPublic = false } = {}) {
  Object.assign(process.env, { BEBEBONJOUR_OWNER_TRIAL_ENABLED: "true",
    BEBEBONJOUR_OPERATIONS_TOKEN: operatorToken, BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: workerToken,
    BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: completionToken,
    BEBEBONJOUR_APPROVAL_HMAC_KEY: hmacKey });
  const t = convexTest(schema, { ...modules, "./_generated/server.js": () => import("convex/server") });
  const ticket = await t.action(ref("ownerTrialRuntime:issueTicket"), { operatorToken,
    idempotencyKey: "offline-completion-scope-fixture", ownerSourceReference: "kanban:t_4b1eb28f",
    recipient: "z@havesomecode.io", origin, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const jobId = ticket.jobId;
  await t.action(ref("ownerTrialRuntime:redeemTicket"), { operatorToken, ticketSecret: ticket.ticketSecret,
    jobId, recipient: "z@havesomecode.io" });
  // Explicitly labelled unit fixture artifacts, not claimed generation/provider evidence.
  // Both delegated reviews and signatures are made through the production review action.
  const publicBytes = Buffer.from(runtimeAssets ? '<!doctype html><html><head><link rel="stylesheet" href="_assets/blessed-arrival-1-0-0-r1/styles.css"></head><body><script>window.__ANNOUNCEMENT_CONFIG__ = {supportedLanguages:["fr","ar"],transcriptUrl:"../artifacts/transcript.json",assetBasePath:"../_assets/blessed-arrival-1-0-0-r1",reviewMode:"private",ambientAudioUrl:""};</script><script type="module" src="_assets/blessed-arrival-1-0-0-r1/app.js"></script></body></html>' : "<!doctype html><html><head></head><body>Offline fictional fixture</body></html>");
  const privateBytes = Buffer.from("offline-private-fixture-not-public");
  const files = await t.run(async ctx => Promise.all([
    ...(fullPublic ? ["fr","ar"].map(lang=>[`deploy/${lang}/index.html`,Buffer.from(publicBytes.toString().replaceAll('"_assets/','"../_assets/'))]) : [["deploy/index.html",publicBytes]]), ["artifacts/current/intake.json", privateBytes],
    ...(fullPublic ? ["artifacts/transcript.json", "artifacts/current/transcript.json"].map(path => [path, Buffer.from(JSON.stringify({version:1,tracks:Object.fromEntries(["fr","ar"].map(lang=>[lang,Array.from({length:6},(_,n)=>({section:`part-${n}`,text:`Offline approved ${lang} section ${n}`,time:`00:0${n}`,seconds:n}))]))}))]) : []),
    ...(runtimeAssets ? Object.entries({"app.js":'import { progress } from "./phrase-progress.mjs";',"phrase-progress.mjs":"export const progress=1;","styles.css":"body { color: #123; }","og-image.svg":'<svg xmlns="http://www.w3.org/2000/svg"></svg>'}).map(([name,text])=>[`deploy/_assets/blessed-arrival-1-0-0-r1/${name}`,Buffer.from(text)]) : []),
    ...(publicNarration ? (fullPublic ? ["fr","ar"].flatMap(lang=>Array.from({length:6},(_,n)=>[`artifacts/audio/${lang}/part-${n}.mp3`,Buffer.from(`offline-unit-audio-${lang}-${n}-not-real-narration`)])) : [["artifacts/audio/fr/intro.mp3", Buffer.from("offline-unit-audio-bytes-not-real-narration")]]) : []),
    ...(publicAssets ? ["deploy/fr/app.js", "deploy/ar/app.js", "deploy/shared/app.css",
      "deploy/fr/other.js", "deploy/shared/other.css", "deploy/fr/manifest.json", "deploy/.env"]
      .map(path => [path, Buffer.from("offline-fixture-static-bytes")]) : []),
  ].map(async ([path, bytes]) => ({ path, storageId: await ctx.storage.store(new Blob([bytes])),
    bytes: path === "deploy/index.html" ? publicDeclaredBytes ?? bytes.length : bytes.length,
    sha256: sha(bytes) }))));
  const makeArtifact = kind => ({ artifactSetId: `artifact_offline_${kind}`, kind, revisionId: "r1",
    files, pageDigest: sha("offline-page"), transcriptDigest: sha("offline-transcript"),
    assetManifestDigest: sha(`${JSON.stringify({ schemaVersion: "1.0", kind, revisionId: "r1",
      files: files.map(({ path, storageId, bytes, sha256 }) => ({ path, storageId, bytes, sha256 })) }, null, 2)}\n`) });
  const content = makeArtifact("private_review"), narration = makeArtifact("narration_review");
  await patchJob(t, jobId, job => ({ ...job, state: "content_review_required", currentRevisionId: "r1",
    revisions: [{ revisionId: "r1", ordinal: 1, inputDigest: job.intakeDigest, createdAt: job.createdAt }],
    artifactSets: [content], stageAttempts: [{ stage: "prepare_review", status: "completed",
      attemptId: "offline-unit-content-run", revisionId: "r1" }] }));
  await review(t, jobId, "content", content);
  await patchJob(t, jobId, job => ({ ...job, state: "narration_review_required", artifactSets: [...job.artifactSets, makeArtifact("prepared_bundle"), narration],
    stageAttempts: [...job.stageAttempts, { stage: "generate_tts", status: "completed",
      attemptId: "offline-unit-narration-run", revisionId: "r1" }] }));
  await review(t, jobId, "narration", narration);
  const policy = await t.query(ref("ownerTrial:completionPolicy"), { completionToken, jobId });
  const claimArgs = { workerToken: completionToken, workerId, jobId, actions, limit: 1, leaseMs: 300000 };
  return { t, ticket, jobId, policy, claimArgs, files, publicBytes };
}
async function job(t, jobId) {
  return t.run(async ctx => (await ctx.db.query("fulfillmentJobs")
    .withIndex("by_job_id", q => q.eq("jobId", jobId)).unique()).aggregate);
}
async function patchJob(t, jobId, change) {
  return t.run(async ctx => {
    const document = await ctx.db.query("fulfillmentJobs").withIndex("by_job_id", q => q.eq("jobId", jobId)).unique();
    await ctx.db.patch(document._id, { aggregate: change(document.aggregate) });
  });
}
async function review(t, jobId, decisionType, artifact) {
  return t.action(ref("ownerTrialRuntime:review"), { operatorToken, jobId, decisionType,
    expectedVersion: (await job(t, jobId)).version, artifactManifestDigest: artifact.assetManifestDigest,
    evidenceDigest: sha(`offline-unit-${decisionType}-inspection-not-personal-owner-acceptance`),
    acknowledgement: `delegated-owner-trial-${decisionType}-inspected-not-owner-acceptance` });
}
async function snapshot(t) {
  return t.run(async ctx => Object.fromEntries(await Promise.all(Object.keys(schema.tables)
    .map(async name => [name, await ctx.db.query(name).collect()]))));
}
async function requestPublish(f) {
  const current = await job(f.t, f.jobId);
  return f.t.mutation(ref("operations:requestCommand"), { operatorToken, jobId: f.jobId,
    commandId: "command_offline_trial_publication", action: "publish", expectedState: current.state,
    expectedVersion: current.version, payload: { revisionId: f.policy.revisionId, artifactManifestDigest: f.policy.manifestDigest } });
}
async function claimPublish(f) {
  await requestPublish(f);
  const [command] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
  assert.equal(command.action, "publish");
  return { workerToken: completionToken, workerId, commandId: command.commandId, leaseToken: command.claim.leaseToken };
}
async function claimStage(f, auth) {
  const current = await job(f.t, f.jobId);
  const next = claimStageTransition(current, { commandId: `claim:${f.jobId}:r1:publish:1`, stage: "publish",
    leaseToken: "offline-stage-lease-distinct-from-command", leaseMs: 300000, maxAttempts: 1,
    operationBinding: null, operationsCommandId: auth.commandId }, new Date().toISOString());
  await f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId,
    workerId, commandId: auth.commandId, leaseToken: auth.leaseToken, expectedVersion: current.version, aggregate: next });
}
async function dualFence(f, auth) {
  await claimStage(f, auth);
  await f.t.mutation(ref("operations:fenceCommand"), { ...auth, leaseMs: 300000, effectMayBeIssued: true });
  const current = await job(f.t, f.jobId), attempt = current.stageAttempts.at(-1);
  const next = fenceExternalEffectTransition(current, { commandId: `effect-fence:${attempt.attemptId}:1`,
    stage: "publish", attemptId: attempt.attemptId, leaseToken: attempt.leaseToken, leaseMs: 300000, effectMayBeIssued: true }, new Date().toISOString());
  await f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId,
    workerId, commandId: auth.commandId, leaseToken: auth.leaseToken, expectedVersion: current.version, aggregate: next });
}
async function revoke(f, change = ticket => ({ ...ticket, redeemed: false })) {
  await f.t.run(async ctx => {
    const ticket = await ctx.db.query("ownerTrialTickets").withIndex("by_ticket_id", q => q.eq("ticketId", f.ticket.ticketId)).unique();
    const { _id, _creationTime, ...next } = change(ticket);
    await ctx.db.replace(ticket._id, next);
  });
}

import { signPublicationAbsenceProof } from "../../src/fulfillment/owner-trial-publication-recovery-proof.mjs";
const recoveryToken = "offline-publication-recovery-role-at-least-32-bytes";
async function failedFixture({ olderCommands = false, runtimeAssets = false, fullPublic = false, legacyRecovery = false } = {}) {
  const f = await fixture({ publicNarration: true, runtimeAssets, fullPublic });
  // Schema-valid privileged persisted-record fault injection, not a public-write exploit.
  if (olderCommands) await f.t.run(async ctx => {
    for (const commandId of ["command_offline_older_uncertain", "command_offline_oldest_uncertain"]) {
      const at = new Date().toISOString();
      await ctx.db.insert("customerFlowOperationsCommands", { commandId, jobId: f.jobId,
        action: "generate", expectedState: "generate_queued", expectedVersion: 1, payload: {},
        requestedAt: at, requestedBy: "primary_operator", state: "completed", attempts: 1,
        claim: null, lastFailureReason: null, outcome: null, updatedAt: at });
    }
  });
  const auth = await claimPublish(f); await dualFence(f, auth);
  const current = await job(f.t, f.jobId), attempt = current.stageAttempts.at(-1);
  const failed = failStageTransition(current, { commandId: `fail:${attempt.attemptId}:publication_scope_invalid`,
    stage: "publish", leaseToken: attempt.leaseToken, reasonCode: "publication_scope_invalid", retryable: false },
    { maxAttemptsByStage: { publish: 1 } }, new Date().toISOString());
  await f.t.mutation(ref("ownerTrialCompletion:replaceJob"), { completionToken, jobId: f.jobId, workerId,
    commandId: auth.commandId, leaseToken: auth.leaseToken, expectedVersion: current.version, aggregate: failed });
  await f.t.mutation(ref("operations:failCommand"), { ...auth, retryable: false, reasonCode: "canonical_provenance_missing" });
  Object.assign(process.env, { BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN: recoveryToken,
    OWNER_TRIAL_JOB_ID: f.jobId, OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID: "team_offline",
    OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID: "prj_offline", OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME: "offline-trial" });
  const binding = { jobId: f.jobId, expectedVersion: failed.version, sourceCommandId: auth.commandId,
    attemptId: attempt.attemptId, revisionId: f.policy.revisionId, artifactManifestDigest: f.policy.manifestDigest,
    idempotencyKey: attempt.idempotencyKey, teamId: "team_offline", projectId: "prj_offline", projectName: "offline-trial", origin };
  const unsigned = { schemaVersion: "1.0", kind: "owner_trial_publication_absence", binding,
    observedAt: new Date().toISOString(), census: { complete: true, pageCount: 1, deploymentCount: 1,
      digest: sha("offline-complete-census-not-live-evidence"), exactMatchCount: 0, ambiguousMatchCount: 0,
      errorCount: 0, terminalCursor: null } };
  const proof = await signPublicationAbsenceProof(unsigned, recoveryToken);
  if (legacyRecovery) {
    await f.t.mutation(ref("ownerTrialPublicationRecovery:recoverPublicationAbsence"), { completionToken, recoveryToken, ...binding, proof });
    const [command] = await f.t.mutation(ref("operations:claimCommands"), f.claimArgs);
    const authority = { workerId, commandId: command.commandId, leaseToken: command.claim.leaseToken };
    const { createOwnerTrialCompletionCapabilities } = await import("../../src/fulfillment/owner-trial-completion-capabilities.mjs");
    const cap = await createOwnerTrialCompletionCapabilities({ client: { query: (n,a) => f.t.query(ref(n),a), mutation: (n,a) => f.t.mutation(ref(n),a) }, policy: f.policy,
      environment: { BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: completionToken, CONVEX_URL: "https://offline-fixture.convex.cloud", OWNER_TRIAL_RESEND_FROM: "trial@example.invalid" },
      publicationProvider: { async reconcile() { return null; }, async publish() { throw new Error("Offline recovered operation1 uncertain effect"); } },
      resend: { emails: { send() { throw new Error("must not deliver during recovery fixture"); } } } });
    await cap.fulfillmentOrchestrator.runExpectedStage(f.jobId, "publish", { operationsCommandId: command.commandId, workerAuthority: authority,
      operationsEffectBoundary: async (_, invoke) => { await f.t.mutation(ref("operations:fenceCommand"), { workerToken: completionToken, ...authority, leaseMs: 300000, effectMayBeIssued: true }); return invoke(); } });
    await f.t.mutation(ref("operations:failCommand"), { workerToken: completionToken, ...authority, retryable: false, reasonCode: "canonical_provenance_missing" });
    const recoveredFailure = await job(f.t, f.jobId);
    assert.equal(recoveredFailure.state, "reconciliation_required");
    assert.equal(recoveredFailure.stageAttempts.at(-1).operationNumber, 1);
    assert.equal((await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"), { completionToken, jobId: f.jobId })).maxAttempts, 2);
    return { ...f, auth, failed: recoveredFailure, binding: { ...binding, expectedVersion: recoveredFailure.version, attemptId: recoveredFailure.stageAttempts.at(-1).attemptId }, proof, args: { completionToken, recoveryToken, ...binding, proof } };
  }
  return { ...f, auth, failed, binding, proof, args: { completionToken, recoveryToken, ...binding, proof } };
}

import { runOwnerTrialCompletionWorkerCommand } from "../../src/operations/owner-trial-completion-worker.mjs";
async function presentFixture(clock, options) {
  const f = await failedFixture(options), commandId = "command_offline_present_reconciliation";
  if(clock){
    const context=await f.t.query(ref("ownerTrialCompletionContinuation:authorizationContext"),{operatorToken,completionToken,jobId:f.jobId});
    clock.mock.timers.enable({apis:["Date"],now:Date.parse(f.ticket.expiresAt)+1});
    await f.t.mutation(ref("ownerTrialCompletionContinuation:authorizeContinuation"),{operatorToken,completionToken,jobId:f.jobId,expectedVersion:f.failed.version,expectedBindingDigest:context.bindingDigest,previousReceiptId:null,ownerSourceReference:"kanban:t_4b1eb28f",authorizationReference:"kanban:t_4b1eb28f:completion:offline-present",expiresAt:new Date(Date.now()+3600000).toISOString()});
    f.policy=await f.t.query(ref("ownerTrial:completionPolicy"),{completionToken,jobId:f.jobId});
    assert.ok(f.policy.continuationReceiptId);
  }
  await f.t.mutation(ref("operations:requestCommand"), { operatorToken, commandId, jobId: f.jobId,
    action: "reconcile", expectedState: "reconciliation_required", expectedVersion: f.failed.version,
    payload: { sourceCommandId: f.binding.sourceCommandId, providerStatus: "confirmed_succeeded" } });
  const args = { operatorToken, completionToken, jobId: f.jobId, expectedVersion: f.failed.version,
    commandId, sourceCommandId: f.binding.sourceCommandId, deploymentId: "dpl_offline_present" };
  return { ...f, commandId, presentArgs: args, client: { query: (n,a) => f.t.query(ref(n),a), mutation: (n,a) => f.t.mutation(ref(n),a) } };
}
test("PRESENT authorization is append-only, exact, authenticated and never a publish retry", async () => {
  const f = await presentFixture(), before = await snapshot(f.t);
  const result = await f.t.mutation(ref("ownerTrialPublicationPresent:authorizeReconciliation"), f.presentArgs);
  assert.equal(result.authorized, true);
  const after = await snapshot(f.t);
  assert.deepEqual(after.fulfillmentJobs, before.fulfillmentJobs);
  assert.deepEqual(after.customerFlowOperationsCommands, before.customerFlowOperationsCommands);
  assert.equal(after.ownerTrialPublicationPresentAuthorizations.length, 1);
  assert.deepEqual(after.ownerTrialPublicationRecoveries, before.ownerTrialPublicationRecoveries);
});

test("real PRESENT worker uses provider.reconcile, exact census and existing alias only",async()=>{
 const f=await presentFixture(); await f.t.mutation(ref("ownerTrialPublicationPresent:authorizeReconciliation"),f.presentArgs);
 const trace=[];
 await assert.rejects(()=>runOwnerTrialCompletionWorkerCommand({client:f.client,environment:{BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN:completionToken,CONVEX_URL:"https://offline-fixture.convex.cloud",OWNER_TRIAL_JOB_ID:f.jobId,OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN:"offline-provider-token",OWNER_TRIAL_PUBLICATION_BUILD_INSPECTION_JSON:JSON.stringify({schemaVersion:"1.0",source:"vercel inspect --format=json",deploymentId:"dpl_offline_bootstrap",buildId:"build_offline",teamId:"team_offline",projectId:"prj_offline",projectName:"offline-trial",revisionId:"r1"})},reconcilePresent:true,signPresentResult:()=>{throw new Error("must not sign failed verification");},fetch:async(input,init={})=>{trace.push([String(input),init.method||"GET"]);throw new Error("offline provider absence must stop reconciliation, never publish");}}));
 assert.ok(trace.length>0);
 assert.ok(trace.every(([u,m])=>m!=="POST"));
 assert.equal((await job(f.t,f.jobId)).state,"reconciliation_required");
});


async function realPresentSeam(clock,mode="success"){
 const f=await presentFixture(clock,{runtimeAssets:mode==="missingRuntime"}); await f.t.mutation(ref("ownerTrialPublicationPresent:authorizeReconciliation"),f.presentArgs);
 const a=(await snapshot(f.t)).ownerTrialPublicationPresentAuthorizations[0].receipt;
 const artifact=f.failed.artifactSets.find(x=>x.kind==="narration_review"),base=`/announcements/${f.jobId}`, calls=[];
 const storageBytes=async id=>Buffer.from(await f.t.run(async ctx=>(await ctx.storage.get(id)).arrayBuffer()));
 const resolver=createOwnerTrialPublicArtifactResolver({policy:f.policy,token:completionToken,siteOrigin:"https://offline-fixture.convex.site",revalidate:async()=>f.policy,fetch:async url=>new Response(await storageBytes(new URL(url).searchParams.get("storageId")),{headers:{"cache-control":"private, no-store","content-type":"application/octet-stream"}})});
 const resolved=await resolver.resolve({jobId:f.jobId,environment:"test",product:"announcement-page",revisionId:"r1",artifactSet:artifact,artifactSetId:artifact.artifactSetId,artifactManifestDigest:f.policy.manifestDigest,idempotencyKey:f.binding.idempotencyKey,artifactReadAuthority:{workerId,commandId:f.commandId,leaseToken:"offline-fixture-preparation"},fenceExternalEffect:async(_,run)=>run()});
 const config=Buffer.from(`${JSON.stringify({redirects:[{source:base,destination:`${base}/${resolved.entrypointPath.slice(0,-10)}`,permanent:false}],headers:[{source:`${base}/(.*)`,headers:[{key:"cache-control",value:"private, no-store, max-age=0"}]}]},null,2)}\n`);
 const manifest=Buffer.from(`${JSON.stringify({schemaVersion:"1.0",jobId:f.jobId,revisionId:"r1",artifactSetId:artifact.artifactSetId,artifactManifestDigest:f.policy.manifestDigest,idempotencyKey:f.binding.idempotencyKey,completionBuild:{deploymentId:"dpl_offline_bootstrap",buildId:"build_offline"},vercelConfiguration:{sha256:sha(config),bytes:config.length},files:resolved.files.map(x=>({path:x.publicPath,sha256:x.sha256,bytes:x.bytes.length}))},null,2)}\n`);
 const paths=[...resolved.files.filter(x=>mode!=="missingRuntime"||!x.publicPath.startsWith("_assets/")).map(x=>`announcements/${f.jobId}/${x.publicPath}`),`announcements/${f.jobId}/.publication.json`,"vercel.json"];
 const tree=[];for(const [index,p]of paths.entries()){let branch=tree;const parts=p.split("/");for(const name of parts.slice(0,-1)){let d=branch.find(x=>x.name===name);if(!d){d={name,type:"directory",mode:16384,children:[]};branch.push(d);}branch=d.children;}branch.push({name:parts.at(-1),type:"file",mode:33188,uid:p==="vercel.json"?"config":`file_${index}`});}
 const deployment={id:"dpl_offline_present",uid:"dpl_offline_present",url:"offline-present.vercel.app",projectId:"prj_offline",readyState:"READY",createdAt:Date.now(),meta:{bbCanaryJobId:f.jobId,bbRevisionId:"r1",bbArtifactSetId:artifact.artifactSetId,bbArtifactManifestDigest:f.policy.manifestDigest,bbIdempotencyKey:f.binding.idempotencyKey}};
 let aliased=mode==="alreadyAliased", signed=0;
 const fetch=async(input,init={})=>{const u=new URL(input),m=init.method||"GET";calls.push([u.pathname,m]); assert.equal(new Headers(init.headers).has("x-vercel-protection-bypass"),false);
  const snap=await snapshot(f.t); assert.ok(snap.ownerTrialPublicationPresentLeases[0].lease.effectStartedAt);assert.ok(snap.customerFlowOperationsCommands[1].claim.effectStartedAtMs);
  if(u.hostname==="offline-fixture.convex.site"){
   const file=await f.t.query(ref("ownerTrialCompletion:authorizeArtifactRead"),{completionToken,jobId:f.jobId,revisionId:"r1",storageId:u.searchParams.get("storageId"),workerId,commandId:f.commandId,leaseToken:init.headers["x-bebebonjour-lease-token"]});
   return new Response(await storageBytes(file.storageId),{headers:{"cache-control":"private, no-store","content-type":"application/octet-stream"}});
  }
  if(u.origin==="https://api.vercel.com"){
   if(m==="POST"){assert.equal(u.pathname,"/v2/deployments/dpl_offline_present/aliases");assert.equal(aliased,false);aliased=true;if(mode==="uncertainAlias")throw new Error("offline uncertain alias transport");return Response.json({uid:"alias_offline_present",created:new Date().toISOString(),alias:new URL(origin).hostname,deploymentId:deployment.id,projectId:"prj_offline"});}
   if(u.pathname==="/v7/deployments"){assert.ok(!u.searchParams.has("until")||Number(u.searchParams.get("until"))>=deployment.createdAt);return Response.json({deployments:mode==="missing"?[]:mode==="ambiguous"?[deployment,{...deployment,id:"dpl_other",uid:"dpl_other"}]:mode==="wrongBinding"?[{...deployment,meta:{...deployment.meta,bbRevisionId:"r2"}}]:[deployment],pagination:{next:null}});}
   if(u.pathname.startsWith("/v13/deployments/"))return Response.json(deployment);
   if(u.pathname.startsWith("/v6/deployments/"))return Response.json(tree);
   if(u.pathname.startsWith("/v8/deployments/"))return Response.json({encoding:"base64",content:config.toString("base64")});
   if(u.pathname.startsWith("/v4/aliases/"))return aliased?Response.json({alias:new URL(origin).hostname,deploymentId:deployment.id,projectId:"prj_offline"}):new Response("",{status:404});
  }
  if(mode==="sso302")return new Response("",{status:302,headers:{location:"https://vercel.com/sso"}});
  const suffix=u.pathname.slice(base.length+1);const bytes=suffix===".publication.json"?manifest:resolved.files.find(x=>x.publicPath===suffix)?.bytes;
  if(bytes)return new Response(mode==="wrongBytes"?Buffer.from("tampered"):bytes,{headers:{"cache-control":"private, no-store, max-age=0"}});
  if(u.pathname===base)return new Response("",{status:307,headers:{location:`${base}/${resolved.entrypointPath.slice(0,-10)}`}});
  if(u.pathname===`${base}/${resolved.entrypointPath.slice(0,-10)}`)return new Response(resolved.files.find(x=>x.publicPath===resolved.entrypointPath).bytes,{headers:{"cache-control":"private, no-store, max-age=0"}});
  throw new Error(`unexpected synthetic transport ${m} ${u.pathname}`);
 };
 const result={provider:"vercel",providerReceiptId:deployment.id,stableUrl:`${origin}${base}`,revisionId:"r1",artifactSetId:artifact.artifactSetId,artifactManifestDigest:f.policy.manifestDigest,idempotencyKey:f.binding.idempotencyKey};
 const signPresentResult=async({authorization,result:verified})=>{
  signed++; assert.equal(aliased,true); assert.deepEqual(verified,result); assert.equal(authorization.signature,a.signature);
  return signPresentEvidence(authorization,verified);
 };
 const before=await snapshot(f.t);
 const run=()=>runOwnerTrialCompletionWorkerCommand({client:f.client,reconcilePresent:true,signPresentResult,fetch,environment:{BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN:completionToken,CONVEX_URL:"https://offline-fixture.convex.cloud",OWNER_TRIAL_JOB_ID:f.jobId,OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN:"offline-provider-token",OWNER_TRIAL_PUBLICATION_BUILD_INSPECTION_JSON:JSON.stringify({schemaVersion:"1.0",source:"vercel inspect --format=json",deploymentId:"dpl_offline_bootstrap",buildId:"build_offline",teamId:"team_offline",projectId:"prj_offline",projectName:"offline-trial",revisionId:"r1"})}});
 if(mode!=="success"&&mode!=="alreadyAliased"){
  await assert.rejects(run);assert.equal(signed,0);assert.deepEqual(await job(f.t,f.jobId),f.failed);
  const after=await snapshot(f.t);assert.deepEqual(after.customerFlowOperationsCommands[0],before.customerFlowOperationsCommands[0]);
  assert.equal(after.ownerTrialPublicationPresentResults.length,0);
  const failedSnapshot=await snapshot(f.t);const effects=calls.length;await assert.rejects(run);assert.equal(calls.length,effects);assert.deepEqual(await snapshot(f.t),failedSnapshot);
  assert.equal(calls.filter(x=>x[1]==="POST").length,mode==="uncertainAlias"?1:0);return;
 }
 await run();assert.equal(signed,1);
 assert.equal((await job(f.t,f.jobId)).state,"published");assert.equal(calls.filter(x=>x[1]==="POST").length,mode==="alreadyAliased"?0:1);
 await normalDelivery(f);
 assert.deepEqual((await snapshot(f.t)).customerFlowOperationsCommands[0],before.customerFlowOperationsCommands[0]);
}
for(const mode of ["success","alreadyAliased","missing","ambiguous","wrongBinding","sso302","wrongBytes","uncertainAlias","missingRuntime"])test(`real PRESENT continuation/provider/artifact/backend seam ${mode}`,clock=>realPresentSeam(clock,mode));


test("positive PRESENT missing-runtime cannot use absence recovery publish replay or old-key supersession",async clock=>{
 const f=await presentFixture(clock,{runtimeAssets:true}),lease=await leased(f),identity={completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken};
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),identity);
 clock.mock.timers.setTime(lease.expiresAtMs);
 const before=await snapshot(f.t);
 const {signature,...proof}=f.proof;
 const nonabsence={...proof,observedAt:new Date().toISOString(),census:{...proof.census,exactMatchCount:1,deploymentCount:1}};
 await assert.rejects(async()=>{
  const signed=await signPublicationAbsenceProof(nonabsence,recoveryToken);
  await f.t.mutation(ref("ownerTrialPublicationRecovery:recoverPublicationAbsence"),{...f.args,proof:signed});
 });
 assert.deepEqual(await snapshot(f.t),before);
 await assert.rejects(()=>f.t.mutation(ref("operations:requestCommand"),{operatorToken,jobId:f.jobId,commandId:"command_unsafe_corrected_publish",action:"publish",expectedVersion:f.failed.version,expectedState:"reconciliation_required",payload:{revisionId:"r1",artifactManifestDigest:f.policy.manifestDigest}}));
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:claimReconciliation"),{...identity,leaseToken:"replacement-without-authority"}));
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),identity));
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:authorizeReconciliation"),{...f.presentArgs,deploymentId:"dpl_corrected_without_supersession"}));
 assert.deepEqual(await snapshot(f.t),before);
});

test("PRESENT authentication, CAS, role, binding, provider drift and single-use lease reject without writes",async()=>{
 const f=await presentFixture(), before=await snapshot(f.t);
 for(const change of [{operatorToken:completionToken},{completionToken:operatorToken},{expectedVersion:f.failed.version-1},{deploymentId:"malformed"},{sourceCommandId:"command_other"},{jobId:`job_owner_trial_${"a".repeat(32)}`}]){await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:authorizeReconciliation"),{...f.presentArgs,...change}));assert.deepEqual(await snapshot(f.t),before);}
 const lease=await leased(f), args={completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken}, after=await snapshot(f.t);
 for(const change of [{completionToken:operatorToken},{workerId:"other-worker"},{leaseToken:"other-lease-token"}]){await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),{...args,...change}));assert.deepEqual(await snapshot(f.t),after);}
 const project=process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID;process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID="prj_changed";
 try{await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),args));}finally{process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID=project;}
 await f.t.run(async c=>{const row=await c.db.query("ownerTrialPublicationPresentLeases").withIndex("by_job_id",q=>q.eq("jobId",f.jobId)).unique();await c.db.patch(row._id,{lease:{...row.lease,expiresAtMs:Date.now()-1}});});
 const expired=await snapshot(f.t);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),args));assert.deepEqual(await snapshot(f.t),expired);
});

for(const mode of ["state","authorizationTamper","ticketTamper","continuationExpiry","effectMismatch"])test(`PRESENT ${mode} rejects before writes`,async clock=>{
 const f=await presentFixture(clock),lease=await leased(f),args={completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken};
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),args);
 if(mode==="state")await patchJob(f.t,f.jobId,j=>({...j,state:"published"}));
 if(mode==="ticketTamper")await revoke(f,t=>({...t,ticketDigest:"0".repeat(64)}));
 if(mode==="continuationExpiry")clock.mock.timers.setTime(Date.parse(lease.authorization.expiresAt));
 if(mode==="authorizationTamper"||mode==="effectMismatch")await f.t.run(async ctx=>{
  const table=mode==="authorizationTamper"?"ownerTrialPublicationPresentAuthorizations":"ownerTrialPublicationPresentLeases";
  const row=await ctx.db.query(table).withIndex("by_job_id",q=>q.eq("jobId",f.jobId)).unique();
  await ctx.db.patch(row._id,mode==="authorizationTamper"?{receipt:{...row.receipt,signature:"0".repeat(64)}}:{lease:{...row.lease,effectStartedAt:new Date(Date.now()-1).toISOString()}});
 });
 const before=await snapshot(f.t);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),args));assert.deepEqual(await snapshot(f.t),before);
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialCompletion:authorizeArtifactRead"),{completionToken,jobId:f.jobId,workerId,commandId:f.commandId,leaseToken:lease.leaseToken,revisionId:"r1",storageId:f.files[0].storageId}));assert.deepEqual(await snapshot(f.t),before);
});

async function normalDelivery(f){
 const current=await job(f.t,f.jobId);
 const p=current.publication;
 await f.t.mutation(ref("operations:requestCommand"),{operatorToken,commandId:"command_offline_present_delivery_queue",jobId:f.jobId,action:"queue_delivery",expectedState:"published",expectedVersion:current.version,payload:{revisionId:"r1",publicationId:p.providerReceiptId,artifactManifestDigest:p.artifactManifestDigest}});

 const workerOptions={client:f.client,jobId:f.jobId,environment:{BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN:completionToken,CONVEX_URL:"https://offline-fixture.convex.cloud",OWNER_TRIAL_RESEND_FROM:"owner-trial@example.invalid"},publicationProvider:{reconcile(){throw new Error("must not republish");},publish(){throw new Error("must not republish");}},resend:{emails:{async send(payload){assert.deepEqual(payload.to,["z@havesomecode.io"]);return{data:{id:"message_offline_present"},error:null};}}}};
 await runOwnerTrialCompletionWorkerCommand(workerOptions);
 const queued=await job(f.t,f.jobId);assert.equal(queued.state,"delivery_queued");
 await f.t.mutation(ref("operations:requestCommand"),{operatorToken,commandId:"command_offline_present_deliver",jobId:f.jobId,action:"deliver",expectedState:queued.state,expectedVersion:queued.version,payload:{revisionId:"r1",publicationId:p.providerReceiptId,artifactManifestDigest:p.artifactManifestDigest}});
 await runOwnerTrialCompletionWorkerCommand(workerOptions);assert.equal((await job(f.t,f.jobId)).state,"sent");
}

async function signPresentEvidence(authorization,result,changes={},secret=recoveryToken){
 const unsigned={kind:"owner_trial_present_evidence",authorizationSignature:authorization.signature,result,observedAt:new Date().toISOString(),verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true},...changes};
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const {stablePrivateValue:json}=await import("../../src/fulfillment/private-generation-authority.mjs");
 return {...unsigned,signature:Buffer.from(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`owner-trial-present-evidence-v1\0${json(unsigned)}`))).toString("hex")};
}

async function leased(f) {
 await f.t.mutation(ref("ownerTrialPublicationPresent:authorizeReconciliation"),f.presentArgs);
 return f.t.mutation(ref("ownerTrialPublicationPresent:claimReconciliation"),{completionToken,jobId:f.jobId,workerId,leaseToken:"offline-present-lease"});
}
test("PRESENT independent bounded lease dual-fences without modifying failed history",async()=>{
 const f=await presentFixture(), before=await snapshot(f.t), lease=await leased(f);
 assert.equal(lease.leaseToken,"offline-present-lease");
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),{completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken});
 const after=await snapshot(f.t);
 assert.deepEqual(after.fulfillmentJobs,before.fulfillmentJobs);
 assert.deepEqual(after.customerFlowOperationsCommands[0],before.customerFlowOperationsCommands[0]);
 assert.ok(after.customerFlowOperationsCommands[1].claim.effectStartedAtMs);
 assert.ok(after.ownerTrialPublicationPresentLeases[0].lease.effectStartedAt);
 await assert.rejects(()=>leased(f));
});
test("PRESENT continuation-backed commit and normal delivery require separate recovery-role signed fresh result evidence",async clock=>{
 const f=await presentFixture(clock), lease=await leased(f);
 const args={completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken,result:{provider:"vercel",providerReceiptId:"dpl_offline_present",revisionId:"r1",stableUrl:`${origin}/announcements/${f.jobId}`,artifactSetId:"artifact_offline_narration_review",artifactManifestDigest:f.policy.manifestDigest,idempotencyKey:f.binding.idempotencyKey}};
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"),{...args,proof:null}));
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),{completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken});
 const unsigned={kind:"owner_trial_present_evidence",authorizationSignature:lease.authorization.signature,result:args.result,observedAt:new Date().toISOString(),verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true}};
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(recoveryToken),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const {stablePrivateValue:json}=await import("../../src/fulfillment/private-generation-authority.mjs");
 const signature=Buffer.from(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`owner-trial-present-evidence-v1\0${json(unsigned)}`))).toString("hex");
 const denied=await snapshot(f.t);
 for(const proof of [await signPresentEvidence(lease.authorization,args.result,{},completionToken),await signPresentEvidence(lease.authorization,args.result,{observedAt:new Date(Date.now()-60001).toISOString()}),await signPresentEvidence(lease.authorization,args.result,{observedAt:new Date(Date.now()+1).toISOString()}),await signPresentEvidence(lease.authorization,args.result,{authorizationSignature:"0".repeat(64)}),await signPresentEvidence(lease.authorization,args.result,{verification:{ready:false}})]){await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"),{...args,proof}));assert.deepEqual(await snapshot(f.t),denied);}
 for(const k of ["providerReceiptId","revisionId","artifactManifestDigest","idempotencyKey"]){const result={...args.result,[k]:"wrong"};const proof=await signPresentEvidence(lease.authorization,result);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"),{...args,result,proof}));assert.deepEqual(await snapshot(f.t),denied);}
 const before=await snapshot(f.t), result=await f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"),{...args,proof:{...unsigned,signature}});
 assert.equal(result.committed,true);
 const current=await job(f.t,f.jobId); assert.equal(current.state,"published");
 assert.deepEqual(current.stageAttempts,f.failed.stageAttempts); assert.deepEqual(current.events.slice(0,-1),f.failed.events);
 const after=await snapshot(f.t); assert.deepEqual(after.customerFlowOperationsCommands[0],before.customerFlowOperationsCommands[0]);
 const replay=await f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"),{...args,proof:{...unsigned,signature}});
 assert.equal(replay.committed,false); assert.deepEqual(await snapshot(f.t),after);
 // Persisted receipt/proof/history/state drift must not hide the unresolved original command.
 for(const mode of ["receipt","proof","history","state"]){
  const target=mode==="receipt"||mode==="proof"?"ownerTrialPublicationPresentResults":"fulfillmentJobs";
  const row=await f.t.run(async ctx=>ctx.db.query(target).withIndex("by_job_id",q=>q.eq("jobId",f.jobId)).unique());
  await f.t.run(async ctx=>{
   if(mode==="receipt")await ctx.db.patch(row._id,{receipt:{...row.receipt,signature:"0".repeat(64)}});
   else if(mode==="proof")await ctx.db.patch(row._id,{receipt:{...row.receipt,proof:{...row.receipt.proof,signature:"0".repeat(64)}}});
   else await ctx.db.patch(row._id,{aggregate:mode==="state"?{...row.aggregate,state:"publish_ready"}:{...row.aggregate,stageAttempts:row.aggregate.stageAttempts.map((a,i)=>i===row.aggregate.stageAttempts.length-1?{...a,attemptNumber:99}:a)}});
  });
  const drifted=await snapshot(f.t);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"),{...args,proof:{...unsigned,signature}}));assert.deepEqual(await snapshot(f.t),drifted);
  await f.t.run(async ctx=>{const {_id,_creationTime,...value}=row;await ctx.db.replace(_id,value);});
 }
 await normalDelivery(f);
 const delivered=await snapshot(f.t);const replayAfterDelivery=await f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"),{...args,proof:{...unsigned,signature}});assert.equal(replayAfterDelivery.committed,false);assert.deepEqual(await snapshot(f.t),delivered);
 });

 test("PRESENT exact result excludes only its source, never older unrelated unresolved commands", async () => {
 const f = await presentFixture(undefined, { olderCommands: true });
 await f.t.run(async ctx => {
   for (const commandId of ["command_offline_older_uncertain", "command_offline_oldest_uncertain"]) {
     const row = await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id", q => q.eq("commandId", commandId)).unique();
     await ctx.db.patch(row._id, { state: "reconciliation_required", lastFailureReason: "uncertain_effect" });
   }
 });
 const lease = await leased(f), args = { completionToken, jobId: f.jobId, workerId, leaseToken: lease.leaseToken };
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"), args);
 const result = { provider: "vercel", providerReceiptId: "dpl_offline_present", revisionId: "r1",
   stableUrl: `${origin}/announcements/${f.jobId}`, artifactSetId: "artifact_offline_narration_review",
   artifactManifestDigest: f.policy.manifestDigest, idempotencyKey: f.binding.idempotencyKey };
 await f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"), { ...args, result, proof: await signPresentEvidence(lease.authorization, result) });
 const current = await job(f.t, f.jobId), before = await snapshot(f.t);
 await assert.rejects(() => f.t.mutation(ref("operations:requestCommand"), { operatorToken,
   commandId: "command_offline_must_block_queue", jobId: f.jobId, action: "queue_delivery",
   expectedState: "published", expectedVersion: current.version, payload: { revisionId: "r1",
     publicationId: current.publication.providerReceiptId, artifactManifestDigest: current.publication.artifactManifestDigest } }),
   "unrelated unresolved commands must not be hidden by the newer receipted source");
 assert.deepEqual(await snapshot(f.t), before);
 const detail = await f.t.query(ref("operations:getJob"), { operatorToken, jobId: f.jobId });
 assert.equal(detail.summary.state, "reconciliation_required");
 assert.deepEqual(detail.availableActions, ["reconcile"]);
 const listing = await f.t.query(ref("operations:listJobs"), { operatorToken, paginationOpts: { numItems: 10, cursor: null } });
 assert.equal(listing.page.find(x => x.jobId === f.jobId).state, "reconciliation_required");
 assert.deepEqual(await snapshot(f.t), before);
 });

const presentCommandDrifts = {
  action: row => ({ action: "publish" }),
  commandId: row => ({ commandId: "command_offline_unrelated" }),
  jobId: row => ({ jobId: `job_owner_trial_${"a".repeat(32)}` }),
  payload: row => ({ payload: { ...row.payload, sourceCommandId: "command_offline_unrelated" } }),
  expectedState: row => ({ expectedState: "publish_ready" }),
  expectedVersion: row => ({ expectedVersion: row.expectedVersion + 1 }),
  requestedAt: row => ({ requestedAt: new Date(Date.parse(row.requestedAt) - 1).toISOString() }),
  requestedBy: row => ({ requestedBy: "automatic_canonical_completion" }),
  supersedesCommandId: row => ({ supersedesCommandId: "command_offline_unrelated" }),
  lastFailureReason: row => ({ lastFailureReason: "uncertain_effect" }),
  outcome: row => ({ outcome: { code: "reconciled", jobVersion: row.expectedVersion } }),
  updatedAt: row => ({ updatedAt: new Date(Date.parse(row.updatedAt) - 1).toISOString() }),
  attempts: row => ({ attempts: row.attempts + 1 }),
  claimWorker: row => ({ claim: { ...row.claim, workerId: "other-worker" } }),
  claimToken: row => ({ claim: { ...row.claim, leaseToken: "other-lease-token" } }),
  claimExpiry: row => ({ claim: { ...row.claim, leaseExpiresAtMs: row.claim.leaseExpiresAtMs + 1 } }),
  claimTime: row => ({ claim: { ...row.claim, claimedAtMs: row.claim.claimedAtMs - 1 } }),
  effectFence: row => ({ claim: { ...row.claim, effectStartedAtMs: row.claim.effectStartedAtMs - 1 } }),
};
async function driftCommand(f, commandId, change) {
  await f.t.run(async ctx => {
    const row = await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id", q => q.eq("commandId", commandId)).unique();
    await ctx.db.patch(row._id, change(row));
  });
}
function presentResult(f) {
  // Explicit synthetic backend proof fixture; real transport/readback is exercised above.
  return { provider: "vercel", providerReceiptId: "dpl_offline_present", revisionId: "r1",
    stableUrl: `${origin}/announcements/${f.jobId}`, artifactSetId: "artifact_offline_narration_review",
    artifactManifestDigest: f.policy.manifestDigest, idempotencyKey: f.binding.idempotencyKey };
}
for (const mode of [...Object.keys(presentCommandDrifts), "sourceAction", "sourcePayload", "sourceAttempts", "originalAttemptIndex", "unrelatedArtifactCommand", "unfencedAction"]) {
  test(`PRESENT signed active command binding rejects ${mode} at every consequential gate`, async () => {
    const f = await presentFixture(), lease = await leased(f);
    const args = { completionToken, jobId: f.jobId, workerId, leaseToken: lease.leaseToken };
    if (mode !== "unfencedAction") await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"), args);
    if (mode.startsWith("source")) await driftCommand(f, f.binding.sourceCommandId,
      mode === "sourceAction" ? row => ({ action: "generate" }) : mode === "sourcePayload"
        ? row => ({ payload: { ...row.payload, revisionId: "r2" } }) : row => ({ attempts: row.attempts + 1 }));
    else if (mode === "originalAttemptIndex") await patchJob(f.t, f.jobId, j => ({ ...j,
      stageAttempts: j.stageAttempts.map((a, i) => i === j.stageAttempts.length - 1 ? { ...a, attemptNumber: a.attemptNumber + 1 } : a) }));
    else if (mode !== "unrelatedArtifactCommand") await driftCommand(f, f.commandId,
      presentCommandDrifts[mode === "unfencedAction" ? "action" : mode]);
    const before = await snapshot(f.t), result = presentResult(f), proof = await signPresentEvidence(lease.authorization, result);
    if (mode !== "unrelatedArtifactCommand") {
      // The same fence is used both to establish and to refresh ownership; neither may repair drift.
      await assert.rejects(() => f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"), args));
      assert.deepEqual(await snapshot(f.t), before);
      await assert.rejects(() => f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"), { ...args, result, proof }));
      assert.deepEqual(await snapshot(f.t), before);
    }
    await assert.rejects(() => f.t.query(ref("ownerTrialCompletion:authorizeArtifactRead"), { ...args,
      commandId: mode === "unrelatedArtifactCommand" ? "command_offline_unrelated" : f.commandId,
      revisionId: "r1", storageId: f.files[0].storageId }));
    assert.deepEqual(await snapshot(f.t), before);
    await assert.rejects(() => f.t.mutation(ref("ownerTrialPublicationPresent:claimReconciliation"), args));
    assert.deepEqual(await snapshot(f.t), before);
  });
}
for (const mode of ["action", "payload", "requestedAt", "requestedBy", "supersedesCommandId", "lastFailureReason", "outcome", "updatedAt", "claimTime", "sourceAction"]) {
  test(`PRESENT committed exact command binding rejects ${mode} before replay or delivery`, async () => {
    const f = await presentFixture(), lease = await leased(f);
    const args = { completionToken, jobId: f.jobId, workerId, leaseToken: lease.leaseToken };
    await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"), args);
    const result = presentResult(f), proof = await signPresentEvidence(lease.authorization, result);
    await f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"), { ...args, result, proof });
    await driftCommand(f, mode === "sourceAction" ? f.binding.sourceCommandId : f.commandId,
      mode === "sourceAction" ? row => ({ action: "generate" }) : presentCommandDrifts[mode]);
    const before = await snapshot(f.t), current = await job(f.t, f.jobId);
    await assert.rejects(() => f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"), { ...args, result, proof }));
    assert.deepEqual(await snapshot(f.t), before);
    await assert.rejects(() => f.t.mutation(ref("operations:requestCommand"), { operatorToken,
      commandId: "command_offline_drift_delivery", jobId: f.jobId, action: "queue_delivery",
      expectedState: "published", expectedVersion: current.version, payload: { revisionId: "r1",
        publicationId: result.providerReceiptId, artifactManifestDigest: result.artifactManifestDigest } }));
    assert.deepEqual(await snapshot(f.t), before);
  });
}

// Privileged synthetic integrity injection after real queue admission.
for(const mode of ["completedCommandAction","olderUnresolved"])test(`INDEPENDENT delivery worker revalidates ${mode} after enqueue`,async()=>{
 const f=await presentFixture(undefined,{olderCommands:true}),lease=await leased(f),args={completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken};
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),args);
 const result=presentResult(f),proof=await signPresentEvidence(lease.authorization,result);
 await f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"),{...args,result,proof});
 let emails=0;
 const opts={client:f.client,jobId:f.jobId,environment:{BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN:completionToken,CONVEX_URL:"https://offline-fixture.convex.cloud",OWNER_TRIAL_RESEND_FROM:"owner-trial@example.invalid"},publicationProvider:{publish(){throw new Error("must not publish");},reconcile(){throw new Error("must not republish");}},resend:{emails:{async send(payload){emails++;assert.deepEqual(payload.to,["z@havesomecode.io"]);return {data:{id:"message_independent_fault"},error:null};}}}};
 let current=await job(f.t,f.jobId);
 const payload={revisionId:"r1",publicationId:result.providerReceiptId,artifactManifestDigest:result.artifactManifestDigest};
 await f.t.mutation(ref("operations:requestCommand"),{operatorToken,commandId:"command_independent_queue_before_drift",jobId:f.jobId,action:"queue_delivery",expectedState:current.state,expectedVersion:current.version,payload});
 await runOwnerTrialCompletionWorkerCommand(opts);
 current=await job(f.t,f.jobId);
 await f.t.mutation(ref("operations:requestCommand"),{operatorToken,commandId:"command_independent_deliver_before_drift",jobId:f.jobId,action:"deliver",expectedState:current.state,expectedVersion:current.version,payload});
 await driftCommand(f,mode==="completedCommandAction"?f.commandId:"command_offline_older_uncertain",()=>mode==="completedCommandAction"?{action:"publish"}:{state:"reconciliation_required",lastFailureReason:"uncertain_effect"});
 if(mode==="completedCommandAction")await assert.rejects(()=>f.t.query(ref("operations:getJob"),{operatorToken,jobId:f.jobId}));
 else {const detail=await f.t.query(ref("operations:getJob"),{operatorToken,jobId:f.jobId});assert.equal(detail.summary.state,"reconciliation_required");assert.deepEqual(detail.availableActions,["reconcile"]);}
 const before=await snapshot(f.t);let workerError=null;
 try{await runOwnerTrialCompletionWorkerCommand(opts);}catch(error){workerError=error.message;}
 console.log("INDEPENDENT persisted-drift delivery observation",JSON.stringify({mode,emails,workerError,state:(await job(f.t,f.jobId)).state}));
 assert.equal(emails,0,"delivery must not issue after PRESENT command binding or unresolved-set drift");
 assert.ok(workerError,"delivery worker must fail closed on persisted drift");
 assert.deepEqual(await snapshot(f.t),before);
});

async function deliveryAuthorityFixture(clock) {
  let f,result;
  if(clock){f=await supersessionFixture(clock);await f.authorize();const identity={completionToken,jobId:f.jobId,workerId,leaseToken:"offline-supersession-delivery-fixture"};const claimed=await f.t.mutation(ref("ownerTrialPublicationSupersession:claimSupersession"),identity);await f.t.mutation(ref("ownerTrialPublicationSupersession:fenceSupersession"),identity);result=supersessionResult(claimed.authorization);await f.t.mutation(ref("ownerTrialPublicationSupersession:commitSupersession"),{...identity,result,proof:await supersessionSuccessProof(claimed.authorization,result)});
  }else{
  f = await presentFixture(undefined, { olderCommands: true });const lease = await leased(f);
  const args = { completionToken, jobId: f.jobId, workerId, leaseToken: lease.leaseToken };
  await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"), args);
  result = presentResult(f);
  await f.t.mutation(ref("ownerTrialPublicationPresent:commitReconciliation"), {
    ...args, result, proof: await signPresentEvidence(lease.authorization, result) });
  }
  const counters = { email: 0, publish: 0, reconcile: 0, artifact: 0 };
  const options = { client: f.client, jobId: f.jobId, environment: {
    BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN: completionToken,
    CONVEX_URL: "https://offline-fixture.convex.cloud", OWNER_TRIAL_RESEND_FROM: "owner-trial@example.invalid" },
    fetch: async () => { counters.artifact++; throw new Error("delivery must not read provider artifacts"); },
    publicationProvider: {
      publish() { counters.publish++; throw new Error("must not publish"); },
      reconcile() { counters.reconcile++; throw new Error("must not republish"); } },
    resend: { emails: { async send(payload) {
      counters.email++; assert.deepEqual(payload.to, ["z@havesomecode.io"]);
      return { data: { id: "message_boundary_fixture" }, error: null };
    } } } };
  const payload = { revisionId: "r1", publicationId: result.providerReceiptId,
    artifactManifestDigest: result.artifactManifestDigest };
  let current = await job(f.t, f.jobId);
  await f.t.mutation(ref("operations:requestCommand"), { operatorToken, jobId: f.jobId,
    commandId: "command_boundary_queue_delivery", action: "queue_delivery",
    expectedState: current.state, expectedVersion: current.version, payload });
  await runOwnerTrialCompletionWorkerCommand(options);
  current = await job(f.t, f.jobId);
  const deliveryCommandId = "command_boundary_deliver";
  await f.t.mutation(ref("operations:requestCommand"), { operatorToken, jobId: f.jobId,
    commandId: deliveryCommandId, action: "deliver", expectedState: current.state,
    expectedVersion: current.version, payload });
  return { ...f, options, counters, deliveryCommandId };
}
async function invalidateDeliveryAuthority(f, mode) {
  await driftCommand(f, mode === "completedCommandAction" ? f.commandId : "command_offline_older_uncertain",
    () => mode === "completedCommandAction" ? { action: "publish" }
      : { state: "reconciliation_required", lastFailureReason: "uncertain_effect" });
}
for(const superseding of [false,true]) {
for (const mode of ["completedCommandAction", "olderUnresolved"]) {
  for (const boundary of ["claim", "stageClaim", "operationsFence", "stageFence", "stageFenceCAS", "successCAS", "providerEffect"]) {
    test(`${superseding?"supersession":"PRESENT"} delivery authority ${mode} drift after ${boundary} preserves fences and blocks replay`, async clock => {
      const f = await deliveryAuthorityFixture(superseding?clock:null), baseline = await snapshot(f.t);
      let injected = false;
      const inject = async () => { assert.equal(injected, false); injected = true; await invalidateDeliveryAuthority(f, mode); };
      // Observe genuine backend transactions; no persistence or capability mocks.
      const client = { ...f.client, mutation: async (name, args) => {
        if (!injected && name === "ownerTrialCompletion:replaceJob"
          && ((boundary === "stageFenceCAS" && args.aggregate.events.at(-1).type === "external_effect_fenced")
            || (boundary === "successCAS" && args.aggregate.events.at(-1).type === "stage_completed"))) await inject();
        const result = await f.client.mutation(name, args);
        if (!injected && ((boundary === "claim" && name === "operations:claimCommands")
          || (boundary === "stageClaim" && name === "ownerTrialCompletion:replaceJob" && args.aggregate.events.at(-1).type === "stage_claimed")
          || (boundary === "operationsFence" && name === "operations:fenceCommand" && args.effectMayBeIssued)
          || (boundary === "stageFence" && name === "ownerTrialCompletion:replaceJob" && args.aggregate.events.at(-1).type === "external_effect_fenced"))) await inject();
        return result;
      } };
      const send = f.options.resend.emails.send;
      if (boundary === "providerEffect") f.options.resend.emails.send = async payload => {
        const result = await send(payload); await inject(); return result;
      };
      try { await runOwnerTrialCompletionWorkerCommand({ ...f.options, client }); } catch {}
      assert.equal(injected, true, "must reach the real named transaction boundary");
      assert.equal(f.counters.email, ["providerEffect", "successCAS"].includes(boundary) ? 1 : 0);
      assert.equal(f.counters.publish + f.counters.reconcile + f.counters.artifact, 0);
      const current = await job(f.t, f.jobId), after = await snapshot(f.t);
      assert.notEqual(current.state, "sent"); assert.equal(current.deliveryAttempts.length, 0);
      assert.equal(current.retry, null);
      assert.deepEqual(current.stageAttempts.slice(0, f.failed.stageAttempts.length), f.failed.stageAttempts);
      assert.deepEqual(current.events.slice(0, f.failed.events.length), f.failed.events);
      assert.deepEqual(after.customerFlowOperationsCommands.find(x => x.commandId === f.binding.sourceCommandId),
        baseline.customerFlowOperationsCommands.find(x => x.commandId === f.binding.sourceCommandId));
      const cmd = after.customerFlowOperationsCommands.find(x => x.commandId === f.deliveryCommandId);
      if (["operationsFence", "stageFence", "stageFenceCAS", "successCAS", "providerEffect"].includes(boundary)) {
        assert.equal(cmd.state, "reconciliation_required");
        assert.equal(cmd.claim, null);
        assert.equal(cmd.outcome, null);
        assert.equal(cmd.lastFailureReason, "operation_failed");
      }
      if (["stageFence", "successCAS", "providerEffect"].includes(boundary)) {
        assert.ok(current.stageAttempts.at(-1).effectStartedAt);
        assert.equal(current.stageAttempts.at(-1).status, "running");
      }
      await assert.rejects(() => runOwnerTrialCompletionWorkerCommand(f.options));
      assert.deepEqual(await snapshot(f.t), after); // inert replay; no automatic retries
      assert.equal(f.counters.email, ["providerEffect", "successCAS"].includes(boundary) ? 1 : 0);
    });
  }
  test(`${superseding?"supersession":"PRESENT"} delivery ${mode} safe nonretryable pre-effect failure bookkeeping remains possible`, async clock => {
    const f = await deliveryAuthorityFixture(superseding?clock:null);
    const [claim] = await f.t.mutation(ref("operations:claimCommands"), { workerToken: completionToken,
      workerId, actions, limit: 1, leaseMs: 300000, jobId: f.jobId });
    await invalidateDeliveryAuthority(f, mode);
    const before = await snapshot(f.t), auth = { workerToken: completionToken,
      commandId: claim.commandId, workerId, leaseToken: claim.claim.leaseToken };
    await assert.rejects(() => f.t.mutation(ref("operations:failCommand"), {
      ...auth, retryable: true, reasonCode: "operation_failed" }));
    assert.deepEqual(await snapshot(f.t), before);
    await f.t.mutation(ref("operations:failCommand"), { ...auth, retryable: false, reasonCode: "operation_failed" });
    const after = await snapshot(f.t);
    assert.deepEqual(after.fulfillmentJobs, before.fulfillmentJobs);
    assert.equal(after.customerFlowOperationsCommands.find(x => x.commandId === claim.commandId).state, "failed");
    assert.deepEqual(f.counters, { email: 0, publish: 0, reconcile: 0, artifact: 0 });
  });
}

for (const mode of ["completedCommandAction", "olderUnresolved", "publicationRemoved"]) {
  test(`${superseding?"supersession":"PRESENT"} delivery ${mode} direct claim refresh effect read CAS and command commit reject without writes`, async clock => {
    const f = await deliveryAuthorityFixture(superseding?clock:null);
    const [command] = await f.t.mutation(ref("operations:claimCommands"), { workerToken: completionToken,
      workerId, actions, jobId: f.jobId, limit: 1, leaseMs: 300000 });
    if (mode === "publicationRemoved") await patchJob(f.t, f.jobId, j => ({ ...j, publication: null }));
    else await invalidateDeliveryAuthority(f, mode);
    const before = await snapshot(f.t), aggregate = await job(f.t, f.jobId);
    const scoped = { completionToken, jobId: f.jobId, workerId,
      commandId: command.commandId, leaseToken: command.claim.leaseToken };
    const ops = { workerToken: completionToken, workerId,
      commandId: command.commandId, leaseToken: command.claim.leaseToken };
    const calls = [
      () => f.t.mutation(ref("operations:claimCommands"), { workerToken: completionToken,
        workerId, actions, jobId: f.jobId, limit: 1, leaseMs: 300000 }),
      ...[false, true].map(effectMayBeIssued => () => f.t.mutation(ref("operations:fenceCommand"), {
        ...ops, leaseMs: 300000, effectMayBeIssued })),
      () => f.t.query(ref("ownerTrialCompletion:getJob"), scoped),
      () => f.t.query(ref("ownerTrialCompletion:getReviewApproval"), {
        completionToken, jobId: f.jobId, approvalId: f.policy.narrationApprovalId }),
      () => f.t.query(ref("ownerTrialCompletion:authorizeArtifactRead"), {
        ...scoped, revisionId: "r1", storageId: f.files[0].storageId }),
      () => f.t.mutation(ref("ownerTrialCompletion:replaceJob"), {
        ...scoped, expectedVersion: aggregate.version, aggregate }),
      () => f.t.mutation(ref("operations:completeCommand"), {
        ...ops, outcome: { code: "delivery_accepted", deliveryAttemptId: "delivery_not_sent", jobVersion: aggregate.version, providerMessageId: "message_not_sent" } }),
    ];
    for (const call of calls) {
      await assert.rejects(call, /Owner trial (?:PRESENT (?:reconciliation|supersession) rejected|delivery has unresolved command authority)/u);
      assert.deepEqual(await snapshot(f.t), before);
    }
    assert.deepEqual(f.counters, { email: 0, publish: 0, reconcile: 0, artifact: 0 });
  });
}

}
test("approved runtime assets pass real internal HTTP artifact authorization",async()=>{
 const f=await presentFixture(undefined,{runtimeAssets:true}),lease=await leased(f);
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),{completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken});
 for(const file of f.files.filter(x=>x.path.startsWith("deploy/_assets/"))){
  const response=await f.t.fetch(`/completion/artifact?jobId=${f.jobId}&revisionId=r1&storageId=${file.storageId}`,{headers:{authorization:`Bearer ${completionToken}`,"x-bebebonjour-worker-id":workerId,"x-bebebonjour-command-id":f.commandId,"x-bebebonjour-lease-token":lease.leaseToken}});
  assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),file.sha256);
 }
});
test("exact expired positive PRESENT exposes supersession context without rewriting history",async clock=>{
 const f=await presentFixture(clock,{runtimeAssets:true}),lease=await leased(f);
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),{completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken});
 clock.mock.timers.setTime(lease.expiresAtMs);
 const before=await snapshot(f.t);
 const context=await f.t.query(ref("ownerTrialPublicationSupersession:authorizationContext"),{operatorToken,completionToken,jobId:f.jobId});
 assert.equal(context.binding.oldDeploymentId,"dpl_offline_present");assert.equal(context.binding.operationNumber,2);
 assert.notEqual(context.binding.idempotencyKey,f.binding.idempotencyKey);assert.equal(context.binding.runtimeFiles.length,4);
 assert.deepEqual(await snapshot(f.t),before);
});

import { stablePrivateValue as canonical } from "../../src/fulfillment/private-generation-authority.mjs";
import { publicToolbarRead } from "../../src/operations/owner-trial-publication-supersession-worker.mjs";
const canonicalDigest=value=>sha(canonical(value));
async function signSupersession(domain,unsigned,secret=recoveryToken){
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return {...unsigned,signature:Buffer.from(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${domain}\0${canonical(unsigned)}`))).toString("hex")};
}
function providerTree(paths){
 const tree=[];for(const [index,path]of paths.entries()){let branch=tree;const parts=path.split("/");for(const name of parts.slice(0,-1)){let d=branch.find(x=>x.name===name);if(!d){d={name,type:"directory",mode:16384,children:[]};branch.push(d);}branch=d.children;}branch.push({name:parts.at(-1),type:"file",mode:33188,uid:path==="vercel.json"?"config":`file_${index}`});}return tree;
}
async function supersessionFixture(clock,{olderCommands=true,legacyRecovery=false}={}){
 const f=await presentFixture(clock,{runtimeAssets:true,fullPublic:true,olderCommands,legacyRecovery}),lease=await leased(f);
 const identity={completionToken,jobId:f.jobId,workerId,leaseToken:lease.leaseToken};
 await f.t.mutation(ref("ownerTrialPublicationPresent:fenceReconciliation"),identity);
 const artifact=f.failed.artifactSets.find(x=>x.kind==="narration_review"),base=`/announcements/${f.jobId}`;
 const resolver=createOwnerTrialPublicArtifactResolver({policy:f.policy,token:completionToken,siteOrigin:"https://offline-fixture.convex.site",revalidate:async()=>f.policy,fetch:(url,init)=>f.t.fetch(new URL(url).pathname+new URL(url).search,init)});
 const resolved=await resolver.resolve({jobId:f.jobId,environment:"test",product:"announcement-page",revisionId:"r1",artifactSet:artifact,artifactSetId:artifact.artifactSetId,artifactManifestDigest:f.policy.manifestDigest,idempotencyKey:f.binding.idempotencyKey,
 artifactReadAuthority:{workerId,commandId:f.commandId,leaseToken:lease.leaseToken},fenceExternalEffect:async(_,invoke)=>invoke()});
 assert.equal(resolved.files.length,18);
 const configuration=Buffer.from(`${JSON.stringify({redirects:[{source:base,destination:`${base}/fr/`,permanent:false}],headers:[{source:`${base}/(.*)`,headers:[{key:"cache-control",value:"private, no-store, max-age=0"}]}]},null,2)}\n`);
 const inspection={schemaVersion:"1.0",source:"vercel inspect --format=json",deploymentId:"dpl_offline_bootstrap",buildId:"build_offline",teamId:"team_offline",projectId:"prj_offline",projectName:"offline-trial",revisionId:"r1"};
 const oldDetail={id:"dpl_offline_present",uid:"dpl_offline_present",url:"offline-old.vercel.app",projectId:"prj_offline",readyState:"READY",createdAt:Date.now(),meta:{bbCanaryJobId:f.jobId,bbRevisionId:"r1",bbArtifactSetId:artifact.artifactSetId,bbArtifactManifestDigest:f.policy.manifestDigest,bbIdempotencyKey:f.binding.idempotencyKey}};
 const oldTree=[{name:"src",type:"directory",mode:16749,children:providerTree([...resolved.files.filter(x=>!x.publicPath.startsWith("_assets/")).map(x=>`announcements/${f.jobId}/${x.publicPath}`),`announcements/${f.jobId}/.publication.json`,"vercel.json"])}];
 const configResponse={data:configuration.toString("base64")};
 const aliasBody={alias:new URL(origin).hostname,deploymentId:oldDetail.id,projectId:"prj_offline"};
 const pages=[{deployments:[oldDetail],pagination:{next:null}}];
 const missingRuntime=resolved.files.filter(x=>x.publicPath.startsWith("_assets/")).map(x=>({path:x.publicPath,httpStatus:404,responseDigest:sha("missing-offline-runtime"),inventoryAbsent:true}));
 clock.mock.timers.setTime(lease.expiresAtMs);
 const ctx=await f.t.query(ref("ownerTrialPublicationSupersession:authorizationContext"),{operatorToken,completionToken,jobId:f.jobId});
 const unsigned={kind:"owner_trial_missing_runtime_evidence",contextDigest:ctx.contextDigest,binding:ctx.binding,observedAt:new Date().toISOString(),sourceManifestDigest:sha("offline-reviewed-candidate-source-manifest-not-live-evidence"),buildInspection:inspection,
 verification:{completeCensus:true,exactPositiveEffect:true,ready:true,exactDetail:true,exactConfig:true,exactInventory:true,exactAliasState:true},
 censusPages:pages,evidenceDigests:{census:canonicalDigest(pages),detail:canonicalDigest(oldDetail),inventory:canonicalDigest(oldTree),config:canonicalDigest(configResponse),alias:canonicalDigest({status:200,body:aliasBody}),publicReadback:canonicalDigest(missingRuntime)},
 historicalObservation:{commandId:f.commandId,authorizationSignature:lease.authorization.signature,leaseDigest:canonicalDigest((await snapshot(f.t)).ownerTrialPublicationPresentLeases[0].lease),completeTransportTraceDigest:sha("complete-offline-closed-invocation-read-only-transport"),complete:true,providerMutationCount:0,aliasMutationCount:0,invocationClosed:true,observedThrough:Date.parse(lease.claimedAt)+1},missingRuntime,
 correctedPublicInventory:resolved.files.map(x=>({path:x.publicPath,bytes:x.bytes.length,sha256:x.sha256}))};
 const proof=await signSupersession("owner-trial-missing-runtime-evidence-v1",unsigned);
 const authorize=()=>f.t.mutation(ref("ownerTrialPublicationSupersession:authorizeSupersession"),{operatorToken,completionToken,jobId:f.jobId,expectedVersion:ctx.binding.expectedVersion,contextDigest:ctx.contextDigest,proof});
 return {...f,ctx,proof,unsigned,authorize,resolved,configuration,inspection,oldDetail,oldTree,configResponse,aliasBody,pages,base};
}
async function realSupersessionSeam(clock,mode="success"){
 const f=await supersessionFixture(clock,{legacyRecovery:mode==="startupWithLegacy"||mode==="playbackBase"}),before=await snapshot(f.t),authorization=await f.authorize();
 const afterAuthorization=await snapshot(f.t);
 assert.deepEqual(afterAuthorization.fulfillmentJobs,before.fulfillmentJobs);
 assert.deepEqual(afterAuthorization.customerFlowOperationsCommands.slice(0,before.customerFlowOperationsCommands.length),before.customerFlowOperationsCommands);
 assert.deepEqual(afterAuthorization.ownerTrialPublicationPresentLeases,before.ownerTrialPublicationPresentLeases);
 const uploads=new Map(),deploymentFiles=new Map(),trace=[];let deployment=null,aliased=false,signed=0,censusReads=0;
 const fetch=async(input,init={})=>{
  const u=new URL(input),method=init.method||"GET",headers=new Headers(init.headers);trace.push({url:u.href,method,toolbar:headers.get("x-vercel-skip-toolbar")});
  assert.equal(headers.has("x-vercel-protection-bypass"),false);
  if(u.origin==="https://api.vercel.com")assert.equal(headers.has("x-vercel-skip-toolbar"),false);
  if(u.hostname==="offline-fixture.convex.site"){
   assert.equal(headers.has("x-vercel-skip-toolbar"),false);
   const response=await f.t.fetch(u.pathname+u.search,init);assert.equal(response.status,200);return response;
  }
  if(u.origin==="https://api.vercel.com"){
   if(u.pathname==="/v7/deployments"){
    censusReads++;
    if(mode.startsWith("newKey")&&censusReads>1&&!deployment){
     const existing={...f.oldDetail,id:"dpl_offline_preexisting_new_key",uid:"dpl_offline_preexisting_new_key",url:"offline-preexisting.vercel.app",meta:{...f.oldDetail.meta,bbIdempotencyKey:f.ctx.binding.idempotencyKey}};
     if(mode==="newKeyCollision")existing.meta.bbArtifactManifestDigest=sha("different-source-under-same-new-key");
     return Response.json({deployments:[f.oldDetail,existing,...(mode==="newKeyDuplicate"?[{...existing,id:"dpl_offline_duplicate_new_key",uid:"dpl_offline_duplicate_new_key"}]:[])],pagination:{next:null}});
    }
    return Response.json(deployment?{deployments:[f.oldDetail,deployment],pagination:{next:null}}:f.pages[0]);
   }
   if(u.pathname==="/v2/files"){
    uploads.set(headers.get("x-vercel-digest"),Buffer.from(init.body));return new Response("",{status:201});
   }
   if(u.pathname==="/v13/deployments"&&method==="POST"){
    const body=JSON.parse(init.body);assert.equal(body.files.length,20);
    for(const file of body.files){assert.ok(uploads.has(file.sha));deploymentFiles.set(file.file,uploads.get(file.sha));}
    deployment={id:"dpl_offline_corrected",uid:"dpl_offline_corrected",url:"offline-corrected.vercel.app",projectId:"prj_offline",readyState:"READY",createdAt:Date.now(),meta:body.meta};
    if(mode==="uncertainCreate")throw new Error("offline uncertain create effect");return Response.json(deployment,{status:201});
   }
   if(u.pathname.startsWith("/v13/deployments/"))return Response.json(u.pathname.endsWith(f.oldDetail.id)?f.oldDetail:deployment);
   if(u.pathname.startsWith("/v6/deployments/"))return Response.json(u.pathname.includes(f.oldDetail.id)?f.oldTree:providerTree([...deploymentFiles.keys()].filter(x=>mode!=="missingRuntime"||!x.includes("/_assets/"))));
   if(u.pathname.startsWith("/v8/deployments/"))return Response.json(f.configResponse);
   if(u.pathname.startsWith("/v4/aliases/"))return Response.json(aliased?{...f.aliasBody,deploymentId:deployment.id}:f.aliasBody);
   if(u.pathname.endsWith("/aliases")&&method==="POST"){
    if(mode==="uncertainAlias")throw new Error("offline uncertain alias effect");aliased=true;return Response.json({uid:"alias_offline_corrected",created:new Date().toISOString(),alias:new URL(origin).hostname,deploymentId:deployment.id,projectId:"prj_offline"});
   }
  }
  assert.equal(headers.get("x-vercel-skip-toolbar"),"1");
  if(u.hostname==="offline-old.vercel.app")return new Response(mode==="dynamic404"?`missing-runtime-request-${trace.length}`:"missing-offline-runtime",{status:404});
  if(mode==="sso302")return new Response("",{status:302,headers:{location:"https://vercel.com/sso"}});
  if(u.pathname===f.base)return new Response("",{status:307,headers:{location:`${f.base}/fr/`}});
  const path=u.pathname.endsWith("/fr/")?u.pathname.slice(1)+"index.html":u.pathname.slice(1);
  const bytes=deploymentFiles.get(path);if(!bytes)throw new Error(`unknown offline public path ${path}`);
  return new Response(mode==="wrongBytes"&&path.endsWith(".html")?Buffer.from("wrong-bytes"):bytes,{headers:{"cache-control":"private, no-store, max-age=0"}});
 };
 const options={client:f.client,supersedePresent:true,jobId:f.jobId,fetch,pollIntervalMs:0,maxPollAttempts:1,environment:{BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN:completionToken,CONVEX_URL:"https://offline-fixture.convex.cloud",OWNER_TRIAL_JOB_ID:f.jobId,OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN:"offline-only-provider-token"},
 signSupersessionResult:async({authorization,result,completeTransportTraceDigest})=>{signed++;assert.equal(aliased,true);return signSupersession("owner-trial-supersession-success-evidence-v1",{kind:"owner_trial_supersession_success_evidence",authorizationSignature:authorization.signature,sourceDigest:authorization.sourceDigest,result,observedAt:new Date().toISOString(),completeTransportTraceDigest,verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true}});}};
 if(mode.startsWith("newKey")){
  await assert.rejects(()=>runOwnerTrialCompletionWorkerCommand(options),/idempotency key already present|publication request failed/u);
  assert.equal(trace.filter(x=>x.method==="POST").length,0);assert.equal(signed,0);assert.equal(aliased,false);
  const failed=await snapshot(f.t),failedJob=await job(f.t,f.jobId);assert.equal(failedJob.state,"reconciliation_required");assert.equal(failedJob.publication,null);assert.equal(failedJob.retry,null);
  const count=trace.length;await assert.rejects(()=>runOwnerTrialCompletionWorkerCommand(options));assert.equal(trace.length,count);
  await assert.rejects(()=>normalDelivery(f));assert.deepEqual(await snapshot(f.t),failed);
 }else if(!["success","dynamic404","startupWithLegacy","playbackBase"].includes(mode)){
  await assert.rejects(()=>runOwnerTrialCompletionWorkerCommand(options),mode==="missingRuntime"?/inventory/u:mode==="wrongBytes"?/bytes/u:mode==="sso302"?/could not be verified/u:/publication request failed/u);assert.equal(signed,0);
  assert.equal(trace.filter(x=>x.method==="POST"&&new URL(x.url).pathname==="/v13/deployments").length,1);
  assert.equal(trace.filter(x=>x.method==="POST"&&new URL(x.url).pathname.endsWith("/aliases")).length,mode==="uncertainAlias"?1:0);
  const failed=await snapshot(f.t);assert.equal((await job(f.t,f.jobId)).publication,null);assert.equal((await job(f.t,f.jobId)).retry,null);
  const count=trace.length;await assert.rejects(()=>runOwnerTrialCompletionWorkerCommand(options));assert.equal(trace.length,count);assert.deepEqual(await snapshot(f.t),failed);
 }else{
  const result=await runOwnerTrialCompletionWorkerCommand(options);assert.equal(result.committed,true);assert.equal(signed,1);
  assert.equal((await job(f.t,f.jobId)).state,"published");assert.equal(deploymentFiles.size,20);
  for(const file of f.resolved.files)assert.equal(sha(deploymentFiles.get(`announcements/${f.jobId}/${file.publicPath}`)),file.sha256);
  assert.ok(![...deploymentFiles.keys()].some(path=>path.includes("intake.json")));
  if(mode==="startupWithLegacy") assert.equal((await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"),{completionToken,jobId:f.jobId})).maxAttempts,2);
  if(mode!=="playbackBase"){await normalDelivery(f);assert.equal((await job(f.t,f.jobId)).state,"sent");}
  if(mode==="startupWithLegacy") assert.equal((await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"),{completionToken,jobId:f.jobId})).maxAttempts,2);
 }
 const after=await snapshot(f.t),oldCount=f.failed.stageAttempts.length;
 assert.deepEqual((await job(f.t,f.jobId)).stageAttempts.slice(0,oldCount),f.failed.stageAttempts);
 assert.deepEqual(after.customerFlowOperationsCommands.filter(x=>[f.binding.sourceCommandId,f.commandId].includes(x.commandId)),before.customerFlowOperationsCommands.filter(x=>[f.binding.sourceCommandId,f.commandId].includes(x.commandId)));
 assert.deepEqual(after.ownerTrialPublicationPresentAuthorizations,before.ownerTrialPublicationPresentAuthorizations);assert.deepEqual(after.ownerTrialPublicationPresentLeases,before.ownerTrialPublicationPresentLeases);
 return {f,options,trace};
}
for(const mode of ["success","dynamic404","missingRuntime","wrongBytes","sso302","uncertainCreate","uncertainAlias","newKeyCollision","newKeyExact","newKeyDuplicate"])test(`supersession real approved 18-file exporter provider internal HTTP and owner delivery ${mode}`,clock=>realSupersessionSeam(clock,mode));

test("supersession signed census denies existing new key conflicting exact duplicate and later omission before writes",async clock=>{
 const f=await supersessionFixture(clock),before=await snapshot(f.t);
 for(const mode of ["conflicting","exact","duplicate","exactThenOmitted"]){
  const existing={...f.oldDetail,id:"dpl_offline_preexisting_new_key",uid:"dpl_offline_preexisting_new_key",meta:{...f.oldDetail.meta,bbIdempotencyKey:f.ctx.binding.idempotencyKey}};
  if(mode==="conflicting")existing.meta.bbArtifactManifestDigest=sha("different-source-under-same-new-key");
  const censusPages=[{deployments:[f.oldDetail,existing,...(mode==="duplicate"?[{...existing,id:"dpl_offline_duplicate_new_key",uid:"dpl_offline_duplicate_new_key"}]:[])],pagination:{next:null}}];
  const proof=await signSupersession("owner-trial-missing-runtime-evidence-v1",{...f.unsigned,censusPages,evidenceDigests:{...f.unsigned.evidenceDigests,census:canonicalDigest(censusPages)}});
  await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationSupersession:authorizeSupersession"),{operatorToken,completionToken,jobId:f.jobId,expectedVersion:f.ctx.binding.expectedVersion,contextDigest:f.ctx.contextDigest,proof}));
  assert.deepEqual(await snapshot(f.t),before);
 }
});

function supersessionResult(a){const b=a.binding;return {provider:"vercel",providerReceiptId:"dpl_offline_corrected",stableUrl:`${b.origin}/announcements/${b.jobId}`,revisionId:b.revisionId,artifactSetId:a.snapshot.originalAggregate.artifactSets.find(x=>x.kind==="narration_review").artifactSetId,artifactManifestDigest:b.artifactManifestDigest,idempotencyKey:b.idempotencyKey};}
async function supersessionSuccessProof(a,result){return signSupersession("owner-trial-supersession-success-evidence-v1",{kind:"owner_trial_supersession_success_evidence",authorizationSignature:a.signature,sourceDigest:a.sourceDigest,result,observedAt:new Date().toISOString(),completeTransportTraceDigest:sha("offline-unit-result-boundary-not-live-provider-evidence"),verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true}});}
test("supersession signed evidence roles freshness historical no-mutation and exact source deny without writes",async clock=>{
 const f=await supersessionFixture(clock),before=await snapshot(f.t),args={operatorToken,completionToken,jobId:f.jobId,expectedVersion:f.ctx.binding.expectedVersion,contextDigest:f.ctx.contextDigest,proof:f.proof};
 for(const change of [{operatorToken:completionToken},{completionToken:operatorToken},{expectedVersion:args.expectedVersion-1},{jobId:`job_owner_trial_${"a".repeat(32)}`},{contextDigest:sha("wrong-context")}]){await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationSupersession:authorizeSupersession"),{...args,...change}));assert.deepEqual(await snapshot(f.t),before);}
 const variants=[{...f.unsigned,observedAt:new Date(Date.now()-60001).toISOString()},{...f.unsigned,observedAt:new Date(Date.now()+1).toISOString()},{...f.unsigned,contextDigest:sha("wrong")},{...f.unsigned,sourceManifestDigest:"arbitrary"},{...f.unsigned,binding:{...f.unsigned.binding,idempotencyKey:f.binding.idempotencyKey}},
 ...[{complete:false},{providerMutationCount:1},{aliasMutationCount:1},{invocationClosed:false},{completeTransportTraceDigest:"missing"},{leaseDigest:sha("wrong-lease")},{commandId:"other"}].map(h=>({...f.unsigned,historicalObservation:{...f.unsigned.historicalObservation,...h}})),
 {...f.unsigned,verification:{...f.unsigned.verification,completeCensus:false}},{...f.unsigned,missingRuntime:f.unsigned.missingRuntime.slice(1)},{...f.unsigned,correctedPublicInventory:f.unsigned.correctedPublicInventory.map((file,n)=>n===0?{...file,path:"intake.json"}:file)},
 {...f.unsigned,censusPages:null},{...f.unsigned,evidenceDigests:{...f.unsigned.evidenceDigests,census:sha("unbound-census")}},
 ...[[],[{deployments:[f.oldDetail],pagination:{next:1}}],[{deployments:[f.oldDetail,f.oldDetail],pagination:{next:null}}],[{deployments:[{...f.oldDetail,projectId:"prj_unrelated"}],pagination:{next:null}}]].map(censusPages=>({...f.unsigned,censusPages,evidenceDigests:{...f.unsigned.evidenceDigests,census:canonicalDigest(censusPages)}}))];
 for(const unsigned of variants){const proof=await signSupersession("owner-trial-missing-runtime-evidence-v1",unsigned);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationSupersession:authorizeSupersession"),{...args,proof}));assert.deepEqual(await snapshot(f.t),before);}
 for(const key of [hmacKey,completionToken,operatorToken]){const proof=await signSupersession("owner-trial-missing-runtime-evidence-v1",f.unsigned,key);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationSupersession:authorizeSupersession"),{...args,proof}));assert.deepEqual(await snapshot(f.t),before);}
 await f.authorize();const after=await snapshot(f.t);await assert.rejects(f.authorize);assert.deepEqual(await snapshot(f.t),after);
});
for(const state of ["pending","running","reconciliation_required"])test(`supersession unrelated ${state} rejects authorization claim artifact effect CAS success`,async clock=>{
 const f=await supersessionFixture(clock),identity={completionToken,jobId:f.jobId,workerId,leaseToken:"offline-supersession-matrix-lease"};
 const setState=()=>driftCommand(f,"command_offline_older_uncertain",()=>({state}));
 await setState();let before=await snapshot(f.t);await assert.rejects(f.authorize);assert.deepEqual(await snapshot(f.t),before);
 await driftCommand(f,"command_offline_older_uncertain",()=>({state:"completed"}));const authorized=await f.authorize();
 await setState();before=await snapshot(f.t);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationSupersession:claimSupersession"),identity));assert.deepEqual(await snapshot(f.t),before);
 await driftCommand(f,"command_offline_older_uncertain",()=>({state:"completed"}));const claimed=await f.t.mutation(ref("ownerTrialPublicationSupersession:claimSupersession"),identity);
 await f.t.mutation(ref("ownerTrialPublicationSupersession:fenceSupersession"),identity);await setState();before=await snapshot(f.t);
 const result=supersessionResult(claimed.authorization),proof=await supersessionSuccessProof(claimed.authorization,result),current=await job(f.t,f.jobId);
 for(const call of [()=>f.t.query(ref("ownerTrialPublicationSupersession:activeSupersession"),identity),()=>f.t.mutation(ref("ownerTrialPublicationSupersession:fenceSupersession"),identity),()=>f.t.mutation(ref("ownerTrialPublicationSupersession:failSupersession"),identity),()=>f.t.mutation(ref("ownerTrialPublicationSupersession:commitSupersession"),{...identity,result,proof}),()=>f.t.mutation(ref("ownerTrialCompletion:replaceJob"),{...identity,commandId:authorized.commandId,expectedVersion:current.version,aggregate:current})]){await assert.rejects(call);assert.deepEqual(await snapshot(f.t),before);}
 const file=f.ctx.binding.runtimeFiles[0];const response=await f.t.fetch(`/completion/artifact?jobId=${f.jobId}&revisionId=r1&storageId=${file.storageId}`,{headers:{authorization:`Bearer ${completionToken}`,"x-bebebonjour-worker-id":workerId,"x-bebebonjour-command-id":authorized.commandId,"x-bebebonjour-lease-token":identity.leaseToken}});assert.equal(response.status,403);assert.deepEqual(await snapshot(f.t),before);
});
test("supersession signature full command historic rows source approval and finite authority drift deny",async clock=>{
 const f=await supersessionFixture(clock),auth=await f.authorize(),identity={completionToken,jobId:f.jobId,workerId,leaseToken:"offline-supersession-integrity-probe"};
 const original=await snapshot(f.t);
 for(const id of [f.commandId,f.binding.sourceCommandId,auth.commandId]){await driftCommand(f,id,()=>({action:"deliver"}));const before=await snapshot(f.t);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationSupersession:claimSupersession"),identity));assert.deepEqual(await snapshot(f.t),before);await f.t.run(async c=>{const row=await c.db.query("customerFlowOperationsCommands").withIndex("by_command_id",q=>q.eq("commandId",id)).unique();const {_id,_creationTime,...record}=original.customerFlowOperationsCommands.find(x=>x.commandId===id);await c.db.replace(row._id,record);});}
 const claimed=await f.t.mutation(ref("ownerTrialPublicationSupersession:claimSupersession"),identity);await f.t.mutation(ref("ownerTrialPublicationSupersession:fenceSupersession"),identity);
 const result=supersessionResult(claimed.authorization),proof=await supersessionSuccessProof(claimed.authorization,result),before=await snapshot(f.t);
 for(const change of [{idempotencyKey:f.binding.idempotencyKey},{providerReceiptId:f.ctx.binding.oldDeploymentId},{stableUrl:"https://unapproved.example.invalid"},{artifactManifestDigest:sha("wrong")},{revisionId:"r2"}]){const modified={...result,...change};await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicationSupersession:commitSupersession"),{...identity,result:modified,proof:await supersessionSuccessProof(claimed.authorization,modified)}));assert.deepEqual(await snapshot(f.t),before);}
 for(const secret of [hmacKey,completionToken]){const {signature,...unsigned}=proof;await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicationSupersession:commitSupersession"),{...identity,result,proof:await signSupersession("owner-trial-supersession-success-evidence-v1",unsigned,secret)}));assert.deepEqual(await snapshot(f.t),before);}
 clock.mock.timers.setTime(claimed.lease.expiresAtMs);await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicationSupersession:commitSupersession"),{...identity,result,proof}));assert.deepEqual(await snapshot(f.t),before);
});

test("supersession completion startup validates legacy receipts after publication and delivery",async clock=>realSupersessionSeam(clock,"startupWithLegacy"));
async function playbackFixture(clock) {
 const {f}=await realSupersessionSeam(clock,"playbackBase");
 const prior=await job(f.t,f.jobId);
 await f.t.mutation(ref("operations:requestCommand"),{operatorToken,jobId:f.jobId,commandId:"command_playback_prior_pending_queue",action:"queue_delivery",expectedState:"published",expectedVersion:prior.version,payload:{revisionId:"r1",publicationId:prior.publication.providerReceiptId,artifactManifestDigest:f.policy.manifestDigest}});
 const ctx=await f.t.query(ref("ownerTrialPublicPlaybackRepair:authorizationContext"),{operatorToken,completionToken,jobId:f.jobId});
 const { projectOwnerTrialPlayback }=await import("../../src/fulfillment/owner-trial-playback-projection.mjs");
 const transcriptFile=ctx.binding.files.find(x=>x.path.endsWith("transcript.json"));
 const transcriptBytes=Buffer.from(await f.t.run(async c=>(await c.storage.get(transcriptFile.storageId)).arrayBuffer()));
 const projected=projectOwnerTrialPlayback({files:f.resolved.files,transcriptBytes});
 const inventory=projected.map(x=>({path:x.publicPath,bytes:x.bytes.length,sha256:x.sha256}));
 const old=await job(f.t,f.jobId),artifact=old.artifactSets.find(x=>x.kind==="narration_review");
 const detail={uid:old.publication.providerReceiptId,url:"offline-corrected.vercel.app",projectId:"prj_offline",readyState:"READY",meta:{bbCanaryJobId:f.jobId,bbRevisionId:"r1",bbArtifactSetId:artifact.artifactSetId,bbArtifactManifestDigest:f.policy.manifestDigest,bbIdempotencyKey:old.publication.idempotencyKey}};
 const censusPages=[{deployments:[detail],pagination:{next:null}}];
 const unsigned={kind:"owner_trial_public_playback_source_evidence",contextDigest:ctx.contextDigest,binding:ctx.binding,observedAt:new Date().toISOString(),sourceManifestDigest:sha("offline-playback-source"),correctedPublicInventory:inventory,censusPages,positivePublication:detail,censusDigest:canonicalDigest(censusPages),positivePublicationDigest:canonicalDigest(detail),verification:{ready:true,completeCensus:true,exactOldPublication:true,exactOldPublicBytes:true,sourceOnlyProjection:true,noPrivateProvenance:true,noProviderMutations:true}};
 const proof=await signSupersession("owner-trial-public-playback-source-evidence-v1",unsigned);
 const args={operatorToken,completionToken,jobId:f.jobId,expectedVersion:ctx.binding.expectedVersion,contextDigest:ctx.contextDigest,proof};
 const identity={completionToken,jobId:f.jobId,workerId,leaseToken:"offline-playback-repair-lease"};
 return {...f,ctx,unsigned,args,identity,projected,transcriptBytes};
}
function playbackResult(a){const b=a.binding;return {provider:"vercel",providerReceiptId:"dpl_offline_playback_op3",stableUrl:`${b.origin}/announcements/${b.jobId}`,revisionId:b.revisionId,artifactSetId:b.artifactSetId,artifactManifestDigest:b.artifactManifestDigest,idempotencyKey:b.idempotencyKey};}
async function playbackSuccess(a,result){
 const b=a.binding,deploymentDetail={id:result.providerReceiptId,url:"offline-playback.vercel.app",projectId:b.provider.projectId,readyState:"READY",meta:{bbCanaryJobId:b.jobId,bbRevisionId:b.revisionId,bbArtifactSetId:b.artifactSetId,bbArtifactManifestDigest:b.artifactManifestDigest,bbIdempotencyKey:b.idempotencyKey}};
 const censusPages=[{deployments:[a.proof.positivePublication,deploymentDetail],pagination:{next:null}}];
 return signSupersession("owner-trial-public-playback-success-evidence-v1",{deploymentDetail,censusPages,censusDigest:canonicalDigest(censusPages),alias:{hostname:new URL(b.origin).hostname,deploymentId:result.providerReceiptId,projectId:b.provider.projectId},byteReadbacks:a.proof.correctedPublicInventory.flatMap(file=>["deployment","stable"].map(target=>({...file,target,status:200}))),kind:"owner_trial_public_playback_success_evidence",authorizationSignature:a.signature,sourceDigest:a.sourceDigest,result,observedAt:new Date().toISOString(),publicInventory:a.proof.correctedPublicInventory,publicInventoryDigest:canonicalDigest(a.proof.correctedPublicInventory),completeTransportTraceDigest:sha("offline-complete-actual-byte-readback"),verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true,playbackProjection:true,noPrivateProvenance:true}});}
test("public playback raw uid census differs from full detail and commits without normalization",async clock=>{
 const f=await playbackFixture(clock);
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),f.args);
 const claimed=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:claimRepair"),f.identity);
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:fenceRepair"),f.identity);
 const result=playbackResult(claimed.authorization),{signature,...unsigned}=await playbackSuccess(claimed.authorization,result);
 const deploymentDetail={...unsigned.deploymentDetail,createdAt:Date.now(),inspectorUrl:"https://vercel.com/offline/full-detail"};
 const {id,...listFields}=unsigned.deploymentDetail,raw={uid:id,...listFields};
 const censusPages=[{deployments:[f.unsigned.positivePublication,raw],pagination:{next:null}}];
 const proof=await signSupersession("owner-trial-public-playback-success-evidence-v1",{...unsigned,deploymentDetail,censusPages,censusDigest:canonicalDigest(censusPages)});
 assert.equal(raw.id,undefined);assert.notDeepEqual(raw,deploymentDetail);
 assert.equal((await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:commitRepair"),{...f.identity,result,proof})).committed,true);
 const row=(await snapshot(f.t)).ownerTrialPublicPlaybackRepairs[0];
 assert.deepEqual(row.lifecycle.result.proof.censusPages,censusPages);
 assert.deepEqual(row.lifecycle.result.proof.deploymentDetail,deploymentDetail);
});
test("public playback op3 authority preserves signed op2 history and ordinary completion policy",async clock=>{
 const f=await playbackFixture(clock),before=await snapshot(f.t),old=await job(f.t,f.jobId);
 assert.equal(f.ctx.binding.operationNumber,3);assert.notEqual(f.ctx.binding.idempotencyKey,old.publication.idempotencyKey);
 const authorized=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),f.args);
 const claimed=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:claimRepair"),f.identity);
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:fenceRepair"),f.identity);
 for(const file of f.ctx.binding.files){const response=await f.t.fetch(`/completion/artifact?jobId=${f.jobId}&revisionId=r1&storageId=${file.storageId}`,{headers:{authorization:`Bearer ${completionToken}`,"x-bebebonjour-worker-id":workerId,"x-bebebonjour-command-id":authorized.commandId,"x-bebebonjour-lease-token":f.identity.leaseToken}});assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),file.sha256);}
 const result=playbackResult(claimed.authorization),proof=await playbackSuccess(claimed.authorization,result);
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:commitRepair"),{...f.identity,result,proof});
 const next=await job(f.t,f.jobId),after=await snapshot(f.t);
 assert.equal(next.publication.providerReceiptId,result.providerReceiptId);assert.deepEqual(next.events.slice(0,old.events.length),old.events);assert.deepEqual(next.stageAttempts.slice(0,old.stageAttempts.length),old.stageAttempts);assert.deepEqual(next.artifactSets,old.artifactSets);
 for(const table of ["ownerTrialPublicationSupersessions","ownerTrialPublicationPresentAuthorizations","ownerTrialPublicationPresentLeases","ownerTrialReviews","fulfillmentReviewApprovals"])assert.deepEqual(after[table],before[table]);
 assert.deepEqual(after.customerFlowOperationsCommands.slice(0,before.customerFlowOperationsCommands.length),before.customerFlowOperationsCommands);
 assert.deepEqual(await f.t.query(ref("ownerTrial:completionPolicy"),{completionToken,jobId:f.jobId}),f.policy);
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:claimRepair"),f.identity));
 const current=await job(f.t,f.jobId);
 await f.t.mutation(ref("operations:requestCommand"),{operatorToken,jobId:f.jobId,commandId:"command_playback_queue_only",action:"queue_delivery",expectedState:"published",expectedVersion:current.version,payload:{revisionId:"r1",publicationId:result.providerReceiptId,artifactManifestDigest:f.policy.manifestDigest}});
 const [queue]=await f.t.mutation(ref("operations:claimCommands"),f.claimArgs);
 const { queueDeliveryTransition }=await import("../../src/fulfillment/job-machine.mjs");
 const queued=queueDeliveryTransition(current,{commandId:queue.commandId,revisionId:"r1",publicationId:result.providerReceiptId},new Date().toISOString());
 await f.t.mutation(ref("ownerTrialCompletion:replaceJob"),{completionToken,jobId:f.jobId,workerId,commandId:queue.commandId,leaseToken:queue.claim.leaseToken,expectedVersion:current.version,aggregate:queued});
 assert.equal((await job(f.t,f.jobId)).state,"delivery_queued");assert.equal((await job(f.t,f.jobId)).deliveryAttempts.length,0);
 assert.equal((await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"),{completionToken,jobId:f.jobId})).maxAttempts,2);
 const queuedBefore=await snapshot(f.t);
 await patchJob(f.t,f.jobId,j=>({...j,unexpectedAuthorityField:true}));
 await assert.rejects(()=>f.t.query(ref("ownerTrial:completionPolicy"),{completionToken,jobId:f.jobId}));
 await patchJob(f.t,f.jobId,()=>queuedBefore.fulfillmentJobs[0].aggregate);
 await f.t.run(async c=>{const row=await c.db.query("ownerTrialPublicPlaybackRepairs").withIndex("by_job_id",q=>q.eq("jobId",f.jobId)).unique();await c.db.patch(row._id,{lifecycle:{...row.lifecycle,signature:"0".repeat(64)}});});
 await assert.rejects(()=>f.t.query(ref("ownerTrial:completionPolicy"),{completionToken,jobId:f.jobId}));
});
test("public playback source roles inventory metadata collision and CAS reject without writes",async clock=>{
 const f=await playbackFixture(clock),before=await snapshot(f.t);
 const variants=[{...f.unsigned,observedAt:new Date(Date.now()-60001).toISOString()},{...f.unsigned,contextDigest:sha("wrong")},{...f.unsigned,correctedPublicInventory:f.unsigned.correctedPublicInventory.slice(1)},{...f.unsigned,correctedPublicInventory:f.unsigned.correctedPublicInventory.map((x,n)=>n===0?{...x,path:"intake.json"}:x)},{...f.unsigned,correctedPublicInventory:f.unsigned.correctedPublicInventory.map(x=>x.path.endsWith(".mp3")?{...x,sha256:sha("changed-audio")}:x)}];
 for(const change of [{projectId:"prj_wrong"},{readyState:"BUILDING"},{meta:{...f.unsigned.positivePublication.meta,bbRevisionId:"r2"}},{meta:{...f.unsigned.positivePublication.meta,bbIdempotencyKey:f.ctx.binding.idempotencyKey}}]){const positivePublication={...f.unsigned.positivePublication,...change},censusPages=[{deployments:[positivePublication],pagination:{next:null}}];variants.push({...f.unsigned,positivePublication,positivePublicationDigest:canonicalDigest(positivePublication),censusPages,censusDigest:canonicalDigest(censusPages)});}
 const conflict={...f.unsigned.positivePublication,id:f.ctx.binding.oldDeploymentId,uid:"dpl_conflicting"},conflictPages=[{deployments:[conflict],pagination:{next:null}}];
 variants.push({...f.unsigned,positivePublication:conflict,positivePublicationDigest:canonicalDigest(conflict),censusPages:conflictPages,censusDigest:canonicalDigest(conflictPages)});
 const collision={...f.unsigned.positivePublication,id:"dpl_collision",meta:{...f.unsigned.positivePublication.meta,bbIdempotencyKey:f.ctx.binding.idempotencyKey}},censusPages=[{deployments:[f.unsigned.positivePublication,collision],pagination:{next:null}}];variants.push({...f.unsigned,censusPages,censusDigest:canonicalDigest(censusPages)});
 for(const unsigned of variants){await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),{...f.args,proof:await signSupersession("owner-trial-public-playback-source-evidence-v1",unsigned)}));assert.deepEqual(await snapshot(f.t),before);}
 for(const secret of [hmacKey,completionToken,operatorToken]){await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),{...f.args,proof:await signSupersession("owner-trial-public-playback-source-evidence-v1",f.unsigned,secret)}));assert.deepEqual(await snapshot(f.t),before);}
 for(const change of [{expectedVersion:f.args.expectedVersion-1},{operatorToken:completionToken},{completionToken:operatorToken}]){await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),{...f.args,...change}));assert.deepEqual(await snapshot(f.t),before);}
});
test("public playback lease fenced proof drift fail and historical chain remain fail-closed",async clock=>{
 const f=await playbackFixture(clock);await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),f.args);const claimed=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:claimRepair"),f.identity),result=playbackResult(claimed.authorization);
 let before=await snapshot(f.t);await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:commitRepair"),{...f.identity,result,proof:await playbackSuccess(claimed.authorization,result)}));assert.deepEqual(await snapshot(f.t),before);
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:fenceRepair"),f.identity);before=await snapshot(f.t);
 const {signature,...unsigned}=await playbackSuccess(claimed.authorization,result);
 for(const modified of [{...unsigned,byteReadbacks:unsigned.byteReadbacks.slice(1)},{...unsigned,byteReadbacks:unsigned.byteReadbacks.map((x,n)=>n===0?{...x,sha256:sha("wrong-body")}:x)},{...unsigned,deploymentDetail:{...unsigned.deploymentDetail,meta:{...unsigned.deploymentDetail.meta,bbRevisionId:"r2"}}},{...unsigned,alias:{...unsigned.alias,projectId:"prj_wrong"}},{...unsigned,publicInventoryDigest:sha("wrong")}]){await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:commitRepair"),{...f.identity,result,proof:await signSupersession("owner-trial-public-playback-success-evidence-v1",modified)}));assert.deepEqual(await snapshot(f.t),before);}
 for(const change of [{uid:"dpl_conflicting"},{projectId:"prj_wrong"},{url:"wrong.vercel.app"},{meta:{...unsigned.deploymentDetail.meta,bbRevisionId:"r2"}}]){
 const censusPages=[{deployments:[f.unsigned.positivePublication,{...unsigned.deploymentDetail,...change}],pagination:{next:null}}];
 const modified={...unsigned,censusPages,censusDigest:canonicalDigest(censusPages)};
 await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:commitRepair"),{...f.identity,result,proof:await signSupersession("owner-trial-public-playback-success-evidence-v1",modified)}));assert.deepEqual(await snapshot(f.t),before);
 }
 for(const change of [{completionToken:operatorToken},{workerId:"other"},{leaseToken:"other"}]){await assert.rejects(()=>f.t.query(ref("ownerTrialPublicPlaybackRepair:activeRepair"),{...f.identity,...change}));assert.deepEqual(await snapshot(f.t),before);}
 const key=process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID;process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID="prj_wrong";try{await assert.rejects(()=>f.t.query(ref("ownerTrialPublicPlaybackRepair:activeRepair"),f.identity));}finally{process.env.OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID=key;}
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:failRepair"),f.identity);const after=await snapshot(f.t);assert.equal((await job(f.t,f.jobId)).retry,null);assert.equal((await job(f.t,f.jobId)).publication.providerReceiptId,f.ctx.binding.oldDeploymentId);
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:claimRepair"),f.identity));await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),f.args));assert.deepEqual(await snapshot(f.t),after);
 await f.t.run(async c=>{const row=await c.db.query("ownerTrialPublicationSupersessions").withIndex("by_job_id",q=>q.eq("jobId",f.jobId)).unique();await c.db.patch(row._id,{authorization:{...row.authorization,signature:"0".repeat(64)}});});
 await assert.rejects(()=>f.t.query(ref("ownerTrial:completionPolicy"),{completionToken,jobId:f.jobId}));
});
async function realPlaybackWorkerSeam(clock,mode="success") {
 const f=await playbackFixture(clock),old=await job(f.t,f.jobId);
 const descriptors=f.ctx.binding.files.filter(x=>x.path.endsWith("transcript.json"));
 assert.equal(descriptors.length,1);assert.equal(descriptors[0].path,"artifacts/transcript.json");
 const authorized=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),f.args);
 const uploads=new Map(),files=new Map(),trace=[];let deployment=null,aliased=false,signed=0,rootBlocked=mode==="resumeSuccess";
 const oldFiles=new Map(f.resolved.files.map(x=>[`${f.base}/${x.publicPath}`,x.bytes]));
 const fetch=async(input,init={})=>{
  const u=new URL(input),method=init.method||"GET",headers=new Headers(init.headers);trace.push({url:u.href,method});
  assert.equal(headers.has("x-vercel-protection-bypass"),false);
  const row=(await snapshot(f.t)).ownerTrialPublicPlaybackRepairs[0];assert.ok(row.lifecycle.lease.effectStartedAt);
  if(u.hostname==="offline-fixture.convex.site"){
   assert.equal(headers.has("x-vercel-skip-toolbar"),false);
   if(u.searchParams.get("storageId")===descriptors[0].storageId){
    const alternate=f.files.find(x=>x.path==="artifacts/current/transcript.json");
    const denied=await f.t.fetch(u.pathname+u.search.replace(encodeURIComponent(descriptors[0].storageId),encodeURIComponent(alternate.storageId)),init);assert.equal(denied.status,403);
   }
   return f.t.fetch(u.pathname+u.search,init);
  }
  if(u.origin==="https://api.vercel.com"){
   assert.equal(headers.has("x-vercel-skip-toolbar"),false);
   if(u.pathname==="/v7/deployments"){
    if(mode==="collision"&&!deployment)return Response.json({deployments:[f.unsigned.positivePublication,{...f.unsigned.positivePublication,id:"dpl_collision",meta:{...f.unsigned.positivePublication.meta,bbIdempotencyKey:f.ctx.binding.idempotencyKey}}],pagination:{next:null}});
    if(mode==="paged"&&deployment)return Response.json(u.searchParams.has("until")?{deployments:[deployment],pagination:{next:null}}:{deployments:[f.unsigned.positivePublication],pagination:{next:1}});
    const raw=deployment?{uid:deployment.id,url:deployment.url,projectId:deployment.projectId,readyState:deployment.readyState,meta:deployment.meta}:null;
    if(raw&&aliased){
     if(mode==="metaDrift")raw.meta={...raw.meta,bbRevisionId:"r2"};
     if(mode==="projectDrift")raw.projectId="prj_wrong";
     if(mode==="urlDrift")raw.url="other.vercel.app";
     if(mode==="idConflict")raw.id="dpl_wrong";
    }
    return Response.json({deployments:[f.unsigned.positivePublication,...(raw?[raw]:[])],pagination:{next:null}});
   }
   if(u.pathname==="/v2/files"){const bytes=Buffer.from(init.body);assert.equal(headers.get("x-vercel-digest"),createHash("sha1").update(bytes).digest("hex"));uploads.set(headers.get("x-vercel-digest"),bytes);return new Response("",{status:201});}
   if(u.pathname==="/v13/deployments"&&method==="POST"){
    assert.equal(deployment,null);const body=JSON.parse(init.body);assert.equal(body.files.length,23);
    for(const file of body.files){const bytes=uploads.get(file.sha);assert.ok(bytes);assert.equal(file.size,bytes.length);files.set(file.file,bytes);}
    deployment={id:mode==="receiptReuse"?f.ctx.binding.oldDeploymentId:"dpl_offline_playback_op3",uid:mode==="receiptIdConflict"?"dpl_conflicting":mode==="receiptReuse"?f.ctx.binding.oldDeploymentId:"dpl_offline_playback_op3",url:"offline-playback.vercel.app",projectId:"prj_offline",readyState:"READY",createdAt:Date.now(),meta:body.meta};
    return Response.json(deployment,{status:201});
   }
   if(u.pathname.startsWith("/v13/deployments/"))return Response.json(u.pathname.endsWith(f.ctx.binding.oldDeploymentId)?{...f.unsigned.positivePublication,id:f.unsigned.positivePublication.uid,createdAt:Date.now(),inspectorUrl:"https://vercel.com/offline/full-detail"}:{...deployment,inspectorUrl:"https://vercel.com/offline/new-full-detail"});
   if(u.pathname.startsWith("/v6/deployments/"))return Response.json(providerTree(u.pathname.includes(f.ctx.binding.oldDeploymentId)?[...oldFiles.keys()].map(x=>x.slice(1)).concat([`announcements/${f.jobId}/.publication.json`,"vercel.json"]):[...files.keys()]));
   if(u.pathname.startsWith("/v8/deployments/"))return Response.json({data:(files.get("vercel.json")||f.configuration).toString("base64")});
   if(u.pathname.startsWith("/v4/aliases/"))return Response.json({alias:new URL(origin).hostname,deploymentId:aliased?deployment.id:f.ctx.binding.oldDeploymentId,projectId:"prj_offline"});
   if(u.pathname.endsWith("/aliases")&&method==="POST"){assert.equal(aliased,false);aliased=true;return Response.json({uid:"alias_offline_playback",created:new Date().toISOString(),alias:new URL(origin).hostname,deploymentId:deployment.id,projectId:"prj_offline"});}
  }
  assert.equal(headers.has("authorization"),false);assert.equal(headers.get("x-vercel-skip-toolbar"),"1");
  if(u.hostname==="offline-corrected.vercel.app"||(!aliased&&u.origin===origin)){
   const bytes=oldFiles.get(u.pathname);assert.ok(bytes,`unknown old public ${u.pathname}`);return new Response(mode==="oldTamper"?Buffer.from("tampered"):bytes,{headers:{"cache-control":"private, no-store, max-age=0"}});
  }
  if(u.pathname===f.base){
   assert.equal(init.redirect,"manual","root must request a bounded manual redirect, never follow");
   if(rootBlocked){clock.mock.timers.setTime(row.lifecycle.lease.expiresAtMs);throw new Error("synthetic external runner overrode manual redirect until expiry");}
   return new Response("",{status:307,headers:{location:`${f.base}/fr/`}});
  }
  const path=u.pathname.endsWith("/fr/")?u.pathname.slice(1)+"index.html":u.pathname.slice(1),bytes=files.get(path);assert.ok(bytes,`unknown new public ${path}`);
  if(mode==="stale"&&path.endsWith("transcript.json"))clock.mock.timers.setTime(row.lifecycle.lease.expiresAtMs);
  return new Response(mode==="tamper"&&path.endsWith("transcript.json")?Buffer.from("tampered"):bytes,{headers:{"cache-control":"private, no-store, max-age=0"}});
 };
 const {runOwnerTrialPublicPlaybackRepair}=await import("../../src/operations/owner-trial-public-playback-repair-worker.mjs");
 const options={client:f.client,jobId:f.jobId,fetch,pollIntervalMs:0,maxPollAttempts:1,environment:{CONVEX_URL:"https://offline-fixture.convex.cloud",OWNER_TRIAL_JOB_ID:f.jobId,BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN:completionToken,OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN:"offline-provider-token",OWNER_TRIAL_PUBLICATION_BUILD_INSPECTION_JSON:JSON.stringify(f.inspection)},signPlaybackResult:async evidence=>{
  signed++;assert.equal(aliased,true);assert.equal(evidence.byteReadbacks.length,42);
  assert.deepEqual(evidence.publicInventory,f.unsigned.correctedPublicInventory);
  assert.equal(evidence.censusPages[0].deployments.at(-1).id,undefined);
  assert.notDeepEqual(evidence.deploymentDetail,evidence.censusPages[0].deployments.at(-1));
  const {authorization,...observed}=evidence;
  return signSupersession("owner-trial-public-playback-success-evidence-v1",{...observed,kind:"owner_trial_public_playback_success_evidence",authorizationSignature:evidence.authorization.signature,sourceDigest:evidence.authorization.sourceDigest,observedAt:new Date().toISOString(),verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true,playbackProjection:true,noPrivateProvenance:true}});
 }};
 // The independent signer is mandatory before any claim or provider traffic.
 const beforeMissing=await snapshot(f.t);await assert.rejects(()=>runOwnerTrialPublicPlaybackRepair({...options,signPlaybackResult:undefined}));assert.deepEqual(await snapshot(f.t),beforeMissing);assert.equal(trace.length,0);
 if(mode==="resumeSuccess"){
  await assert.rejects(()=>runOwnerTrialPublicPlaybackRepair(options));const returnedAt=Date.now();assert.equal(signed,0);assert.equal(aliased,false);
  const previous=(await snapshot(f.t)).ownerTrialPublicPlaybackRepairs[0].lifecycle;
  assert.equal(previous.phase,"fenced");assert.equal((await job(f.t,f.jobId)).state,"publishing");
  const ctx=await f.t.query(ref("ownerTrialPublicPlaybackRepair:expiredRunContext"),{operatorToken,completionToken,jobId:f.jobId});
  const result=playbackResult((await snapshot(f.t)).ownerTrialPublicPlaybackRepairs[0].authorization),{signature,...observed}=await playbackSuccess((await snapshot(f.t)).ownerTrialPublicPlaybackRepairs[0].authorization,result);
  const unsigned={kind:"owner_trial_public_playback_expired_run_evidence",contextDigest:ctx.contextDigest,binding:ctx.binding,observedAt:new Date().toISOString(),sourceManifestDigest:sha("synthetic-continuation-source"),deploymentDetail:{...deployment,inspectorUrl:"https://vercel.com/offline/new-full-detail"},censusPages:[{deployments:[f.unsigned.positivePublication,{uid:deployment.id,url:deployment.url,projectId:deployment.projectId,readyState:deployment.readyState,meta:deployment.meta}],pagination:{next:null}}],alias:{hostname:new URL(origin).hostname,deploymentId:f.ctx.binding.oldDeploymentId,projectId:"prj_offline"},publicInventory:observed.publicInventory,byteReadbacks:observed.byteReadbacks.filter(x=>x.target==="deployment"),completeTransportTraceDigest:canonicalDigest(trace),verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactManifest:true,exactDeploymentBytes:true,exactOldAlias:true,noProviderMutations:true},historicalObservation:{invocationClosed:true,complete:true,createCount:1,aliasCount:0,leaseDigest:canonicalDigest(previous.lease),completeTransportTraceDigest:canonicalDigest(trace),observedThrough:returnedAt}};
  assert.ok(returnedAt>=previous.lease.expiresAtMs);
  unsigned.censusDigest=canonicalDigest(unsigned.censusPages);
  const continued=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),{operatorToken,completionToken,recoveryToken,jobId:f.jobId,expectedVersion:previous.aggregate.version,contextDigest:ctx.contextDigest,workerId,leaseToken:"offline-real-worker-resume-lease",proof:await signSupersession("owner-trial-public-playback-expired-run-evidence-v1",unsigned)});
  const start=trace.length,before=await snapshot(f.t);
  options.resume={leaseToken:continued.lease.leaseToken,commandId:ctx.binding.commandId,attemptId:ctx.binding.attemptId,deploymentId:deployment.id,continuationSignature:continued.continuation.signature};
  rootBlocked=false;
  const committed=await runOwnerTrialPublicPlaybackRepair(options);assert.equal(committed.committed,true);
  const resumeTrace=trace.slice(start);assert.equal(resumeTrace.filter(x=>x.method==="POST").length,1);assert.ok(resumeTrace.filter(x=>x.method==="POST").every(x=>new URL(x.url).pathname===`/v2/deployments/${deployment.id}/aliases`));
  assert.equal(trace.filter(x=>x.method==="POST"&&new URL(x.url).pathname==="/v13/deployments").length,1);
  const next=await job(f.t,f.jobId);assert.equal(next.stageAttempts.length,previous.aggregate.stageAttempts.length);assert.equal(next.stageAttempts.at(-1).attemptId,previous.aggregate.stageAttempts.at(-1).attemptId);
  assert.deepEqual((await snapshot(f.t)).ownerTrialPublicPlaybackRepairs[0].lifecycle.continuation.previousLifecycle,previous);
  assert.deepEqual((await snapshot(f.t)).customerFlowOperationsCommands.slice(0,-1),before.customerFlowOperationsCommands.slice(0,-1));
  assert.equal(signed,1);assert.equal(next.deliveryAttempts.length,0);
  const final=await snapshot(f.t),count=trace.length;await assert.rejects(()=>runOwnerTrialPublicPlaybackRepair(options));assert.equal(trace.length,count);assert.deepEqual(await snapshot(f.t),final);
  assert.deepEqual(await f.t.query(ref("ownerTrial:completionPolicy"),{completionToken,jobId:f.jobId}),f.policy);return;
 }
 if(mode!=="success"){
  await assert.rejects(()=>runOwnerTrialPublicPlaybackRepair(options));assert.equal(signed,0);
  assert.equal(trace.filter(x=>x.method==="POST"&&new URL(x.url).pathname==="/v13/deployments").length,["collision","oldTamper"].includes(mode)?0:1);
  if(["collision","oldTamper"].includes(mode))assert.equal(trace.filter(x=>x.method==="POST").length,0);
  if(["receiptReuse","receiptIdConflict"].includes(mode))assert.equal(trace.filter(x=>x.method==="POST"&&new URL(x.url).pathname.endsWith("/aliases")).length,0);
  assert.equal((await job(f.t,f.jobId)).publication.providerReceiptId,old.publication.providerReceiptId);
  const before=await snapshot(f.t),count=trace.length;await assert.rejects(()=>runOwnerTrialPublicPlaybackRepair(options));assert.equal(trace.length,count);assert.deepEqual(await snapshot(f.t),before);assert.equal((await job(f.t,f.jobId)).deliveryAttempts.length,0);return;
 }
 const result=await runOwnerTrialPublicPlaybackRepair(options);assert.equal(result.committed,true);assert.equal(signed,1);
 assert.equal(trace.filter(x=>x.method==="POST"&&new URL(x.url).pathname==="/v13/deployments").length,1);assert.equal(trace.filter(x=>x.method==="POST"&&new URL(x.url).pathname.endsWith("/aliases")).length,1);
 for(const file of f.projected)assert.equal(sha(files.get(`announcements/${f.jobId}/${file.publicPath}`)),file.sha256);
 const next=await job(f.t,f.jobId);assert.deepEqual(next.artifactSets,old.artifactSets);assert.deepEqual(next.events.slice(0,old.events.length),old.events);assert.deepEqual(next.stageAttempts.slice(0,old.stageAttempts.length),old.stageAttempts);
 assert.deepEqual(await f.t.query(ref("ownerTrial:completionPolicy"),{completionToken,jobId:f.jobId}),f.policy);
 assert.equal((await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"),{completionToken,jobId:f.jobId})).maxAttempts,2);
 const before=await snapshot(f.t),count=trace.length;await assert.rejects(()=>runOwnerTrialPublicPlaybackRepair(options));assert.equal(trace.length,count);assert.deepEqual(await snapshot(f.t),before);
 // Real production completion startup and ordinary queue/store seam; no email.
 const {createOwnerTrialCompletionCapabilities}=await import("../../src/fulfillment/owner-trial-completion-capabilities.mjs");
 await createOwnerTrialCompletionCapabilities({client:f.client,policy:f.policy,environment:{...options.environment,OWNER_TRIAL_RESEND_FROM:"Offline <offline@example.invalid>"},publicationProvider:{publish(){throw Error("no second create");},reconcile(){throw Error("no reconciliation");}},resend:{emails:{send(){throw Error("no email");}}}});
 await f.t.mutation(ref("operations:requestCommand"),{operatorToken,jobId:f.jobId,commandId:"command_playback_worker_queue",action:"queue_delivery",expectedState:"published",expectedVersion:next.version,payload:{revisionId:"r1",publicationId:next.publication.providerReceiptId,artifactManifestDigest:f.policy.manifestDigest}});
 const [queue]=await f.t.mutation(ref("operations:claimCommands"),f.claimArgs);assert.equal(queue.commandId,"command_playback_worker_queue");
 const {queueDeliveryTransition}=await import("../../src/fulfillment/job-machine.mjs");
 await f.t.mutation(ref("ownerTrialCompletion:replaceJob"),{completionToken,jobId:f.jobId,workerId,commandId:queue.commandId,leaseToken:queue.claim.leaseToken,expectedVersion:next.version,aggregate:queueDeliveryTransition(next,{commandId:queue.commandId,revisionId:"r1",publicationId:next.publication.providerReceiptId},new Date().toISOString())});
 assert.equal((await job(f.t,f.jobId)).state,"delivery_queued");assert.equal((await job(f.t,f.jobId)).deliveryAttempts.length,0);
 assert.equal((await f.t.query(ref("ownerTrialPublicationRecovery:recoveryAllowance"),{completionToken,jobId:f.jobId})).maxAttempts,2);
}
test("public playback expired-run worker resumes exact created deployment with no upload create or delivery",clock=>realPlaybackWorkerSeam(clock,"resumeSuccess"));
test("public playback production worker real exporter provider Convex op3 and startup queue success",clock=>realPlaybackWorkerSeam(clock));
for(const mode of ["collision","oldTamper","tamper","receiptReuse","receiptIdConflict","stale","paged","metaDrift","projectDrift","urlDrift","idConflict"])
 test(`public playback production worker rejects ${mode} without reuse or delivery`,clock=>realPlaybackWorkerSeam(clock,mode));

async function expiredPlaybackFixture(clock) {
 const f=await playbackFixture(clock);
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:authorizeRepair"),f.args);
 const claimed=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:claimRepair"),f.identity);
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:fenceRepair"),f.identity);
 const previous=(await snapshot(f.t)).ownerTrialPublicPlaybackRepairs[0].lifecycle;
 clock.mock.timers.setTime(previous.lease.expiresAtMs);
 const ctx=await f.t.query(ref("ownerTrialPublicPlaybackRepair:expiredRunContext"),{operatorToken,completionToken,jobId:f.jobId});
 const result=playbackResult(claimed.authorization),{signature,...success}=await playbackSuccess(claimed.authorization,result);
 const unsigned={kind:"owner_trial_public_playback_expired_run_evidence",contextDigest:ctx.contextDigest,binding:ctx.binding,observedAt:new Date().toISOString(),sourceManifestDigest:sha("offline-continuation-source"),deploymentDetail:success.deploymentDetail,censusPages:success.censusPages,censusDigest:success.censusDigest,alias:{...success.alias,deploymentId:claimed.authorization.binding.oldDeploymentId},publicInventory:success.publicInventory,byteReadbacks:success.byteReadbacks.filter(x=>x.target==="deployment"),completeTransportTraceDigest:sha("synthetic-read-only-continuation-observation"),verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactManifest:true,exactDeploymentBytes:true,exactOldAlias:true,noProviderMutations:true},historicalObservation:{invocationClosed:true,complete:true,createCount:1,aliasCount:0,leaseDigest:canonicalDigest(previous.lease),completeTransportTraceDigest:sha("synthetic-read-only-continuation-observation"),observedThrough:Date.now()}};
 const proof=await signSupersession("owner-trial-public-playback-expired-run-evidence-v1",unsigned);
 const args={operatorToken,completionToken,recoveryToken,jobId:f.jobId,expectedVersion:previous.aggregate.version,contextDigest:ctx.contextDigest,workerId,leaseToken:"offline-playback-continuation-lease",proof};
 return {...f,claimed,previous,continuationContext:ctx,continuationUnsigned:unsigned,continuationArgs:args,result};
}
test("public playback expired-run continuation renews only signed independent authority preserving attempt and command",async clock=>{
 const f=await expiredPlaybackFixture(clock),before=await snapshot(f.t);
 await assert.rejects(()=>f.t.query(ref("ownerTrialPublicPlaybackRepair:activeRepair"),f.identity));
 const renewed=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),f.continuationArgs);
 assert.equal(renewed.continued,true);assert.equal(renewed.deploymentId,f.result.providerReceiptId);
 const after=await snapshot(f.t);
 assert.deepEqual(after.fulfillmentJobs,before.fulfillmentJobs);
 assert.deepEqual(after.customerFlowOperationsCommands,before.customerFlowOperationsCommands);
 for(const table of ["ownerTrialPublicationSupersessions","ownerTrialPublicationPresentAuthorizations","ownerTrialPublicationPresentLeases","ownerTrialPublicationRecoveries","ownerTrialReviews","fulfillmentReviewApprovals"])assert.deepEqual(after[table],before[table]);
 assert.deepEqual(after.ownerTrialPublicPlaybackRepairs[0].lifecycle.continuation.previousLifecycle,f.previous);
 assert.ok(renewed.continuation.signature);assert.equal(renewed.lease.expiresAtMs,Date.now()+300000);
 const identity={...f.identity,leaseToken:f.continuationArgs.leaseToken};
 const readback=await f.t.query(ref("ownerTrialPublicPlaybackRepair:activeRepair"),identity);
 assert.deepEqual(readback.lease,renewed.lease);assert.deepEqual(readback.continuation,renewed.continuation);
 await assert.rejects(()=>f.t.query(ref("ownerTrialPublicPlaybackRepair:activeRepair"),f.identity));
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:claimRepair"),identity));
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),f.continuationArgs));
 assert.deepEqual(await snapshot(f.t),after);
 const file=f.ctx.binding.files[0];
 const response=await f.t.fetch(`/completion/artifact?jobId=${f.jobId}&revisionId=r1&storageId=${file.storageId}`,{headers:{authorization:`Bearer ${completionToken}`,"x-bebebonjour-worker-id":workerId,"x-bebebonjour-command-id":f.claimed.authorization.commandId,"x-bebebonjour-lease-token":identity.leaseToken}});
 assert.equal(response.status,200);
 await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:commitRepair"),{...identity,result:f.result,proof:await playbackSuccess(f.claimed.authorization,f.result)});
 assert.equal((await job(f.t,f.jobId)).state,"published");
 assert.deepEqual(await f.t.query(ref("ownerTrial:completionPolicy"),{completionToken,jobId:f.jobId}),f.policy);
 assert.equal((await job(f.t,f.jobId)).deliveryAttempts.length,0);
});

test("public playback expired-run closure after expiry accepts real wallclock and verifies exact lease bound",async clock=>{
 // Synthetic historical setup only; continuation uses the real, unmocked wallclock.
 clock.mock.timers.enable({apis:["Date"],now:Date.now()-5400000});
 const historicalClock={mock:{timers:{enable:options=>clock.mock.timers.setTime(options.now),setTime:time=>clock.mock.timers.setTime(time)}}};
 const f=await expiredPlaybackFixture(historicalClock);
 clock.mock.timers.reset();
 const returnedAt=Date.now();
 assert.ok(returnedAt>=f.previous.lease.expiresAtMs);
 const unsigned={...f.continuationUnsigned,observedAt:new Date().toISOString(),historicalObservation:{...f.continuationUnsigned.historicalObservation,observedThrough:returnedAt}};
 const proof=await signSupersession("owner-trial-public-playback-expired-run-evidence-v1",unsigned);
 const before=await snapshot(f.t);
 const continued=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),{...f.continuationArgs,proof});
 assert.equal(continued.lease.expiresAtMs,Math.min(Date.parse(continued.lease.claimedAt)+300000,Date.parse(f.claimed.authorization.binding.expiresAt)));
 const active=await f.t.query(ref("ownerTrialPublicPlaybackRepair:activeRepair"),{...f.identity,leaseToken:continued.lease.leaseToken});
 assert.deepEqual(active.lease,continued.lease);
 const after=await snapshot(f.t);
 assert.deepEqual(after.fulfillmentJobs,before.fulfillmentJobs);
 assert.deepEqual(after.customerFlowOperationsCommands,before.customerFlowOperationsCommands);
 assert.deepEqual(active.continuation.previousLifecycle,f.previous);
});

test("public playback expired-run rejects mismatched complete historical trace without writes",async clock=>{
 const f=await expiredPlaybackFixture(clock),before=await snapshot(f.t);
 const unsigned={...f.continuationUnsigned,historicalObservation:{...f.continuationUnsigned.historicalObservation,completeTransportTraceDigest:sha("wrong-closed-invocation-trace")}};
 await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),{...f.continuationArgs,proof:await signSupersession("owner-trial-public-playback-expired-run-evidence-v1",unsigned)}));
 assert.deepEqual(await snapshot(f.t),before);
});

test("public playback expired-run roles closure freshness and proof denials preserve all tables",async clock=>{
 const f=await expiredPlaybackFixture(clock),before=await snapshot(f.t),u=f.continuationUnsigned;
 const deny=async change=>{await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),{...f.continuationArgs,...change}));assert.deepEqual(await snapshot(f.t),before);};
 for(const change of [{operatorToken:completionToken},{completionToken:operatorToken},{recoveryToken:operatorToken},{workerId:"other"},{leaseToken:f.identity.leaseToken},{expectedVersion:f.continuationArgs.expectedVersion-1},{contextDigest:sha("wrong-context")},{proof:null},{proof:{...f.continuationArgs.proof,signature:"0".repeat(64)}}])await deny(change);
 for(const key of [hmacKey,completionToken,operatorToken])await deny({proof:await signSupersession("owner-trial-public-playback-expired-run-evidence-v1",u,key)});
 const variants=[...[{invocationClosed:false},{complete:false},{createCount:0},{createCount:2},{aliasCount:1},{leaseDigest:sha("wrong-lease")},{observedThrough:Date.now()+1},{observedThrough:Date.parse(f.previous.lease.effectStartedAt)-1}].map(h=>({...u,historicalObservation:{...u.historicalObservation,...h}})),
 {...u,observedAt:new Date(Date.now()+1).toISOString()},{...u,observedAt:new Date(Date.now()-60001).toISOString()},{...u,sourceManifestDigest:"bad"},{...u,binding:{...u.binding,commandId:"wrong-command"}}];
 for(const unsigned of variants)await deny({proof:await signSupersession("owner-trial-public-playback-expired-run-evidence-v1",unsigned)});
 clock.mock.timers.setTime(f.previous.lease.expiresAtMs-1);
 await assert.rejects(()=>f.t.query(ref("ownerTrialPublicPlaybackRepair:expiredRunContext"),{operatorToken,completionToken,jobId:f.jobId}));
 await deny({});
});

test("public playback expired-run detail census identity alias inventory bytes denials preserve all tables",async clock=>{
 const f=await expiredPlaybackFixture(clock),before=await snapshot(f.t),u=f.continuationUnsigned;
 const variants=[...[{projectId:"prj_wrong"},{readyState:"BUILDING"},{uid:"dpl_conflict"},{id:f.claimed.authorization.binding.oldDeploymentId},{meta:{...u.deploymentDetail.meta,bbIdempotencyKey:"bb_wrong"}},{meta:{...u.deploymentDetail.meta,bbRevisionId:"r2"}}].map(d=>({...u,deploymentDetail:{...u.deploymentDetail,...d}})),
 ...[{deploymentId:u.deploymentDetail.id},{projectId:"prj_wrong"},{hostname:"wrong.invalid"}].map(alias=>({...u,alias:{...u.alias,...alias}})),
 {...u,censusDigest:sha("wrong-census")},{...u,publicInventory:u.publicInventory.slice(1)},{...u,byteReadbacks:u.byteReadbacks.slice(1)},
 {...u,byteReadbacks:u.byteReadbacks.map((x,n)=>n===0?{...x,sha256:sha("wrong-bytes")}:x)},{...u,byteReadbacks:u.byteReadbacks.map((x,n)=>n===0?{...x,bytes:x.bytes+1}:x)}];
 for(const deployments of [[u.deploymentDetail],[...u.censusPages[0].deployments,u.deploymentDetail],u.censusPages[0].deployments.map((x,n)=>n===1?{...x,projectId:"prj_wrong"}:x),u.censusPages[0].deployments.map((x,n)=>n===1?{...x,meta:{...x.meta,bbIdempotencyKey:"bb_wrong"}}:x)]){const censusPages=[{deployments,pagination:{next:null}}];variants.push({...u,censusPages,censusDigest:canonicalDigest(censusPages)});}
 const censusPages=[{...u.censusPages[0],pagination:{next:1}}];variants.push({...u,censusPages,censusDigest:canonicalDigest(censusPages)});
 for(const unsigned of variants){await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),{...f.continuationArgs,proof:await signSupersession("owner-trial-public-playback-expired-run-evidence-v1",unsigned)}));assert.deepEqual(await snapshot(f.t),before);}
});

test("public playback expired-run continuation clips original authority expiry rejects replay expiry and tampered history",async clock=>{
 const f=await expiredPlaybackFixture(clock);
 clock.mock.timers.setTime(Date.parse(f.claimed.authorization.binding.expiresAt)-120000);
 const unsigned={...f.continuationUnsigned,observedAt:new Date().toISOString()};
 const args={...f.continuationArgs,proof:await signSupersession("owner-trial-public-playback-expired-run-evidence-v1",unsigned)};
 const continued=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),args),identity={...f.identity,leaseToken:continued.lease.leaseToken};
 assert.equal(continued.lease.expiresAtMs,Date.parse(f.claimed.authorization.binding.expiresAt));
 const before=await snapshot(f.t);
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),{...args,leaseToken:"offline-second-continuation-forbidden"}));assert.deepEqual(await snapshot(f.t),before);
 await f.t.run(async c=>{const row=await c.db.query("ownerTrialPublicPlaybackRepairs").withIndex("by_job_id",q=>q.eq("jobId",f.jobId)).unique();const {signature:oldContinuationSignature,...unsignedContinuation}=row.lifecycle.continuation;const continuation=await signSupersession("owner-trial-public-playback-expired-run-continuation-v1",{...unsignedContinuation,previousLifecycle:{...unsignedContinuation.previousLifecycle,signature:"0".repeat(64)}},hmacKey);const {signature:oldLifecycleSignature,...unsignedLifecycle}=row.lifecycle;const lifecycle=await signSupersession("owner-trial-public-playback-lifecycle-v1",{...unsignedLifecycle,continuation},hmacKey);await c.db.patch(row._id,{lifecycle});});
 const tampered=await snapshot(f.t);
 await assert.rejects(()=>f.t.query(ref("ownerTrialPublicPlaybackRepair:activeRepair"),identity));assert.deepEqual(await snapshot(f.t),tampered);
 await f.t.run(async c=>{const row=await c.db.query("ownerTrialPublicPlaybackRepairs").withIndex("by_job_id",q=>q.eq("jobId",f.jobId)).unique();await c.db.patch(row._id,{lifecycle:before.ownerTrialPublicPlaybackRepairs[0].lifecycle});});
 clock.mock.timers.setTime(continued.lease.expiresAtMs);
 const expired=await snapshot(f.t);
 for(const name of ["activeRepair","expiredRunContext"])await assert.rejects(()=>f.t.query(ref(`ownerTrialPublicPlaybackRepair:${name}`),name==="activeRepair"?identity:{operatorToken,completionToken,jobId:f.jobId}));
 await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:commitRepair"),{...identity,result:f.result,proof:await playbackSuccess(f.claimed.authorization,f.result)}));
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),args));assert.deepEqual(await snapshot(f.t),expired);
});

test("public playback expired-run renewed five minute lease alone expires without claim or commit writes",async clock=>{
 const f=await expiredPlaybackFixture(clock);
 const continued=await f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),f.continuationArgs),identity={...f.identity,leaseToken:continued.lease.leaseToken};
 assert.ok(continued.lease.expiresAtMs<Date.parse(f.claimed.authorization.binding.expiresAt));
 clock.mock.timers.setTime(continued.lease.expiresAtMs);
 const before=await snapshot(f.t);
 await assert.rejects(()=>f.t.query(ref("ownerTrialPublicPlaybackRepair:activeRepair"),identity));
 await assert.rejects(async()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:commitRepair"),{...identity,result:f.result,proof:await playbackSuccess(f.claimed.authorization,f.result)}));
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:claimRepair"),identity));
 await assert.rejects(()=>f.t.mutation(ref("ownerTrialPublicPlaybackRepair:continueExpiredRun"),{...f.continuationArgs,leaseToken:"offline-second-lease-not-authorized"}));
 assert.deepEqual(await snapshot(f.t),before);
});

test("toolbar NON-AUTH suppression is exact-host public GET only",()=>{
 const hosts=new Set(["exact.vercel.app","stable.example.invalid"]);
 for(const [url,init,skip]of [["https://exact.vercel.app/a",{},true],["https://stable.example.invalid/a",{},true],["https://other.vercel.app/a",{},false],["https://api.vercel.com/v13/deployments",{},false],["https://vercel.com/sso",{},false],["https://exact.vercel.app/a",{method:"POST"},false],["http://exact.vercel.app/a",{},false],["https://exact.vercel.app:444/a",{},false],["https://exact.vercel.app/a",{headers:{authorization:"dummy"}},false]]){
  const headers=publicToolbarRead(url,init,hosts).headers;assert.equal(headers.has("x-vercel-skip-toolbar"),skip);assert.equal(headers.has("x-vercel-protection-bypass"),false);
 }
});
