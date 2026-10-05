import { validatedPublicPlaybackProjection } from "./ownerTrialPublicPlaybackRepair.js";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { hashTrial } from "./ownerTrial.js";
import { snapshotExpiredPresent } from "./ownerTrialPublicationPresent.js";
import { ownerTrialCompletionBasePolicy, assertOwnerTrialCompletionToken } from "./ownerTrialCompletion.js";
import { assertOwnerTrialOperator } from "../src/fulfillment/owner-trial-authority.mjs";
import { stablePrivateValue as json } from "../src/fulfillment/private-generation-authority.mjs";
const clean=({_id,_creationTime,...x})=>x;
const find=(c,t,jobId)=>c.db.query(t).withIndex("by_job_id",q=>q.eq("jobId",jobId)).unique();
const command=(c,id)=>c.db.query("customerFlowOperationsCommands").withIndex("by_command_id",q=>q.eq("commandId",id)).unique();
const reject=()=>{throw new Error("Owner trial PRESENT supersession rejected.");};
const HEX=/^[a-f0-9]{64}$/u;
export const approvedPublicPath=path=>/^deploy\/(?:fr\/|ar\/)?index\.html$/u.test(path)
 || /^(?:deploy\/(?:fr|ar)\/app\.js|deploy\/shared\/app\.css)$/u.test(path)
 || /^deploy\/_assets\/[a-z0-9]+(?:-[a-z0-9]+){0,30}\/(?:app\.js|phrase-progress\.mjs|styles\.css|og-image\.svg)$/u.test(path)
 || /^artifacts\/audio\/[A-Za-z0-9/_-]+\.mp3$/u.test(path);
