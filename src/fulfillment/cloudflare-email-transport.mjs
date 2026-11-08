const SENDER = "Bébé Bonjour <bonjour@updates.bebebonjour.com>";
const REPLY_TO = "contact@bebebonjour.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_LIMIT = 50;
const QUERY = `query BebeEmailStatus($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      emailSendingAdaptive(filter: { datetime_geq: $start, datetime_leq: $end },
        limit: 50, orderBy: [datetime_DESC]) { messageId status datetime }
    }
  }
}`;

export function readCloudflareEmailConfiguration(config, environment = {}) {
  const allowed = new Set(["provider", "enabled", "accountId", "zoneId", "from", "replyTo"]);
  if (!config || Object.keys(config).some(key => !allowed.has(key))
      || config.provider !== "cloudflare" || config.enabled !== true
      || !/^[a-f0-9]{32}$/u.test(config.accountId || "") || !/^[a-f0-9]{32}$/u.test(config.zoneId || "")
      || config.from !== SENDER || config.replyTo !== REPLY_TO) {
    throw failure("cloudflare_configuration_invalid", false);
  }
  const sendToken = environment.BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN;
  const analyticsToken = environment.BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN;
  if (![sendToken, analyticsToken].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/u.test(value))) {
    throw failure("cloudflare_configuration_invalid", false);
  }
  return Object.freeze({ ...config, sendToken, analyticsToken });
}

// The callback fence must durably admit only the first attempt of this logical
// effect. Correlation headers are NOT provider-side idempotency. No HTTP retries.
export function createCloudflareEmailTransport(options = {}) {
  const config = readCloudflareEmailConfiguration(options.config, options.environment);
  const fetchImpl = options.fetch || globalThis.fetch;
  const clock = options.clock || (() => new Date().toISOString());
  return Object.freeze({
    async reconcile() {
      // No documented lookup by application idempotency key. Started effects
      // without a persisted provider ID require operator reconciliation.
      return null;
    },
    async send(message, { fenceExternalEffect } = {}) {
      validateMessage(message);
      const payload = { from: { address: "bonjour@updates.bebebonjour.com", name: "Bébé Bonjour" },
        to: message.to, reply_to: config.replyTo, subject: message.subject, html: message.html, text: message.text,
        headers: { "X-Bebe-Operation": message.idempotencyKey } };
      const idempotencyKey = message.idempotencyKey;
      if (typeof fenceExternalEffect !== "function") throw failure("cloudflare_fence_required", false);
      let invoked = false;
      return fenceExternalEffect({ effectMayBeIssued: true }, async () => {
        if (invoked) throw failure("cloudflare_fence_repeated", false);
        invoked = true;
        const body = await requestJson(fetchImpl,
          `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`,
          config.sendToken, payload, "cloudflare_send_uncertain", false);
        const result = body?.result;
        if (body?.success !== true || !Array.isArray(body.errors) || body.errors.length !== 0
            || !isMessageId(result?.message_id)) throw failure("cloudflare_send_uncertain", false);
        const delivered = result.delivered;
        const queued = result.queued;
        const bounced = result.permanent_bounces;
        const suppressed = result.suppressed_recipients ?? [];
        if (![delivered, queued, bounced, suppressed].every(Array.isArray)
            || [...delivered, ...queued, ...bounced, ...suppressed].some(address => address !== payload.to)
            || delivered.length + queued.length + bounced.length + suppressed.length !== 1) {
          throw failure("cloudflare_send_uncertain", false);
        }
        if (bounced.length || suppressed.length) throw failure("cloudflare_recipient_rejected", false);
        return { provider: "cloudflare", providerMessageId: result.message_id, idempotencyKey };
      });
    },
    async status({ providerMessageId } = {}) {
      if (!isMessageId(providerMessageId)) throw failure("cloudflare_status_input_invalid", false);
      const end = clock();
      const endMs = Date.parse(end);
      if (!Number.isFinite(endMs)) throw failure("cloudflare_status_input_invalid", false);
      const start = new Date(endMs - DAY_MS).toISOString();
      const body = await requestJson(fetchImpl, "https://api.cloudflare.com/client/v4/graphql",
        config.analyticsToken, { query: QUERY, variables: { zoneTag: config.zoneId, start, end } },
        "cloudflare_status_unavailable", true);
      const zones = body?.data?.viewer?.zones;
      const events = zones?.[0]?.emailSendingAdaptive;
      if ((body?.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length))
          || !Array.isArray(zones) || zones.length !== 1 || !Array.isArray(events)
          || events.length >= EVENT_LIMIT || events.some(event => !event || !isMessageId(event.messageId)
            || typeof event.status !== "string" || typeof event.datetime !== "string"
            || !Number.isFinite(Date.parse(event.datetime)) || Date.parse(event.datetime) > endMs
            || Date.parse(event.datetime) < endMs - DAY_MS)) {
        throw failure("cloudflare_status_unavailable", true);
      }
      const matches = events.filter(event => event.messageId === providerMessageId)
        .sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime));
      const latest = matches[0];
      if (!latest || matches.some(event => Date.parse(event.datetime) === Date.parse(latest.datetime)
          && event.status !== latest.status)) throw failure("cloudflare_status_unavailable", true);
      const outcomes = { sent: "pending", delivered: "delivered", deliveryFailed: "failed", rejected: "failed", failed: "failed" };
      const outcome = Object.hasOwn(outcomes, latest.status) ? outcomes[latest.status] : null;
      if (!outcome) throw failure("cloudflare_status_unavailable", true);
      const failureCodes = { deliveryFailed: "cloudflare_delivery_failed", rejected: "cloudflare_rejected", failed: "cloudflare_failed" };
      return { providerMessageId, outcome, recordedAt: new Date(endMs).toISOString(), retryable: false,
        reasonCode: outcome === "failed" ? failureCodes[latest.status] : null };
    },
  });
}

async function requestJson(fetchImpl, url, token, body, reasonCode, retryable) {
  try {
    const response = await fetchImpl(url, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("http_failure");
    return await response.json();
  } catch {
    // Provider responses/errors can contain recipient details or credentials.
    // Emit a stable code only, never the untrusted response as cause/message.
    throw failure(reasonCode, retryable);
  }
}

function validateMessage(message) {
  const allowed = new Set(["from", "to", "subject", "html", "text", "idempotencyKey"]);
  if (!message || Object.keys(message).some(key => !allowed.has(key))
      || typeof message.to !== "string" || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u.test(message.to)
      || message.to.length > 254 || /[\x00-\x1f\x7f]/u.test(message.subject || "")
      || [message.subject, message.html, message.text].some(value => typeof value !== "string"
        || !value.trim() || Buffer.byteLength(value, "utf8") > 32_000)
      || (message.from !== undefined && message.from !== SENDER)
      || typeof message.idempotencyKey !== "string"
      || !/^(?:bb_[a-f0-9]{64}|bebe-loop:job_[A-Za-z0-9_-]+:[1-9][0-9]*:(?:draft_email|final_email|closure_notice))$/u.test(message.idempotencyKey)
      || message.idempotencyKey.length > 200) {
    throw failure("cloudflare_input_invalid", false);
  }
}

function isMessageId(value) {
  return typeof value === "string" && /^[\x21-\x7e]{1,998}$/u.test(value);
}

function failure(reasonCode, retryable) {
  return Object.assign(new Error(reasonCode), { reasonCode, retryable });
}
