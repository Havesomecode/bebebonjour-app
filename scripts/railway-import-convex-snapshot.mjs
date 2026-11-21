import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createRailwayRuntime, RUNTIME_TABLES } from '../src/backend/runtime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, function (key, v) { return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v; });
async function jsonl(dir, table) {
  let text;
  try { text = await readFile(path.join(dir,table,'documents.jsonl'),'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}
async function snapshot(dir) {
  const tables = {}, refs = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'storageId' && typeof child === 'string') refs.add(child);
      else walk(child);
    }
  }
  for (const table of RUNTIME_TABLES) { tables[table] = await jsonl(dir,table); tables[table].forEach(walk); }
  const storage = new Map((await jsonl(dir,'_storage')).map(doc => [doc._id,doc]));
  return { tables, refs, storage };
}
function tableDiff(a,b) {
  const left = new Map(a.map(d => [d._id,d])), right = new Map(b.map(d => [d._id,d]));
  return { snapshotCount:a.length, databaseCount:b.length,
    missingInDatabase:[...left.keys()].filter(id => !right.has(id)).sort(),
    extraInDatabase:[...right.keys()].filter(id => !left.has(id)).sort(),
    changed:[...left.keys()].filter(id => right.has(id) && canonical(left.get(id)) !== canonical(right.get(id))).sort() };
}
function compareTables(a,b) {
  const tables = Object.fromEntries([...RUNTIME_TABLES].map(t => [t,tableDiff(a[t],b[t])]));
  return { tables, ok:Object.values(tables).every(t => !t.missingInDatabase.length && !t.extraInDatabase.length && !t.changed.length) };
}
async function storageBytes(dir,id,metadata) {
  if (!metadata || id.includes('/') || id.includes('\\') || id === '.' || id === '..') throw new Error('storage_missing');
  let names;
  try { names = await readdir(path.join(dir,'_storage')); } catch (e) { if (e.code === 'ENOENT') throw new Error('storage_missing'); throw e; }
  const matches = names.filter(n => n === id || n.startsWith(id+'.'));
  if (matches.length !== 1) throw new Error('storage_missing');
  const bytes = await readFile(path.join(dir,'_storage',matches[0]));
  if (bytes.length !== metadata.size) throw new Error('storage_size_mismatch');
  if (hash(bytes) !== Buffer.from(metadata.sha256 || '', 'base64').toString('hex')) throw new Error('storage_sha256_mismatch');
  return bytes;
}
export async function importConvexSnapshot({database,dir}) {
  await createRailwayRuntime({database,advisoryLock:false});
  const client = database.connect ? await database.connect() : database;
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE documents, storage IN ACCESS EXCLUSIVE MODE');
    if ((await client.query('SELECT 1 FROM documents UNION ALL SELECT 1 FROM storage LIMIT 1')).rows.length) throw new Error('target_not_empty');
    const snap = await snapshot(dir), counts = {};
    for (const [table,docs] of Object.entries(snap.tables)) {
      counts[table] = docs.length;
      for (const doc of docs) await client.query('INSERT INTO documents (id,table_name,creation_time,doc) VALUES ($1,$2,$3,$4)',[doc._id,table,doc._creationTime,JSON.stringify(doc)]);
    }
    for (const id of snap.refs) {
      const meta = snap.storage.get(id), bytes = await storageBytes(dir,id,meta);
      await client.query('INSERT INTO storage (id,data,size,content_type,sha256,creation_time) VALUES ($1,$2,$3,$4,$5,$6)',[id,bytes,meta.size,meta.contentType ?? null,hash(bytes),meta._creationTime]);
    }
    await client.query('COMMIT'); return {tables:counts,storage:snap.refs.size};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { if (client !== database) client.release(); }
}
export async function compareConvexSnapshot({database,dir}) {
  const snap = await snapshot(dir), rows = (await database.query('SELECT table_name,doc FROM documents')).rows;
  const dbTables = Object.fromEntries([...RUNTIME_TABLES].map(t => [t,rows.filter(r => r.table_name === t).map(r => r.doc)]));
  const result = compareTables(snap.tables,dbTables);
  const stored = (await database.query('SELECT id,data,sha256 FROM storage')).rows, db = new Map(stored.map(r => [r.id,r]));
  const missing = [...snap.refs].filter(id => !db.has(id) || !snap.storage.has(id)).sort();
  const extra = [...db.keys()].filter(id => !snap.refs.has(id)).sort();
  const shaMismatch = [...snap.refs].filter(id => db.has(id) && snap.storage.has(id) && (hash(db.get(id).data) !== Buffer.from(snap.storage.get(id).sha256 || '', 'base64').toString('hex') || db.get(id).sha256 !== hash(db.get(id).data))).sort();
  result.storage = {referenced:snap.refs.size,imported:stored.length,missing,extra,shaMismatch};
  result.ok &&= !missing.length && !extra.length && !shaMismatch.length && rows.every(r => RUNTIME_TABLES.has(r.table_name));
  return result;
}
export async function diffConvexSnapshots(dirA,dirB) {
  const a = await snapshot(dirA), b = await snapshot(dirB);
  return compareTables(a.tables,b.tables);
}
export async function checkAnnouncements({database,origin,fetch = globalThis.fetch}) {
  const rows = (await database.query("SELECT doc FROM documents WHERE table_name='deliveryLoopJobs'")).rows;
  const result = {pages:{},audio:{},byJob:{}};
  const add = (bucket,code) => { bucket[code] = (bucket[code] || 0) + 1; };
  for (const {doc} of rows) {
    if (!doc.publicToken) continue;
    const base = `${origin.replace(/\/$/,'')}/announcements/${encodeURIComponent(doc.publicToken)}`;
    const page = (await fetch(base,{redirect:'manual'})).status; add(result.pages,page);
    const codes = [];
    for (const revision of doc.data?.revisions || []) for (const file of revision.audioFiles || []) {
      const code = (await fetch(`${base}/audio/${encodeURIComponent(revision.revision)}/${encodeURIComponent(file.language)}`,{redirect:'manual'})).status;
      codes.push(code); add(result.audio,code);
    }
    result.byJob[doc.jobId] = {status:doc.status,page,audio:codes};
  }
  return result;
}
async function main() {
  const [command,...args] = process.argv.slice(2);
  if (!['import','compare','diff','check'].includes(command) || args.length !== (command === 'diff' ? 2 : 1)) throw new Error('invalid_arguments');
  if (command === 'diff') { const result = await diffConvexSnapshots(...args); console.log(JSON.stringify(result,null,2)); if (!result.ok) process.exitCode=1; return; }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const database = new pg.Pool({connectionString:process.env.DATABASE_URL});
  try {
    let result;
    if (command === 'import') { const imported = await importConvexSnapshot({database,dir:args[0]}); const comparison = await compareConvexSnapshot({database,dir:args[0]}); result = {imported,comparison}; if (!comparison.ok) process.exitCode=1; }
    if (command === 'compare') { result = await compareConvexSnapshot({database,dir:args[0]}); if (!result.ok) process.exitCode=1; }
    if (command === 'check') result = await checkAnnouncements({database,origin:args[0]});
    console.log(JSON.stringify(result,null,2));
  } finally { await database.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(JSON.stringify({error: ['target_not_empty','storage_missing','storage_size_mismatch','storage_sha256_mismatch','invalid_arguments','DATABASE_URL required'].includes(error.message) ? error.message : 'operation_failed'})); process.exitCode=1; });
