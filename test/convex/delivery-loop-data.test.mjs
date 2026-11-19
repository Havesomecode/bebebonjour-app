import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import test, { mock } from 'node:test';
mock.timers.enable({ apis: ['setTimeout'] });
import { convexTest } from 'convex-test';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import schema from '../../convex/schema.js';
import { DAY } from '../../convex/deliveryLoopData.js';
import { narrate, sendEmail } from '../../convex/deliveryLoopProviders.js';
const ref = name => makeFunctionReference(`deliveryLoop:${name}`);
test('a Cloudflare admission without configuration cannot send', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected_network'); };
  try {
    const ctx = {
      runQuery: async () => ({ jobId: 'job_offline', intake: { baby: { firstName: 'Mila' }, customer: { email: 'test@example.invalid' } }, publicUrl: 'https://example.invalid', reviewUrl: 'https://example.invalid/review' }),
      runMutation: async fn => getFunctionName(fn).endsWith(':fence') ? { emailProvider: 'cloudflare' } : null,
    };
    await assert.rejects(sendEmail._handler(ctx, { workerToken, jobId: 'job_offline', leaseToken: 'offline-lease', revision: 1, stage: 'draft_email' }), /cloudflare_configuration_invalid/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
const dataRef = name => makeFunctionReference(`deliveryLoopData:${name}`);
const sha = s => createHash('sha256').update(s).digest('hex');
const workerToken='offline-data-worker-'+'w'.repeat(36), editorialToken='offline-data-editor-'+'e'.repeat(36), operatorToken='offline-data-operator-'+'o'.repeat(36);
const intake={email:'data-fixture@example.invalid',babyName:'FictionalBaby',gender:'girl',language:'fr',context:'general',voiceEnabled:true,consent:true,customerPermissions:true,termsAccepted:true,publication:true};
function fixture() {
  Object.assign(process.env,{BEBEBONJOUR_DELIVERY_LOOP_TOKEN:workerToken,BEBEBONJOUR_OPERATIONS_TOKEN:operatorToken,BEBEBONJOUR_DELIVERY_LOOP_ORIGIN:'https://offline.invalid',BEBEBONJOUR_PAID_EDITORIAL_TOKEN:editorialToken,BEBEBONJOUR_PAID_ROUTE_A_ENABLED:'true',BEBEBONJOUR_PAID_TERMS_URL:'https://offline.invalid/terms',BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID:'acct_offline',BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED:'true'});
  return convexTest(schema,{'../../convex/_generated/server.js':()=>import('convex/server'),'../../convex/deliveryLoop.js':()=>import('../../convex/deliveryLoop.js'),'../../convex/deliveryLoopNotices.js':()=>import('../../convex/deliveryLoopNotices.js'),'../../convex/deliveryLoopData.js':()=>import('../../convex/deliveryLoopData.js'),'../../convex/deliveryLoopDataProviders.js':()=>import('../../convex/deliveryLoopDataProviders.js'),'../../convex/http.js':()=>import('../../convex/http.js')});
}
const claim=t=>t.mutation(ref('claim'),{workerToken,workerId:'offline-data',leaseToken:crypto.randomUUID()});
const raw=(t,job)=>t.run(ctx=>ctx.db.query('deliveryLoopJobs').withIndex('by_job_id',q=>q.eq('jobId',job.jobId)).unique());
const patchData=(t,job,patch)=>t.run(async ctx=>{const row=await ctx.db.query('deliveryLoopJobs').withIndex('by_job_id',q=>q.eq('jobId',job.jobId)).unique();await ctx.db.patch(row._id,{data:{...row.data,...patch}});});
const submit=async (t,key=crypto.randomUUID())=>{const job=await t.mutation(ref('submit'),{idempotencyKey:key,orderMode:'paid_route_a',intake});await t.finishAllScheduledFunctions(()=>mock.timers.tick(0));return job;};
async function email(t, job) {
  const lease=await claim(t); const args={workerToken,jobId:job.jobId,revision:lease.revision,leaseToken:lease.leaseToken,stage:lease.stage};
  await t.mutation(ref('fence'),args);await t.mutation(ref('completeEmail'),{...args,providerMessageId:`offline_${lease.stage}`});
}
async function delivered(t) {
  const job=await submit(t);
  assert.equal((await raw(t,job)).status,'awaiting_operator');
  await t.mutation(ref('operatorLaunch'),{operatorToken,jobId:job.jobId,expectedRevision:1,brief:{firstName:'FictionalBaby',nameArabic:null,gender:'girl',birthDate:null,religion:'general',tone:'tendre',phrases:[]}});
  await t.finishAllScheduledFunctions(()=>mock.timers.tick(0));
  const launched=await raw(t,job); assert.equal(launched.status,'payment_pending');
  await t.mutation(ref('recordPaymentEvidence'),{jobId:job.jobId,revision:1,previewDigest:launched.data.briefs[0].briefDigest,providerAccountId:'acct_offline',providerPaymentId:'pi_offlinedata',amountMinor:3900,currency:'eur',livemode:true,settled:true});
  const lease=await claim(t); assert.equal(lease.stage,'generate');
  const contentHtml='<html lang="fr"><body><p>Bienvenue FictionalBaby.</p><p>Douceur.</p><p>Amour.</p></body></html>';
  const composition={languages:{fr:{introLines:['Bienvenue FictionalBaby.'],blessingLines:['Douceur.'],closingLines:['Amour.'],introNarration:'Bienvenue FictionalBaby.',blessingNarration:'Douceur.',closingNarration:'Amour.'}}};
  const p={contentHtml,contentDigest:sha(contentHtml),composition,compositionJson:JSON.stringify(composition),compositionReceipt:{provider:'openai-codex-subscription',outputDigest:sha(JSON.stringify(composition))}};
  const id={workerToken,jobId:job.jobId,revision:1,leaseToken:lease.leaseToken};const textDigest=sha('Bienvenue FictionalBaby.\n\nDouceur.\n\nAmour.');
  await t.mutation(ref('beginNarration'),{...id,language:'fr',textDigest});
  const bytes=new Uint8Array(160).fill(13); const storageId=await t.run(ctx=>ctx.storage.store(new Blob([bytes],{type:'audio/mpeg'})));
  await t.mutation(ref('recordNarration'),{...id,language:'fr',textDigest,storageId,provider:'openai',model:'offline-fixture',voice:'cedar',phraseStarts:[0,1,2]});
  await t.mutation(ref('publish'),{...id,...p,audioFiles:[{language:'fr',textDigest,storageId,phraseStarts:[0,1,2]}]});await email(t,job);
  await t.mutation(ref('requestReview'),{jobId:job.jobId,reviewToken:job.reviewToken,action:'approve',expectedRevision:1,idempotencyKey:crypto.randomUUID()});
  await email(t,job);
  return {job,storageId,bytes};
}
const capability=job=>({jobId:job.jobId,reviewToken:job.reviewToken});
const exportUrl=(job,kind)=>'/delivery/export?'+new URLSearchParams({jobId:job.jobId,token:job.reviewToken,kind});
const post=(t,path,value,token,origin)=>t.fetch(path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(origin?{origin}:{})},body:JSON.stringify(value)});
function unzipStored(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), files={};let at=0;
  while(view.getUint32(at,true)===0x04034b50){const size=view.getUint32(at+18,true), nameLength=view.getUint16(at+26,true), extra=view.getUint16(at+28,true);const name=new TextDecoder().decode(bytes.slice(at+30,at+30+nameLength));const start=at+30+nameLength+extra;files[name]=bytes.slice(start,start+size);at=start+size;}
  assert.equal(view.getUint32(at,true),0x02014b50);return files;
}

