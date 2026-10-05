import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import fs from "node:fs";
import {convexTest} from "convex-test";
import {makeFunctionReference as ref} from "convex/server";
import schema from "../../convex/schema.js";
const root=new URL("../../",import.meta.url);
test("live deliveryLoop schema and HTTP coexist with approved trial authority",async()=>{
 const exported=JSON.parse(schema.export());
 const tables=exported.tables.map(t=>t.tableName);
 for(const t of ["deliveryLoopJobs","deliveryLoopIntakeThrottle","ownerTrialPublicationSupersessions","ownerTrialPublicationPresentAuthorizations"])assert.ok(tables.includes(t),t);
 const modules=Object.fromEntries(["deliveryLoop","deliveryLoopHttp","http","narrationHttp"].map(n=>[`./${n}.js`,()=>import(`../../convex/${n}.js`)]));
 const t=convexTest(schema,{...modules,"./_generated/server.js":()=>import("convex/server")});
 const response=await t.fetch("/delivery");assert.equal(response.status,200);
 for(const route of [["/delivery/intake","POST"],["/delivery/review","GET"],["/delivery/review","POST"],["/announcements/offline-unknown","GET"]]){
  const result=await t.fetch(route[0],{method:route[1]});assert.notEqual(result.status,405);assert.notEqual(result.status,500);
 }
});
test("approved publication provider and test bytes are immutable",()=>{
 const sha=p=>createHash("sha256").update(fs.readFileSync(new URL(p,root))).digest("hex");
 assert.equal(sha("src/fulfillment/vercel-test-a-publication-provider.mjs"),"fceb4e9418f7df42cc662e8e5c3cc138a169aa2dcf42e00734392de60c84a5c7");
 assert.equal(sha("test/fulfillment/vercel-test-a-publication-provider.test.mjs"),"64c760d55072a45a9cde17a73b09d42c38c1908ccd6bde476c02388fb308c6fa");
});

const captured=new URL("../fixtures/",import.meta.url);
const load=name=>JSON.parse(fs.readFileSync(new URL(name,captured),"utf8"));
test("every active live table/field/index is preserved exactly, with only approved trial additions",()=>{
 const live=JSON.parse(load("supersession-forward-live-schema.json").active);
 const now=JSON.parse(schema.export());assert.equal(now.schemaValidation,live.schemaValidation);
 for(const table of live.tables){
  const candidate=now.tables.find(t=>t.tableName===table.tableName);assert.ok(candidate,table.tableName);
  assert.deepEqual(candidate.documentType,table.documentType,table.tableName);
  const indexes=table.indexes.map(i=>({...i,fields:i.fields.filter(f=>f!=="_creationTime")}));
  assert.deepEqual([...candidate.indexes].sort((a,b)=>a.indexDescriptor.localeCompare(b.indexDescriptor)),indexes.sort((a,b)=>a.indexDescriptor.localeCompare(b.indexDescriptor)),table.tableName);
  assert.deepEqual(candidate.searchIndexes,table.searchIndexes);assert.deepEqual(candidate.vectorIndexes,table.vectorIndexes);
 }
});
test("every captured live function ABI remains; only workerHealth adds optional trial selector",async()=>{
 const specs=load("supersession-predeploy-current-function-spec.json").functions;
 for(const spec of specs.filter(s=>s.identifier)){
  const [file,name]=spec.identifier.split(":");
  const mod=await import(new URL(`../../convex/${file}`,import.meta.url));const fn=mod[name];assert.ok(fn,spec.identifier);
  const args=JSON.parse(fn.exportArgs());
  if(spec.identifier==="operations.js:workerHealth")delete args.value.jobId;
  assert.deepEqual(args,spec.args,spec.identifier);
  assert.equal(Boolean(fn.isQuery),spec.functionType==="Query",spec.identifier);
  assert.equal(Boolean(fn.isMutation),spec.functionType==="Mutation",spec.identifier);
  assert.equal(Boolean(fn.isAction),spec.functionType==="Action",spec.identifier);
  assert.equal(Boolean(fn.isPublic),spec.visibility.kind==="public",spec.identifier);
 }
 assert.equal(specs.filter(s=>s.identifier?.startsWith("deliveryLoop")).length,18);
});
test("current narration role stays current while trial worker retains signed policy authority",async()=>{
 const token="offline-coexist-current-narration-token-32-bytes";
 process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN=token;
 delete process.env.BEBEBONJOUR_TTS_WORKER_TOKEN;
 const {workerHealth}=await import("../../convex/operations.js");
 const ctx={db:{query:()=>{throw Error("worker health must not query without a job selector")}}};
 assert.deepEqual(await workerHealth._handler(ctx,{workerToken:token}),{protocolVersion:"1.0",scope:"narration"});
 const trialToken="offline-coexist-trial-completion-token-32-bytes";
 process.env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN=trialToken;
 await assert.rejects(()=>workerHealth._handler(ctx,{workerToken:trialToken}),/Owner trial/);
});

