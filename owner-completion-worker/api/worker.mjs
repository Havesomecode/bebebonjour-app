import { createLazyOperationsWorkerHttpHandler } from "../../src/http/operations-worker-handler.mjs";
import { runOwnerCompletionWorkerCommand } from "../../src/operations/production-owner-completion-worker.mjs";

export const config = { runtime: "nodejs", maxDuration: 300 };

export default createLazyOperationsWorkerHttpHandler({
  runWorker: () => runOwnerCompletionWorkerCommand(),
});