async function sign(domain,value,recovery=false){
 const secret=process.env[recovery?"BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN":"BEBEBONJOUR_APPROVAL_HMAC_KEY"];
 if(typeof secret!=="string"||secret.length<32)reject();
 if(recovery&&["BEBEBONJOUR_OPERATIONS_TOKEN","BEBEBONJOUR_OPERATIONS_WORKER_TOKEN","BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN","BEBEBONJOUR_APPROVAL_HMAC_KEY","CRON_SECRET","OWNER_TRIAL_INVOKE_SECRET"].some(k=>process.env[k]===secret))reject();
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return [...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${domain}\0${json(value)}`)))].map(n=>n.toString(16).padStart(2,"0")).join("");
}
async function signed(domain,{signature:previousSignature,...value}){return {...value,signature:await sign(domain,value)};}
async function verify(domain,receipt,recovery=false){if(!receipt)reject();const {signature,...value}=receipt;if(signature!==await sign(domain,value,recovery))reject();return value;}
async function dependencies(c,jobId,policy){
 const customer=clean(await find(c,"customerFlowJobs",jobId));
 const ticket=clean(await c.db.query("ownerTrialTickets").withIndex("by_ticket_id",q=>q.eq("ticketId",policy.ticketId)).unique());
 const reviews=(await c.db.query("ownerTrialReviews").withIndex("by_job_type",q=>q.eq("jobId",jobId)).collect()).map(clean).sort((a,b)=>a.decisionType.localeCompare(b.decisionType));
 const approvals=await Promise.all([policy.contentApprovalId,policy.narrationApprovalId].map(async approvalId=>clean(await c.db.query("fulfillmentReviewApprovals").withIndex("by_approval_id",q=>q.eq("approvalId",approvalId)).unique())));
 const recoveries=(await c.db.query("ownerTrialPublicationRecoveries").withIndex("by_job_revision",q=>q.eq("jobId",jobId)).collect()).map(clean);
 const continuation=await find(c,"ownerTrialCompletionContinuations",jobId);
 return {customer,ticket,reviews,approvals,recoveries,continuation:continuation?clean(continuation):null};
}
// No elapsed-time inference: expiry allows a new separately signed observation, not absence.
async function context(c,jobId){
 const present=await snapshotExpiredPresent(c,jobId),a=present.authorization;
 const policy=await ownerTrialCompletionBasePolicy(c,jobId);
 const old=a.originalAggregate,release=old.artifactSets.find(x=>x.kind==="narration_review"&&x.revisionId===policy.revisionId);
 const runtimeFiles=release.files.filter(x=>x.path.startsWith("deploy/_assets/"));
 if(runtimeFiles.length!==4||runtimeFiles.some(x=>!approvedPublicPath(x.path))||new Set(runtimeFiles.map(x=>x.path)).size!==4
   ||new Set(runtimeFiles.map(x=>x.path.split("/")[2])).size!==1||old.state!=="reconciliation_required"||old.publication!==null||old.retry!==null)reject();
 const files=release.files.filter(x=>approvedPublicPath(x.path)).map(({path,storageId,bytes,sha256})=>({path,storageId,bytes,sha256}));
 const approvedFilesDigest=await hashTrial(json(files));
 const operationNumber=Math.max(...old.stageAttempts.filter(x=>x.stage==="publish"&&x.revisionId===policy.revisionId).map(x=>x.operationNumber))+1;
 const idempotencyKey=`bb_${await hashTrial([jobId,policy.revisionId,"publish",String(operationNumber)].join("\0"))}`;
 const binding={jobId,expectedVersion:old.version,revisionId:policy.revisionId,artifactManifestDigest:policy.manifestDigest,
 sourceCommandId:a.sourceCommandId,presentCommandId:a.commandId,oldDeploymentId:a.deploymentId,oldIdempotencyKey:old.stageAttempts.at(-1).idempotencyKey,
 provider:a.provider,origin:policy.origin,operationNumber,idempotencyKey,approvedFilesDigest,runtimeFiles,files,expiresAt:a.expiresAt};
 const snapshot={policy,originalAggregate:old,originalCommand:a.originalCommand,present,...await dependencies(c,jobId,policy)};
 await unresolved(c,jobId,[binding.sourceCommandId,binding.presentCommandId]);
 return {binding,snapshot,contextDigest:await hashTrial(json({binding,snapshot}))};
}
async function unresolved(c,jobId,excluded,{published=false,result,commandId}={}){
 const commands=await c.db.query("customerFlowOperationsCommands").withIndex("by_job_id_and_state",q=>q.eq("jobId",jobId)).collect();
 for(const x of commands){
  if(excluded.includes(x.commandId))continue;
  if(!["pending","running","reconciliation_required"].includes(x.state))continue;
  // Only existing, exact owner-only delivery commands may progress after a signed result.
  if(published&&["queue_delivery","deliver"].includes(x.action)&&x.state!=="reconciliation_required"
   &&json(x.payload)===json({revisionId:result.revisionId,publicationId:result.providerReceiptId,artifactManifestDigest:result.artifactManifestDigest})
   &&(!x.claim||x.claim.workerId==="owner-trial-completion-worker"))continue;
  reject();
 }
}
const authArgs={operatorToken:v.string(),completionToken:v.string(),jobId:v.string()};
export const authorizationContext=queryGeneric({args:authArgs,handler:async(c,args)=>{
 assertOwnerTrialOperator(args.operatorToken);assertOwnerTrialCompletionToken(args.completionToken);return context(c,args.jobId);
}});
async function evidence(ctx,proof,{fresh=true}={}){
 const p=await verify("owner-trial-missing-runtime-evidence-v1",proof,true),b=ctx.binding;
 const time=Date.parse(p.observedAt);
 if(p.kind!=="owner_trial_missing_runtime_evidence"||p.contextDigest!==ctx.contextDigest||json(p.binding)!==json(b)
  ||!HEX.test(p.sourceManifestDigest)||!Number.isFinite(time)||time<Date.parse(ctx.snapshot.originalAggregate.updatedAt)
  ||(fresh&&(time>Date.now()||Date.now()-time>60000)))reject();
 const expected={completeCensus:true,exactPositiveEffect:true,ready:true,exactDetail:true,exactConfig:true,exactInventory:true,exactAliasState:true};
 if(json(p.verification)!==json(expected)||!p.evidenceDigests||Object.keys(p.evidenceDigests).sort().join(",")!=="alias,census,config,detail,inventory,publicReadback"
  ||Object.values(p.evidenceDigests).some(x=>!HEX.test(x)))reject();
 // A digest and a "complete" flag alone cannot establish new-key absence.
 // Bind the actual complete census and reject every existing new-key record,
 // including records whose other metadata conflict with the approved source.
 const pages=p.censusPages;
 if(!Array.isArray(pages)||pages.length<1||pages.length>100||await hashTrial(json(pages))!==p.evidenceDigests.census)reject();
 const ids=new Set(),cursors=new Set();let previousCursor=null;
 for(const [index,page]of pages.entries()){
  if(!page||!Array.isArray(page.deployments)||page.deployments.length>100||!page.pagination||!Object.hasOwn(page.pagination,"next"))reject();
  const next=page.pagination.next;
  if(index===pages.length-1){if(next!==null)reject();}
  else{
   if(next===null||!Number.isSafeInteger(Number(next))||Number(next)<0||cursors.has(String(next))||(previousCursor!==null&&Number(next)>=Number(previousCursor)))reject();
   cursors.add(String(next));previousCursor=next;
  }
  for(const deployment of page.deployments){
   const id=deployment?.id||deployment?.uid;
   if(!/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(id||"")||ids.has(id)||deployment.projectId!==b.provider.projectId||deployment.meta?.bbIdempotencyKey===b.idempotencyKey)reject();
   ids.add(id);
  }
 }
 const oldMatches=pages.flatMap(page=>page.deployments).filter(deployment=>(deployment.id||deployment.uid)===b.oldDeploymentId);
 if(oldMatches.length!==1||oldMatches[0].meta?.bbIdempotencyKey!==b.oldIdempotencyKey)reject();
 const h=p.historicalObservation;
 if(!h||h.commandId!==b.presentCommandId||h.authorizationSignature!==ctx.snapshot.present.authorization.signature
  ||h.leaseDigest!==await hashTrial(json(ctx.snapshot.present.lease))||!HEX.test(h.completeTransportTraceDigest)
  ||h.complete!==true||h.providerMutationCount!==0||h.aliasMutationCount!==0||h.invocationClosed!==true||!Number.isFinite(h.observedThrough)||h.observedThrough<Date.parse(ctx.snapshot.present.lease.effectStartedAt)||h.observedThrough>=ctx.snapshot.present.lease.expiresAtMs)reject();
 const build=p.buildInspection;
 if(!build||build.schemaVersion!=="1.0"||build.source!=="vercel inspect --format=json"||build.teamId!==b.provider.teamId||build.projectId!==b.provider.projectId||build.projectName!==b.provider.projectName||build.revisionId!==b.revisionId||!/^dpl_[A-Za-z0-9_-]+$/u.test(build.deploymentId)||typeof build.buildId!=="string"||!build.buildId)reject();
 const missing=p.missingRuntime;
 if(!Array.isArray(missing)||missing.length!==4||json(missing.map(x=>x.path).sort())!==json(b.runtimeFiles.map(x=>x.path.slice(7)).sort())
  ||missing.some(x=>x.inventoryAbsent!==true||x.httpStatus!==404||!HEX.test(x.responseDigest)))reject();
 const inventory=p.correctedPublicInventory;
 if(!Array.isArray(inventory)||inventory.length!==b.files.length||new Set(inventory.map(x=>x.path)).size!==inventory.length)reject();
 for(const file of b.files){const path=file.path.startsWith("deploy/")?file.path.slice(7):file.path;
  const match=inventory.find(x=>x.path===path);
  if(!match||!HEX.test(match.sha256)||!Number.isSafeInteger(match.bytes)||match.bytes<1||Object.keys(match).sort().join(",")!=="bytes,path,sha256"
   ||(!path.endsWith(".html")&&(match.sha256!==file.sha256||match.bytes!==file.bytes)))reject();
 }
 return p;
}
export const authorizeSupersession=mutationGeneric({args:{...authArgs,expectedVersion:v.number(),contextDigest:v.string(),proof:v.any()},handler:async(c,args)=>{
 assertOwnerTrialOperator(args.operatorToken);assertOwnerTrialCompletionToken(args.completionToken);
 const ctx=await context(c,args.jobId);if(args.expectedVersion!==ctx.binding.expectedVersion||args.contextDigest!==ctx.contextDigest)reject();
 const p=await evidence(ctx,args.proof),sourceDigest=await hashTrial(json({artifactManifestDigest:ctx.binding.artifactManifestDigest,approvedFilesDigest:ctx.binding.approvedFilesDigest,sourceManifestDigest:p.sourceManifestDigest,correctedPublicInventory:p.correctedPublicInventory}));
 const commandId=`command_${args.jobId}_supersede_v${args.expectedVersion}`;
 const a=await signed("owner-trial-supersession-authorization-v1",{kind:"owner_trial_supersession_authorization",...ctx,proof:args.proof,sourceDigest,commandId});
 if(await find(c,"ownerTrialPublicationSupersessions",args.jobId)||await command(c,commandId))reject();
 const at=new Date().toISOString(),pending={commandId,jobId:args.jobId,action:"publish",expectedState:"reconciliation_required",expectedVersion:args.expectedVersion,
 payload:{revisionId:ctx.binding.revisionId,artifactManifestDigest:ctx.binding.artifactManifestDigest},requestedAt:at,requestedBy:"primary_operator",state:"pending",attempts:0,claim:null,lastFailureReason:null,outcome:null,updatedAt:at};
 await c.db.insert("customerFlowOperationsCommands",pending);
 await c.db.insert("ownerTrialPublicationSupersessions",{jobId:args.jobId,authorization:a,lifecycle:await signed("owner-trial-supersession-lifecycle-v1",{authorizationSignature:a.signature,phase:"authorized",aggregate:ctx.snapshot.originalAggregate,command:pending,lease:null,result:null})});
 return {authorized:true,commandId,authorization:a};
}});
async function current(c,jobId,{published=false}={}){
 const row=await find(c,"ownerTrialPublicationSupersessions",jobId);if(!row)reject();
 const a=row.authorization,l=row.lifecycle;
 await verify("owner-trial-supersession-authorization-v1",a);await verify("owner-trial-supersession-lifecycle-v1",l);await evidence(a,a.proof,{fresh:false});
 const b=a.binding,policy=await ownerTrialCompletionBasePolicy(c,jobId);
 if(l.authorizationSignature!==a.signature||process.env.OWNER_TRIAL_JOB_ID!==jobId||b.jobId!==jobId||Date.parse(b.expiresAt)<=Date.now()
  ||json(policy)!==json(a.snapshot.policy)||json(await dependencies(c,jobId,policy))!==json(Object.fromEntries(["customer","ticket","reviews","approvals","recoveries","continuation"].map(k=>[k,a.snapshot[k]]))))reject();
 const target=Object.fromEntries([["teamId","OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID"],["projectId","OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID"],["projectName","OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME"]].map(([k,e])=>[k,process.env[e]]));
 if(json(target)!==json(b.provider)||json(clean(await command(c,b.sourceCommandId)))!==json(a.snapshot.originalCommand)
  ||json(clean(await command(c,b.presentCommandId)))!==json(a.snapshot.present.command)
  ||json((await find(c,"ownerTrialPublicationPresentAuthorizations",jobId)).receipt)!==json(a.snapshot.present.authorization)
  ||json((await find(c,"ownerTrialPublicationPresentLeases",jobId)).lease)!==json(a.snapshot.present.lease)
  ||await find(c,"ownerTrialPublicationPresentResults",jobId)
  ||json(clean(await command(c,a.commandId)))!==json(l.command))reject();
 const document=await find(c,"fulfillmentJobs",jobId);
 if(published){if(l.phase!=="published"||!l.result)reject();await successProof(a,l.result.result,l.result.proof,{fresh:false});}
 const projection=published?await validatedPublicPlaybackProjection(c,jobId,row,document.aggregate):null;
 const job=projection?projection.historicalAggregate:document.aggregate;
 if(published){
  if(l.phase!=="published"||!l.result)reject();
  await successProof(a,l.result.result,l.result.proof,{fresh:false});
  const expected=l.aggregate;
  if(!["published","delivery_queued","sending","sent","complete","failed","reconciliation_required"].includes(job.state)||job.version<expected.version
   ||json(job.publication)!==json(expected.publication)||job.publishedRevisionId!==b.revisionId
   ||json(job.events.slice(0,expected.events.length))!==json(expected.events)
   ||json(job.stageAttempts.slice(0,expected.stageAttempts.length))!==json(expected.stageAttempts)
   ||job.stageAttempts.slice(expected.stageAttempts.length).some(x=>x.stage!=="deliver"))reject();
  for(const k of Object.keys(expected))if(!["state","version","updatedAt","events","stageAttempts","deliveryAttempts"].includes(k)&&json(job[k])!==json(expected[k]))reject();
 }else if(json(job)!==json(l.aggregate)||l.phase==="published")reject();
 await unresolved(c,jobId,[b.sourceCommandId,b.presentCommandId,a.commandId,...(projection?[projection.commandId,...projection.retiredCommands.map(x=>x.commandId)]:[])],{published:published&&(!projection||projection.phase==="published"),result:projection?.result||l.result?.result});
 return {row,a,l,document,projection};
}
const leaseArgs={completionToken:v.string(),jobId:v.string(),workerId:v.string(),leaseToken:v.string()};
async function active(c,args,{effect=false}={}){
 assertOwnerTrialCompletionToken(args.completionToken);const x=await current(c,args.jobId),l=x.l;
 if(args.workerId!=="owner-trial-completion-worker"||!l.lease||l.lease.workerId!==args.workerId||l.lease.leaseToken!==args.leaseToken
  ||(args.commandId&&args.commandId!==x.a.commandId)||l.lease.expiresAtMs<=Date.now()||!["claimed","fenced"].includes(l.phase)
  ||(effect&&l.phase!=="fenced"))reject();return x;
}
export async function assertSupersessionLease(c,args){return active(c,args,{effect:true});}
async function persist(c,x,next){
 const lifecycle=await signed("owner-trial-supersession-lifecycle-v1",next);
 await c.db.patch(x.row._id,{lifecycle});
 const cmd=await command(c,x.a.commandId);await c.db.replace(cmd._id,next.command);
 await c.db.patch(x.document._id,{aggregate:next.aggregate});
}
async function event(a,type,at,state,version){return {eventId:`event_${(await hashTrial(`${a.commandId}\0${type}`)).slice(0,24)}`,commandId:a.commandId,commandDigest:await hashTrial(json({authorizationSignature:a.signature,type,version})),type,at,state};}
export const claimSupersession=mutationGeneric({args:leaseArgs,handler:async(c,args)=>{
 assertOwnerTrialCompletionToken(args.completionToken);const x=await current(c,args.jobId),{a,l}=x;
 if(l.phase!=="authorized"||args.workerId!=="owner-trial-completion-worker"||args.leaseToken.length<16)reject();
 const at=new Date().toISOString(),expiresAtMs=Math.min(Date.now()+300000,Date.parse(a.binding.expiresAt));
 const lease={workerId:args.workerId,leaseToken:args.leaseToken,claimedAt:at,expiresAtMs,effectStartedAt:null};
 const old=l.aggregate,b=a.binding,attemptNumber=old.stageAttempts.filter(x=>x.stage==="publish"&&x.revisionId===b.revisionId).length+1;
 const attempt={attemptId:`attempt_${(await hashTrial([args.jobId,b.revisionId,"publish",String(attemptNumber)].join("\0"))).slice(0,24)}`,stage:"publish",revisionId:b.revisionId,attemptNumber,operationNumber:b.operationNumber,idempotencyKey:b.idempotencyKey,
 operationBinding:null,operationsCommandId:a.commandId,status:"running",leaseToken:lease.leaseToken,leaseExpiresAt:new Date(expiresAtMs).toISOString(),startedAt:at,effectStartedAt:null,completedAt:null,failure:null};
 const next={...old,state:"publishing",version:old.version+1,updatedAt:at,stageAttempts:[...old.stageAttempts,attempt],events:[...old.events,await event(a,"owner_trial_supersession_claimed",at,"publishing",old.version+1)]};
 const claimed={...l.command,state:"running",attempts:1,updatedAt:at,claim:{workerId:lease.workerId,leaseToken:lease.leaseToken,claimedAtMs:Date.parse(at),leaseExpiresAtMs:expiresAtMs}};
 await persist(c,x,{...l,phase:"claimed",lease,aggregate:next,command:claimed});return {authorization:a,lease};
}});
export const fenceSupersession=mutationGeneric({args:leaseArgs,handler:async(c,args)=>{
 const x=await active(c,args),{a,l}=x;if(l.phase==="fenced")return {active:true,authorization:a};
 const at=new Date().toISOString(),old=l.aggregate,lease={...l.lease,effectStartedAt:at};
 const next={...old,version:old.version+1,updatedAt:at,stageAttempts:[...old.stageAttempts.slice(0,-1),{...old.stageAttempts.at(-1),effectStartedAt:at}],events:[...old.events,await event(a,"external_effect_fenced",at,"publishing",old.version+1)]};
 await persist(c,x,{...l,phase:"fenced",lease,aggregate:next,command:{...l.command,claim:{...l.command.claim,effectStartedAtMs:Date.parse(at)}}});return {active:true,authorization:a};
}});
export const activeSupersession=queryGeneric({args:leaseArgs,handler:async(c,args)=>{const {a}=await active(c,args);return {active:true,authorization:a};}});
async function successProof(a,result,proof,{fresh=true}={}){
 const p=await verify("owner-trial-supersession-success-evidence-v1",proof,true),b=a.binding;
 const expected={provider:"vercel",providerReceiptId:result?.providerReceiptId,stableUrl:`${b.origin}/announcements/${b.jobId}`,revisionId:b.revisionId,artifactSetId:a.snapshot.originalAggregate.artifactSets.find(x=>x.kind==="narration_review"&&x.revisionId===b.revisionId).artifactSetId,artifactManifestDigest:b.artifactManifestDigest,idempotencyKey:b.idempotencyKey};
 const time=Date.parse(p.observedAt);
 if(json(result)!==json(expected)||!/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(result?.providerReceiptId||"")||result.providerReceiptId===b.oldDeploymentId
  ||p.kind!=="owner_trial_supersession_success_evidence"||p.authorizationSignature!==a.signature||p.sourceDigest!==a.sourceDigest||json(p.result)!==json(result)
  ||json(p.verification)!==json({ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true})
  ||!HEX.test(p.completeTransportTraceDigest)||!Number.isFinite(time)||time<Date.parse(a.proof.observedAt)||(fresh&&(time>Date.now()||Date.now()-time>60000)))reject();
}
export const commitSupersession=mutationGeneric({args:{...leaseArgs,result:v.any(),proof:v.any()},handler:async(c,args)=>{
 const x=await active(c,args,{effect:true}),{a,l}=x;await successProof(a,args.result,args.proof);
 const at=new Date().toISOString(),old=l.aggregate,{artifactSetId,...result}=args.result;
 const publication={...result,status:"published",operationsCommandId:a.commandId};
 const next={...old,state:"published",version:old.version+1,updatedAt:at,publication,publishedRevisionId:a.binding.revisionId,
  stageAttempts:[...old.stageAttempts.slice(0,-1),{...old.stageAttempts.at(-1),status:"completed",leaseToken:null,leaseExpiresAt:null,completedAt:at}],events:[...old.events,await event(a,"stage_completed",at,"published",old.version+1)]};
 await persist(c,x,{...l,phase:"published",aggregate:next,result:{result:args.result,proof:args.proof},command:{...l.command,state:"completed",updatedAt:at,outcome:{code:"publication_superseded",jobVersion:next.version,publicationId:args.result.providerReceiptId}}});
 await current(c,args.jobId,{published:true});return {committed:true,commandId:a.commandId,jobVersion:next.version};
}});
export const failSupersession=mutationGeneric({args:leaseArgs,handler:async(c,args)=>{
 const x=await active(c,args),{a,l}=x,at=new Date().toISOString(),old=l.aggregate;
 // A transport/fence failure is never an absence certificate, never retryable.
 const next={...old,state:"reconciliation_required",version:old.version+1,updatedAt:at,retry:null,
 stageAttempts:[...old.stageAttempts.slice(0,-1),{...old.stageAttempts.at(-1),status:"reconciliation_required",leaseToken:null,leaseExpiresAt:null,failure:{reasonCode:"publication_scope_invalid",retryable:false}}],events:[...old.events,await event(a,"owner_trial_supersession_uncertain",at,"reconciliation_required",old.version+1)]};
 await persist(c,x,{...l,phase:"reconciliation_required",aggregate:next,command:{...l.command,state:"reconciliation_required",claim:null,lastFailureReason:"operation_failed",updatedAt:at}});return {retryable:false};
}});
export async function verifiedPublishedSupersession(c,jobId){
 const row=await find(c,"ownerTrialPublicationSupersessions",jobId);if(!row)return null;
 if(row.lifecycle?.phase!=="published")reject();
 const {a,document}=await current(c,jobId,{published:true});
 return {doc:document,a,policy:a.snapshot.policy};
}
export async function verifiedSupersessionResult(c,jobId){
 const row=await find(c,"ownerTrialPublicationSupersessions",jobId);if(!row)return null;
 if(row.lifecycle?.phase!=="published")reject();
 const {a,l,projection}=await current(c,jobId,{published:true});
 return {sourceCommandId:a.binding.sourceCommandId,presentCommandId:a.binding.presentCommandId,commandId:projection?.commandId||a.commandId,result:projection?.result||l.result.result};
}
