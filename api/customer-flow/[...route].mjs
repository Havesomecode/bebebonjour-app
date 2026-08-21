import { getRequestListener } from "@hono/node-server";

import { createHostedCustomerFlowRuntime } from "../../src/customer-flow/hosted-runtime.mjs";

export const config = { runtime: "nodejs" };

const runtime = createHostedCustomerFlowRuntime();

export default getRequestListener(runtime.api.fetch);
