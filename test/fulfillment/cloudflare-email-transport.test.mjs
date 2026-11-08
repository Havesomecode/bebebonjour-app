import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createCloudflareEmailTransport,
  readCloudflareEmailConfiguration,
} from "../../src/fulfillment/cloudflare-email-transport.mjs";

const config = { provider: "cloudflare", enabled: true, accountId: "a".repeat(32), zoneId: "b".repeat(32),
  from: "Bébé Bonjour <bonjour@mail.havesomecode.io>", replyTo: "contact@bebebonjour.com" };
const environment = { BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: "synthetic-send-token",
  BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN: "synthetic-read-token" };
const message = { to: "recipient@example.invalid", subject: "Une annonce est prête", html: "<p>Annonce</p>",
  text: "Annonce", idempotencyKey: "bebe-loop:job_synthetic_001:1:draft_email" };
const messageId = "<synthetic-001@updates.bebebonjour.com>";
const now = "2026-11-08T11:00:00.000Z";
const fence = async (options, mutation) => { assert.deepEqual(options, { effectMayBeIssued: true }); return mutation(); };
const accepted = (result = {}) => ({ success: true, errors: [], result: { message_id: messageId,
  queued: [message.to], delivered: [], permanent_bounces: [], ...result } });
const analytics = (events) => ({ data: { viewer: { zones: [{ emailSendingAdaptive: events }] } } });
function setup(fetchImpl) {
  return createCloudflareEmailTransport({ config, environment, fetch: fetchImpl, clock: () => now });
}
const json = (value, status = 200) => Response.json(value, { status });

test("Cloudflare configuration is explicit, strict, inert by default and snapshots credentials", async () => {
  const example = JSON.parse(await readFile(new URL("../../ops/cloudflare-email.example.json", import.meta.url)));
  assert.throws(() => readCloudflareEmailConfiguration(example, environment), /configuration/i);
  for (const change of [ { enabled: false }, { enabled: "true" }, { provider: "resend" },
    { accountId: ` ${config.accountId}` }, { zoneId: "not-an-id" }, { from: "other@example.invalid" },
    { replyTo: "z@havesomecode.io" }, { endpoint: "https://example.invalid" } ]) {
    assert.throws(() => readCloudflareEmailConfiguration({ ...config, ...change }, environment), /configuration/i);
  }
  for (const env of [{}, { RESEND_API_KEY: "synthetic" }, { ...environment, BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN: "" },
    { ...environment, BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: "bad\r\nheader" }]) {
    assert.throws(() => readCloudflareEmailConfiguration(config, env), /configuration/i);
  }
  const mutable = { ...config };
  const env = { ...environment };
  const checked = readCloudflareEmailConfiguration(mutable, env);
  mutable.accountId = "x"; env.BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN = "x";
  assert.equal(checked.accountId, config.accountId);
  assert.equal(checked.sendToken, environment.BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN);
  assert(Object.isFrozen(checked));
});

test("REST preserves real delivery-loop content, support reply-to and opaque message ID behind the lease fence", async () => {
  let fences = 0;
  const transport = setup(async (url, options) => {
    assert.equal(fences, 1);
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert(options.signal instanceof AbortSignal);
    assert.equal(options.headers.authorization, `Bearer ${environment.BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN}`);
    assert(!("idempotency-key" in options.headers));
    assert.deepEqual(JSON.parse(options.body), { to: message.to,
      from: { address: "bonjour@mail.havesomecode.io", name: "Bébé Bonjour" },
      reply_to: config.replyTo, subject: message.subject, html: message.html, text: message.text,
      headers: { "X-Bebe-Operation": message.idempotencyKey } });
    return json(accepted());
  });
  assert.deepEqual(await transport.send(message, { fenceExternalEffect: async (...args) => { fences++; return fence(...args); } }),
    { provider: "cloudflare", providerMessageId: messageId, idempotencyKey: message.idempotencyKey });
  assert.equal(await transport.reconcile(), null);
});

