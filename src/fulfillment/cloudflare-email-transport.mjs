const SENDER = "Bébé Bonjour <bonjour@mail.havesomecode.io>";
const REPLY_TO = "contact@bebebonjour.com";
export function readCloudflareEmailConfiguration(config, environment = {}) {
  const allowed = new Set(["provider", "enabled", "accountId", "zoneId", "from", "replyTo"]);
  if (!config || Object.keys(config).some(key => !allowed.has(key))
      || config.provider !== "cloudflare" || config.enabled !== true
      || !/^[a-f0-9]{32}$/u.test(config.accountId || "") || !/^[a-f0-9]{32}$/u.test(config.zoneId || "")
      || config.from !== SENDER || config.replyTo !== REPLY_TO) {
    throw failure("cloudflare_configuration_invalid", false);
  }
  const sendToken = environment.BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN;
  if (typeof sendToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(sendToken)) {
    throw failure("cloudflare_configuration_invalid", false);
  }
  return Object.freeze({ ...config, sendToken });
}

// The callback fence must durably admit only the first attempt of this logical
// effect. Correlation headers are NOT provider-side idempotency. No HTTP retries.
export function createCloudflareEmailTransport(options = {}) {
  const config = readCloudflareEmailConfiguration(options.config, options.environment);
  const fetchImpl = options.fetch || globalThis.fetch;
  return Object.freeze({
    async reconcile() {
      // No documented lookup by application idempotency key. Started effects
      // without a persisted provider ID require operator reconciliation.
      return null;
    },
    async send(message, { fenceExternalEffect } = {}) {
      validateMessage(message);
      const payload = { from: { address: "bonjour@mail.havesomecode.io", name: "Bébé Bonjour" },
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
      // Adaptive analytics may omit later events through sampling; neither a
      // short page nor an apparent terminal event establishes completeness.
      throw failure("cloudflare_status_unavailable", true);
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
      || !/^(?:bb_[a-f0-9]{64}|bebe-loop:job_[A-Za-z0-9_-]+:[1-9][0-9]*:(?:draft_email|final_email|closure_notice)|bebe-notice:job_[A-Za-z0-9_-]+:[1-9][0-9]*:(?:operator_new|operator_correction|customer_payment)|bebe-interest:int_[a-f0-9]{24}:[1-9][0-9]*:confirmation)$/u.test(message.idempotencyKey)
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
