// SR-01 regression adapted from the independent offline reproduction.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../convex/schema.js';
import { createDeliveryLoopWorker } from '../../src/delivery-loop/worker.mjs';
import { buildCodexCompositionRequest } from '../../scripts/lib/codex-subscription-composition.mjs';

const workerToken = 'offline-review-worker-capability-32-characters';
const operatorToken = 'offline-review-operator-capability-32-characters';
const sha = s => createHash('sha256').update(s).digest('hex');
const ref = n => makeFunctionReference(`deliveryLoop:${n}`);
function fixture() {
  Object.assign(process.env, {
    BEBEBONJOUR_DELIVERY_LOOP_TOKEN: workerToken,
    BEBEBONJOUR_OPERATIONS_TOKEN: operatorToken,
    BEBEBONJOUR_PAID_ROUTE_A_ENABLED: 'true',
    BEBEBONJOUR_PAID_TERMS_URL: 'https://offline.example.invalid/terms',
    BEBEBONJOUR_PAID_STRIPE_ACCOUNT_ID: 'acct_offline',
    CONVEX_SITE_URL: 'https://offline.convex.site',
    BEBEBONJOUR_VOICE_WORKER_URL: 'https://voice.example.invalid',
    BEBEBONJOUR_VOICE_WORKER_TOKEN: 'offline-token',
    BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER: 'cloudflare',
    BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    BEBEBONJOUR_CLOUDFLARE_ZONE_ID: 'b'.repeat(32),
    BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: 'synthetic-send-token',
  });
  return convexTest(schema, {
    './_generated/server.js': () => import('convex/server'),
    './deliveryLoop.js': () => import('../../convex/deliveryLoop.js'),
    './deliveryLoopNotices.js': () => import('../../convex/deliveryLoopNotices.js'),
    './deliveryLoopHttp.js': () => import('../../convex/deliveryLoopHttp.js'),
    './deliveryLoopProviders.js': () => import('../../convex/deliveryLoopProviders.js'),
    './http.js': () => import('../../convex/http.js'),
    './narrationHttp.js': () => import('../../convex/narrationHttp.js'),
  });
}
const read = (t, job) => t.query(ref('read'), { workerToken, jobId: job.jobId });
const hidden = 'Une affirmation ajoutée uniquement à la narration, jamais montrée aux réviseurs.';
const fr = { description:'Une histoire.', introLines:['Bienvenue.', 'Un bonheur & une joie.'], introNarration:'HIDDEN INTRO FR', blessingLines:['Des jours doux.'], blessingNarration:'HIDDEN BLESSING FR', meaningLines:['Douceur.'], revealLines:['Notre enfant.'], closingLines:['Notre amour.'], closingNarration:hidden };
const ar = { description:'فرح جديد.', introLines:['أهلاً بك.', 'فرح جديد.'], introNarration:'HIDDEN INTRO AR', blessingLines:['أيام جميلة.'], blessingNarration:'HIDDEN BLESSING AR', meaningLines:['Douceur.'], revealLines:['Notre enfant.'], closingLines:['لك كل الحب.'], closingNarration:hidden };
const composition = { schemaVersion:'2.0', languages:{fr,ar} };
// Speech reads every displayed screen in order: intro, wishes, meaning, reveal lead-in, the name, closing.
const transcript = language => { const c = composition.languages[language]; return [...c.introLines, ...c.blessingLines, ...c.meaningLines, ...c.revealLines, language === 'fr' ? 'Amal' : 'أمل', ...c.closingLines].join('\n'); };

