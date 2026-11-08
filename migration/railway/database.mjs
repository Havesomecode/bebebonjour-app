import { readFile } from "node:fs/promises";
import { Pool } from "pg";

export function createPool(connectionString) {
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000, statement_timeout: 10_000, lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000 });
  // Provider exceptions may contain credentials; emit a fixed diagnostic only.
  pool.on("error", () => console.error("candidate_database_idle_connection_failed"));
  return pool;
}

export async function initializeSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query(await readFile(new URL("schema.sql", import.meta.url), "utf8"));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
