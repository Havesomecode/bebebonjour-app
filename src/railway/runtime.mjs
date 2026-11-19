import { randomUUID, createHash } from "node:crypto";
import { getFunctionName } from "convex/server";
import schema from "../../convex/schema.js";
import { resolveFunction, validateArguments } from "./function-boundary.mjs";

const tables = new Set(["deliveryLoopJobs", "deliveryLoopIntakeThrottle", "deliveryLoopPaymentEvidence", "deliveryLoopPaymentEvents", "deliveryLoopRetainedEvidence", "customerFlowOperationsLoginThrottle"]);
const nameOf = ref => typeof ref === "string" ? ref : getFunctionName(ref);
const id = () => randomUUID().replaceAll("-", "");

export async function createRailwayRuntime({ database, advisoryLock = true, publicOrigin } = {}) {
  if (!database) throw new Error("database_required");
  for (const statement of `CREATE TABLE IF NOT EXISTS documents (id text PRIMARY KEY, table_name text NOT NULL, creation_time double precision NOT NULL, doc jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS documents_table_time ON documents (table_name, creation_time, id);
    CREATE TABLE IF NOT EXISTS storage (id text PRIMARY KEY, data bytea NOT NULL, size integer NOT NULL, content_type text, sha256 text NOT NULL, creation_time double precision NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_functions (id bigserial PRIMARY KEY, name text NOT NULL, args jsonb NOT NULL, run_at double precision NOT NULL, state text NOT NULL, created_at double precision NOT NULL, finished_at double precision, error_code text);
    CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_functions (run_at) WHERE state = 'pending'`.split(";")) await database.query(statement);
  await database.query(`CREATE SEQUENCE IF NOT EXISTS document_creation_seq START ${Date.now() * 1000}`);
  let wake = () => {};
  let tail = Promise.resolve();
  async function transaction(fn, write = true, notify = true) {
    let release; const previous = tail; tail = new Promise(r => { release = r; }); await previous;
    let client;
    try {
      client = database.connect ? await database.connect() : database;
      await client.query(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      if (advisoryLock && write) await client.query("SELECT pg_advisory_xact_lock(708324119)");
      const result = await fn(client); await client.query("COMMIT"); if (write && notify) queueMicrotask(wake); return result;
    } catch (error) { if (client) await client.query("ROLLBACK"); throw error; }
    finally { if (client && client !== database) client.release(); release(); }
  }
  function storage(client) {
    return {
      async store(blob) { const bytes = Buffer.from(await blob.arrayBuffer()); const key = id(); await client.query("INSERT INTO storage VALUES ($1,$2,$3,$4,$5,$6)", [key, bytes, bytes.length, blob.type || null, createHash("sha256").update(bytes).digest("hex"), Date.now()]); return key; },
      async get(key) { const { rows } = await client.query("SELECT data, content_type FROM storage WHERE id=$1", [key]); return rows[0] ? new Blob([rows[0].data], { type: rows[0].content_type || "" }) : null; },
      async delete(key) { await client.query("DELETE FROM storage WHERE id=$1", [key]); },
      async generateUploadUrl() { throw new Error("unsupported_upload_url"); },
      async getUrl() { return null; },
    };
  }
  function db(client) {
    return {
      system: { async get(key) { const { rows } = await client.query("SELECT id, size, content_type, sha256, creation_time FROM storage WHERE id=$1", [key]); const r = rows[0]; return r ? { _id: r.id, _creationTime: r.creation_time, size: r.size, contentType: r.content_type || undefined, sha256: r.sha256 } : null; } },
      async get(key) { const { rows } = await client.query("SELECT doc FROM documents WHERE id=$1", [key]); return rows[0]?.doc ?? null; },
      async insert(table, value) { if (!tables.has(table)) throw new Error("table_not_allowed"); const key = id(), time = Number((await client.query("SELECT setval('document_creation_seq', GREATEST(nextval('document_creation_seq'), floor(extract(epoch from clock_timestamp()) * 1000000)::bigint)) AS value")).rows[0].value) / 1000; const doc = { ...value, _id: key, _creationTime: time }; await client.query("INSERT INTO documents VALUES ($1,$2,$3,$4)", [key, table, time, JSON.stringify(doc)]); return key; },
      async patch(key, values) { const current = await this.get(key); if (!current) throw new Error("document_not_found"); for (const [k,v] of Object.entries(values)) { if (v === undefined) delete current[k]; else current[k] = v; } await client.query("UPDATE documents SET doc=$2 WHERE id=$1", [key, JSON.stringify(current)]); },
      async replace(key, value) { const current = await this.get(key); if (!current) throw new Error("document_not_found"); await client.query("UPDATE documents SET doc=$2 WHERE id=$1", [key, JSON.stringify({ ...value, _id:key, _creationTime:current._creationTime })]); },
      async delete(key) { await client.query("DELETE FROM documents WHERE id=$1", [key]); },
      query(table) {
        if (!tables.has(table)) throw new Error("table_not_allowed"); let filters = [], direction = "asc", indexFields = [];
        const q = {
          withIndex(index, build = x => x) { const definition = schema.tables[table].indexes.find(i => i.indexDescriptor === index); if (!definition) throw new Error("invalid_index"); indexFields = definition.fields; filters = []; const range = { eq(k,v) { if (indexFields[filters.length] !== k) throw new Error("invalid_index_fields"); filters.push([k,v]); return this; } }; build(range); return q; },
          order(value) { if (!["asc", "desc"].includes(value)) throw new Error("invalid_order"); direction = value; return q; },
          async collect() { const params = [table]; const predicates = filters.map(([key,value]) => { params.push(key.split("."),JSON.stringify(value)); return `doc #> $${params.length-1}::text[] = $${params.length}::jsonb`; }); const ordering = indexFields.slice(filters.length).map(field => { params.push(field.split(".")); return `doc #> $${params.length}::text[] ${direction.toUpperCase()} ${direction === "asc" ? "NULLS FIRST" : "NULLS LAST"}`; }); ordering.push(`creation_time ${direction.toUpperCase()}`, `id ${direction.toUpperCase()}`); const {rows} = await client.query(`SELECT doc FROM documents WHERE table_name=$1 ${predicates.map(p => `AND ${p}`).join(" ")} ORDER BY ${ordering.join(", ")}`,params); return rows.map(r => r.doc); },
          async take(n) { return (await q.collect()).slice(0,n); },
          async first() { return (await q.take(1))[0] ?? null; },
          async unique() { const found = await q.take(2); if (found.length > 1) throw new Error("not_unique"); return found[0] ?? null; },
          async paginate({cursor, numItems}) { const docs = await q.collect(); let start = 0; if (cursor) { const marker = JSON.parse(Buffer.from(cursor, "base64url").toString()); start = docs.findIndex(d => d._id === marker); if (start < 0) throw new Error("invalid_cursor"); start++; } const page = docs.slice(start,start+numItems), isDone = start + page.length >= docs.length; return { page, isDone, continueCursor: page.length ? Buffer.from(JSON.stringify(page.at(-1)._id)).toString("base64url") : "" }; },
        }; return q;
      },
    };
  }
  const runtime = {};
  function context(client) {
    const ctx = { db: db(client), storage: storage(client), scheduler: { async runAfter(delay, ref, args) { const now = Date.now(); const {rows} = await client.query("INSERT INTO scheduled_functions (name,args,run_at,state,created_at) VALUES ($1,$2,$3,'pending',$4) RETURNING id", [nameOf(ref), JSON.stringify(args), now+delay, now]); return String(rows[0].id); } } };
    return ctx;
  }
  async function call(kind, ref, args, internal = true) {
    const started = Date.now(); let ok = false; let name = "invalid_function";
    try { const fn = await resolveFunction(nameOf(ref), kind, { internal }); name = nameOf(ref); const result = await invoke(kind, ref, args, fn); ok = true; return result; } finally { console.log(JSON.stringify({name, kind, duration: Date.now() - started, ok})); }
  }
  async function invoke(kind, ref, args, fn) {
    validateArguments(fn,args);
    if (kind === "action") {
      const ctx = actionContext(); return (await fn._handler(ctx,args)) ?? null;
    }
    return transaction(async client => (await fn._handler(context(client),args)) ?? null, kind === "mutation");
  }
  function actionContext() {
    return { runQuery: (ref,args) => call("query",ref,args), runMutation: (ref,args) => call("mutation",ref,args), runAction: (ref,args) => call("action",ref,args), scheduler: { runAfter: (delay, ref, args) => transaction(c => context(c).scheduler.runAfter(delay, ref, args)) }, storage: {
      generateUploadUrl: async () => { throw new Error("unsupported_upload_url"); }, getUrl: async () => null,
      store: blob => transaction(c => storage(c).store(blob)), get: key => transaction(c => storage(c).get(key),false), delete: key => transaction(c => storage(c).delete(key)),
    } };
  }
  Object.assign(runtime, { call, runQuery: (r,a) => call("query",r,a), runMutation: (r,a) => call("mutation",r,a), runAction: (r,a) => call("action",r,a), actionContext, transaction, context,
    setWake(fn) { wake = fn; },
    async pollScheduler() { const row = await transaction(async c => { const {rows} = await c.query("SELECT * FROM scheduled_functions WHERE state = 'pending' AND run_at <= $1 ORDER BY run_at,id LIMIT 1 FOR UPDATE SKIP LOCKED", [Date.now()]); if (!rows[0]) return null; await c.query("UPDATE scheduled_functions SET state='running', run_at=$2 WHERE id=$1", [rows[0].id, Date.now()]); return rows[0]; }, true, false); if (!row) return false; let errorCode = null; try { let kind; for (const candidate of ["action", "mutation"]) { try { await resolveFunction(row.name,candidate,{internal:true}); kind = candidate; break; } catch (e) { if (e.message !== "function_not_found") throw e; } } if (!kind) throw new Error("function_not_found"); await call(kind,row.name,row.args); } catch (e) { errorCode = e.message === "function_not_found" ? "function_not_found" : "scheduled_function_failed"; } await transaction(c => c.query("UPDATE scheduled_functions SET state=$2, finished_at=$3, error_code=$4 WHERE id=$1", [row.id,errorCode ? "failed" : "done",Date.now(),errorCode]), true, false); return true; },
  });
  return runtime;
}