test("closure notices retain their separate logical email identity", async () => {
  const notice = { ...message, idempotencyKey: "bebe-loop:job_synthetic_001:1:closure_notice" };
  let calls = 0;
  const transport = setup(async () => { calls++; return json(accepted()); });
  const receipt = await transport.send(notice, { fenceExternalEffect: fence });
  assert.equal(receipt.idempotencyKey, notice.idempotencyKey);
  assert.equal(calls, 1);
});

test("validation or a refused fence causes zero provider calls", async () => {
  let calls = 0;
  const transport = setup(async () => { calls++; throw new Error("unexpected"); });
  for (const change of [ { to: [message.to] }, { to: "a@example.invalid,b@example.invalid" }, { to: " a@example.invalid" },
    { subject: "bad\nheader" }, { text: "" }, { html: "x".repeat(32_001) }, { idempotencyKey: "bad\r\nheader" },
    { from: "bad@example.invalid" }, { cc: [message.to] }, { headers: { Bcc: message.to } } ]) {
    await assert.rejects(transport.send({ ...message, ...change }, { fenceExternalEffect: fence }), /input/i);
  }
  await assert.rejects(transport.send(message), /fence/i);
  await assert.rejects(transport.send(message, { fenceExternalEffect: async () => { throw new Error("lease_lost"); } }), /lease_lost/);
  assert.equal(calls, 0);
});

test("a fence cannot invoke the same HTTP mutation callback twice", async () => {
  let calls = 0;
  const transport = setup(async () => { calls++; return json(accepted()); });
  await assert.rejects(transport.send(message, { fenceExternalEffect: async (_options, mutate) => {
    await mutate();
    return mutate();
  } }), /cloudflare_fence_repeated/);
  assert.equal(calls, 1);
});