for (const language of ['fr', 'ar']) test(`SR-01: ${language} generated speech uses displayed prose, never hidden narration`, async context => {
  const t = fixture(); const effects = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body); effects.push({url,payload});
    if (url === 'https://voice.example.invalid/speak') {
      const frame = Buffer.alloc(384); frame.set([0xff, 0xf3, 0xc4, 0xc4]);
      return new Response(frame, {headers:{'content-type':'audio/mpeg'}});
    }
    if (url.startsWith('https://api.cloudflare.com/')) return Response.json({success:true,errors:[],result:{message_id:`offline_message_${effects.length}`,queued:[payload.to],delivered:[],permanent_bounces:[]}});
    throw new Error('unexpected_network_forbidden');
  });
  const composer = { async compose(input) {
    return { composition, metadata:{ adapterVersion:'2.0.0', provider:'openai-codex-subscription', model:'offline-fixture', requestDigest:sha(JSON.stringify({adapterVersion:'2.0.0',provider:'openai-codex-subscription',model:'offline-fixture',request:buildCodexCompositionRequest(input)})), outputDigest:sha(JSON.stringify(composition)) } };
  } };
  const client = Object.fromEntries(['query','mutation','action'].map(method => [method,(name,args) => t[method](makeFunctionReference(name),args)]));
  const stateDir = await mkdtemp(path.join(process.env.TMPDIR,'sr01-regression-'));
  context.after(() => rm(stateDir, {recursive:true,force:true}));
  const worker = createDeliveryLoopWorker({client,composer,stateDir,workerToken,workerId:'offline-review',reconciliationAttempts:1,logger(){}});
  const intake = {email:'fictional@example.invalid',babyName:'Amal',language,gender:'girl',context:'general',voiceEnabled:true,consent:true,customerPermissions:true,termsAccepted:true,publication:true,fictional:true};
  const job = await t.mutation(ref('submit'), {intake,orderMode:'paid_route_a',idempotencyKey:crypto.randomUUID()});
  await t.mutation(ref('operatorLaunch'), {operatorToken,jobId:job.jobId,expectedRevision:1,brief:{firstName:'Amal',nameArabic:null,gender:'girl',birthDate:null,religion:'general',tone:'tendre',phrases:[]}});
  const launched = await t.run(ctx => ctx.db.query('deliveryLoopJobs').withIndex('by_job_id',q=>q.eq('jobId',job.jobId)).unique());
  await t.mutation(ref('recordPaymentEvidence'), {jobId:job.jobId,revision:1,previewDigest:launched.data.briefs[0].briefDigest,providerPaymentId:'pi_offlineReview',amountMinor:3900,currency:'eur',livemode:true,settled:true,providerAccountId:'acct_offline'});
  const result = await worker.runOnce();
  assert.equal(result.status,'published',JSON.stringify(result));
  const speech = effects.filter(e => e.url === 'https://voice.example.invalid/speak');
  const inputs = speech.map(e => e.payload.text);
  assert.deepEqual(inputs, transcript(language).split('\n'));
  assert.ok(inputs.every(input => !input.includes(hidden) && !input.includes('HIDDEN')));
  const final = await read(t,job);
  assert.ok(final.revisions[0].contentHtml.includes(language === 'fr' ? 'Notre amour.' : 'لك كل الحب.'));
  assert.equal((await worker.runOnce()).status,'email_sent');
  await t.mutation(ref('requestReview'), {jobId:job.jobId,reviewToken:job.reviewToken,expectedRevision:1,action:'approve',idempotencyKey:crypto.randomUUID()});
  assert.equal(final.revisions[0].compositionJson,JSON.stringify(composition));
  assert.equal((await worker.runOnce()).status,'email_sent');
  assert.equal((await read(t,job)).status,'approved_sent');
  const publicResponse = await t.fetch(`/announcements/${final.publicToken}`);
  assert.equal(publicResponse.status,200);
  const publicHtml = await publicResponse.text();
  assert.ok(publicHtml.includes(language === 'fr' ? 'Notre amour.' : 'لك كل الحب.'));
  assert.ok(!publicHtml.includes(hidden));
  assert.ok(publicHtml.includes(`/announcements/${final.publicToken}/audio/1/${language}`));
  const audioResponse = await t.fetch(`/announcements/${final.publicToken}/audio/1/${language}`);
  assert.equal(audioResponse.status,200);
  assert.ok((await audioResponse.arrayBuffer()).byteLength > 384 * 4);
  assert.equal((await worker.runOnce()).status,'idle');
  assert.equal(effects.filter(e => e.url.startsWith('https://api.cloudflare.com/') && e.payload.headers['X-Bebe-Operation'].startsWith('bebe-loop:')).length,2);
});
