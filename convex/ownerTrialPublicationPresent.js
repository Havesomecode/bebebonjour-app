import { mutationGeneric } from "convex/server";
import { verifiedSupersessionResult } from "./ownerTrialPublicationSupersession.js";
import { v } from "convex/values";
import { hashTrial } from "./ownerTrial.js";
import { ownerTrialCompletionPolicy, ownerTrialCompletionBasePolicy, assertOwnerTrialCompletionToken } from "./ownerTrialCompletion.js";
import { assertOwnerTrialOperator } from "../src/fulfillment/owner-trial-authority.mjs";
import { stablePrivateValue as json } from "../src/fulfillment/private-generation-authority.mjs";
const find = (c,t,f,x) => c.db.query(t).withIndex(`by_${f === "jobId" ? "job_id" : "command_id"}`,q=>q.eq(f,x)).unique();
const clean = ({_id,_creationTime,...x})=>x;
const reject = () => { throw new Error("Owner trial PRESENT reconciliation rejected."); };
async function sign(domain, value) {
  const secret = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  if (typeof secret !== "string" || secret.length < 32) reject();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${domain}\0${json(value)}`)))].map(n=>n.toString(16).padStart(2,"0")).join("");
}
const provider = () => Object.fromEntries([["teamId","OWNER_TRIAL_PUBLICATION_VERCEL_TEAM_ID"],["projectId","OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_ID"],["projectName","OWNER_TRIAL_PUBLICATION_VERCEL_PROJECT_NAME"]].map(([k,e])=>[k,process.env[e]]));
const authArgs = {operatorToken:v.string(),completionToken:v.string(),jobId:v.string(),expectedVersion:v.number(),commandId:v.string(),sourceCommandId:v.string(),deploymentId:v.string()};
export const authorizeReconciliation = mutationGeneric({args:authArgs,handler:async(c,a)=>{
  assertOwnerTrialOperator(a.operatorToken); assertOwnerTrialCompletionToken(a.completionToken);
  const policy = await ownerTrialCompletionPolicy(c,a.jobId);
  const job = (await find(c,"fulfillmentJobs","jobId",a.jobId)).aggregate;
  const source = await find(c,"customerFlowOperationsCommands","commandId",a.sourceCommandId);
  const command = await find(c,"customerFlowOperationsCommands","commandId",a.commandId);
  const attempt = job.stageAttempts.at(-1), target = provider();
  if (process.env.OWNER_TRIAL_JOB_ID !== a.jobId || !/^dpl_[A-Za-z0-9_-]{1,156}$/u.test(a.deploymentId)
    || Object.values(target).some(x=>typeof x!=="string"||!x)
    || job.version!==a.expectedVersion || job.state!=="reconciliation_required" || job.publication!==null || job.retry!==null
    || attempt?.stage!=="publish" || attempt.status!=="reconciliation_required" || attempt.operationsCommandId!==a.sourceCommandId
    || !Number.isFinite(Date.parse(attempt.effectStartedAt)) || attempt.leaseToken!==null || attempt.leaseExpiresAt!==null
    || source?.jobId!==a.jobId || source.action!=="publish" || source.state!=="reconciliation_required" || source.claim!==null
    || source.attempts!==attempt.attemptNumber || source.outcome!==null || source.payload.revisionId!==policy.revisionId
    || source.payload.artifactManifestDigest!==policy.manifestDigest || attempt.revisionId!==policy.revisionId
    || command?.jobId!==a.jobId || command.action!=="reconcile" || command.state!=="pending" || command.attempts!==0 || command.claim!==null
    || command.expectedVersion!==a.expectedVersion || command.expectedState!==job.state
    || json(command.payload)!==json({sourceCommandId:a.sourceCommandId,providerStatus:"confirmed_succeeded"})) reject();
  const busy = await c.db.query("customerFlowOperationsCommands").withIndex("by_job_id_and_state",q=>q.eq("jobId",a.jobId)).collect();
  if (busy.some(x=>x.commandId!==a.commandId && ["pending","running"].includes(x.state))) reject();
  const ticket = await c.db.query("ownerTrialTickets").withIndex("by_ticket_id",q=>q.eq("ticketId",policy.ticketId)).unique();
  const customer = clean(await find(c,"customerFlowJobs","jobId",a.jobId));
  const expiresAt = policy.completionExpiresAt || ticket.binding.expiresAt;
  const unsigned = {kind:"owner_trial_present_authorization",jobId:a.jobId,commandId:a.commandId,sourceCommandId:a.sourceCommandId,
    expectedVersion:a.expectedVersion,deploymentId:a.deploymentId,provider:target,policy,expiresAt,
    originalAggregate:job,originalCommand:clean(source),reconcileCommand:clean(command),ticket:clean(ticket),customer};
  const receipt = {...unsigned,signature:await sign("owner-trial-present-authorization-v1",unsigned)};
  const prior = await find(c,"ownerTrialPublicationPresentAuthorizations","jobId",a.jobId);
  if (prior) { if(json(prior.receipt)!==json(receipt)) reject(); return {authorized:false}; }
  await c.db.insert("ownerTrialPublicationPresentAuthorizations",{jobId:a.jobId,receipt});
  return {authorized:true};
}});
async function authorization(c,jobId,{published=false,policy:validatedPolicy}={}) {
 const row=await find(c,"ownerTrialPublicationPresentAuthorizations","jobId",jobId);
 if(!row) reject();
 const {signature,...unsigned}=row.receipt, a=row.receipt;
 if(signature!==await sign("owner-trial-present-authorization-v1",unsigned) || a.jobId!==jobId
   || process.env.OWNER_TRIAL_JOB_ID!==jobId || json(a.provider)!==json(provider()) || Date.parse(a.expiresAt)<=Date.now()) reject();
 const policy=validatedPolicy || await ownerTrialCompletionBasePolicy(c,jobId);
 const source=clean(await find(c,"customerFlowOperationsCommands","commandId",a.sourceCommandId));
 const job=(await find(c,"fulfillmentJobs","jobId",jobId)).aggregate;
 const ticket=clean(await c.db.query("ownerTrialTickets").withIndex("by_ticket_id",q=>q.eq("ticketId",policy.ticketId)).unique());
 const customer=clean(await find(c,"customerFlowJobs","jobId",jobId));
 if(json(policy)!==json(a.policy)||json(source)!==json(a.originalCommand)||json(ticket)!==json(a.ticket)
  ||json(customer)!==json(a.customer)||(!published&&json(job)!==json(a.originalAggregate))) reject();
 return a;
}
const leaseArgs={completionToken:v.string(),jobId:v.string(),workerId:v.string(),leaseToken:v.string()};
// Only claim lifecycle fields may differ from the signed pending command. Compare the
// whole derived record so action, optional ancestry and future immutable fields stay bound.
function claimedCommand(a,l) {
 const claimedAtMs=Date.parse(l.claimedAt), effectAtMs=Date.parse(l.effectStartedAt);
 if(a.reconcileCommand.action!=="reconcile"||a.reconcileCommand.commandId!==a.commandId
  ||a.reconcileCommand.jobId!==a.jobId||a.reconcileCommand.expectedVersion!==a.expectedVersion
  ||l.workerId!=="owner-trial-completion-worker"||typeof l.leaseToken!=="string"||l.leaseToken.length<16
  ||!Number.isFinite(claimedAtMs)||!Number.isFinite(l.expiresAtMs)||claimedAtMs>Date.now()
  ||l.expiresAtMs!==Math.min(claimedAtMs+300000,Date.parse(a.expiresAt))
  ||(l.effectStartedAt!==null&&(!Number.isFinite(effectAtMs)||effectAtMs<claimedAtMs||effectAtMs>=l.expiresAtMs||effectAtMs>Date.now()))) reject();
 const claim={workerId:l.workerId,leaseToken:l.leaseToken,leaseExpiresAtMs:l.expiresAtMs,claimedAtMs,
  ...(l.effectStartedAt===null?{}:{effectStartedAtMs:effectAtMs})};
 return {...a.reconcileCommand,state:"running",attempts:1,claim,updatedAt:l.claimedAt};
}
const reconciledOutcome=(a,version)=>({code:"reconciled",jobVersion:version,reconciledState:"published",sourceCommandId:a.sourceCommandId,providerStatus:"confirmed_succeeded"});
export const claimReconciliation=mutationGeneric({args:leaseArgs,handler:async(c,args)=>{
 assertOwnerTrialCompletionToken(args.completionToken);
 if(args.workerId!=="owner-trial-completion-worker"||typeof args.leaseToken!=="string"||args.leaseToken.length<16) reject();
 const a=await authorization(c,args.jobId);
 if(await find(c,"ownerTrialPublicationPresentLeases","jobId",args.jobId)) reject();
 const command=await find(c,"customerFlowOperationsCommands","commandId",a.commandId);
 if(json(clean(command))!==json(a.reconcileCommand)) reject();
 const now=Date.now(), expiresAtMs=Math.min(now+300000,Date.parse(a.expiresAt));
 const lease={workerId:args.workerId,leaseToken:args.leaseToken,expiresAtMs,claimedAt:new Date(now).toISOString(),effectStartedAt:null};
 await c.db.insert("ownerTrialPublicationPresentLeases",{jobId:args.jobId,lease});
 await c.db.patch(command._id,{state:"running",attempts:1,claim:{workerId:args.workerId,leaseToken:args.leaseToken,leaseExpiresAtMs:expiresAtMs,claimedAtMs:now},updatedAt:lease.claimedAt});
 return {...lease,authorization:a};
}});
export async function assertPresentLease(c,args,{effect=false,published=false}={}) {
 assertOwnerTrialCompletionToken(args.completionToken);
 const a=await authorization(c,args.jobId,{published});
 const row=await find(c,"ownerTrialPublicationPresentLeases","jobId",args.jobId), l=row?.lease;
 const command=await find(c,"customerFlowOperationsCommands","commandId",a.commandId);
 if(args.workerId!=="owner-trial-completion-worker"||!l||l.workerId!==args.workerId||l.leaseToken!==args.leaseToken||l.expiresAtMs<=Date.now()
  ||command?.jobId!==args.jobId||command.state!=="running"||command.commandId!==(args.commandId||a.commandId)||command.claim?.leaseToken!==l.leaseToken
  ||command.claim.workerId!==l.workerId||command.claim.leaseExpiresAtMs!==l.expiresAtMs
  ||json(clean(command))!==json(claimedCommand(a,l))
  ||!Number.isFinite(l.expiresAtMs)||command.claim.claimedAtMs!==Date.parse(l.claimedAt)
  ||(l.effectStartedAt!==null&&(!Number.isFinite(Date.parse(l.effectStartedAt))||command.claim.effectStartedAtMs!==Date.parse(l.effectStartedAt)))
  ||(l.effectStartedAt===null&&command.claim.effectStartedAtMs!==undefined)
  ||(effect&&l.effectStartedAt===null)) reject();
 return {a,row,l,command};
}
export const fenceReconciliation=mutationGeneric({args:leaseArgs,handler:async(c,args)=>{
 const {a,row,l,command}=await assertPresentLease(c,args);
 const at=l.effectStartedAt||new Date().toISOString();
 await c.db.patch(row._id,{lease:{...l,effectStartedAt:at}});
 await c.db.patch(command._id,{claim:{...command.claim,effectStartedAtMs:Date.parse(at)}});
 return {active:true,authorization:a};
}});

async function presenceProof(a,result,proof,{fresh=true}={}) {
 const secret=process.env.BEBEBONJOUR_OWNER_TRIAL_PUBLICATION_RECOVERY_TOKEN;
 if(typeof secret!=="string"||secret.length<32||["BEBEBONJOUR_OPERATIONS_TOKEN","BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN","BEBEBONJOUR_OPERATIONS_WORKER_TOKEN","BEBEBONJOUR_APPROVAL_HMAC_KEY","CRON_SECRET","OWNER_TRIAL_INVOKE_SECRET"].some(k=>process.env[k]===secret)) reject();
 const expected={provider:"vercel",providerReceiptId:a.deploymentId,revisionId:a.policy.revisionId,stableUrl:`${a.policy.origin}/announcements/${a.jobId}`,artifactSetId:a.originalAggregate.artifactSets.find(x=>x.kind==="narration_review"&&x.revisionId===a.policy.revisionId).artifactSetId,artifactManifestDigest:a.policy.manifestDigest,idempotencyKey:a.originalAggregate.stageAttempts.at(-1).idempotencyKey};
 if(json(result)!==json(expected)||!proof) reject();
 const unsigned={kind:"owner_trial_present_evidence",authorizationSignature:a.signature,result,observedAt:proof.observedAt,verification:{ready:true,completeCensus:true,exactInventory:true,exactConfig:true,exactPublicBytes:true,exactAlias:true}};
 const time=Date.parse(proof.observedAt), key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signature=[...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`owner-trial-present-evidence-v1\0${json(unsigned)}`)))].map(n=>n.toString(16).padStart(2,"0")).join("");
 if(json(proof)!==json({...unsigned,signature})||!Number.isFinite(time)||time<Date.parse(a.originalAggregate.updatedAt)||(fresh&&(time>Date.now()||Date.now()-time>60000))) reject();
}
export async function verifiedPresentResult(c,jobId,policy) {
 const row=await find(c,"ownerTrialPublicationPresentResults","jobId",jobId); if(!row)return null;
 const a=await authorization(c,jobId,{published:true,policy}), r=row.receipt, {signature,...unsigned}=r;
 if(signature!==await sign("owner-trial-present-result-v1",unsigned)||r.authorizationSignature!==a.signature) reject();
 await presenceProof(a,r.result,r.proof,{fresh:false});
 const leaseRow=await find(c,"ownerTrialPublicationPresentLeases","jobId",jobId);
 const command=await find(c,"customerFlowOperationsCommands","commandId",a.commandId);
 const expected={...claimedCommand(a,r.lease),state:"completed",outcome:reconciledOutcome(a,r.publishedVersion),updatedAt:r.event.at};
 const digest=await hashTrial(json({authorizationSignature:a.signature,result:r.result,proof:r.proof}));
 if(!leaseRow||json(leaseRow.lease)!==json(r.lease)||r.lease.effectStartedAt===null
  ||r.workerId!==r.lease.workerId||r.leaseToken!==r.lease.leaseToken
  ||!command||json(clean(command))!==json(expected)||r.receiptId!==`present_${digest.slice(0,24)}`
  ||json(r.event)!==json({eventId:`event_${(await hashTrial(`${jobId}\0${a.commandId}`)).slice(0,24)}`,commandId:a.commandId,commandDigest:digest,type:"owner_trial_publication_present_reconciled",at:r.event.at,state:"published"})) reject();
 const job=(await find(c,"fulfillmentJobs","jobId",jobId)).aggregate, old=a.originalAggregate;
 if(!["published","delivery_queued","sending","sent","complete","failed","reconciliation_required"].includes(job.state)
  ||(["sending","sent","complete","failed","reconciliation_required"].includes(job.state)&&job.stageAttempts.length<=old.stageAttempts.length)
  ||job.stageAttempts.slice(old.stageAttempts.length).some(x=>x.stage!=="deliver"))reject();
 if(json(job.publication)!==json(r.publication)||job.publishedRevisionId!==a.policy.revisionId||json(job.stageAttempts.slice(0,old.stageAttempts.length))!==json(old.stageAttempts)||json(job.events.slice(0,old.events.length))!==json(old.events)||json(job.events[old.events.length])!==json(r.event)||job.version<r.publishedVersion||r.publishedVersion!==a.expectedVersion+1) reject();
 for(const k of Object.keys(old))if(!["state","version","updatedAt","publication","publishedRevisionId","events","stageAttempts","deliveryAttempts"].includes(k)&&json(old[k])!==json(job[k]))reject();
 return r;
}
// Transaction-bound shared unresolved-set validation. Only the signed, currently
// exact PRESENT source is discharged. An in-flight deliver is not an unresolved
// command merely because its effect fence exists; only persisted uncertainty is.
export async function snapshotExpiredPresent(c,jobId) {
 const a=await authorization(c,jobId);
 const row=await find(c,"ownerTrialPublicationPresentLeases","jobId",jobId),l=row?.lease;
 const command=await find(c,"customerFlowOperationsCommands","commandId",a.commandId);
 if(!l||l.expiresAtMs>Date.now()||l.effectStartedAt===null||json(clean(command))!==json(claimedCommand(a,l)))reject();
 return {authorization:a,lease:l,command:clean(command)};
}
export async function findUnresolvedPresentCommand(c,jobId,policy) {
  const supersession=await verifiedSupersessionResult(c,jobId);
  if(supersession)return null; // verifier checked the entire unresolved set in this transaction
  const receipt = await verifiedPresentResult(c,jobId,policy);
  const verifiedSourceCommandId = receipt
    ? (await find(c,"ownerTrialPublicationPresentAuthorizations","jobId",jobId)).receipt.sourceCommandId
    : null;
  const unresolved = await c.db.query("customerFlowOperationsCommands")
    .withIndex("by_job_id_and_state",q=>q.eq("jobId",jobId).eq("state","reconciliation_required"))
    .order("desc").collect();
  return unresolved.find(command=>command.commandId!==verifiedSourceCommandId) || null;
}
export const commitReconciliation=mutationGeneric({args:{...leaseArgs,result:v.any(),proof:v.any()},handler:async(c,args)=>{
 assertOwnerTrialCompletionToken(args.completionToken);
 const prior=await verifiedPresentResult(c,args.jobId);
 if(prior){if(args.workerId!==prior.workerId||args.leaseToken!==prior.leaseToken||json(args.result)!==json(prior.result)||json(args.proof)!==json(prior.proof))reject();return{committed:false,receiptId:prior.receiptId};}
 const {a,l,command}=await assertPresentLease(c,args,{effect:true}); await presenceProof(a,args.result,args.proof);
 const at=new Date().toISOString(), old=a.originalAggregate, digest=await hashTrial(json({authorizationSignature:a.signature,result:args.result,proof:args.proof}));
 const event={eventId:`event_${(await hashTrial(`${args.jobId}\0${a.commandId}`)).slice(0,24)}`,commandId:a.commandId,commandDigest:digest,type:"owner_trial_publication_present_reconciled",at,state:"published"};
 const {artifactSetId,...fields}=args.result, publication={...fields,status:"published",operationsCommandId:a.commandId};
 const next={...old,state:"published",version:old.version+1,updatedAt:at,publication,publishedRevisionId:a.policy.revisionId,events:[...old.events,event]};
 const unsigned={kind:"owner_trial_present_result",receiptId:`present_${digest.slice(0,24)}`,authorizationSignature:a.signature,result:args.result,proof:args.proof,publication,event,publishedVersion:next.version,workerId:args.workerId,leaseToken:args.leaseToken,lease:l};
 const receipt={...unsigned,signature:await sign("owner-trial-present-result-v1",unsigned)};
 await c.db.insert("ownerTrialPublicationPresentResults",{jobId:args.jobId,receipt});
 const document=await find(c,"fulfillmentJobs","jobId",args.jobId); await c.db.patch(document._id,{aggregate:next});
 await c.db.patch(command._id,{state:"completed",outcome:reconciledOutcome(a,next.version),updatedAt:at});
 return{committed:true,receiptId:receipt.receiptId};
}});
