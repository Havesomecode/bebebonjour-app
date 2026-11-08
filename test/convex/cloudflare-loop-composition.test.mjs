import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { sendEmail, inspectEmail } from '../../convex/deliveryLoopProviders.js';

test('an admitted Cloudflare announcement submits once and records its exact provider receipt', async () => {
  const saved = { ...process.env }; const original = globalThis.fetch; const mutations = [];
  Object.assign(process.env, { BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), BEBEBONJOUR_CLOUDFLARE_ZONE_ID: 'b'.repeat(32), BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: 'synthetic-send-token', BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN: 'synthetic-read-token' });
  let sends = 0;
  globalThis.fetch = async (url, opts) => {
    sends++; assert.match(url, /api\.cloudflare\.com\/client\/v4\/accounts\//);
    const body = JSON.parse(opts.body); assert.equal(body.from.address, 'bonjour@mail.havesomecode.io');
    assert.equal(body.to, 'test@example.invalid');
    return Response.json({ success: true, errors: [], result: { message_id: '<opaque@example.invalid>', queued: [body.to], delivered: [], permanent_bounces: [] } });
  };
  const ctx = { runQuery: async () => ({ jobId: 'job_offline', intake: { baby: { firstName: 'Mila' }, customer: { email: 'test@example.invalid' } }, publicUrl: 'https://example.invalid', reviewUrl: 'https://example.invalid/review' }),
    runMutation: async (fn, args) => { const name = getFunctionName(fn); mutations.push({ name, args }); if (name.endsWith(':fence')) return { emailProvider: 'cloudflare' }; } };
  try {
    const result = await sendEmail._handler(ctx, { workerToken: 'offline', jobId: 'job_offline', leaseToken: 'lease', revision: 1, stage: 'draft_email' });
    assert.equal(sends, 1); assert.equal(result.providerMessageId, '<opaque@example.invalid>');
    assert.equal(mutations[0].name, 'deliveryLoop:fence');
    assert.equal(mutations[1].name, 'deliveryLoop:completeEmail');
    assert.equal(mutations[1].args.provider, 'cloudflare'); assert.equal(mutations[1].args.providerMessageId, result.providerMessageId);
  } finally { globalThis.fetch = original; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test('inspection uses the receipt provider, not the current selector', async () => {
  const saved = { ...process.env }; const original = globalThis.fetch;
  Object.assign(process.env, { BEBEBONJOUR_DELIVERY_LOOP_EMAIL_PROVIDER: 'resend', BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), BEBEBONJOUR_CLOUDFLARE_ZONE_ID: 'b'.repeat(32), BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: 'synthetic-send-token', BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN: 'synthetic-read-token' });
  const id='<opaque@example.invalid>'; let calls=0;
  globalThis.fetch=async (url,options)=>{ calls++; assert.equal(url,'https://api.cloudflare.com/client/v4/graphql');const end=JSON.parse(options.body).variables.end;return Response.json({data:{viewer:{zones:[{emailSendingAdaptive:[{messageId:id,status:'delivered',datetime:end}]}]}}}); };
  try {const ctx={runQuery:async()=>({emailReceipts:[{provider:'cloudflare',providerMessageId:id}]})};await assert.rejects(inspectEmail._handler(ctx,{workerToken:'offline',jobId:'job_offline',providerMessageId:id}), /cloudflare_status_unavailable/);assert.equal(calls,0);}
  finally {globalThis.fetch=original;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});
