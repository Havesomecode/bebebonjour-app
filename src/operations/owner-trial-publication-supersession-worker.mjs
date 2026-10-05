import { randomUUID, createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { stablePrivateValue as json } from "../fulfillment/private-generation-authority.mjs";
import { createOwnerTrialPublicArtifactResolver } from "../fulfillment/owner-trial-completion-capabilities.mjs";
import { createVercelTestAPublicationProvider, parseAuthoritativeVercelBuildInspection } from "../fulfillment/vercel-test-a-publication-provider.mjs";
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const digest=value=>sha(json(value));
// NON-AUTH header only. Exact validated hosts, GET, no credentials, no redirects.
export function publicToolbarRead(input,init,hosts){
 const u=new URL(input),headers=new Headers(init.headers);
 if(u.protocol==="https:"&&hosts.has(u.hostname)&&!u.username&&!u.password&&!u.port&&(init.method||"GET")==="GET"
   &&!headers.has("authorization")&&!headers.has("cookie")&&!headers.has("x-vercel-protection-bypass"))headers.set("x-vercel-skip-toolbar","1");
 return {...init,headers};
}
// Validate all nodes before recognizing only the observed virtual src root.
function oldInventoryFiles(inventory){
 const files=[],seen=new Set();let count=0;
 const visit=(nodes,parent="",depth=0)=>{
  if(!Array.isArray(nodes)||depth>100)throw new Error("Supersession malformed old inventory.");
  for(const node of nodes){
   if(++count>10000||!node||typeof node.name!=="string"||!node.name||[".",".."].includes(node.name)||/[\\/]/u.test(node.name)||!Number.isSafeInteger(node.mode)||node.mode<0)throw new Error("Supersession malformed old inventory.");
   const path=parent?`${parent}/${node.name}`:node.name;if(seen.has(path))throw new Error("Supersession duplicate old inventory.");seen.add(path);
   if(node.type==="directory")visit(node.children,path,depth+1);
   else{if(node.type!=="file"||!/^([A-Za-z0-9_-]){1,160}$/u.test(node.uid||"")||node.children!==undefined)throw new Error("Supersession malformed old inventory.");files.push({path,uid:node.uid});}
  }
 };visit(inventory);
 return inventory.length===1&&inventory[0].name==="src"&&inventory[0].type==="directory"&&inventory[0].mode===16749?files.map(x=>({...x,path:x.path.slice(4)})):files;
}
export async function runOwnerTrialPublicationSupersession(options={}){
 const env=options.environment||process.env,jobId=env.OWNER_TRIAL_JOB_ID,token=env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN;
 if(!/^job_owner_trial_[a-f0-9]{32}$/u.test(jobId||"")||(options.jobId!==undefined&&options.jobId!==jobId)||typeof options.signSupersessionResult!=="function")throw new Error("Exact owner-trial supersession and independent signer required.");
 const client=options.client||new ConvexHttpClient(env.CONVEX_URL),identity={completionToken:token,jobId,workerId:"owner-trial-completion-worker",leaseToken:randomUUID()};
 const mutate=(name,args={})=>client.mutation(`ownerTrialPublicationSupersession:${name}`,{...identity,...args});
 const claimed=await mutate("claimSupersession"),a=claimed.authorization,b=a.binding;
 const active=()=>client.query("ownerTrialPublicationSupersession:activeSupersession",identity);
 const baseFetch=options.fetch||fetch,trace=[],hosts=new Set([new URL(b.origin).hostname]);
 const query=`teamId=${encodeURIComponent(b.provider.teamId)}`;
 let deploymentId=null,creates=0,aliases=0;
 const uploadBytes=new Set();
 const guarded=async(input,init={})=>{
  await active();
  const u=new URL(input),method=(init.method||"GET").toUpperCase();
  if(u.origin==="https://api.vercel.com"){
   if(u.searchParams.get("teamId")!==b.provider.teamId||u.searchParams.has("projectId")&&u.searchParams.get("projectId")!==b.provider.projectId)throw new Error("Supersession provider scope drift.");
   if(method!=="GET"){
    if(method!=="POST")throw new Error("Supersession transport mutation forbidden.");
    if(u.pathname==="/v2/files"){
     if(!uploadBytes.has(sha(Buffer.from(init.body))))throw new Error("Supersession unapproved upload.");
    }else if(u.pathname==="/v13/deployments"){
     const payload=JSON.parse(init.body);
     if(creates++!==0||payload.project!==b.provider.projectId||payload.name!==b.provider.projectName||payload.meta?.bbIdempotencyKey!==b.idempotencyKey
      ||payload.meta?.bbArtifactManifestDigest!==b.artifactManifestDigest||payload.meta?.bbCanaryJobId!==jobId)throw new Error("Supersession exact new operation required.");
    }else if(u.pathname===`/v2/deployments/${deploymentId}/aliases`){
     if(!deploymentId||deploymentId===b.oldDeploymentId||aliases++!==0||json(JSON.parse(init.body))!==json({alias:new URL(b.origin).hostname}))throw new Error("Supersession alias scope rejected.");
    }else throw new Error("Supersession transport mutation forbidden.");
   }
  }else if(u.origin===siteOrigin){if(method!=="GET"||u.pathname!=="/completion/artifact")throw new Error("Supersession artifact transport rejected.");}
  else if(u.protocol!=="https:"||!hosts.has(u.hostname)||method!=="GET"||u.username||u.password||u.port)throw new Error("Supersession public host rejected.");
  await mutate("fenceSupersession");
  const response=await baseFetch(input,publicToolbarRead(input,{...init,redirect:init.redirect||"error"},hosts));
  const responseBytes=Buffer.from(await response.clone().arrayBuffer());
  trace.push({url:u.href,method,status:response.status,responseDigest:sha(responseBytes),requestDigest:init.body?sha(Buffer.from(init.body)):null});
  // Fence every provider census, not just the signed preflight. A later census
  // must not turn a known key collision into apparent absence and a new create.
  if(u.origin==="https://api.vercel.com"&&u.pathname==="/v7/deployments"&&response.ok){
   const page=JSON.parse(responseBytes.toString());
   if(!Array.isArray(page.deployments))throw new Error("Supersession incomplete census.");
   const newKey=page.deployments.filter(detail=>detail?.meta?.bbIdempotencyKey===b.idempotencyKey);
   if(newKey.length>1||newKey.some(detail=>!deploymentId||(detail.id||detail.uid)!==deploymentId))throw new Error("Supersession new idempotency key already present.");
  }
  if(u.origin==="https://api.vercel.com"&&(u.pathname==="/v13/deployments"||u.pathname.startsWith("/v13/deployments/"))&&response.ok){
   const detail=JSON.parse(responseBytes.toString());
   if(u.pathname==="/v13/deployments"&&method==="POST")deploymentId=detail.id||detail.uid;
   if(detail.projectId===b.provider.projectId&&detail.readyState==="READY"&&detail.url&&[b.oldDeploymentId,deploymentId].includes(detail.id||detail.uid)){
    const h=new URL(`https://${detail.url}`);
    if(h.origin!==`https://${detail.url}`||!h.hostname.endsWith(".vercel.app")||h.username||h.password||h.port)throw new Error("Supersession verified deployment host invalid.");
    hosts.add(h.hostname);
   }
  }
  return response;
 };
 const siteOrigin=new URL(env.CONVEX_SITE_URL||env.CONVEX_URL.replace(/\.cloud$/u,".site")).origin;
 const getJson=async path=>{const response=await guarded(`https://api.vercel.com${path}`,{method:"GET",headers:{authorization:`Bearer ${env.OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN}`}});if(!response.ok)throw new Error("Supersession observation failed.");return response.json();};
 try{
  // Independently re-observe every signed old positive-effect input before uploads.
  const pages=[],cursors=new Set();let cursor=null;
  do{
   const page=await getJson(`/v7/deployments?projectId=${encodeURIComponent(b.provider.projectId)}&limit=100${cursor===null?"":`&until=${cursor}`}&${query}`);
   if(!Array.isArray(page.deployments)||!page.pagination||!Object.hasOwn(page.pagination,"next")||pages.length>=100)throw new Error("Supersession incomplete census.");
   pages.push(page);const next=page.pagination.next;if(next!==null&&(!Number.isSafeInteger(Number(next))||cursors.has(String(next))||(cursor!==null&&Number(next)>=Number(cursor))))throw new Error("Supersession census cursor rejected.");
   cursors.add(String(next));cursor=next;
  }while(cursor!==null);
  const all=pages.flatMap(x=>x.deployments),matches=all.filter(x=>(x.id||x.uid)===b.oldDeploymentId);
  if(matches.length!==1||matches[0].projectId!==b.provider.projectId)throw new Error("Supersession old positive effect disappeared.");
  const detail=await getJson(`/v13/deployments/${b.oldDeploymentId}?${query}`);
  if((detail.id||detail.uid)!==b.oldDeploymentId||detail.projectId!==b.provider.projectId||detail.readyState!=="READY"||detail.meta?.bbIdempotencyKey!==b.oldIdempotencyKey)throw new Error("Supersession old positive binding drift.");
  const inventory=await getJson(`/v6/deployments/${b.oldDeploymentId}/files?${query}`);
  const leaves=oldInventoryFiles(inventory);
  const configFile=leaves.find(x=>x.path==="vercel.json");if(!configFile)throw new Error("Supersession old config missing.");
  const config=await getJson(`/v8/deployments/${b.oldDeploymentId}/files/${configFile.uid}?${query}`);
  const aliasResponse=await guarded(`https://api.vercel.com/v4/aliases/${encodeURIComponent(new URL(b.origin).hostname)}?projectId=${encodeURIComponent(b.provider.projectId)}&${query}`,{method:"GET",headers:{authorization:`Bearer ${env.OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN}`}});
  if(![200,404].includes(aliasResponse.status))throw new Error("Supersession alias observation failed.");
  const alias={status:aliasResponse.status,body:aliasResponse.status===200?await aliasResponse.json():null};
  const publicReadback=[];
  for(const file of b.runtimeFiles){const path=file.path.slice(7);if(leaves.some(x=>x.path===`announcements/${jobId}/${path}`))throw new Error("Supersession runtime is not missing.");
   const response=await guarded(`https://${detail.url}/announcements/${jobId}/${path}`,{method:"GET"});
   const record={path,httpStatus:response.status,responseDigest:sha(Buffer.from(await response.arrayBuffer())),inventoryAbsent:true};
   if(response.status!==404)throw new Error("Supersession missing runtime readback drift.");publicReadback.push(record);
  }
  const digests={census:digest(pages),detail:digest(detail),inventory:digest(inventory),config:digest(config),alias:digest(alias),publicReadback:digest(publicReadback)};
  // Missing-file error bodies can contain a different request ID on every GET.
  // Preserve both exact body hashes; compare fresh absence facts, not error bytes.
  // Approved/public success bytes remain strictly verified by the real provider.
  const {publicReadback:historicalReadbackDigest,...signedDigests}=a.proof.evidenceDigests;
  const {publicReadback:freshReadbackDigest,...freshDigests}=digests;
  const absenceFacts=records=>records.map(({responseDigest,...facts})=>facts);
  if(historicalReadbackDigest!==digest(a.proof.missingRuntime)||!freshReadbackDigest
   ||json(freshDigests)!==json(signedDigests)||json(absenceFacts(publicReadback))!==json(absenceFacts(a.proof.missingRuntime)))throw new Error("Supersession signed observation changed.");
  const resolver=createOwnerTrialPublicArtifactResolver({policy:a.snapshot.policy,token,siteOrigin,fetch:guarded,revalidate:async()=>{await active();return a.snapshot.policy;}});
  const artifact=a.snapshot.originalAggregate.artifactSets.find(x=>x.kind==="narration_review"&&x.revisionId===b.revisionId);
  const request={jobId,environment:"test",product:"announcement-page",revisionId:b.revisionId,artifactSet:artifact,artifactSetId:artifact.artifactSetId,artifactManifestDigest:b.artifactManifestDigest,idempotencyKey:b.idempotencyKey,attemptStartedAt:claimed.lease.claimedAt,
   artifactReadAuthority:{workerId:identity.workerId,commandId:a.commandId,leaseToken:identity.leaseToken},fenceExternalEffect:async(_,invoke)=>{await mutate("fenceSupersession");return invoke();}};
  const scopedResolver={resolve:async req=>{
   const resolved=await resolver.resolve(req),inventory=resolved.files.map(f=>({path:f.publicPath,bytes:f.bytes.length,sha256:f.sha256}));
   if(json(inventory)!==json(a.proof.correctedPublicInventory))throw new Error("Supersession corrected source inventory drift.");
   for(const file of resolved.files)uploadBytes.add(sha(file.bytes));
   // Envelope bytes come only from the original provider using the signed build and exact file list.
   const base=`/announcements/${jobId}`,configuration=Buffer.from(`${JSON.stringify({redirects:[{source:base,destination:`${base}/${resolved.entrypointPath.slice(0,-10)}`,permanent:false}],headers:[{source:`${base}/(.*)`,headers:[{key:"cache-control",value:"private, no-store, max-age=0"}]}]},null,2)}\n`);
   const manifest=Buffer.from(`${JSON.stringify({schemaVersion:"1.0",jobId,revisionId:b.revisionId,artifactSetId:artifact.artifactSetId,artifactManifestDigest:b.artifactManifestDigest,idempotencyKey:b.idempotencyKey,completionBuild:{deploymentId:a.proof.buildInspection.deploymentId,buildId:a.proof.buildInspection.buildId},vercelConfiguration:{sha256:sha(configuration),bytes:configuration.length},files:inventory.map(({path,sha256,bytes})=>({path,sha256,bytes}))},null,2)}\n`);
   uploadBytes.add(sha(configuration));uploadBytes.add(sha(manifest));return resolved;
  }};
  const provider=createVercelTestAPublicationProvider({token:env.OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN,buildInspection:parseAuthoritativeVercelBuildInspection(Buffer.from(JSON.stringify(a.proof.buildInspection))),...b.provider,
   stableOrigin:b.origin,canaryJobId:jobId,canaryRevisionId:b.revisionId,artifactResolver:scopedResolver,fetch:guarded,requirePrivateDeploymentProtection:false,requireExistingAliasProject:alias.status===200,pollIntervalMs:options.pollIntervalMs??1000,maxPollAttempts:options.maxPollAttempts??30});
  const result=await provider.publish(request);
  await active();
  const completeTransportTraceDigest=digest(trace);
  const proof=await options.signSupersessionResult({authorization:a,result,trace,completeTransportTraceDigest});
  return await mutate("commitSupersession",{result,proof});
 }catch(error){try{await mutate("failSupersession");}catch{/* Drift/expired fence must not be repaired by failure bookkeeping. */}throw error;}
}
