import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { hashTrial } from "./ownerTrial.js";
import { verifiedSupersessionResult, approvedPublicPath } from "./ownerTrialPublicationSupersession.js";
import { ownerTrialCompletionBasePolicy, assertOwnerTrialCompletionToken } from "./ownerTrialCompletion.js";
import { assertOwnerTrialOperator } from "../src/fulfillment/owner-trial-authority.mjs";
import { stablePrivateValue as json } from "../src/fulfillment/private-generation-authority.mjs";
const clean=({_id,_creationTime,...x})=>x;
const find=(c,t,jobId)=>c.db.query(t).withIndex("by_job_id",q=>q.eq("jobId",jobId)).unique();
const command=(c,id)=>c.db.query("customerFlowOperationsCommands").withIndex("by_command_id",q=>q.eq("commandId",id)).unique();
const reject=()=>{throw new Error("Owner trial public playback repair rejected.");};
const HEX=/^[a-f0-9]{64}$/u;
function deploymentIdentity(d){
 const id=d?.id||d?.uid;
 if(!/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(id||"")||(d.id!==undefined&&d.uid!==undefined&&d.id!==d.uid))reject();
 return id;
}
function deploymentFacts(d){
 return {id:deploymentIdentity(d),projectId:d.projectId,readyState:d.readyState,url:d.url,
 meta:Object.fromEntries(["bbCanaryJobId","bbRevisionId","bbArtifactSetId","bbArtifactManifestDigest","bbIdempotencyKey"].map(k=>[k,d.meta?.[k]]))};
}
export const playbackApprovedPath=path=>approvedPublicPath(path)||/^(?:artifacts\/transcript\.json|artifacts\/current\/transcript\.json)$/u.test(path);
const publicPath=path=>/transcript\.json$/u.test(path)?"transcript.json":path.startsWith("deploy/")?path.slice(7):path;
async function sign(domain,value,recovery=false){
 const secret=process.env[recovery?"BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN":"BEBEBONJOUR_APPROVAL_HMAC_KEY"];
 const roles=["BEBEBONJOUR_OPERATIONS_TOKEN","BEBEBONJOUR_OPERATIONS_WORKER_TOKEN","BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN","CRON_SECRET","OWNER_TRIAL_INVOKE_SECRET","BEBEBONJOUR_NARRATION_WORKER_TOKEN","BEBEBONJOUR_TTS_WORKER_TOKEN","BEBEBONJOUR_COMPLETION_WORKER_TOKEN","BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN","BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN","CUSTOMER_FLOW_BACKEND_TOKEN","BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN",recovery?"BEBEBONJOUR_APPROVAL_HMAC_KEY":"BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN"];
 if(typeof secret!=="string"||secret.length<32||roles.some(k=>process.env[k]===secret))reject();
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return [...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${domain}\0${json(value)}`)))].map(n=>n.toString(16).padStart(2,"0")).join("");
}
async function signed(domain,{signature:previous,...value}){return {...value,signature:await sign(domain,value)};}
async function verify(domain,receipt,recovery=false){if(!receipt)reject();const {signature,...value}=receipt;if(signature!==await sign(domain,value,recovery))reject();return value;}
async function context(c,jobId){
 const result=await verifiedSupersessionResult(c,jobId),s=await find(c,"ownerTrialPublicationSupersessions",jobId),document=await find(c,"fulfillmentJobs",jobId),old=document?.aggregate;
 if(!result||s.lifecycle.phase!=="published"||old.state!=="published"||old.retry!==null||old.deliveryAttempts.length||old.stageAttempts.some(x=>x.stage==="deliver")||await find(c,"ownerTrialPublicPlaybackRepairs",jobId)||json(old)!==json(s.lifecycle.aggregate))reject();
 const policy=await ownerTrialCompletionBasePolicy(c,jobId),release=old.artifactSets.find(x=>x.kind==="narration_review"&&x.revisionId===policy.revisionId);
 const transcript=release.files.find(x=>x.path==="artifacts/transcript.json")||release.files.find(x=>x.path==="artifacts/current/transcript.json");
 const files=release.files.filter(x=>approvedPublicPath(x.path)||x===transcript).map(({path,storageId,bytes,sha256})=>({path,storageId,bytes,sha256}));
 if(files.filter(x=>/transcript\.json$/u.test(x.path)).length!==1||new Set(files.map(x=>x.path)).size!==files.length)reject();
 const operationNumber=Math.max(...old.stageAttempts.filter(x=>x.stage==="publish"&&x.revisionId===policy.revisionId).map(x=>x.operationNumber))+1;
 if(operationNumber!==3||s.authorization.binding.operationNumber!==2)reject();
 const idempotencyKey=`bb_${await hashTrial([jobId,policy.revisionId,"publish",String(operationNumber)].join("\0"))}`;
 const commands=(await c.db.query("customerFlowOperationsCommands").withIndex("by_job_id_and_state",q=>q.eq("jobId",jobId)).collect()).map(clean);
 const retiredCommands=commands.filter(x=>x.state==="pending"&&x.action==="queue_delivery");
 for(const x of retiredCommands)if(x.attempts!==0||x.claim!==null||x.outcome!==null||x.expectedVersion!==old.version||x.expectedState!=="published"||json(x.payload)!==json({revisionId:policy.revisionId,publicationId:old.publication.providerReceiptId,artifactManifestDigest:policy.manifestDigest}))reject();
 const runtime=files.filter(x=>x.path.startsWith("deploy/_assets/"));
 if(runtime.length!==4||new Set(runtime.map(x=>x.path.split("/")[2])).size!==1)reject();
 const derivedPaths=["fr","ar"].map(lang=>`_assets/${runtime[0].path.split("/")[2]}/audio/narration/${lang}/manifest.json`);
 const binding={derivedPaths,jobId,expectedVersion:old.version,revisionId:policy.revisionId,artifactSetId:release.artifactSetId,artifactManifestDigest:policy.manifestDigest,oldDeploymentId:old.publication.providerReceiptId,oldIdempotencyKey:old.publication.idempotencyKey,origin:policy.origin,provider:s.authorization.binding.provider,operationNumber,idempotencyKey,files,approvedFilesDigest:await hashTrial(json(files)),expiresAt:s.authorization.binding.expiresAt};
 const snapshot={policy,originalAggregate:old,previousDeploymentIds:[s.authorization.binding.oldDeploymentId,old.publication.providerReceiptId],supersessionDigest:await hashTrial(json(clean(s))),retiredCommands};
 return {binding,snapshot,contextDigest:await hashTrial(json({binding,snapshot}))};
}
const authArgs={operatorToken:v.string(),completionToken:v.string(),jobId:v.string()};
export const authorizationContext=queryGeneric({args:authArgs,handler:async(c,args)=>{assertOwnerTrialOperator(args.operatorToken);assertOwnerTrialCompletionToken(args.completionToken);return context(c,args.jobId);}});
async function evidence(ctx,proof,{fresh=true}={}){
 const p=await verify("owner-trial-public-playback-source-evidence-v1",proof,true),b=ctx.binding,time=Date.parse(p.observedAt);
 if(p.kind!=="owner_trial_public_playback_source_evidence"||p.contextDigest!==ctx.contextDigest||json(p.binding)!==json(b)||!HEX.test(p.sourceManifestDigest)||!Number.isFinite(time)||time<Date.parse(ctx.snapshot.originalAggregate.updatedAt)||(fresh&&(time>Date.now()||Date.now()-time>60000))||json(p.verification)!==json({ready:true,completeCensus:true,exactOldPublication:true,exactOldPublicBytes:true,sourceOnlyProjection:true,noPrivateProvenance:true,noProviderMutations:true}))reject();
 const pages=p.censusPages;
 if(!Array.isArray(pages)||pages.length<1||pages.length>100||await hashTrial(json(pages))!==p.censusDigest)reject();
 const ids=new Set(),cursors=new Set();let previous=null;
 for(const [i,page]of pages.entries()){
  if(!page||!Array.isArray(page.deployments)||page.deployments.length>100||!page.pagination||!Object.hasOwn(page.pagination,"next"))reject();
  const next=page.pagination.next;
  if(i===pages.length-1){if(next!==null)reject();}else{if(next===null||!Number.isSafeInteger(Number(next))||Number(next)<0||cursors.has(String(next))||(previous!==null&&Number(next)>=Number(previous)))reject();cursors.add(String(next));previous=next;}
  for(const d of page.deployments){const id=deploymentIdentity(d);if(!/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(id||"")||ids.has(id)||d.projectId!==b.provider.projectId||d.meta?.bbIdempotencyKey===b.idempotencyKey)reject();ids.add(id);}
 }
 const positive=p.positivePublication,m=positive?.meta;
 const matches=pages.flatMap(x=>x.deployments).filter(x=>(x.id||x.uid)===b.oldDeploymentId);
 if(matches.length!==1||json(matches[0])!==json(positive)||await hashTrial(json(positive))!==p.positivePublicationDigest||positive.readyState!=="READY"||positive.projectId!==b.provider.projectId||m?.bbCanaryJobId!==b.jobId||m.bbRevisionId!==b.revisionId||m.bbArtifactSetId!==b.artifactSetId||m.bbArtifactManifestDigest!==b.artifactManifestDigest||m.bbIdempotencyKey!==b.oldIdempotencyKey)reject();
 const inventory=p.correctedPublicInventory;
 if(!Array.isArray(inventory)||inventory.length!==b.files.length+b.derivedPaths.length||new Set(inventory.map(x=>x.path)).size!==inventory.length)reject();
 for(const file of [...b.files,...b.derivedPaths.map(path=>({path}))]){const path=publicPath(file.path),match=inventory.find(x=>x.path===path);
  if(!match||Object.keys(match).sort().join(",")!=="bytes,path,sha256"||!HEX.test(match.sha256)||!Number.isSafeInteger(match.bytes)||match.bytes<1||(!b.derivedPaths.includes(path)&&!path.endsWith(".html")&&!path.endsWith("transcript.json")&&(match.sha256!==file.sha256||match.bytes!==file.bytes)))reject();
 }
 return p;
}
export const authorizeRepair=mutationGeneric({args:{...authArgs,expectedVersion:v.number(),contextDigest:v.string(),proof:v.any()},handler:async(c,args)=>{
 assertOwnerTrialOperator(args.operatorToken);assertOwnerTrialCompletionToken(args.completionToken);
 const ctx=await context(c,args.jobId);if(args.expectedVersion!==ctx.binding.expectedVersion||args.contextDigest!==ctx.contextDigest)reject();
 const p=await evidence(ctx,args.proof),sourceDigest=await hashTrial(json({artifactManifestDigest:ctx.binding.artifactManifestDigest,approvedFilesDigest:ctx.binding.approvedFilesDigest,sourceManifestDigest:p.sourceManifestDigest,correctedPublicInventory:p.correctedPublicInventory}));
 const commandId=`command_${args.jobId}_playback_op3_v${args.expectedVersion}`;
 if(await command(c,commandId))reject();
 const a=await signed("owner-trial-public-playback-authorization-v1",{kind:"owner_trial_public_playback_authorization",...ctx,proof:args.proof,sourceDigest,commandId});
 const at=new Date().toISOString(),pending={commandId,jobId:args.jobId,action:"publish",expectedState:"published",expectedVersion:args.expectedVersion,payload:{revisionId:ctx.binding.revisionId,artifactManifestDigest:ctx.binding.artifactManifestDigest},requestedAt:at,requestedBy:"primary_operator",state:"pending",attempts:0,claim:null,lastFailureReason:null,outcome:null,updatedAt:at};
 await c.db.insert("customerFlowOperationsCommands",pending);
 await c.db.insert("ownerTrialPublicPlaybackRepairs",{jobId:args.jobId,authorization:a,lifecycle:await signed("owner-trial-public-playback-lifecycle-v1",{authorizationSignature:a.signature,phase:"authorized",aggregate:ctx.snapshot.originalAggregate,command:pending,lease:null,result:null})});
 return {authorized:true,commandId,authorization:a};
}});
// Called ONLY inside the op2 verifier, after its historical signatures, policy,
// source command, PRESENT authorization/lease and positive evidence are verified.
// No caller-selectable aggregate override or generic historical bypass exists.
export async function validatedPublicPlaybackProjection(c,jobId,supersession,job){
 const row=await find(c,"ownerTrialPublicPlaybackRepairs",jobId);if(!row)return null;
 const a=row.authorization,l=row.lifecycle,b=a?.binding;
 await verify("owner-trial-public-playback-authorization-v1",a);await verify("owner-trial-public-playback-lifecycle-v1",l);await evidence(a,a.proof,{fresh:false});
 const policy=await ownerTrialCompletionBasePolicy(c,jobId);
 if(b.jobId!==jobId||b.operationNumber!==3||supersession.authorization.binding.operationNumber!==2||l.authorizationSignature!==a.signature||json(policy)!==json(a.snapshot.policy)||json(a.snapshot.originalAggregate)!==json(supersession.lifecycle.aggregate)||a.snapshot.supersessionDigest!==await hashTrial(json(clean(supersession)))||a.contextDigest!==await hashTrial(json({binding:b,snapshot:a.snapshot}))||a.sourceDigest!==await hashTrial(json({artifactManifestDigest:b.artifactManifestDigest,approvedFilesDigest:b.approvedFilesDigest,sourceManifestDigest:a.proof.sourceManifestDigest,correctedPublicInventory:a.proof.correctedPublicInventory}))||Date.parse(b.expiresAt)<=Date.now()||json(clean(await command(c,a.commandId)))!==json(l.command))reject();
 for(const x of a.snapshot.retiredCommands)if(json(clean(await command(c,x.commandId)))!==json(x))reject();
 await verifiedContinuation(a,l);
 const expected=l.aggregate;
 if(Object.keys(job).sort().join("\0")!==Object.keys(expected).sort().join("\0"))reject();
 if(l.phase==="published"){
  await successProof(a,l.result?.result,l.result?.proof,{fresh:false});
  if(!l.lease?.effectStartedAt||Date.parse(l.result.proof.observedAt)<Date.parse(l.lease.effectStartedAt))reject();
  if(!["published","delivery_queued","sending","sent","complete","failed","reconciliation_required"].includes(job.state)||job.version<expected.version||json(job.events.slice(0,expected.events.length))!==json(expected.events)||json(job.stageAttempts.slice(0,expected.stageAttempts.length))!==json(expected.stageAttempts)||job.stageAttempts.slice(expected.stageAttempts.length).some(x=>x.stage!=="deliver"))reject();
  for(const k of Object.keys(expected))if(!["state","version","updatedAt","events","stageAttempts","deliveryAttempts"].includes(k)&&json(job[k])!==json(expected[k]))reject();
 }else if(!["authorized","claimed","fenced","reconciliation_required"].includes(l.phase)||json(job)!==json(expected))reject();
 // In-flight repair is not a delivery release. The historical op2 comparison uses
 // its exact immutable snapshot, while the current aggregate was checked above.
 return {historicalAggregate:a.snapshot.originalAggregate,commandId:a.commandId,retiredCommands:a.snapshot.retiredCommands,result:l.phase==="published"?l.result.result:null,phase:l.phase};
}
async function current(c,jobId){
 await verifiedSupersessionResult(c,jobId);
 const row=await find(c,"ownerTrialPublicPlaybackRepairs",jobId);if(!row)reject();
 return {row,a:row.authorization,l:row.lifecycle,document:await find(c,"fulfillmentJobs",jobId)};
}
const leaseArgs={completionToken:v.string(),jobId:v.string(),workerId:v.string(),leaseToken:v.string()};
async function active(c,args,{effect=false}={}){
 assertOwnerTrialCompletionToken(args.completionToken);const x=await current(c,args.jobId),l=x.l;
 if(args.workerId!=="owner-trial-completion-worker"||!l.lease||l.lease.workerId!==args.workerId||l.lease.leaseToken!==args.leaseToken||(args.commandId&&args.commandId!==x.a.commandId)||l.lease.expiresAtMs<=Date.now()||!["claimed","fenced"].includes(l.phase)||(effect&&l.phase!=="fenced"))reject();return x;
}
export async function assertPublicPlaybackRepairLease(c,args){return active(c,args,{effect:true});}
async function persist(c,x,next){const lifecycle=await signed("owner-trial-public-playback-lifecycle-v1",next);await c.db.patch(x.row._id,{lifecycle});const cmd=await command(c,x.a.commandId);await c.db.replace(cmd._id,next.command);await c.db.patch(x.document._id,{aggregate:next.aggregate});}
async function event(a,type,at,state,version){return {eventId:`event_${(await hashTrial(`${a.commandId}\0${type}`)).slice(0,24)}`,commandId:a.commandId,commandDigest:await hashTrial(json({authorizationSignature:a.signature,type,version})),type,at,state};}
export const claimRepair=mutationGeneric({args:leaseArgs,handler:async(c,args)=>{
 assertOwnerTrialCompletionToken(args.completionToken);const x=await current(c,args.jobId),{a,l}=x;
 if(l.phase!=="authorized"||args.workerId!=="owner-trial-completion-worker"||args.leaseToken.length<16)reject();
 const at=new Date().toISOString(),expiresAtMs=Math.min(Date.now()+300000,Date.parse(a.binding.expiresAt)),lease={workerId:args.workerId,leaseToken:args.leaseToken,claimedAt:at,expiresAtMs,effectStartedAt:null};
 const old=l.aggregate,b=a.binding,attemptNumber=old.stageAttempts.filter(x=>x.stage==="publish"&&x.revisionId===b.revisionId).length+1;
 const attempt={attemptId:`attempt_${(await hashTrial([args.jobId,b.revisionId,"publish",String(attemptNumber)].join("\0"))).slice(0,24)}`,stage:"publish",revisionId:b.revisionId,attemptNumber,operationNumber:b.operationNumber,idempotencyKey:b.idempotencyKey,operationBinding:null,operationsCommandId:a.commandId,status:"running",leaseToken:lease.leaseToken,leaseExpiresAt:new Date(expiresAtMs).toISOString(),startedAt:at,effectStartedAt:null,completedAt:null,failure:null};
 const next={...old,state:"publishing",version:old.version+1,updatedAt:at,stageAttempts:[...old.stageAttempts,attempt],events:[...old.events,await event(a,"owner_trial_public_playback_claimed",at,"publishing",old.version+1)]};
 await persist(c,x,{...l,phase:"claimed",lease,aggregate:next,command:{...l.command,state:"running",attempts:1,updatedAt:at,claim:{workerId:lease.workerId,leaseToken:lease.leaseToken,claimedAtMs:Date.parse(at),leaseExpiresAtMs:expiresAtMs}}});return {authorization:a,lease};
}});
export const fenceRepair=mutationGeneric({args:leaseArgs,handler:async(c,args)=>{
 const x=await active(c,args),{a,l}=x;if(l.phase==="fenced")return {active:true,authorization:a};
 const at=new Date().toISOString(),old=l.aggregate,lease={...l.lease,effectStartedAt:at};
 const next={...old,version:old.version+1,updatedAt:at,stageAttempts:[...old.stageAttempts.slice(0,-1),{...old.stageAttempts.at(-1),effectStartedAt:at}],events:[...old.events,await event(a,"external_effect_fenced",at,"publishing",old.version+1)]};
 await persist(c,x,{...l,phase:"fenced",lease,aggregate:next,command:{...l.command,claim:{...l.command.claim,effectStartedAtMs:Date.parse(at)}}});return {active:true,authorization:a};
}});
export async function publicPlaybackReservedCommandIds(c,jobId){
 const row=await find(c,"ownerTrialPublicPlaybackRepairs",jobId);if(!row)return [];
 await verifiedSupersessionResult(c,jobId);
 return [row.authorization.commandId,...row.authorization.snapshot.retiredCommands.map(x=>x.commandId)];
}
// A single evidence-gated continuation, never a re-claim or a publish retry.
// Original aggregate/command/lease history remains byte-identical in the receipt.
async function expiredContext(a,l){
 const attempt=l.aggregate?.stageAttempts.at(-1),lease=l.lease;
 if(l.continuation||l.phase!=="fenced"||l.result!==null||l.aggregate.state!=="publishing"||l.aggregate.retry!==null||l.aggregate.deliveryAttempts.length||!lease?.effectStartedAt||!Number.isSafeInteger(lease.expiresAtMs)||lease.expiresAtMs>Date.now()||lease.workerId!=="owner-trial-completion-worker"||l.command.state!=="running"||l.command.attempts!==1||l.command.outcome!==null||l.command.lastFailureReason!==null||l.command.claim?.leaseToken!==lease.leaseToken||l.command.claim.leaseExpiresAtMs!==lease.expiresAtMs||l.command.claim.workerId!==lease.workerId||l.command.claim.claimedAtMs!==Date.parse(lease.claimedAt)||l.command.claim.effectStartedAtMs!==Date.parse(lease.effectStartedAt)||attempt?.status!=="running"||attempt.operationsCommandId!==a.commandId||attempt.operationNumber!==3||attempt.idempotencyKey!==a.binding.idempotencyKey||attempt.revisionId!==a.binding.revisionId||attempt.leaseToken!==lease.leaseToken||Date.parse(attempt.leaseExpiresAt)!==lease.expiresAtMs||attempt.startedAt!==lease.claimedAt||attempt.effectStartedAt!==lease.effectStartedAt||attempt.failure!==null||attempt.completedAt!==null)reject();
 const binding={jobId:a.binding.jobId,commandId:a.commandId,attemptId:attempt.attemptId,expectedVersion:l.aggregate.version,authorizationSignature:a.signature,previousLifecycleSignature:l.signature,idempotencyKey:a.binding.idempotencyKey,provider:a.binding.provider,origin:a.binding.origin,sourceDigest:a.sourceDigest,originalSourceManifestDigest:a.proof.sourceManifestDigest,expiresAt:a.binding.expiresAt};
 return {binding,contextDigest:await hashTrial(json(binding))};
}
async function continuationEvidence(a,previous,ctx,proof,{fresh=true}={}){
 const p=await verify("owner-trial-public-playback-expired-run-evidence-v1",proof,true),b=a.binding,time=Date.parse(p.observedAt),h=p.historicalObservation;
 if(p.kind!=="owner_trial_public_playback_expired_run_evidence"||p.contextDigest!==ctx.contextDigest||json(p.binding)!==json(ctx.binding)||!HEX.test(p.sourceManifestDigest)||!Number.isFinite(time)||time<previous.lease.expiresAtMs||time>=Date.parse(b.expiresAt)||(fresh&&(time>Date.now()||Date.now()-time>60000))||json(p.verification)!==json({ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactManifest:true,exactDeploymentBytes:true,exactOldAlias:true,noProviderMutations:true})||!HEX.test(p.completeTransportTraceDigest)||!h||h.invocationClosed!==true||h.complete!==true||h.createCount!==1||h.aliasCount!==0||h.leaseDigest!==await hashTrial(json(previous.lease))||!HEX.test(h.completeTransportTraceDigest)||h.completeTransportTraceDigest!==p.completeTransportTraceDigest||!Number.isFinite(h.observedThrough)||h.observedThrough<Date.parse(previous.lease.effectStartedAt)||h.observedThrough>time)reject();
 const d=p.deploymentDetail,id=deploymentIdentity(d),meta=d.meta;
 if(a.snapshot.previousDeploymentIds.includes(id)||d.projectId!==b.provider.projectId||d.readyState!=="READY"||meta?.bbCanaryJobId!==b.jobId||meta.bbRevisionId!==b.revisionId||meta.bbArtifactSetId!==b.artifactSetId||meta.bbArtifactManifestDigest!==b.artifactManifestDigest||meta.bbIdempotencyKey!==b.idempotencyKey||typeof d.url!=="string"||!/^https:\/\/[A-Za-z0-9.-]+\.vercel\.app$/u.test(`https://${d.url}`))reject();
 if(!Array.isArray(p.censusPages)||p.censusPages.length!==1||p.censusPages[0].pagination?.next!==null||!Array.isArray(p.censusPages[0].deployments)||p.censusPages[0].deployments.length>100||p.censusDigest!==await hashTrial(json(p.censusPages)))reject();
 const ids=new Set(),census=p.censusPages[0].deployments;
 for(const entry of census){const id=deploymentIdentity(entry);if(ids.has(id)||entry.projectId!==b.provider.projectId)reject();ids.add(id);}
 const matches=census.filter(x=>x.meta?.bbIdempotencyKey===b.idempotencyKey),old=census.filter(x=>deploymentIdentity(x)===b.oldDeploymentId);
 if(matches.length!==1||json(deploymentFacts(matches[0]))!==json(deploymentFacts(d))||old.length!==1||json(deploymentFacts(old[0]))!==json(deploymentFacts(a.proof.positivePublication))||json(p.alias)!==json({hostname:new URL(b.origin).hostname,deploymentId:b.oldDeploymentId,projectId:b.provider.projectId})||json(p.publicInventory)!==json(a.proof.correctedPublicInventory)||!Array.isArray(p.byteReadbacks)||p.byteReadbacks.length!==p.publicInventory.length)reject();
 for(const file of p.publicInventory){const matches=p.byteReadbacks.filter(x=>x.path===file.path);if(matches.length!==1||json(matches[0])!==json({...file,target:"deployment",status:200}))reject();}
 return id;
}
async function verifiedContinuation(a,l){
 const r=l.continuation;if(!r)return;
 await verify("owner-trial-public-playback-expired-run-continuation-v1",r);
 const previous=r.previousLifecycle;
 await verify("owner-trial-public-playback-lifecycle-v1",previous);
 const ctx=await expiredContext(a,previous),id=await continuationEvidence(a,previous,ctx,r.proof,{fresh:false}),lease=r.lease,time=Date.parse(lease?.claimedAt);
 if(r.kind!=="owner_trial_public_playback_expired_run_continuation"||r.authorizationSignature!==a.signature||r.contextDigest!==ctx.contextDigest||r.deploymentId!==id||previous.authorizationSignature!==a.signature||json(l.lease)!==json(lease)||!Number.isFinite(time)||time<Date.parse(r.proof.observedAt)||time-Date.parse(r.proof.observedAt)>60000||lease.workerId!==previous.lease.workerId||typeof lease.leaseToken!=="string"||lease.leaseToken.length<16||lease.leaseToken===previous.lease.leaseToken||lease.effectStartedAt!==lease.claimedAt||lease.expiresAtMs!==Math.min(time+300000,Date.parse(a.binding.expiresAt)))reject();
 if(l.phase==="fenced"){
  if(json(l.aggregate)!==json(previous.aggregate)||json(l.command)!==json(previous.command)||l.result!==null)reject();
 }else if(!["published","reconciliation_required"].includes(l.phase)||json(l.aggregate.events.slice(0,previous.aggregate.events.length))!==json(previous.aggregate.events)||json(l.aggregate.stageAttempts.slice(0,-1))!==json(previous.aggregate.stageAttempts.slice(0,-1)))reject();
 if(l.phase==="published"&&(l.result.result.providerReceiptId!==id||Date.parse(l.result.proof.observedAt)<time))reject();
}
export const expiredRunContext=queryGeneric({args:authArgs,handler:async(c,args)=>{
 assertOwnerTrialOperator(args.operatorToken);assertOwnerTrialCompletionToken(args.completionToken);
 const {a,l}=await current(c,args.jobId);return expiredContext(a,l);
}});
export const continueExpiredRun=mutationGeneric({args:{...authArgs,recoveryToken:v.string(),workerId:v.string(),leaseToken:v.string(),expectedVersion:v.number(),contextDigest:v.string(),proof:v.any()},handler:async(c,args)=>{
 assertOwnerTrialOperator(args.operatorToken);assertOwnerTrialCompletionToken(args.completionToken);
 const role=process.env.BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN;
 if(typeof role!=="string"||role.length<32||args.recoveryToken!==role)reject();
 const x=await current(c,args.jobId),{a,l}=x,ctx=await expiredContext(a,l);
 if(args.workerId!==l.lease.workerId||args.leaseToken.length<16||args.leaseToken===l.lease.leaseToken||args.expectedVersion!==ctx.binding.expectedVersion||args.contextDigest!==ctx.contextDigest)reject();
 const deploymentId=await continuationEvidence(a,l,ctx,args.proof),now=Date.now(),at=new Date(now).toISOString(),lease={workerId:args.workerId,leaseToken:args.leaseToken,claimedAt:at,expiresAtMs:Math.min(now+300000,Date.parse(a.binding.expiresAt)),effectStartedAt:at};
 if(lease.expiresAtMs<=Date.now())reject();
 const continuation=await signed("owner-trial-public-playback-expired-run-continuation-v1",{kind:"owner_trial_public_playback_expired_run_continuation",authorizationSignature:a.signature,contextDigest:ctx.contextDigest,previousLifecycle:l,proof:args.proof,deploymentId,lease});
 const lifecycle=await signed("owner-trial-public-playback-lifecycle-v1",{...l,lease,continuation});
 await c.db.patch(x.row._id,{lifecycle});
 await current(c,args.jobId);
 return {continued:true,deploymentId,authorization:a,lease,continuation};
}});
export const activeRepair=queryGeneric({args:leaseArgs,handler:async(c,args)=>{const {a,l}=await active(c,args);return {active:true,authorization:a,lease:l.lease,continuation:l.continuation||null};}});
async function successProof(a,result,proof,{fresh=true}={}){
 const p=await verify("owner-trial-public-playback-success-evidence-v1",proof,true),b=a.binding;
 const expected={provider:"vercel",providerReceiptId:result?.providerReceiptId,stableUrl:`${b.origin}/announcements/${b.jobId}`,revisionId:b.revisionId,artifactSetId:b.artifactSetId,artifactManifestDigest:b.artifactManifestDigest,idempotencyKey:b.idempotencyKey},time=Date.parse(p.observedAt);
 if(json(result)!==json(expected)||!/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(result?.providerReceiptId||"")||a.snapshot.originalAggregate.stageAttempts.some(x=>x.stage==="publish"&&x.idempotencyKey===result.idempotencyKey)||a.snapshot.previousDeploymentIds.includes(result.providerReceiptId)||result.providerReceiptId===a.snapshot.originalAggregate.stageAttempts.find(x=>x.operationNumber===1)?.providerReceiptId||p.kind!=="owner_trial_public_playback_success_evidence"||p.authorizationSignature!==a.signature||p.sourceDigest!==a.sourceDigest||json(p.result)!==json(result)||json(p.publicInventory)!==json(a.proof.correctedPublicInventory)||p.publicInventoryDigest!==await hashTrial(json(p.publicInventory))||json(p.verification)!==json({ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true,playbackProjection:true,noPrivateProvenance:true})||!HEX.test(p.completeTransportTraceDigest)||!Number.isFinite(time)||time<Date.parse(a.proof.observedAt)||(fresh&&(time>Date.now()||Date.now()-time>60000)))reject();
 const detail=p.deploymentDetail,meta=detail?.meta;
 if(!detail||deploymentIdentity(detail)!==result.providerReceiptId||detail.projectId!==b.provider.projectId||detail.readyState!=="READY"||meta?.bbCanaryJobId!==b.jobId||meta.bbRevisionId!==b.revisionId||meta.bbArtifactSetId!==b.artifactSetId||meta.bbArtifactManifestDigest!==b.artifactManifestDigest||meta.bbIdempotencyKey!==b.idempotencyKey||json(p.alias)!==json({hostname:new URL(b.origin).hostname,deploymentId:result.providerReceiptId,projectId:b.provider.projectId}))reject();
 if(!Array.isArray(p.censusPages)||p.censusPages.length!==1||p.censusPages[0].pagination?.next!==null||!Array.isArray(p.censusPages[0].deployments)||p.censusDigest!==await hashTrial(json(p.censusPages)))reject();
 const census=p.censusPages[0].deployments,ids=new Set();
 for(const d of census){const id=deploymentIdentity(d);if(ids.has(id)||d.projectId!==b.provider.projectId)reject();ids.add(id);}
 const matches=census.filter(d=>d.meta?.bbIdempotencyKey===b.idempotencyKey);
 if(matches.length!==1||json(deploymentFacts(matches[0]))!==json(deploymentFacts(detail))||!ids.has(b.oldDeploymentId))reject();
 // Each signed readback is an actual body hash/byte count, not just an exact flag.
 const reads=p.byteReadbacks;
 if(!Array.isArray(reads)||reads.length!==p.publicInventory.length*2)reject();
 for(const file of p.publicInventory)for(const target of ["deployment","stable"]){
  const matches=reads.filter(x=>x.path===file.path&&x.target===target);
  if(matches.length!==1||json(matches[0])!==json({...file,target,status:200}))reject();
 }
}
export const commitRepair=mutationGeneric({args:{...leaseArgs,result:v.any(),proof:v.any()},handler:async(c,args)=>{
 const x=await active(c,args,{effect:true}),{a,l}=x;await successProof(a,args.result,args.proof);
 if(Date.parse(args.proof.observedAt)<Date.parse(l.lease.effectStartedAt))reject();
 const at=new Date().toISOString(),old=l.aggregate,{artifactSetId,...result}=args.result,publication={...result,status:"published",operationsCommandId:a.commandId};
 const next={...old,state:"published",version:old.version+1,updatedAt:at,publication,publishedRevisionId:a.binding.revisionId,stageAttempts:[...old.stageAttempts.slice(0,-1),{...old.stageAttempts.at(-1),status:"completed",leaseToken:null,leaseExpiresAt:null,completedAt:at}],events:[...old.events,await event(a,"stage_completed",at,"published",old.version+1)]};
 await persist(c,x,{...l,phase:"published",aggregate:next,result:{result:args.result,proof:args.proof},command:{...l.command,state:"completed",updatedAt:at,outcome:{code:"public_playback_repaired",jobVersion:next.version,publicationId:args.result.providerReceiptId}}});
 await current(c,args.jobId);return {committed:true,commandId:a.commandId,jobVersion:next.version};
}});
export const failRepair=mutationGeneric({args:leaseArgs,handler:async(c,args)=>{
 const x=await active(c,args),{a,l}=x,at=new Date().toISOString(),old=l.aggregate;
 const next={...old,state:"reconciliation_required",version:old.version+1,updatedAt:at,retry:null,stageAttempts:[...old.stageAttempts.slice(0,-1),{...old.stageAttempts.at(-1),status:"reconciliation_required",leaseToken:null,leaseExpiresAt:null,failure:{reasonCode:"publication_scope_invalid",retryable:false}}],events:[...old.events,await event(a,"owner_trial_public_playback_uncertain",at,"reconciliation_required",old.version+1)]};
 await persist(c,x,{...l,phase:"reconciliation_required",aggregate:next,command:{...l.command,state:"reconciliation_required",claim:null,lastFailureReason:"operation_failed",updatedAt:at}});return {retryable:false};
}});
