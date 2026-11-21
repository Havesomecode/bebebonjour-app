import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { backendTest } from '../support/backend.mjs';

test('synthetic HTTP submit, status, delivery and unknown path', async () => {
  process.env.BEBEBONJOUR_TRIAL_PASSWORD_SHA256 = createHash('sha256').update('synthetic-password').digest('hex');
  delete process.env.BEBEBONJOUR_OPERATOR_EMAIL;
  const backend = backendTest();
  const response = await backend.fetch('/delivery/intake', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey:'synthetic-smoke-001',magicPassword:'synthetic-password',intake:{email:'smoke@example.invalid',babyName:'Amal',language:'fr',gender:'girl',context:'general',voiceEnabled:false,consent:true,fictional:true,source:'first_party_delivery'}})});
  assert.equal(response.status,200);
  const job = await response.json();
  const status = await backend.fetch(`/delivery/review?${new URLSearchParams({jobId:job.jobId,token:job.reviewToken,format:'json'})}`);
  assert.equal(status.status,200);
  assert.equal((await status.json()).status,'awaiting_operator');
  assert.equal((await backend.fetch('/delivery')).status,200);
  assert.equal((await backend.fetch('/delivery/unknown')).status,404);
});

test('JSON function endpoint preserves ordinary JSON values without special decoding', async () => {
  const { createHttpHandler } = await import('../../src/backend/http.mjs');
  const payload = { data: { $integer: 'AQAAAAAAAAA=' } };
  let received;
  const handler = createHttpHandler({ async call(kind,path,args,internal) { received={kind,path,args,internal}; return payload; } });
  const response = await handler(new Request('https://offline.example.invalid/api/mutation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:'deliveryLoop:submit',args:[payload]})}));
  assert.deepEqual(received,{kind:'mutation',path:'deliveryLoop:submit',args:payload,internal:false});
  assert.deepEqual(await response.json(),{status:'success',value:payload,logLines:[]});
});
