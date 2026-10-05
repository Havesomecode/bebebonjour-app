import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { createOwnerTrialPublicArtifactResolver } from "../fulfillment/owner-trial-completion-capabilities.mjs";
import { createVercelTestAPublicationProvider, parseAuthoritativeVercelBuildInspection } from "../fulfillment/vercel-test-a-publication-provider.mjs";
// Separate bounded reconciliation lease; never broaden ordinary completion scopes.
export async function runOwnerTrialPresentReconciliation(options) {
 const env=options.environment||process.env, token=env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN;
 const client=options.client||new ConvexHttpClient(env.CONVEX_URL);
 if(typeof options.signPresentResult!=="function" || !/^job_owner_trial_[a-f0-9]{32}$/u.test(env.OWNER_TRIAL_JOB_ID||"")
  || (options.jobId!==undefined&&options.jobId!==env.OWNER_TRIAL_JOB_ID))throw new Error("PRESENT trusted result signer and exact job required");
 const identity={completionToken:token,jobId:env.OWNER_TRIAL_JOB_ID,workerId:"owner-trial-completion-worker",leaseToken:randomUUID()};
 const mutate=(name,args)=>client.mutation(`ownerTrialPublicationPresent:${name}`,{...identity,...args});
 const claimed=await mutate("claimReconciliation",{}), a=claimed.authorization;
 const authority={workerId:identity.workerId,commandId:a.commandId,leaseToken:identity.leaseToken};
 const revalidate=()=>client.query("ownerTrial:completionPolicy",{completionToken:token,jobId:a.jobId});
 const baseFetch=options.fetch||fetch; let aliases=0, pinnedCensus=false;
 const guardedFetch=async(input,init={})=>{
  const url=new URL(input),method=init.method||"GET";
  if(method!=="GET") {
   if(url.origin!=="https://api.vercel.com"||method!=="POST"||url.pathname!==`/v2/deployments/${a.deploymentId}/aliases`
    ||url.searchParams.size!==1||url.searchParams.get("teamId")!==a.provider.teamId||JSON.stringify(JSON.parse(init.body))!==JSON.stringify({alias:new URL(a.policy.origin).hostname})
    ||!pinnedCensus||aliases++!==0)throw new Error("PRESENT transport mutation forbidden");
  }
  await mutate("fenceReconciliation",{});
  const response=await baseFetch(input,init);
  if(url.origin==="https://api.vercel.com"&&url.pathname==="/v7/deployments") {
   const census=await response.clone().json(), matches=census.deployments?.filter(d=>(d.uid||d.id)===a.deploymentId);
   if(!response.ok||!Array.isArray(matches)||matches.length!==1||census.pagination?.next!==null)throw new Error("PRESENT exact complete census required");
   pinnedCensus=true;
  }
  return response;
 };
 const resolver=createOwnerTrialPublicArtifactResolver({policy:a.policy,token,siteOrigin:new URL(env.CONVEX_SITE_URL||env.CONVEX_URL.replace(/\.cloud$/u,".site")).origin,fetch:guardedFetch,revalidate});
 const provider=createVercelTestAPublicationProvider({token:env.OWNER_TRIAL_PUBLICATION_VERCEL_TOKEN,
  buildInspection:parseAuthoritativeVercelBuildInspection(Buffer.from(env.OWNER_TRIAL_PUBLICATION_BUILD_INSPECTION_JSON||"{}")),
  ...a.provider,stableOrigin:a.policy.origin,canaryJobId:a.jobId,canaryRevisionId:a.policy.revisionId,
  artifactResolver:resolver,fetch:guardedFetch,pollIntervalMs:0,maxPollAttempts:1});
 const original=a.originalAggregate,attempt=original.stageAttempts.at(-1), artifact=original.artifactSets.find(x=>x.kind==="narration_review"&&x.revisionId===a.policy.revisionId);
 // Present observation window is genuine and independent from immutable old attempt times.
 const result=await provider.reconcile({jobId:a.jobId,environment:original.environment,product:original.product,
  revisionId:a.policy.revisionId,artifactSet:artifact,artifactSetId:artifact.artifactSetId,artifactManifestDigest:a.policy.manifestDigest,
  idempotencyKey:attempt.idempotencyKey,reconciliationOnly:true,attemptStartedAt:new Date().toISOString(),
  originalAttemptStartedAt:attempt.startedAt,artifactReadAuthority:authority,
  fenceExternalEffect:async(_fence,invoke)=>{await mutate("fenceReconciliation",{});return invoke();}});
 if(!result||result.providerReceiptId!==a.deploymentId)throw new Error("PRESENT exact reconciliation result required; no publication fallback");
 // The separate recovery role signs only after the real strict provider verifier succeeds.
 const proof=await options.signPresentResult({authorization:a,result});
 return mutate("commitReconciliation",{result,proof});
}
