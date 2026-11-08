import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createCandidateRuntime, loadConfig } from "./runtime.mjs";

export function startCandidateServer(environment = process.env) {
  const config = loadConfig(environment);
  const runtime = createCandidateRuntime({ config });
  const server = serve({ fetch: runtime.api.fetch, hostname: "0.0.0.0", port: config.port });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  let stopping = null;
  const stop = () => stopping ||= (async () => {
    const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
    try {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await runtime.close();
    } finally { clearTimeout(deadline); }
  })();
  return { server, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { server, stop } = startCandidateServer();
    server.on("error", () => { console.error("candidate_http_listener_failed"); process.exitCode = 1; void stop(); });
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
      void stop().catch(() => { console.error("candidate_shutdown_failed"); process.exitCode = 1; });
    });
  } catch { console.error("candidate_startup_configuration_invalid"); process.exitCode = 1; }
}
