import { createPool, initializeSchema } from "./database.mjs";

let pool;
try {
  if (process.env.BB_CANDIDATE_MODE !== "synthetic") throw new Error("Explicit synthetic mode is required.");
  const url = new URL(process.env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/^\/bb_candidate[a-z0-9_]*$/.test(url.pathname)) throw new Error("Initialization is restricted to a dedicated local candidate database.");
  pool = createPool(url.href);
  await initializeSchema(pool);
  console.log("candidate_local_schema_ready");
} catch { console.error("candidate_schema_initialization_refused_or_failed"); process.exitCode = 1; }
finally { await pool?.end(); }
