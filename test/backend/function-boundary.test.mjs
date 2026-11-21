import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFunction, validateArguments } from '../../src/backend/function-boundary.mjs';

test('public function boundary excludes internal and unrelated functions', async () => {
  const registration = await resolveFunction('deliveryLoop:claim', 'mutation');
  assert.equal(registration.isPublic, true);
  assert.deepEqual(Object.keys(registration).sort(), ['args','handler','isPublic','kind']);
  assert.equal(registration.kind, 'mutation');
  assert.equal(Object.isFrozen(registration), true);
  await assert.rejects(resolveFunction('deliveryLoopNotices:send', 'action'));
  await assert.rejects(resolveFunction('operations:listJobs', 'query'));
  await assert.rejects(resolveFunction('deliveryLoop:claim', 'query'));
  assert.equal((await resolveFunction('deliveryLoopNotices:send', 'action', { internal: true })).isPublic, false);
  await assert.rejects(resolveFunction('operations:listJobs', 'query', { internal: true }));
});

test('function arguments enforce required fields, types and closed objects', async () => {
  const fn = await resolveFunction('deliveryLoop:claim', 'mutation');
  assert.doesNotThrow(() => validateArguments(fn, { workerToken: 'x', workerId: 'y', leaseToken: 'z', voiceReady: true }));
  assert.throws(() => validateArguments(fn, { workerToken: 'x', workerId: 'y', leaseToken: 'z' }));
  assert.throws(() => validateArguments(fn, { workerToken: 'x', workerId: 'y' }));
  assert.throws(() => validateArguments(fn, { workerToken: 1, workerId: 'y', leaseToken: 'z' }));
  assert.throws(() => validateArguments(fn, { workerToken: 'x', workerId: 'y', leaseToken: 'z', extra: true }));
});

test('nested validators preserve strict types', async () => {
  const { mutation, v } = await import('../../src/backend/functions.mjs');
  const fn = mutation({ args: { item: v.object({ name: v.string(), tags: v.optional(v.array(v.string())) }) }, handler() {} });
  assert.doesNotThrow(() => validateArguments(fn, { item: { name:'fixture', tags:['a'] } }));
  assert.throws(() => validateArguments(fn, { item: { name:'fixture', extra:true } }));
  assert.throws(() => validateArguments(fn, { item: { name:'fixture', tags:[1] } }));
  const anyFn = mutation({ args: { data: v.any() }, handler() {} });
  assert.throws(() => validateArguments(anyFn, { data: { invalid: undefined } }));
});
