#!/usr/bin/env node

import { runOperationsWorkerCommand } from "../src/operations/operations-worker-startup.mjs";

try {
  const result = await runOperationsWorkerCommand();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ status: "error", code: "worker_failed_safely" })}\n`);
  process.exitCode = 1;
}
