import {isOwnerTrialJob} from '../fulfillment/owner-trial-authority.mjs';
import {isPrivateGenerationJob} from '../fulfillment/private-generation-authority.mjs';
const specialToken=args=>[process.env.BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN,process.env.BEBEBONJOUR_TTS_WORKER_TOKEN].some(t=>typeof t==='string'&&t.length>0&&t===args.workerToken);
const prefix=id=>/^job_owner_trial_/u.test(id||'');
async function trialJob(context,jobId){
 if(prefix(jobId))return true;
 if(!jobId||!context.db)return false;
 const customer=await context.db.query('customerFlowJobs').withIndex('by_job_id',q=>q.eq('jobId',jobId)).unique();
 const fulfillment=await context.db.query('fulfillmentJobs').withIndex('by_job_id',q=>q.eq('jobId',jobId)).unique();
 return isOwnerTrialJob(customer?.job,fulfillment?.aggregate)||isPrivateGenerationJob(customer?.job,fulfillment?.aggregate);
}
export async function selectTrial(context,args){
 if(specialToken(args)||prefix(args.jobId)||prefix(args.aggregate?.jobId))return true;
 let jobId=args.jobId||args.aggregate?.jobId;
 if(!jobId&&args.commandId&&context.db){
  const cmd=await context.db.query('customerFlowOperationsCommands').withIndex('by_command_id',q=>q.eq('commandId',args.commandId)).unique();jobId=cmd?.jobId;
 }
 return trialJob(context,jobId);
}
function partitionContext(context,wantTrial){
 const cache=new Map();
 const selected=async doc=>{
  if(!doc)return false;
  if(!cache.has(doc.jobId))cache.set(doc.jobId,trialJob(context,doc.jobId));
  return (await cache.get(doc.jobId))===wantTrial;
 };
 function queryProxy(query){return new Proxy(query,{get(target,key){
  const value=target[key];if(typeof value!=='function')return value;
  return (...args)=>{
   if(key==='take'||key==='first'){
    const limit=key==='first'?1:args[0];
    // Preserve SDK validation; count matching rows, not rows in the other partition.
    if(!Number.isInteger(limit)||limit<0)return value.apply(target,args);
    return (async()=>{
     const keep=[];
     if(limit>0)for await(const row of target){
      if(await selected(row)){keep.push(row);if(keep.length===limit)break;}
     }
     return key==='first'?(keep[0]??null):keep;
    })();
   }
   const result=value.apply(target,args);
   if(['collect','paginate'].includes(key))return Promise.resolve(result).then(async data=>{
    const rows=key==='paginate'?data.page:data;const keep=[];for(const row of rows)if(await selected(row))keep.push(row);
    return key==='paginate'?{...data,page:keep}:keep;
   });
   if(key==='unique')return Promise.resolve(result).then(async doc=>(await selected(doc))?doc:null);
   return result&&typeof result==='object'?queryProxy(result):result;
  };
 }});}
 const db=new Proxy(context.db,{get(target,key){
  if(key==='query')return table=>table==='customerFlowOperationsCommands'?queryProxy(target.query(table)):target.query(table);
  const value=target[key];return typeof value==='function'?value.bind(target):value;
 }});
 return {...context,db};
}
export function coexistDefinition(approved,live,name,module){
 if(!live)return approved;
 return {...approved,handler:async(context,args)=>{
  if(await selectTrial(context,args))return approved.handler(context,args);
  if(module==='operations'&&name==='claimCommands'&&args.jobId===undefined&&context.db){
   // Partition unscoped claims: current handlers cannot acquire trial commands.
   // No trial candidates means the exact current handler runs without a proxy.
   let hasTrial=false;for await(const command of context.db.query('customerFlowOperationsCommands'))if(await trialJob(context,command.jobId)){hasTrial=true;break;}
   if(hasTrial){
    const trial=await approved.handler(partitionContext(context,true),args);
    if(trial.length>=args.limit)return trial;
    return [...trial,...await live._handler(partitionContext(context,false),{...args,limit:args.limit-trial.length})];
   }
  }
  // workerHealth's additive optional trial job selector is not part of the live ABI.
  const currentArgs=module==='operations'&&name==='workerHealth'?{workerToken:args.workerToken}:args;
  return live._handler(context,currentArgs);
 }};
}