test('actual paid exports download exact text, audio and standalone ZIP; wrong/customer-public/worker capabilities denied',async()=>{
  const t=fixture();const {job,bytes}=await delivered(t);const row=await raw(t,job);
  const text=await t.fetch(exportUrl(job,'text'));assert.equal(text.status,200);assert.equal(await text.text(),'Bienvenue FictionalBaby.\n\nDouceur.\n\nAmour.');assert.equal(text.headers.get('cache-control'),'private, no-store');assert.match(text.headers.get('content-disposition'),/attachment/);
  const audio=await t.fetch(exportUrl(job,'audio'));assert.deepEqual(new Uint8Array(await audio.arrayBuffer()),bytes);
  const zip=await t.fetch(exportUrl(job,'page'));const zipBytes=new Uint8Array(await zip.arrayBuffer());const archive=unzipStored(zipBytes);assert.deepEqual(Object.keys(archive),['annonce.html','texte.txt','audio-fr.mp3']);assert.deepEqual(archive['audio-fr.mp3'],bytes);assert.match(new TextDecoder().decode(archive['annonce.html']),/src="audio-fr.mp3"/);
  for(const token of ['wrong',row.publicToken,workerToken]) assert.equal((await t.fetch(exportUrl({...job,reviewToken:token},'page'))).status,404);
  assert.equal((await post(t,'/delivery/data/operator',{jobId:job.jobId,action:'inspect'},workerToken)).status,403);
  const inspect=await post(t,'/delivery/data/operator',{jobId:job.jobId,action:'inspect'},editorialToken);assert.equal(inspect.status,200);assert.doesNotMatch(await inspect.text(),/FictionalBaby|data-fixture@example.invalid|reviewToken/);
});
test('unpaid request has no exports; revocation closes public text/audio immediately but keeps private exports',async()=>{
  const t=fixture();const unpaid=await submit(t);assert.equal((await t.fetch(exportUrl(unpaid,'text'))).status,404);
  const t2=fixture();const {job}=await delivered(t2);const row=await raw(t2,job);
  assert.equal((await post(t2,'/delivery/data',{jobId:job.jobId,token:'wrong',action:'revoke'})).status,403);
  assert.equal((await post(t2,'/delivery/data',{jobId:job.jobId,token:job.reviewToken,action:'revoke'},null,'https://attacker.invalid')).status,403);
  await t2.mutation(dataRef('customerControl'),{...capability(job),action:'revoke'});
  assert.equal(await t2.query(ref('publicPage'),{publicToken:row.publicToken}),null);assert.equal(await t2.query(ref('publicAudio'),{publicToken:row.publicToken,revision:1,language:'fr'}),null);
  assert.equal((await t2.fetch(exportUrl(job,'page'))).status,200);assert.equal(await claim(t2),null);
});
for (const admissionProvider of ['cloudflare', undefined]) test(`deletion retains each receipt and ${admissionProvider || 'unknown'} admission provider`,async()=>{
  const t=fixture();const {job}=await delivered(t);const row=await raw(t,job);
  const [first,second]=row.data.emailReceipts;
  const legacy={...first};delete legacy.provider;
  const cloudflare={...second,provider:'cloudflare',providerMessageId:'<opaque+receipt@example.invalid>'};
  await patchData(t,job,{emailReceipts:[legacy,cloudflare],lease:{stage:'final_email',effectStartedAtMs:123,emailIdempotencyKey:'offline-uncertain',...(admissionProvider ? {emailProvider:admissionProvider} : {})},desiredRevision:1});
  await t.mutation(dataRef('customerControl'),{...capability(job),action:'delete'});
  const evidence=(await t.query(dataRef('inspect'),{editorialToken,jobId:job.jobId})).retainedEvidence;
  assert.deepEqual(evidence.emailReceipts.map(({provider,providerMessageId})=>({provider,providerMessageId})),[{provider:null,providerMessageId:legacy.providerMessageId},{provider:'cloudflare',providerMessageId:cloudflare.providerMessageId}]);
  assert.equal(evidence.uncertainEffect.emailProvider,admissionProvider || null);
  assert.doesNotMatch(JSON.stringify(evidence),/FictionalBaby|data-fixture@example.invalid|reviewToken/);
});

