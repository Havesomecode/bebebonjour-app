import test from 'node:test';
import assert from 'node:assert/strict';
import { convexTest } from '../support/backend.mjs';

test('test harness drains scheduled work even when it is due in the future', async () => {
  const backend = convexTest();
  await backend.run(ctx => ctx.scheduler.runAfter(86400000, 'deliveryLoopData:sweep', {}));
  assert.equal((await backend.scheduledFunctions())[0].state, 'pending');
  await backend.finishAllScheduledFunctions();
  assert.equal((await backend.scheduledFunctions())[0].state, 'done');
});
