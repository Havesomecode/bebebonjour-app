import { createLazyOperationsWorkerHttpHandler } from "../../src/http/operations-worker-handler.mjs";
import { runCanonicalTestCompletionWorkerCommand } from "../../src/operations/canonical-test-completion-worker.mjs";

export const config = { runtime: "nodejs", maxDuration: 300 };

export default createLazyOperationsWorkerHttpHandler({
  runWorker: () => runCanonicalTestCompletionWorkerCommand(),
});
