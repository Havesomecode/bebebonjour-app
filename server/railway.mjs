import { createServer } from "node:http";
import pg from "pg";
import { Readable } from "node:stream";
import { createRailwayRuntime } from "../src/backend/runtime.mjs";
import { createHttpHandler } from "../src/backend/http.mjs";
import { createInterestList } from "../src/interest/interest-list.mjs";
import { cloudflareTransport, alreadyAdmitted } from "../src/delivery-loop/cloudflare-runtime.mjs";

export async function startRailwayServer({ database, publicOrigin = process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN, port = 0, host = "127.0.0.1", sendInterestEmail, schedulerIntervalMs = 1000, sweepIntervalMs = 3600000, advisoryLock = true } = {}) {
  const origin = publicOrigin ? new URL(publicOrigin) : null; if (origin && (!["http:","https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)) throw new Error("public_origin_invalid");
  const runtime = await createRailwayRuntime({database, advisoryLock, publicOrigin:origin?.origin}); const interest = await createInterestList({ database, publicOrigin: origin?.origin, operationsToken: process.env.BEBEBONJOUR_OPERATIONS_TOKEN,
    sendEmail: sendInterestEmail ?? (message => cloudflareTransport().send(message, { fenceExternalEffect: alreadyAdmitted })) });
  const handle = createHttpHandler(runtime, { interest });
  const server = createServer(async (req,res) => {
    try {
      const forwardedProto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
      const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
      const base = origin?.origin || `${forwardedProto}://${forwardedHost}`;
      const request = new Request(new URL(req.url, base), { method:req.method, headers:req.headers, ...(req.method === "GET" || req.method === "HEAD" ? {} : {body:Readable.toWeb(req), duplex:"half"}) });
      const response = await handle(request); res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await new Promise((resolve,reject) => { const stream = Readable.fromWeb(response.body); stream.on("error",reject); res.on("error",reject); res.on("finish",resolve); stream.pipe(res); }); else res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise((resolve,reject) => { server.once("error",reject); server.listen(port,host,resolve); });
  let polling = false;
  let pendingWake = false;
  const runPoll = async () => { if (polling) { pendingWake = true; return; } polling = true; try { do { pendingWake = false; while (await runtime.pollScheduler()) {} } while (pendingWake); } catch { console.error("scheduled_function_failed"); } finally { polling = false; } };
  runtime.setWake(() => { void runPoll(); });
  const poll = setInterval(runPoll,schedulerIntervalMs);
  const purgeInterest = () => interest.purge().catch(() => console.error("interest_purge_failed"));
  const sweep = setInterval(() => { runtime.runMutation("deliveryLoopData:sweep", {}).catch(() => console.error("hourly_sweep_failed")); void purgeInterest(); },sweepIntervalMs);
  poll.unref(); sweep.unref(); void runPoll(); void purgeInterest();
  return {server,runtime, async close() { clearInterval(poll); clearInterval(sweep); await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }};
}
export async function createRailwayBackend({ db, ...options } = {}) { return startRailwayServer({ database: db, ...options }); }

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const database = new pg.Pool({connectionString:process.env.DATABASE_URL});
  const app = await startRailwayServer({database,publicOrigin:process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN,port:Number(process.env.PORT || 8080),host:"0.0.0.0"});
  for (const signal of ["SIGTERM","SIGINT"]) process.once(signal, () => { app.close().then(()=>database.end()).then(()=>process.exit(0)); });
}