test("no send errors trigger a retry or provider fallback; untrusted provider content is not logged", async () => {
  const cases = [
    () => { throw new Error("private recipient and secret-token"); },
    () => new Response("not-json"),
    () => json(accepted(), 403), () => json(accepted(), 429), () => json(accepted(), 503),
    () => json({ ...accepted(), success: false }), () => json({ ...accepted(), errors: [{ code: 1, message: "private" }] }),
    () => json(accepted({ message_id: undefined })), () => json(accepted({ message_id: "bad\r\nid" })),
    () => json(accepted({ queued: [] })), () => json(accepted({ queued: ["other@example.invalid"] })),
    () => json(accepted({ queued: [message.to], delivered: [message.to] })),
    () => json(accepted({ permanent_bounces: [message.to], queued: [] })),
    () => json(accepted({ suppressed_recipients: [message.to], queued: [] })),
    () => json(accepted({ suppressed_recipients: "malformed" })),
  ];
  for (const response of cases) {
    let calls = 0;
    const transport = setup(async () => { calls++; return response(); });
    await assert.rejects(transport.send(message, { fenceExternalEffect: fence }), (error) => {
      assert.equal(error.retryable, false);
      assert.match(error.reasonCode, /^cloudflare_/);
      assert(!/private|secret-token|recipient@example/.test(String(error)));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("status finds a recent or old receipt in a busy zone without trusting truncated results", async () => {
  for (const ageDays of [0, 20]) {
    const end = Date.parse(now);
    const target = { messageId, status: "delivered", datetime: new Date(end - ageDays * 86400000 - 1000).toISOString() };
    const noise = Array.from({ length: 80 }, (_, i) => ({ messageId: `noise-${i}`, status: "sent", datetime: new Date(end - i * 60000).toISOString() }));
    let calls = 0;
    const transport = setup(async (_url, options) => {
      calls++;
      const { start, end } = JSON.parse(options.body).variables;
      const rows = [...noise, target].filter(e => e.datetime >= start && e.datetime <= end)
        .sort((a, b) => b.datetime.localeCompare(a.datetime)).slice(0, 50);
      return json(analytics(rows));
    });
    assert.equal((await transport.status({ providerMessageId: messageId })).outcome, "delivered");
    assert(calls > 1 && calls <= 128);
  }
});

test("a truly saturated timestamp and conflicting latest events fail closed", async () => {
  const at = "2026-11-08T10:59:00.000Z";
  for (const events of [
    Array.from({ length: 50 }, (_, i) => ({ messageId: i ? `other-${i}` : messageId, status: "delivered", datetime: at })),
    [{ messageId, status: "delivered", datetime: at }, { messageId, status: "failed", datetime: at }],
  ]) {
    let calls = 0;
    const transport = setup(async (_url, options) => {
      calls++;
      const { start, end } = JSON.parse(options.body).variables;
      return json(analytics(events.filter(event => event.datetime >= start && event.datetime <= end)));
    });
    await assert.rejects(transport.status({ providerMessageId: messageId }), /cloudflare_status_unavailable/);
    assert(calls <= 128);
  }
});

test("status reads only bounded metadata, matches exact ID, and never equates sent with delivered", async () => {
  const mapping = { sent: "pending", delivered: "delivered", deliveryFailed: "failed", rejected: "failed", failed: "failed" };
  for (const [status, outcome] of Object.entries(mapping)) {
    let calls = 0;
    const transport = setup(async (url, options) => {
      calls++;
      assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
      assert.equal(options.headers.authorization, `Bearer ${environment.BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN}`);
      assert.equal(options.redirect, "error");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.variables, { zoneTag: config.zoneId, start: "2026-10-08T11:01:00.000Z", end: now });
      assert.match(body.query, /emailSendingAdaptive/);
      assert.match(body.query, /limit: 50/);
      assert(!/\b(subject|from|to|errorDetail)\b/.test(body.query));
      return json(analytics([
        { messageId: "different", status: "delivered", datetime: now },
        { messageId, status, datetime: "2026-11-08T10:59:00.000Z" },
        { messageId, status: "sent", datetime: "2026-11-08T10:58:00.000Z" },
      ]));
    });
    const result = await transport.status({ providerMessageId: messageId });
    assert.equal(result.providerMessageId, messageId);
    assert.equal(result.outcome, outcome);
    assert.equal(result.retryable, false);
    const reasonCodes = { deliveryFailed: "cloudflare_delivery_failed", rejected: "cloudflare_rejected", failed: "cloudflare_failed" };
    assert.equal(result.reasonCode, outcome === "failed" ? reasonCodes[status] : null);
    assert.equal(calls, 1);
  }
});

test("absent, truncated, unknown, conflicting or invalid status cannot confirm delivery", async () => {
  const event = { messageId, status: "delivered", datetime: now };
  const responses = [
    {}, analytics([]), { errors: [{ message: "private" }], ...analytics([event]) },
    { data: { viewer: { zones: [] } } }, analytics([{ ...event, messageId: "different" }]),
    analytics([{ ...event, status: "opened" }]), analytics([{ ...event, datetime: "bad" }]),
    analytics([{ ...event, datetime: "2026-11-09T00:00:00Z" }]),
    analytics([{ ...event, datetime: "2026-10-07T00:00:00Z" }]),
    analytics([event, { ...event, status: "failed" }]),
    analytics(Array.from({ length: 50 }, () => event)), analytics([event, null]),
  ];
  for (const body of responses) {
    const transport = setup(async () => json(body));
    await assert.rejects(transport.status({ providerMessageId: messageId }), error => {
      assert.equal(error.reasonCode, "cloudflare_status_unavailable");
      assert.equal(error.retryable, true);
      return true;
    });
  }
  for (const response of [async () => { throw new Error("private"); }, async () => new Response("bad"),
    async () => json(analytics([event]), 403)]) {
    await assert.rejects(setup(response).status({ providerMessageId: messageId }), /cloudflare_status_unavailable/);
  }
});
