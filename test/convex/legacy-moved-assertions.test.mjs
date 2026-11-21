import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../support/legacy-schema.mjs';
import http from '../../convex/http.js';

test('legacy Convex upload URL remains HTTPS for an authorized lease', async () => {
  const password='fictional-offline-complimentary-password', workerToken='offline-delivery-worker-token-over-32-characters', operatorToken='offline-operations-token-over-32-characters';
  Object.assign(process.env,{BEBEBONJOUR_DELIVERY_LOOP_TOKEN:workerToken,BEBEBONJOUR_OPERATIONS_TOKEN:operatorToken,BEBEBONJOUR_TRIAL_PASSWORD_SHA256:createHash('sha256').update(password).digest('hex'),CONVEX_SITE_URL:'https://offline.convex.site'});
  delete process.env.BEBEBONJOUR_OPERATOR_EMAIL;
  const t=convexTest(schema, {'./_generated/server.js':()=>import('convex/server'),'./deliveryLoop.js':()=>import('../support/legacy-deliveryLoop.mjs'),'./deliveryLoopNotices.js':()=>import('../support/legacy-deliveryLoopNotices.mjs')});
  const ref=name=>makeFunctionReference(`deliveryLoop:${name}`);
  const job=await t.mutation(ref('submit'),{intake:{email:'fictional@example.invalid',babyName:'Amal',language:'fr',gender:'girl',context:'general',voiceEnabled:false,consent:true,fictional:true,source:'first_party_delivery'},magicPassword:password,idempotencyKey:'intake-offline-001'});
  await t.mutation(ref('operatorLaunch'),{operatorToken,jobId:job.jobId,expectedRevision:1,brief:{firstName:'Amal',nameArabic:null,gender:'girl',birthDate:null,religion:'general',tone:'tendre',phrases:[]}});
  const lease=await t.mutation(ref('claim'),{workerToken,voiceReady:true,workerId:'offline-worker',leaseToken:'offline-lease-token-001'});
  assert.match(await t.mutation(ref('uploadUrl'),{workerToken,jobId:job.jobId,leaseToken:lease.leaseToken}),/^https:/);
  await assert.rejects(t.mutation(ref('completeEmail'),{workerToken,jobId:job.jobId,leaseToken:lease.leaseToken,revision:1,stage:'draft_email',provider:'other',providerMessageId:'opaque'}), /Validator error/);
  await new Promise(resolve=>setTimeout(resolve,20)); await t.finishInProgressScheduledFunctions();
});

test('legacy completion artifact rejects unauthorized access', async () => {
  const handler=http.lookup('/completion/artifact','GET')[0];
  const owner=await handler._handler({runQuery:async()=>{throw Error('forbidden');}},new Request('https://offline.example.invalid/completion/artifact'));
  assert.equal(owner.status,403);
});

test('legacy Convex value codec retains integer, float and byte values', async () => {
  const { convexToJson, jsonToConvex } = await import('convex/values');
  const value = {integer:-9n, float:Infinity, bytes:Uint8Array.of(1,2,255).buffer};
  const decoded=jsonToConvex(convexToJson(value));
  assert.equal(decoded.integer,value.integer);
  assert.equal(decoded.float,Infinity);
  assert.deepEqual([...new Uint8Array(decoded.bytes)],[1,2,255]);
});
