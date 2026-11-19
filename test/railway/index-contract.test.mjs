import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createRailwayRuntime } from '../../src/railway/runtime.mjs';

test('schema indexes sort remaining fields, enforce prefixes, paginate, and roll back', async t => {
  const database = new PGlite(); t.after(() => database.close());
  const runtime = await createRailwayRuntime({database, advisoryLock:false});
  await runtime.transaction(async c => {
    const db = runtime.context(c).db;
    for (const providerEventId of ['z', 'a', 'm', 'a']) await db.insert('deliveryLoopPaymentEvents', {providerAccountId:'fixture', providerEventId});
  });
  await runtime.transaction(async c => {
    const db = runtime.context(c).db;
    const indexed = () => db.query('deliveryLoopPaymentEvents').withIndex('by_identity', q => q.eq('providerAccountId','fixture'));
    const docs = await indexed().collect();
    assert.deepEqual(docs.map(x => x.providerEventId), ['a','a','m','z']);
    assert.ok(docs[0]._creationTime < docs[1]._creationTime);
    assert.deepEqual((await indexed().order('desc').collect()).map(x => x.providerEventId), ['z','m','a','a']);
    assert.throws(() => db.query('deliveryLoopPaymentEvents').withIndex('missing', q => q), /invalid_index/);
    assert.throws(() => db.query('deliveryLoopPaymentEvents').withIndex('by_identity', q => q.eq('providerEventId','a')), /invalid_index_fields/);
    await assert.rejects(indexed().unique(), /not_unique/);
    const first = await indexed().paginate({cursor:null,numItems:2});
    const second = await indexed().paginate({cursor:first.continueCursor,numItems:2});
    assert.deepEqual([...first.page,...second.page].map(x => x._id),docs.map(x => x._id));
    assert.equal(second.isDone,true);
  }, false);
  await assert.rejects(runtime.transaction(async c => { await runtime.context(c).db.insert('deliveryLoopPaymentEvents',{providerAccountId:'rollback'}); throw Error('rollback'); }), /rollback/);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM documents WHERE doc->>'providerAccountId' = 'rollback'")).rows[0].n,0);
});

test('scheduler records failure and stale work without retry', async t => {
  const database = new PGlite(); t.after(() => database.close());
  const runtime = await createRailwayRuntime({database, advisoryLock:false});
  await database.query("INSERT INTO scheduled_functions (name,args,run_at,state,created_at) VALUES ('noSuch:fn','{}',0,'pending',0), ('old:fn','{}',0,'running',0)");
  assert.equal(await runtime.pollScheduler(), true);
  assert.equal(await runtime.pollScheduler(), false);
  const {rows} = await database.query('SELECT state,error_code,finished_at FROM scheduled_functions ORDER BY id');
  assert.deepEqual(rows.map(x => [x.state,x.error_code]), [['failed','function_not_found'],['running',null]]);
  assert.ok(rows[0].finished_at !== null);
  assert.equal(rows[1].finished_at, null);
});
