import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Resend } from "resend";
import { materializeCorrectedMail, CORRECTED_MAIL_COMMIT } from "../materialize-mail.mjs";
import { createPostgresEmailEffects, createResendReceiptReader } from "../email-effects.mjs";
import { openTestDatabase } from "./database.mjs";
import { syntheticEmailIntent } from "./email-fixture.mjs";

const { root, receipt } = await materializeCorrectedMail();
after(() => rm(root, { recursive: true, force: true }));
assert.equal(receipt.commit, CORRECTED_MAIL_COMMIT);
console.log(`MAIL_SOURCE_RECEIPT=${JSON.stringify(receipt)}`);
const { createCloudflareEmailTransport } = await import(pathToFileURL(path.join(root, "src/fulfillment/cloudflare-email-transport.mjs")));
const config = { provider: "cloudflare", enabled: true, accountId: "a".repeat(32), zoneId: "b".repeat(32),
  from: "Bébé Bonjour <bonjour@updates.bebebonjour.com>", replyTo: "contact@bebebonjour.com" };
const environment = { BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: "synthetic_send_token_not_real",
  BEBEBONJOUR_CLOUDFLARE_ANALYTICS_TOKEN: "synthetic_read_token_not_real" };
const json = (value) => ({ ok: true, json: async () => value });

test("corrected Cloudflare transport composes with durable one-shot PostgreSQL and opaque terminal receipts", async (t) => {
  const db = await openTestDatabase(t);
  const { intent, message } = await syntheticEmailIntent(db.pool);
  const prefix = `<CF.Message+${intent.jobId}:Case/`;
  const suffix = "@opaque.example>";
  const opaque = `${prefix}${"x".repeat(998 - prefix.length - suffix.length)}${suffix}`;
  assert.equal(opaque.length, 998);
  let sends = 0;
  let reads = 0;
  const transport = createCloudflareEmailTransport({ config, environment, fetch: async (url, options) => {
    assert.equal(options.redirect, "error");
    const payload = JSON.parse(options.body);
    if (url === `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`) {
      sends++;
      assert.equal(payload.headers["X-Bebe-Operation"], intent.idempotencyKey);
      assert.equal(payload.to, message.to);
      const persisted = (await db.pool.query("SELECT state FROM bb_candidate.email_effects WHERE idempotency_key=$1", [intent.idempotencyKey])).rows[0];
      assert.equal(persisted.state, "issued");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json({ success: true, errors: [], result: { message_id: opaque,
        delivered: [], queued: [message.to], permanent_bounces: [], suppressed_recipients: [] } });
    }
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    reads++;
    assert.equal(payload.variables.zoneTag, config.zoneId);
    assert.ok(!url.includes(opaque));
    return json({ data: { viewer: { zones: [{ emailSendingAdaptive: [
      { messageId: opaque.toLowerCase(), status: "delivered", datetime: new Date(Date.now() - 1_000).toISOString() },
      { messageId: opaque, status: "deliveryFailed", datetime: new Date(Date.now() - 1_000).toISOString() },
    ] }] } } });
  } });
  const ledger = createPostgresEmailEffects({ pool: db.pool, readers: { cloudflare: transport.status } });
  await ledger.prepare(intent);
  const parallel = await Promise.allSettled([ledger.send(intent, message, transport), ledger.send(intent, message, transport)]);
  assert.deepEqual(parallel.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(sends, 1);
  const restarted = createPostgresEmailEffects({ pool: db.newPool(), readers: { cloudflare: transport.status } });
  assert.equal((await restarted.send(intent, message, transport)).providerMessageId, opaque);
  assert.equal(sends, 1);
  const inspected = await restarted.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey });
  assert.equal(inspected.outcome, "failed");
  assert.equal(inspected.reasonCode, "cloudflare_delivery_failed");
  assert.equal(inspected.retryable, false);
  assert.equal(reads, 1);
  const persisted = await restarted.readEffect(intent.jobId, intent.idempotencyKey);
  assert.equal(persisted.state, "failed");
  assert.equal(persisted.receipt.providerMessageId, opaque);
  await assert.rejects(() => restarted.send(intent, message, transport), /email_terminal_failure/);
  assert.equal(sends, 1);
});

test("corrected transport cannot repeat an uncertain effect under a new process or lease", async (t) => {
  const db = await openTestDatabase(t);
  const { intent, message } = await syntheticEmailIntent(db.pool);
  let sends = 0;
  const transport = createCloudflareEmailTransport({ config, environment, fetch: async () => {
    sends++;
    throw new Error("synthetic connection lost after remote acceptance, not a real provider call");
  } });
  const ledger = createPostgresEmailEffects({ pool: db.pool });
  await ledger.prepare(intent);
  await assert.rejects(() => ledger.send(intent, message, transport), /email_effect_uncertain/);
  const restarted = createPostgresEmailEffects({ pool: db.newPool() });
  await assert.rejects(() => restarted.send(intent, message, transport), /email_reconciliation_required/);
  await assert.rejects(() => restarted.prepare({ ...intent, leaseToken: "synthetic_new_lease_must_not_reset_fence" }), /email_intent_conflict/);
  assert.equal(sends, 1);
});

test("actual Resend SDK reads only its stored synthetic receipt while Cloudflare selection stays separate", async (t) => {
  const db = await openTestDatabase(t);
  const { intent, message } = await syntheticEmailIntent(db.pool, { provider: "resend" });
  const id = `resend_${intent.jobId}`;
  let gets = 0;
  let cloudflareReads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `https://api.resend.com/emails/${id}`);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    gets++;
    return new Response(JSON.stringify({ id, last_event: "delivered" }), { status: 200,
      headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reader = createResendReceiptReader({ client: new Resend("re_synthetic_not_a_real_key", { baseUrl: "https://api.resend.com" }) });
  const ledger = createPostgresEmailEffects({ pool: db.pool, readers: { resend: reader,
    cloudflare: async () => { cloudflareReads++; throw new Error("must not inspect historical Resend with Cloudflare"); } } });
  await ledger.prepare(intent);
  await ledger.send(intent, message, { send: (_payload, { fenceExternalEffect }) => fenceExternalEffect({ effectMayBeIssued: true }, async () => ({
    provider: "resend", providerMessageId: id, idempotencyKey: intent.idempotencyKey,
  })) });
  await assert.rejects(() => ledger.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey, provider: "cloudflare" }), /email_receipt_not_bound/);
  assert.equal((await ledger.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey })).outcome, "delivered");
  assert.equal(gets, 1);
  assert.equal(cloudflareReads, 0);
});
