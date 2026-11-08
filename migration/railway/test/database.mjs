import assert from "node:assert/strict";
import { createPool, initializeSchema } from "../database.mjs";
export async function openTestDatabase(t) {
  const connectionString = process.env.BB_TEST_DATABASE_URL;
  assert.ok(connectionString, "BB_TEST_DATABASE_URL is required; use a disposable local PostgreSQL.");
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests refuse non-loopback databases.");
  assert.match(url.pathname, /^\/bb_candidate[a-z0-9_]*$/, "Tests require a dedicated bb_candidate database.");
  const pools = [];
  const newPool = () => { const pool = createPool(connectionString); pools.push(pool); return pool; };
  const pool = newPool();
  t.after(async () => { for (const p of pools) if (!p.ended) await p.end(); });
  await initializeSchema(pool);
  return { pool, newPool };
}
