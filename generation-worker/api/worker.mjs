import { createLazyOperationsWorkerHttpHandler } from "../../src/http/operations-worker-handler.mjs";

export const config = { runtime: "nodejs", maxDuration: 300 };

export default createLazyOperationsWorkerHttpHandler();