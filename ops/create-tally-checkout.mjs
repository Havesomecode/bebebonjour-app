#!/usr/bin/env node

import { ConvexHttpClient } from "convex/browser";

import { runOperationsWorkerCommand } from "../src/operations/operations-worker-startup.mjs";
import { createTallyCheckoutHandoff } from "../src/operations/tally-checkout-handoff.mjs";

// Operator-only, one explicit canonical job; never accepts a Tally event or a raw
// intake token. No customer, provider, or webhook data is logged on failure.
try {
  if (process.argv.length !== 3 || process.env.BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS !== "create_checkout") {
    throw new Error("invalid_checkout_scope");
  }
  const client = new ConvexHttpClient(process.env.CONVEX_URL);
  const handoff = createTallyCheckoutHandoff({
    client,
    operatorToken: process.env.BEBEBONJOUR_OPERATIONS_TOKEN,
    processJob: (jobId) => runOperationsWorkerCommand({
      client,
      environment: process.env,
      jobId,
    }),
  });
  const result = await handoff(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ status: "error", code: "checkout_handoff_unavailable" })}\n`);
  process.exitCode = 1;
}
