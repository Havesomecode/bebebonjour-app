import { loadFulfillmentConfig } from "../config/fulfillment-config.mjs";
import { createSupabaseFulfillmentStore } from "../persistence/supabase-fulfillment-store.mjs";
import {
  createStripeWebhookHandler,
  createTallyWebhookHandler,
} from "./webhook-handlers.mjs";

export function createLazyProductionWebhookHandler(provider, options = {}) {
  const environment = options.environment || process.env;
  const logger = options.logger || console;
  let handler;

  return async function lazyProductionWebhookHandler(request, response) {
    try {
      if (!handler) {
        const config = loadFulfillmentConfig(environment);
        const store = createSupabaseFulfillmentStore(config.supabase);
        handler = provider === "tally"
          ? createTallyWebhookHandler({ config: config.tally, store, logger })
          : createStripeWebhookHandler({ config: config.stripe, store, logger });
      }
      return await handler(request, response);
    } catch (error) {
      logger.error(`${provider} webhook initialization failed.`, {
        name: error?.name,
        message: error?.message,
      });
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({
        received: false,
        error: "Webhook service is not configured.",
      }));
    }
  };
}
