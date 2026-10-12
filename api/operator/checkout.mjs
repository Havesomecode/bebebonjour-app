import { ConvexHttpClient } from "convex/browser";

import { createScopedCheckoutHandler } from "../../src/http/scoped-checkout-handler.mjs";
import { runCheckoutWorkerCommand } from "../../src/operations/checkout-worker-startup.mjs";
import { createTallyCheckoutHandoff } from "../../src/operations/tally-checkout-handoff.mjs";

export const config = { runtime: "nodejs" };

export default createScopedCheckoutHandler({
  environment: process.env,
  handoff: async (jobId) => {
    const client = new ConvexHttpClient(process.env.CONVEX_URL);
    const handoff = createTallyCheckoutHandoff({
      client,
      operatorToken: process.env.BEBEBONJOUR_OPERATIONS_TOKEN,
      processJob: (id) => runCheckoutWorkerCommand({ client, environment: process.env, jobId: id }),
    });
    return handoff(jobId);
  },
});
