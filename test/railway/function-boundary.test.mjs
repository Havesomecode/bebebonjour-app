import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFunction, validateArguments } from '../../src/railway/function-boundary.mjs';

test('public function boundary excludes internal and unrelated functions', async () => {
  assert.equal((await resolveFunction('deliveryLoop:claim', 'mutation')).isPublic, true);
  await assert.rejects(resolveFunction('deliveryLoopNotices:send', 'action'));
  await assert.rejects(resolveFunction('operations:listJobs', 'query'));
  await assert.rejects(resolveFunction('deliveryLoop:claim', 'query'));
  assert.equal((await resolveFunction('deliveryLoopNotices:send', 'action', { internal: true })).isInternal, true);
  await assert.rejects(resolveFunction('operations:listJobs', 'query', { internal: true }));
});

test('function arguments enforce required fields, types and closed objects', async () => {
  const fn = await resolveFunction('deliveryLoop:claim', 'mutation');
  assert.doesNotThrow(() => validateArguments(fn, { workerToken: 'x', workerId: 'y', leaseToken: 'z' }));
  assert.throws(() => validateArguments(fn, { workerToken: 'x', workerId: 'y' }));
  assert.throws(() => validateArguments(fn, { workerToken: 1, workerId: 'y', leaseToken: 'z' }));
  assert.throws(() => validateArguments(fn, { workerToken: 'x', workerId: 'y', leaseToken: 'z', extra: true }));
});
