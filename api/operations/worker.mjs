import { createLazyOperationsWorkerHttpHandler } from "../../src/http/operations-worker-handler.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

export default createLazyOperationsWorkerHttpHandler();
