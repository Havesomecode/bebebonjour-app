import { PGlite } from '@electric-sql/pglite';
import { createRailwayRuntime } from '../../src/backend/runtime.mjs';
import { createHttpHandler } from '../../src/backend/http.mjs';
import test from 'node:test';

const fixtures = new Set(), pool = [];
test.afterEach(async () => { for (const release of fixtures) await release(); fixtures.clear(); });
test.after(async () => { for (const item of pool) await item.database.close(); });
export function convexTest() {
  let item = pool.find(entry => !entry.busy);
  if (!item) { const database = new PGlite(); item = {database, ready:createRailwayRuntime({database, advisoryLock:false}), busy:false}; pool.push(item); }
  item.busy=true; const {database, ready} = item;
  fixtures.add(async () => { await ready; await database.query('TRUNCATE documents, storage, scheduled_functions'); item.busy=false; });
  const call = kind => async (ref,args) => (await ready).call(kind,ref,args,true);
  return {
    query:call('query'), mutation:call('mutation'), action:call('action'),
    run: async fn => { const r=await ready; return r.transaction(c=>fn(r.context(c))); },
    scheduledFunctions: async () => { await ready; return (await database.query('SELECT state, run_at FROM scheduled_functions ORDER BY id')).rows; },
    fetch: async (path,options) => createHttpHandler(await ready)(new Request(new URL(path,'https://offline.convex.site'),options)),
    finishInProgressScheduledFunctions: async () => { const r=await ready; while (await r.pollScheduler()) {} },
    finishAllScheduledFunctions: async advance => { const r=await ready; for (let count=0; count<1000; count++) { if (advance) await advance(); if (!await r.pollScheduler({through:Number.MAX_SAFE_INTEGER})) return; } throw new Error("scheduled_functions_limit"); },
  };
}
