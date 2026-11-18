import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../convex/schema.js';
import { inspectPaidPayment } from '../../src/delivery-loop/paid-payment.mjs';
import { PAID_MODE, TERMS_VERSION, paidEligible } from '../../convex/deliveryLoopPaidPolicy.js';
import { createDeliveryLoopWorker } from '../../src/delivery-loop/worker.mjs';
import { buildCodexCompositionRequest } from '../../scripts/lib/codex-subscription-composition.mjs';

const workerToken = 'offline-worker-secret-with-more-than-32-characters';
const editorialToken = 'offline-human-editor-secret-with-more-than-32-characters';
const sha = s => createHash('sha256').update(s).digest('hex');
const ref = name => makeFunctionReference(`deliveryLoop:${name}`);
const intake = { email:'fictional@example.invalid', babyName:'Amal', language:'fr', gender:'girl', context:'general', voiceEnabled:true, consent:true, customerPermissions:true, fictional:true };
function fixture() {
  process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN = workerToken;
  process.env.BEBEBONJOUR_PAID_EDITORIAL_TOKEN = editorialToken;
  process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED = 'true';
  process.env.BEBEBONJOUR_PAID_TERMS_URL = 'https://offline.example.invalid/terms';
  process.env.BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID = 'acct_offline';
  process.env.CONVEX_SITE_URL = 'https://offline.convex.site';
  return convexTest(schema, {
    './_generated/server.js': () => import('convex/server'),
    './deliveryLoop.js': () => import('../../convex/deliveryLoop.js'),
    './deliveryLoopHttp.js': () => import('../../convex/deliveryLoopHttp.js'),
    './deliveryLoopData.js': () => import('../../convex/deliveryLoopData.js'),
    './deliveryLoopProviders.js': () => import('../../convex/deliveryLoopProviders.js'),
    './http.js': () => import('../../convex/http.js'),
    './narrationHttp.js': () => import('../../convex/narrationHttp.js'),
  });
}
const submit = (t, fields={}) => t.mutation(ref('submit'), { intake, orderMode:PAID_MODE, previewConsent:true, idempotencyKey:crypto.randomUUID(), ...fields });
const read = (t, job) => t.query(ref('read'), { workerToken, jobId:job.jobId });
const claim = t => t.mutation(ref('claim'), { workerToken, workerId:'offline', leaseToken:crypto.randomUUID() });
const decision = (t, job, revision, action='approve', more={}) => t.mutation(ref('requestReview'), { jobId:job.jobId, reviewToken:job.reviewToken, expectedRevision:revision, action, idempotencyKey:crypto.randomUUID(), ...more });
const permissions = (t, job, revision, more={}) => t.mutation(ref('paidPermissions'), { jobId:job.jobId, reviewToken:job.reviewToken, expectedRevision:revision, termsVersion:TERMS_VERSION, termsAccepted:true, publication:true, ...more });
const editorial = (t, job, preview, more={}) => t.mutation(ref('paidEditorial'), { editorialToken, jobId:job.jobId, expectedRevision:preview.revision, previewDigest:preview.contentDigest, reviewerId:'offline-human-fixture', humanReviewed:true, ...more });
const payment = (t, job, preview, more={}) => t.mutation(ref('recordPaymentEvidence'), { jobId:job.jobId, revision:preview.revision, previewDigest:preview.contentDigest, providerPaymentId:'pi_offline', amountMinor:3900, currency:'eur', livemode:true, settled:true, providerAccountId:'acct_offline', ...more });
async function email(t, job) {
  const lease = await claim(t);
  await t.mutation(ref('fence'), { workerToken, jobId:job.jobId, leaseToken:lease.leaseToken, revision:lease.revision, stage:lease.stage });
  await t.mutation(ref('completeEmail'), { workerToken, jobId:job.jobId, leaseToken:lease.leaseToken, revision:lease.revision, stage:lease.stage, provider:'cloudflare', providerMessageId:`offline_${crypto.randomUUID()}` });
  return lease;
}
async function preview(t, job) {
  const lease = await claim(t);
  const contentHtml = `<html><body><h1>Aperçu privé ${lease.revision}</h1></body></html>`;
  const composition = { schemaVersion:'1.0', languages:{ fr:{ description:'Un bonheur.', introLines:['Bienvenue.'], introNarration:'Bienvenue.', blessingLines:['Des jours doux.'], blessingNarration:'Des jours doux.', closingLines:['Notre amour.'], closingNarration:'Notre amour.' } } };
  const contentDigest = sha(contentHtml);
  await t.mutation(ref('publish'), { workerToken, jobId:job.jobId, leaseToken:lease.leaseToken, revision:lease.revision, contentHtml, contentDigest, composition, compositionJson:JSON.stringify(composition), compositionReceipt:{ provider:'openai-codex-subscription', outputDigest:sha(JSON.stringify(composition)) }, audioFiles:[] });
  assert.equal((await read(t, job)).previewExpiresAtMs, null, 'window has not started before availability notice');
  await email(t, job);
  return (await read(t, job)).revisions.at(-1);
}
async function ready(t, fields={}) {
  const job = await submit(t, fields);
  const p = await preview(t, job);
  await decision(t, job, p.revision);
  await permissions(t, job, p.revision);
  return { job, p };
}
async function patchData(t, job, patch, status) {
  await t.run(async ctx => {
    const row = await ctx.db.query('deliveryLoopJobs').withIndex('by_job_id', q=>q.eq('jobId',job.jobId)).unique();
    await ctx.db.patch(row._id, { data:{ ...row.data, ...patch }, ...(status ? { status } : {}) });
  });
}

