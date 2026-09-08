import { createLazyOperationsWorkerHttpHandler } from "../../src/http/operations-worker-handler.mjs";
import { runTestACompletionWorkerCommand } from "../../src/operations/production-completion-worker.mjs";

export const config = { runtime: "nodejs", maxDuration: 300 };

export default createLazyOperationsWorkerHttpHandler({
  runWorker: () => runTestACompletionWorkerCommand(),
});
