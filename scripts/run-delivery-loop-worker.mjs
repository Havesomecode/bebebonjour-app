#!/usr/bin/env node
import { createBackendClient } from "../src/backend/client.mjs";
import { createDeliveryLoopWorker, DeliveryLoopWorkerError } from "../src/delivery-loop/worker.mjs";

const HELP = `Usage: node scripts/run-delivery-loop-worker.mjs [--once]

Processes one job at a time; polls every five seconds by default.
--once processes at most one claimed stage and exits.

Required environment:
  BEBEBONJOUR_BACKEND_URL            HTTPS backend origin
  BEBEBONJOUR_DELIVERY_LOOP_TOKEN     Scoped backend worker token
Optional:
  BEBEBONJOUR_DELIVERY_LOOP_WORKER_ID (default: bebe-delivery-loop)
  BEBEBONJOUR_DELIVERY_LOOP_STATE_DIR (absolute private durable directory)
  BEBEBONJOUR_COMPOSITION_MODEL      (default: gpt-5.6-sol)
  BEBEBONJOUR_COMPOSITION_TIMEOUT_MS (default/max: 300000)
  BEBEBONJOUR_DELIVERY_LOOP_POLL_MS   (default: 5000; range: 1000..60000)

Text uses the existing locally authenticated Codex ChatGPT subscription.
Narration and email use scoped backend provider actions; no API keys are required
by this worker. The sendEmail action owns fencing and backend completion.
SIGTERM/SIGINT stop polling, abort composition and reconcile uncertain effects.
`;

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(HELP);
  } else {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--once")) throw new DeliveryLoopWorkerError("worker_arguments_rejected");
    const environment = process.env;
    let url;
    try {
      url = new URL(environment.BEBEBONJOUR_BACKEND_URL);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !environment.BEBEBONJOUR_DELIVERY_LOOP_TOKEN) throw new Error();
    } catch { throw new DeliveryLoopWorkerError("worker_configuration_rejected"); }
    const pollIntervalMs = Number(environment.BEBEBONJOUR_DELIVERY_LOOP_POLL_MS ?? 5000);
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60_000) throw new DeliveryLoopWorkerError("worker_configuration_rejected");
    // Provider exceptions can contain sensitive data; the client does not log them.
    const client = createBackendClient(url.origin);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      const worker = createDeliveryLoopWorker({ client, environment });
      const result = await worker.run({ once: args[0] === "--once", signal: controller.signal, pollIntervalMs });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === "failed") process.exitCode = 1;
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  }
} catch (error) {
  const code = error instanceof DeliveryLoopWorkerError ? error.reasonCode : "worker_failed_safely";
  process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
  process.exitCode = 1;
}