test('confirmed deletion erases content and storage, invalidates all reads/effects and keeps allowlisted financial evidence separately',async()=>{
  const t=fixture();const {job,storageId}=await delivered(t);const row=await raw(t,job);
  const payload={jobId:job.jobId,token:job.reviewToken,action:'delete'};
  assert.equal((await post(t,'/delivery/data',payload)).status,400);assert.ok(await t.run(async ctx=>Boolean(await ctx.storage.get(storageId))));
  assert.equal((await post(t,'/delivery/data',{...payload,confirmDeletion:true})).status,200);
  assert.equal(await t.run(ctx=>ctx.storage.get(storageId)),null);assert.equal((await raw(t,job)).status,'data_deleted');assert.doesNotMatch(JSON.stringify(await raw(t,job)),/FictionalBaby|data-fixture@example.invalid|reviewToken/);
  assert.equal(await t.query(ref('publicPage'),{publicToken:row.publicToken}),null);assert.equal((await t.fetch(exportUrl(job,'text'))).status,404);assert.equal(await claim(t),null);
  await assert.rejects(t.query(ref('read'),{workerToken,jobId:job.jobId}),/data_deleted/);
  const evidence=await t.query(dataRef('inspect'),{editorialToken,jobId:job.jobId});assert.equal(evidence.retainedEvidence.payment.providerPaymentId,'pi_offlinedata');assert.doesNotMatch(JSON.stringify(evidence),/FictionalBaby|data-fixture@example.invalid|reviewToken|storageId/);
});
test('hourly sweep honors 7/30-day boundaries, purges working content but preserves hosted final and leaves complimentary untouched',async()=>{
  const t=fixture();const job=await submit(t);const created=Date.now()-7*DAY+2000;await patchData(t,job,{createdAtMs:created,lastActivityAtMs:created});await t.mutation(dataRef('sweep'),{});assert.notEqual((await raw(t,job)).status,'data_deleted');await patchData(t,job,{createdAtMs:Date.now()-7*DAY,lastActivityAtMs:Date.now()-7*DAY});await t.mutation(dataRef('sweep'),{});assert.equal((await raw(t,job)).status,'data_deleted');
  const t2=fixture();const {job:final,storageId}=await delivered(t2);const before=await raw(t2,final);
  await patchData(t2,final,{deliveredAtMs:Date.now()-30*DAY+2000});await t2.mutation(dataRef('sweep'),{});assert.equal((await raw(t2,final)).data.workingPurgedAtMs,undefined);
  await patchData(t2,final,{deliveredAtMs:Date.now()-30*DAY,feedback:'PRIVATE WORKING NOTE'});await t2.mutation(dataRef('sweep'),{});const after=await raw(t2,final);assert.deepEqual(after.data.revisions.map(r=>r.revision),[after.data.approvedRevision]);assert.equal(after.data.feedback,null);assert.ok(after.data.workingPurgedAtMs);assert.ok(await t2.run(async ctx=>Boolean(await ctx.storage.get(storageId))));assert.ok(await t2.query(ref('publicPage'),{publicToken:before.publicToken}));assert.equal((await t2.fetch(exportUrl(final,'page'))).status,200);
  const legacy=await t2.run(ctx=>ctx.db.insert('deliveryLoopJobs',{jobId:'job_legacy',publicToken:'legacy_public',idempotencyKey:'legacy_key',status:'old',data:{createdAtMs:1}}));const original=await t2.run(ctx=>ctx.db.get(legacy));await t2.mutation(dataRef('sweep'),{});assert.deepEqual(await t2.run(ctx=>ctx.db.get(legacy)),original);
});
test('calendar hosting expiry closes text/audio and deletes storage; cancellation is retained only 30 days; tombstones block replay',async()=>{
  const t=fixture();const {job,storageId}=await delivered(t);const row=await raw(t,job);await patchData(t,job,{hostingEndsAtMs:Date.now()-1});
  assert.equal(await t.query(ref('publicPage'),{publicToken:row.publicToken}),null);assert.equal((await t.fetch(exportUrl(job,'page'))).status,404);await t.mutation(dataRef('sweep'),{});assert.equal(await t.run(ctx=>ctx.storage.get(storageId)),null);assert.equal((await raw(t,job)).data.reason,'hosting_ended');
  const t2=fixture();const key='abandoned-idempotency';const cancelled=await submit(t2,key);await patchData(t2,cancelled,{cancelledAtMs:Date.now()-30*DAY+2000});await t2.mutation(dataRef('sweep'),{});assert.notEqual((await raw(t2,cancelled)).status,'data_deleted');await patchData(t2,cancelled,{cancelledAtMs:Date.now()-30*DAY});await t2.mutation(dataRef('sweep'),{});assert.equal((await raw(t2,cancelled)).data.reason,'cancelled_retention');await assert.rejects(t2.mutation(ref('submit'),{idempotencyKey:key,orderMode:'paid_route_a',intake}),/data_deleted/);
});
test('Cloudflare closure uses its own durable admission and records provider identity', async()=>{
  const t=fixture(); const {job}=await delivered(t); await patchData(t,job,{hostingEndsAtMs:Date.now()+30*DAY-1000});
  const original=globalThis.fetch; const names=['BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER','BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID','BEBEBONJOUR_CLOUDFLARE_ZONE_ID','BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN','BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN']; const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  delete process.env.BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN;
  Object.assign(process.env,{BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER:'cloudflare',BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),BEBEBONJOUR_CLOUDFLARE_ZONE_ID:'b'.repeat(32),BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN:'synthetic-send-token'});
  let calls=0; globalThis.fetch=async(url,opts)=>{calls++;assert.match(url,/api\.cloudflare\.com/);const body=JSON.parse(opts.body);assert.match(body.headers['X-Bebe-Operation'],/:closure_notice$/);return Response.json({success:true,errors:[],result:{message_id:'<notice@example.invalid>',queued:[body.to],delivered:[],permanent_bounces:[]}});};
  try { await t.mutation(dataRef('sweep'),{});await t.finishAllScheduledFunctions(()=>mock.timers.tick(0));const notice=(await raw(t,job)).data.closureNotice;assert.equal(calls,1);assert.equal(notice.status,'sent');assert.equal(notice.provider,'cloudflare');assert.equal(notice.providerMessageId,'<notice@example.invalid>');await t.action(makeFunctionReference('deliveryLoopDataProviders:sendClosureNotice'),{jobId:job.jobId});assert.equal(calls,1); }
  finally {globalThis.fetch=original;for(const k of names)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
});
test('uncertain closure transport remains fenced against another send', async()=>{
  const t=fixture(); const {job}=await delivered(t); await patchData(t,job,{hostingEndsAtMs:Date.now()+30*DAY-1000});
  const names=['BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER','BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID','BEBEBONJOUR_CLOUDFLARE_ZONE_ID','BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN']; const saved=Object.fromEntries(names.map(k=>[k,process.env[k]])); const original=globalThis.fetch; let calls=0;
  Object.assign(process.env,{BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER:'cloudflare',BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),BEBEBONJOUR_CLOUDFLARE_ZONE_ID:'b'.repeat(32),BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN:'synthetic-send-token'});
  globalThis.fetch=async()=>{calls++;throw new Error('offline_timeout');};
  try { await t.mutation(dataRef('sweep'),{}); await t.finishAllScheduledFunctions(()=>mock.timers.tick(0)); assert.equal((await raw(t,job)).data.closureNotice.status,'reconciliation_required'); await t.action(makeFunctionReference('deliveryLoopDataProviders:sendClosureNotice'),{jobId:job.jobId}); assert.equal(calls,1); }
  finally {globalThis.fetch=original;for(const k of names)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
});
test('hourly pagination schedules continuation past ten legacy records; privacy UI and operator scripts compile',async()=>{
  const t=fixture();for(let i=0;i<11;i++)await t.run(ctx=>ctx.db.insert('deliveryLoopJobs',{jobId:`legacy_${i}`,publicToken:`public_${i}`,idempotencyKey:`key_${i}`,status:'old',data:{createdAtMs:1}}));const job=await submit(t);await patchData(t,job,{createdAtMs:Date.now()-8*DAY,lastActivityAtMs:Date.now()-8*DAY});const result=await t.mutation(dataRef('sweep'),{});assert.equal(result.done,false);await t.finishAllScheduledFunctions(()=>mock.timers.tick(0));assert.equal((await raw(t,job)).status,'data_deleted');
  const t2=fixture();const {job:final}=await delivered(t2);for(const url of [new URL(final.reviewUrl).pathname+new URL(final.reviewUrl).search,'/delivery/data/operator']){const html=await (await t2.fetch(url)).text();for(const [,script]of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Script(script));assert.match(html,/Supprimer|supprimer/);}
  const crons=readFileSync(new URL('../../convex/crons.js',import.meta.url),'utf8');assert.match(crons,/hours: 1/);assert.match(crons,/deliveryLoopData:sweep/);
});
test('late narration recording denial removes only the action-owned new blob',async()=>{
  const original=globalThis.fetch;const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='offline-not-real';
  const deleted=[];const bytes=Buffer.alloc(384);bytes.set([0xff,0xf3,0xc4,0xc4]);
  globalThis.fetch=async url=>{assert.equal(url,'https://api.openai.com/v1/audio/speech');return new Response(bytes);};
  try {
    const ctx={runQuery:async()=>({orderMode:'paid_route_a',intake:{languages:['fr']},narrationReceipts:[]}),runMutation:async fn=>{if(getFunctionName(fn).endsWith(':recordNarration'))throw new Error('data_deleted');},storage:{store:async()=> 'new_action_owned_blob',delete:async id=>deleted.push(id)}};
    await assert.rejects(narrate._handler(ctx,{workerToken,jobId:'job_offline',leaseToken:'offline-lease',revision:1,language:'fr',text:'Bienvenue.',textDigest:sha('Bienvenue.')}),/data_deleted/);
    assert.deepEqual(deleted,['new_action_owned_blob']);
  }finally{globalThis.fetch=original;if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
});
