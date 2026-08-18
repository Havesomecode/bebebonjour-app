import { handle } from "hono/vercel";

import { createHostedCustomerFlowRuntime } from "../../src/customer-flow/hosted-runtime.mjs";

export const config = { runtime: "nodejs" };

const runtime = createHostedCustomerFlowRuntime();

export default handle(runtime.api);
