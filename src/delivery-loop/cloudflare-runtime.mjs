import { createCloudflareEmailTransport } from '../fulfillment/cloudflare-email-transport.mjs';

export function cloudflareConfig(environment = process.env) {
  return {
    provider: 'cloudflare', enabled: true,
    accountId: environment.BEBEBONJOUR_CLOUDFLARE_ACCOUNT_ID,
    zoneId: environment.BEBEBONJOUR_CLOUDFLARE_ZONE_ID,
    from: 'Bébé Bonjour <bonjour@mail.havesomecode.io>', replyTo: 'contact@bebebonjour.com',
  };
}

export function cloudflareTransport(environment = process.env) {
  return createCloudflareEmailTransport({ environment, config: cloudflareConfig(environment) });
}

// The action may invoke this only after its own durable admission has committed.
export const alreadyAdmitted = async (_effect, issue) => issue();