test("trial metadata routes to approved authority even with non-prefix job IDs",async()=>{
 const {coexistDefinition}=await import("../../src/forward-coexistence/dispatch.mjs");
 let approved=0,current=0;
 const definition=coexistDefinition({handler:async()=>{approved++;throw Error("approved trial authority rejection");}}, {_handler:async()=>{current++;return "current";}},"readClaim","narration");
 const docs={customerFlowJobs:{job:{jobId:"job_coexist_regular",ownerTrialAuthority:{invalid:true}}},fulfillmentJobs:{aggregate:{jobId:"job_coexist_regular"}}};
 const ctx={db:{query:table=>({withIndex(){return this;},async unique(){return docs[table];}})}};
 await assert.rejects(()=>definition.handler(ctx,{jobId:"job_coexist_regular"}),/approved trial authority rejection/);
 assert.equal(approved,1);assert.equal(current,0);
});

test("exact full current HTTP route census is retained, not only deliveryLoop routes",async()=>{
 const specs=load("supersession-predeploy-current-function-spec.json").functions.filter(s=>s.functionType==="HttpAction");
 const http=(await import("../../convex/http.js")).default;
 const routes=http.getRoutes().map(([path,method])=>({path,method}));
 const key=r=>`${r.method} ${r.path}`;
 assert.deepEqual(routes.map(key).sort(),specs.map(key).sort());
 assert.equal(routes.length,8);
});

test("rejected oldest metadata trial cannot starve unscoped ordinary claims",async()=>{
 const token="offline-coexist-mixed-queue-worker-at-least-32-bytes";
 process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN=token;
 process.env.BEBEBONJOUR_OWNER_TRIAL_ENABLED="true";
 const t=convexTest(schema,{
  "./_generated/server.js":()=>import("convex/server"),
  "./operations.js":()=>import("../../convex/operations.js"),
 });
 const trialId="job_coexist_rejected_metadata",ordinaryId="job_coexist_ordinary";
 const aggregate=jobId=>({
  schemaVersion:"1.0",authority:"convex-target/local-test-projection",jobId,
  environment:"test",product:"announcement-page",intakeDigest:"a".repeat(64),
  paymentCorrelation:{project:"bebebonjour",product:"announcement-page",environment:"test",jobId,intakeDigest:"a".repeat(64)},
  narrationRequired:true,state:"generation_queued",version:3,
  createdAt:"2026-09-02T20:00:00.000Z",updatedAt:"2026-09-02T20:05:00.000Z",
  currentRevisionId:null,publishedRevisionId:null,retry:null,payment:{providerPaymentId:"pi_offline"},
  revisions:[],artifactSets:[],reviewDecisions:[],stageAttempts:[],publication:null,deliveryAttempts:[],events:[],
 });
 const command=(jobId,requestedAt)=>({
  commandId:`command_${jobId}`,jobId,action:"generate",expectedState:"generation_queued",expectedVersion:3,
  payload:{},requestedAt,requestedBy:"primary_operator",state:"pending",attempts:0,
  claim:null,lastFailureReason:null,outcome:null,updatedAt:requestedAt,
 });
 await t.run(async ctx=>{
  for(const jobId of [trialId,ordinaryId]){
   const a=aggregate(jobId),job={schemaVersion:"1.0",jobId,version:2,intakeDigest:"a".repeat(64),payment:{status:"paid"}};
   if(jobId===trialId){a.ownerTrialAuthority={invalid:true};job.ownerTrialAuthority={invalid:true};}
   await ctx.db.insert("customerFlowJobs",{jobId,job});
   await ctx.db.insert("fulfillmentJobs",{jobId,aggregate:a});
   await ctx.db.insert("customerFlowOperationsCommands",command(jobId,jobId===trialId?"2026-09-02T20:00:00.000Z":"2026-09-02T20:05:00.000Z"));
  }
 });
 const readTrial=()=>t.run(async ctx=>({
  customer:await ctx.db.query("customerFlowJobs").withIndex("by_job_id",q=>q.eq("jobId",trialId)).unique(),
  aggregate:await ctx.db.query("fulfillmentJobs").withIndex("by_job_id",q=>q.eq("jobId",trialId)).unique(),
  command:await ctx.db.query("customerFlowOperationsCommands").withIndex("by_command_id",q=>q.eq("commandId",`command_${trialId}`)).unique(),
 }));
 const before=await readTrial();
 const args={workerToken:token,workerId:"offline-coexist-worker",actions:["generate"],limit:1,leaseMs:300000};
 const claimed=await t.mutation(ref("operations:claimCommands"),args);
 assert.equal(claimed.length,1,"eligible ordinary command must not be hidden by rejected oldest trial");
 assert.equal(claimed[0].jobId,ordinaryId);
 assert.equal(claimed[0].attempts,1);
 assert.equal(claimed[0].state,"running");
 assert.deepEqual(await readTrial(),before,"rejected trial authority and command must remain unchanged");
 assert.deepEqual(await t.mutation(ref("operations:claimCommands"),args),[],"live lease is not replayed");
 assert.deepEqual(await t.mutation(ref("operations:claimCommands"),args),[],"repeated claim does not touch rejected trial");
 assert.deepEqual(await readTrial(),before);
});