test('paid mode is disabled by default, separate from waiver and requires preview/parent permissions', async()=>{
  const t=fixture(); delete process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED;
  await assert.rejects(submit(t), /paid_route_unavailable/);
  assert.equal((await t.fetch('/delivery?mode=paid_route_a')).status, 400);
  process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED='true';
  for(const fields of [{ previewConsent:false }, { magicPassword:'not-a-waiver' }, { intake:{ ...intake, voiceEnabled:false } }, { intake:{ ...intake, customerPermissions:false } }, { intake:{ ...intake, context:'islam' } }]) await assert.rejects(submit(t,fields));
  const job=await submit(t);
  assert.equal(job.publicUrl,null); assert.equal((await read(t,job)).payment.status,'pending');
});
test('private unpaid preview has no public text or audio, human simulation is not customer approval', async()=>{
  const t=fixture(); const job=await submit(t); const p=await preview(t,job); const row=await read(t,job);
  assert.equal(await t.query(ref('publicPage'),{publicToken:row.publicToken}),null);
  assert.equal(await t.query(ref('publicAudio'),{publicToken:row.publicToken,revision:1,language:'fr'}),null);
  assert.equal((await t.query(ref('preview'),{jobId:job.jobId,reviewToken:job.reviewToken,expectedRevision:1})).contentHtml,p.contentHtml);
  await assert.rejects(t.query(ref('preview'),{jobId:job.jobId,reviewToken:'wrong',expectedRevision:1}), /forbidden/);
  await assert.rejects(decision(t,job,1,'approve',{workerToken,reviewToken:undefined,actor:'simulated_human'}), /customer_decision_required/);
  await assert.rejects(decision(t,job,1,'approve',{workerToken,actor:'customer'}), /customer_decision_required/);
  await assert.rejects(permissions(t,job,1), /content_approval_required/);
  await decision(t,job,1);
  assert.equal((await read(t,job)).status,'payment_pending');
  await assert.rejects(permissions(t,job,1,{publication:false}), /paid_permissions_required/);
  await assert.rejects(permissions(t,job,1,{termsVersion:'wrong'}), /paid_permissions_required/);
  await permissions(t,job,1);
  assert.equal(await claim(t),null);
});
test('payment evidence rejects wrong amount, currency, revision, digest, account and unpaid claims', async()=>{
  const t=fixture();const {job,p}=await ready(t);
  for(const fields of [{amountMinor:3800},{currency:'usd'},{revision:2},{previewDigest:'a'.repeat(64)},{providerAccountId:'acct_wrong'},{settled:false},{providerPaymentId:'waived'}]) await assert.rejects(payment(t,job,p,fields));
  await payment(t,job,p,{livemode:false});
  assert.equal((await read(t,job)).payment.status,'test_only');
  await editorial(t,job,p); assert.equal(await claim(t),null);
  await payment(t,job,p,{providerPaymentId:'pi_liveoffline'});
  assert.equal((await claim(t)).stage,'finalize');
});
test('settlement deduplicates globally, cannot approve editorial review and locks corrections', async()=>{
  const t=fixture();const {job,p}=await ready(t);
  await payment(t,job,p); await payment(t,job,p);
  assert.equal((await read(t,job)).audit.filter(e=>e.type==='stripe_payment_verified').length,1);
  assert.equal(await claim(t),null,'payment alone cannot generate final narration');
  await assert.rejects(editorial(t,job,p,{editorialToken:workerToken}),/forbidden/);
  await assert.rejects(editorial(t,job,p,{humanReviewed:false}),/editorial_approval_required/);
  await assert.rejects(decision(t,job,1,'request_changes',{feedback:'Change the closing.'}),/review_not_available|paid_preview_locked/);
  const other=await ready(t,{intake:{...intake,email:'other@example.invalid'}});
  await assert.rejects(payment(t,other.job,other.p),/payment_evidence_conflict/);
  await editorial(t,job,p); assert.equal((await read(t,job)).status,'finalize_queued');
});
test('corrected preview gets a fresh notice window, stale approval is denied and only two corrections are included', async()=>{
  const t=fixture();const job=await submit(t); let p=await preview(t,job);
  await editorial(t,job,p);
  for(let revision=1;revision<=2;revision++) {
    await decision(t,job,revision,'request_changes',{feedback:'A warmer closing.'});
    await assert.rejects(decision(t,job,revision),/stale_revision/);
    assert.equal((await read(t,job)).editorialApproval,null);
    p=await preview(t,job);
    assert.equal(p.revision,revision+1);
    assert.ok((await read(t,job)).previewExpiresAtMs>Date.now());
  }
  await assert.rejects(decision(t,job,3,'request_changes',{feedback:'Third correction'}),/correction_limit/);
  await decision(t,job,3);
  await assert.rejects(permissions(t,job,2),/stale_revision/);
});
test('expiry/silence is not consent; one manual renewal, cancellation and failure remain fail-closed', async()=>{
  const t=fixture();const job=await submit(t);await preview(t,job);
  await patchData(t,job,{previewExpiresAtMs:Date.now()-1});
  await assert.rejects(decision(t,job,1),/preview_expired/);
  const control={editorialToken,jobId:job.jobId,expectedRevision:1};
  await t.mutation(ref('paidControl'),{...control,action:'renew_preview'});
  await assert.rejects(t.mutation(ref('paidControl'),{...control,action:'renew_preview'}),/preview_renewal_unavailable/);
  await t.mutation(ref('paidControl'),{...control,action:'cancel'});
  await assert.rejects(decision(t,job,1),/review_not_available|order_cancelled/);
  assert.equal((await read(t,job)).payment.status,'pending');
  assert.equal(await claim(t),null);
});
test('paid eligibility is rechecked after claim and cancellation; synthetic waiver cannot authorize effects',async()=>{
  const t=fixture();const {job,p}=await ready(t);await payment(t,job,p);await editorial(t,job,p);
  const lease=await claim(t); const row=await read(t,job);
  for(const patch of [{payment:{status:'waived'}},{editorialApproval:null},{paidApproval:{revision:0}},{paidPermissions:null},{desiredRevision:2}]) {
    const changed={...row,data:{...row,...patch}}; assert.throws(()=>paidEligible(changed));
  }
  await patchData(t,job,{editorialApproval:null});
  await assert.rejects(t.query(ref('authorizeProvider'),{workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,revision:1,stage:'finalize'}),/editorial_approval_required/);
  await assert.rejects(t.mutation(ref('publish'),{workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,revision:1,contentHtml:p.contentHtml,contentDigest:p.contentDigest,composition:p.composition,compositionReceipt:p.compositionReceipt,audioFiles:[]}),/editorial_approval_required/);
});
test('offline paid-mode success binds narration to approved text, publishes exact preview and deduplicates final notification',async()=>{
  const t=fixture();const {job,p}=await ready(t);await editorial(t,job,p);await payment(t,job,p);const lease=await claim(t);
  const id={workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,revision:1};

  const digest=sha(['Bienvenue.','Des jours doux.','Notre amour.'].join('\n\n'));
  await assert.rejects(t.mutation(ref('beginNarration'),{...id,language:'fr',textDigest:'a'.repeat(64)}),/approved_content_mismatch/);
  await t.mutation(ref('beginNarration'),{...id,language:'fr',textDigest:digest});
  await assert.rejects(t.mutation(ref('beginNarration'),{...id,language:'fr',textDigest:digest}),/narration_reconciliation_required/);
  const storageId=await t.run(ctx=>ctx.storage.store(new Blob([new Uint8Array(160).fill(12)],{type:'audio/mpeg'})));
  await t.mutation(ref('recordNarration'),{...id,language:'fr',textDigest:digest,storageId,provider:'openai',model:'offline-fixture',voice:'cedar'});
  const args={...id,contentHtml:p.contentHtml,contentDigest:p.contentDigest,composition:p.composition,compositionJson:p.compositionJson,compositionReceipt:p.compositionReceipt,audioFiles:[{language:'fr',textDigest:digest,storageId}]};
  await assert.rejects(t.mutation(ref('publish'),{...args,contentHtml:p.contentHtml+'changed',contentDigest:sha(p.contentHtml+'changed')}),/approved_content_mismatch/);
  await t.mutation(ref('publish'),args);
  let row=await read(t,job);
  const published=await t.query(ref('publicPage'),{publicToken:row.publicToken});
  assert.equal(published.draft,false);assert.equal(published.contentHtml,p.contentHtml);assert.deepEqual(published.audioLanguages,['fr']);
  await email(t,job);row=await read(t,job);assert.equal(row.status,'approved_sent');assert.ok(row.hostingEndsAtMs>row.deliveredAtMs);
  await payment(t,job,p);await editorial(t,job,p);assert.equal(await claim(t),null);
  assert.equal(row.emailReceipts.filter(e=>e.stage==='final_email').length,1);
  await patchData(t,job,{revokedAtMs:Date.now()});
  assert.equal(await t.query(ref('publicPage'),{publicToken:row.publicToken}),null);
  assert.equal(await t.query(ref('publicAudio'),{publicToken:row.publicToken,revision:1,language:'fr'}),null);
});
test('uncertain paid narration is durably fenced even when another worker has no local journal',async()=>{
  const t=fixture();const {job,p}=await ready(t);await payment(t,job,p);await editorial(t,job,p);const lease=await claim(t);
  await t.mutation(ref('beginNarration'),{workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,revision:1,language:'fr',textDigest:sha('Bienvenue.\n\nDes jours doux.\n\nNotre amour.')});
  await t.mutation(ref('fail'),{workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,reason:'provider_timeout',retryable:true});
  assert.equal((await read(t,job)).status,'reconciliation_required');assert.equal(await claim(t),null);
});
function stripeFixture(scope, overrides={}) {
  return {id:'pi_offline',status:'succeeded',amount:3900,amount_received:3900,currency:'eur',livemode:true,metadata:{project:'bebebonjour',order_mode:PAID_MODE,job_id:scope.jobId,revision:String(scope.revision),preview_digest:scope.previewDigest},latest_charge:{paid:true,captured:true,refunded:false,amount_refunded:0,disputed:false,amount:3900,currency:'eur',payment_intent:'pi_offline',livemode:true},...overrides};
}
test('provider adapter retrieves account and settled charge with immutable order metadata, never creates a payment',async()=>{
  const scope={jobId:'offline-job',revision:1,previewDigest:'a'.repeat(64)};let intent=stripeFixture(scope);const calls=[];
  const stripe={accounts:{retrieve:async()=>({id:'acct_offline'})},paymentIntents:{retrieve:async(id,opts)=>{calls.push({id,opts});return intent;}}};
  const inspect=()=>inspectPaidPayment({scope,providerPaymentId:'pi_offline',accountId:'acct_offline',stripe});
  assert.equal((await inspect()).livemode,true);assert.equal(calls[0].opts.expand[0],'latest_charge');
  for(const override of [{metadata:{...intent.metadata,job_id:'other'}},{metadata:{...intent.metadata,revision:'2'}},{amount_received:3899},{currency:'usd'},{status:'processing'},{latest_charge:{...intent.latest_charge,refunded:true}},{latest_charge:{...intent.latest_charge,disputed:true}}]) {intent=stripeFixture(scope,override);await assert.rejects(inspect(),/payment_evidence_mismatch/);}
  intent=stripeFixture(scope,{livemode:false,latest_charge:{...stripeFixture(scope).latest_charge,livemode:false}});assert.equal((await inspect()).livemode,false);
});
test('actual paid HTTP views and private/review/operator contracts are bounded and have runnable browser scripts',async()=>{
  const t=fixture();const job=await submit(t);const p=await preview(t,job);const row=await read(t,job);
  for(const url of ['/delivery?mode=paid_route_a',new URL(job.reviewUrl).pathname+new URL(job.reviewUrl).search,'/delivery/operator']) {
    const response=await t.fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');const html=await response.text();assert.doesNotMatch(html,/href="null"/);
    for(const [,script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(()=>new Script(script));
    if(url.startsWith('/delivery?')) assert.match(html,/39 €/);
  }
  const response=await t.fetch('/delivery/preview?'+new URLSearchParams({jobId:job.jobId,token:job.reviewToken,revision:'1'}));assert.equal(await response.text(),p.contentHtml);assert.match(response.headers.get('content-security-policy'),/sandbox/);
  assert.doesNotMatch(await (await t.fetch('/announcements/'+row.publicToken)).text(),/Aperçu privé 1/);
  const post=(url,data,token)=>t.fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  assert.equal((await post('/delivery/operator',{action:'read',jobId:job.jobId},workerToken)).status,403);
  assert.equal((await post('/delivery/operator',{action:'read',jobId:job.jobId},editorialToken)).status,200);
  assert.equal((await post('/delivery/review',{jobId:job.jobId,reviewToken:job.reviewToken,expectedRevision:1,action:'approve',idempotencyKey:'http-approve-paid'})).status,200);
  assert.equal((await post('/delivery/review',{jobId:job.jobId,reviewToken:job.reviewToken,expectedRevision:1,action:'accept_permissions',termsVersion:TERMS_VERSION,termsAccepted:true,publication:true})).status,200);
});

for (const lostAck of [false, true]) test(`worker reconciles opaque Cloudflare receipt with${lostAck ? '' : 'out'} lost action acknowledgement`, async context => {
  const t=fixture();
  Object.assign(process.env,{BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER:'cloudflare',BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),BEBEBONJOUR_CLOUDFLARE_ZONE_ID:'b'.repeat(32),BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN:'synthetic-send-token',BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN:'synthetic-read-token'});
  context.after(()=>{for(const k of ['BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER','BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID','BEBEBONJOUR_CLOUDFLARE_ZONE_ID','BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN','BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN']) delete process.env[k];});
  const id='<opaque+receipt@example.invalid>'; let sends=0;
  context.mock.method(globalThis,'fetch',async (url,options)=>{sends++;assert.match(url,/api\.cloudflare\.com/);const body=JSON.parse(options.body);return Response.json({success:true,errors:[],result:{message_id:id,queued:[body.to],delivered:[],permanent_bounces:[]}});});
  const job=await submit(t);const lease=await claim(t);const contentHtml='<html><body>Offline preview</body></html>';
  const composition={schemaVersion:'1.0',languages:{fr:{description:'Un bonheur.',introLines:['Bienvenue.'],introNarration:'Bienvenue.',blessingLines:['Des jours doux.'],blessingNarration:'Des jours doux.',closingLines:['Notre amour.'],closingNarration:'Notre amour.'}}};
  await t.mutation(ref('publish'),{workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,revision:1,contentHtml,contentDigest:sha(contentHtml),composition,compositionJson:JSON.stringify(composition),compositionReceipt:{provider:'openai-codex-subscription',outputDigest:sha(JSON.stringify(composition))},audioFiles:[]});
  const client=Object.fromEntries(['mutation','query','action'].map(method=>[method,async(name,args)=>{const result=await t[method](makeFunctionReference(name),args);if(lostAck && name==='deliveryLoopProviders:sendEmail') throw new Error('lost_ack');return result;}]));
  const root=await mkdtemp(path.join(process.env.TMPDIR,'opaque-worker-'));context.after(()=>rm(root,{recursive:true,force:true}));
  const worker=createDeliveryLoopWorker({client,composer:{async compose(){throw new Error('unexpected_composition');}},stateDir:root,workerToken,workerId:'offline',reconciliationAttempts:1,logger(){}});
  const result=await worker.runOnce();assert.equal(result.status,'email_sent',JSON.stringify(result));assert.equal(result.providerMessageId,id);
  const row=await read(t,job);assert.equal(row.emailReceipts[0].provider,'cloudflare');assert.equal(row.emailReceipts[0].providerMessageId,id);
  assert.equal((await worker.runOnce()).status,'idle');assert.equal(sends,1);
});

test('actual durable worker and Convex provider actions complete corrected paid Route A offline without preapproval speech/publication/final mail',async context=>{
  const t=fixture();process.env.OPENAI_API_KEY='offline-not-a-real-key';Object.assign(process.env,{BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),BEBEBONJOUR_CLOUDFLARE_ZONE_ID:'b'.repeat(32),BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN:'offline-send-token'});delete process.env.BEBEBONJOUR_DELIVERY_LOOP_PROVIDER_URL;
  const effects=[];
  context.mock.method(globalThis,'fetch',async(url,options)=>{
    const payload=JSON.parse(options.body);effects.push({url,payload});
    if(url==='https://api.openai.com/v1/audio/speech') return new Response(new Uint8Array(180).fill(23),{headers:{'content-type':'audio/mpeg'}});
    if(url.startsWith('https://api.cloudflare.com/')) return Response.json({success:true,errors:[],result:{message_id:`<offline_message_${effects.length}@example.invalid>`,queued:[payload.to],delivered:[],permanent_bounces:[]}});
    throw new Error('unexpected_network_forbidden');
  });
  const scratch=process.env.TMPDIR;assert.ok(scratch);await mkdir(scratch,{recursive:true});const root=await mkdtemp(path.join(scratch,'paid-route-offline-'));context.after(()=>rm(root,{recursive:true,force:true}));
  const client=Object.fromEntries(['mutation','query','action'].map(method=>[method,(name,args)=>t[method](makeFunctionReference(name),args)]));
  let compositions=0;
  const composer={async compose(input){compositions++;const closing=compositions===1?'Notre amour.':'Notre amour grandit chaque jour.';const composition={schemaVersion:'1.0',languages:{fr:{description:'Une histoire.',introLines:['Bienvenue.'],introNarration:'Bienvenue.',blessingLines:['Des jours doux.'],blessingNarration:'Des jours doux.',closingLines:[closing],closingNarration:closing},ar:{description:'فرح جديد.',introLines:['أهلاً بك.'],introNarration:'أهلاً بك.',blessingLines:['أيام جميلة.'],blessingNarration:'أيام جميلة.',closingLines:['لك كل الحب.'],closingNarration:'لك كل الحب.'}}};const metadata={adapterVersion:'1.0.0',provider:'openai-codex-subscription',model:'offline-fixture',requestDigest:sha(JSON.stringify({adapterVersion:'1.0.0',provider:'openai-codex-subscription',model:'offline-fixture',request:buildCodexCompositionRequest(input)})),outputDigest:sha(JSON.stringify(composition))};return {composition,metadata};}};
  const worker=createDeliveryLoopWorker({client,composer,stateDir:path.join(root,'state'),workerToken,workerId:'offline',reconciliationAttempts:1});
  const job=await submit(t);
  assert.equal((await worker.runOnce()).status,'published');assert.equal(effects.length,0);
  assert.equal((await worker.runOnce()).status,'email_sent');assert.equal(effects.length,1);
  assert.match(effects[0].payload.text,/aperçu privé|Aperçu/);assert.doesNotMatch(effects[0].payload.text,/\/announcements\//);
  await decision(t,job,1,'request_changes',{feedback:'A warmer closing.'});
  assert.equal((await worker.runOnce()).status,'published');assert.equal((await worker.runOnce()).status,'email_sent');
  const p=(await read(t,job)).revisions.at(-1);await decision(t,job,2);await permissions(t,job,2);
  assert.equal((await worker.runOnce()).status,'idle');assert.equal(effects.filter(e=>e.url.includes('openai')).length,0);
  await payment(t,job,p);assert.equal((await worker.runOnce()).status,'idle');await editorial(t,job,p);
  const final=await worker.runOnce();assert.equal(final.status,'published',JSON.stringify({final,receipt:p.compositionReceipt,storedOutputDigest:sha(JSON.stringify(p.composition))}));assert.equal(compositions,2,'finalization never recomposes the approved text');
  assert.equal(effects.filter(e=>e.url.includes('openai')).length,1);
  assert.match(effects.find(e=>e.url.includes('openai')).payload.input,/Notre amour grandit chaque jour/);
  const row=await read(t,job);assert.equal(row.finalPublication.contentHtml,p.contentHtml);assert.equal(row.narrationReceipts.length,1);
  const page=await t.fetch('/announcements/'+row.publicToken);const html=await page.text();assert.match(html,/Notre amour grandit chaque jour/);assert.match(html,/<audio controls/);assert.doesNotMatch(html,/Première version/);
  assert.equal((await worker.runOnce()).status,'email_sent');assert.equal((await worker.runOnce()).status,'idle');
  assert.equal(effects.filter(e=>e.url.includes('cloudflare')).length,3);assert.equal(effects.filter(e=>e.url.includes('resend')).length,0);assert.match(effects.at(-1).payload.text,/\/announcements\//);
  const arabic=await submit(t,{intake:{...intake,email:'arabic@example.invalid',language:'ar'}});
  assert.equal((await worker.runOnce()).status,'published');assert.equal((await worker.runOnce()).status,'email_sent');
  const ap=(await read(t,arabic)).revisions.at(-1);await decision(t,arabic,1);await permissions(t,arabic,1);await editorial(t,arabic,ap);await payment(t,arabic,ap,{providerPaymentId:'pi_arabicfixture'});
  assert.equal((await worker.runOnce()).status,'published');assert.match(effects.findLast(e=>e.url.includes('openai')).payload.input,/أهلاً بك/);
  const ar=(await read(t,arabic));const arPage=await t.query(ref('publicPage'),{publicToken:ar.publicToken});assert.deepEqual(arPage.audioLanguages,['ar']);assert.match(arPage.contentHtml,/dir="rtl"/);
  assert.equal((await worker.runOnce()).status,'email_sent');assert.equal((await read(t,arabic)).status,'approved_sent');
});

test('paid intake/review browser scripts submit actual separate backend permissions and never link the private draft publicly',async()=>{
  const t=fixture();
  const element=()=>({hidden:false,disabled:false,textContent:'',href:'',value:'',checked:false,handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},querySelector(){return this.button;},querySelectorAll(){return this.buttons||[];}});
  const entries={email:intake.email,babyName:intake.babyName,gender:'girl',language:'fr',previewConsent:'on',customerPermissions:'on'};
  const form=element();form.button=element();const elements={'#paid-intake':form,'#result':element(),'#review-link':element()};
  class FormDataFixture {get(key){return entries[key]??null;}has(key){return key in entries;}}
  const fetchFixture=(url,options)=>t.fetch(url,options);
  const intakeHtml=await (await t.fetch('/delivery?mode=paid_route_a')).text();const script=[...intakeHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  new Script(script).runInNewContext({document:{querySelector:s=>elements[s]},crypto,FormData:FormDataFixture,fetch:fetchFixture});
  await form.handlers.submit({preventDefault(){}});assert.equal(form.hidden,true);assert.match(elements['#review-link'].href,/\/delivery\/review\?/);assert.doesNotMatch(elements['#result'].textContent,/payé|publiée/);
  const url=new URL(elements['#review-link'].href);const job={jobId:url.searchParams.get('jobId'),reviewToken:url.searchParams.get('token')};await preview(t,job);
  const review=element();review.elements={feedback:{value:''}};review.buttons=[{value:'approve',disabled:true},{value:'request_changes',disabled:true}];
  const perm=element();perm.button=element();perm.elements={terms:{checked:false},publication:{checked:false}};
  const dom={'#review':review,'#permissions':perm,'#result':element(),'#state':element(),'#details':element(),'#window':element(),'#preview-link':element(),'#public-link':element(),'#refresh':element()};
  const html=await (await t.fetch(url.pathname+url.search)).text();const reviewScript=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  for(const selector of ['#data-result','#hosting','#downloads','#revoke','#erase','#confirm-delete'])dom[selector]=element();
  const downloads=['text','audio','page'].map(kind=>({...element(),dataset:{kind}}));
  new Script(reviewScript).runInNewContext({document:{querySelector:s=>dom[s],querySelectorAll:()=>downloads,hidden:false},location:{search:url.search},crypto,URLSearchParams,fetch:fetchFixture,setInterval(){}});
  await dom['#refresh'].handlers.click();assert.equal(review.buttons[0].disabled,false);assert.equal(dom['#public-link'].hidden,true);assert.equal(dom['#preview-link'].hidden,false);
  await review.handlers.submit({preventDefault(){},submitter:{value:'approve'}});
  assert.equal((await read(t,job)).paidPermissions,null);assert.equal(perm.hidden,false);
  await perm.handlers.submit({preventDefault(){}});assert.equal((await read(t,job)).paidPermissions,null,'unchecked boxes must be rejected even without native required validation');
  perm.elements.terms.checked=true;perm.elements.publication.checked=true;await perm.handlers.submit({preventDefault(){}});
  assert.equal((await read(t,job)).paidPermissions.publication,true);assert.equal((await read(t,job)).payment.status,'pending');assert.equal(dom['#public-link'].hidden,true);
  await dom['#revoke'].handlers.click();assert.ok((await read(t,job)).revokedAtMs);assert.match(dom['#data-result'].textContent,/Publication retirée/);
  await dom['#erase'].handlers.click();assert.match(dom['#data-result'].textContent,/Confirmez/);assert.equal((await read(t,job)).status,'revoked');
  dom['#confirm-delete'].checked=true;await dom['#erase'].handlers.click();assert.match(dom['#data-result'].textContent,/supprimés/);assert.equal(dom['#downloads'].hidden,true);await assert.rejects(read(t,job),/data_deleted/);
});

test('cancellation between paid claim and effect denies narration/email; repeat or uncertain email never initiates a second send',async()=>{
  const t=fixture();const {job,p}=await ready(t);await payment(t,job,p);await editorial(t,job,p);const lease=await claim(t);
  await t.mutation(ref('paidControl'),{editorialToken,jobId:job.jobId,expectedRevision:1,action:'cancel'});
  await assert.rejects(t.mutation(ref('beginNarration'),{workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,revision:1,language:'fr',textDigest:sha('Bienvenue.\n\nDes jours doux.\n\nNotre amour.')}),/stale_lease|order_cancelled/);
  const other=await submit(t,{intake:{...intake,email:'email-fence@example.invalid'}});const previewLease=await claim(t);
  const html='<html><body>Private</body></html>';const composition={languages:{fr:{introNarration:'Private',blessingNarration:'Private',closingNarration:'Private'}}};
  await t.mutation(ref('publish'),{workerToken,jobId:other.jobId,leaseToken:previewLease.leaseToken,revision:1,contentHtml:html,contentDigest:sha(html),composition,compositionJson:JSON.stringify(composition),compositionReceipt:{provider:'openai-codex-subscription',outputDigest:sha(JSON.stringify(composition))},audioFiles:[]});
  const mail=await claim(t);const id={workerToken,jobId:other.jobId,leaseToken:mail.leaseToken,revision:1,stage:'draft_email'};
  await t.mutation(ref('fence'),id);await assert.rejects(t.mutation(ref('fence'),id),/email_reconciliation_required/);
  await t.mutation(ref('fail'),{workerToken,jobId:other.jobId,leaseToken:mail.leaseToken,reason:'provider_timeout',retryable:true,providerDefinitiveFailure:true});
  assert.equal((await read(t,other)).status,'reconciliation_required');assert.equal(await claim(t),null);
});
