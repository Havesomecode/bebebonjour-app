import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresEmailEffects, createResendReceiptReader } from "../email-effects.mjs";
import { openTestDatabase } from "./database.mjs";
import { syntheticEmailIntent } from "./email-fixture.mjs";
const opaqueId = (intent) => `<CF.message+Case:${intent.jobId}/@zone.example>`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("durable email admission is one-shot across pools, restart and provider changes", async (t) => {
  const db = await openTestDatabase(t);
  const { intent, message } = await syntheticEmailIntent(db.pool);
  const opaque = opaqueId(intent);
  const left = createPostgresEmailEffects({ pool: db.pool });
  const right = createPostgresEmailEffects({ pool: db.newPool() });
  await left.prepare(intent);
  let issued = 0;
  const transport = { send: (value, { fenceExternalEffect }) => fenceExternalEffect({ effectMayBeIssued: true }, async () => {
    assert.deepEqual(value, message);
    assert.equal((await right.readEffect(intent.jobId, intent.idempotencyKey)).state, "issued");
    issued++;
    await pause(30);
    return { provider: "cloudflare", providerMessageId: opaque, idempotencyKey: intent.idempotencyKey };
  }) };
  const attempts = await Promise.allSettled([left.send(intent, message, transport), right.send(intent, message, transport)]);
  assert.deepEqual(attempts.map((a) => a.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(issued, 1);
  const restarted = createPostgresEmailEffects({ pool: db.newPool() });
  const replay = await restarted.send(intent, message, transport);
  assert.equal(replay.providerMessageId, opaque);
  assert.equal(issued, 1);
  await assert.rejects(() => restarted.prepare({ ...intent, provider: "resend" }), /email_intent_conflict/);
  await assert.rejects(() => restarted.prepare({ ...intent, leaseToken: "synthetic-new-lease-token-that-must-not-reset" }), /email_intent_conflict/);
  const raw = await db.pool.query("SELECT * FROM bb_candidate.email_effects WHERE idempotency_key=$1", [intent.idempotencyKey]);
  const text = JSON.stringify(raw.rows);
  assert.ok(!text.includes(intent.leaseToken));
  assert.doesNotMatch(text, /ledger@example\.test|Un message synthétique/);
});

test("lost database acknowledgement after acceptance returns the durable receipt without a second issue", async (t) => {
  const db = await openTestDatabase(t);
  const { intent, message } = await syntheticEmailIntent(db.pool);
  let lostAck = false;
  const faultingPool = { connect: db.pool.connect.bind(db.pool), async query(sql, values) {
    const result = await db.pool.query(sql, values);
    if (!lostAck && sql.includes("SET state='accepted',provider_message_id")) {
      lostAck = true;
      throw new Error("synthetic lost acknowledgement after SQL commit");
    }
    return result;
  } };
  const ledger = createPostgresEmailEffects({ pool: faultingPool });
  await ledger.prepare(intent);
  let issued = 0;
  const transport = { send: (_message, { fenceExternalEffect }) => fenceExternalEffect({ effectMayBeIssued: true }, async () => {
    issued++;
    return { provider: "cloudflare", providerMessageId: opaqueId(intent), idempotencyKey: intent.idempotencyKey };
  }) };
  await assert.rejects(() => ledger.send(intent, message, transport), /email_effect_uncertain/);
  const restarted = createPostgresEmailEffects({ pool: db.newPool() });
  assert.equal((await restarted.readEffect(intent.jobId, intent.idempotencyKey)).state, "accepted");
  assert.equal((await restarted.send(intent, message, transport)).providerMessageId, opaqueId(intent));
  assert.equal(issued, 1);
});

test("uncertain issuance stays fenced after restart, and expired intent never calls transport", async (t) => {
  const db = await openTestDatabase(t);
  const ledger = createPostgresEmailEffects({ pool: db.pool });
  const { intent, message } = await syntheticEmailIntent(db.pool);
  await ledger.prepare(intent);
  let calls = 0;
  const uncertain = { send: (_value, { fenceExternalEffect }) => fenceExternalEffect({ effectMayBeIssued: true }, async () => {
    calls++;
    throw new Error("provider body containing private information must not survive");
  }) };
  await assert.rejects(() => ledger.send(intent, message, uncertain), /email_effect_uncertain/);
  const restarted = createPostgresEmailEffects({ pool: db.newPool() });
  assert.equal((await restarted.readEffect(intent.jobId, intent.idempotencyKey)).state, "reconciliation_required");
  await assert.rejects(() => restarted.send(intent, message, uncertain), /email_reconciliation_required/);
  assert.equal(calls, 1);
  const stale = await syntheticEmailIntent(db.pool, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  await ledger.prepare(stale.intent);
  await assert.rejects(() => ledger.send(stale.intent, stale.message, uncertain), /email_lease_expired/);
  assert.equal(calls, 1);
  assert.equal((await ledger.readEffect(stale.intent.jobId, stale.intent.idempotencyKey)).state, "ready");
});

test("Resend receipt reader refuses an alternate origin and supplies a bounded GET signal", async () => {
  assert.throws(() => createResendReceiptReader({ client: { baseUrl: "https://not-resend.example.test", get() {} } }), /resend_inspection_unavailable/);
  const reader = createResendReceiptReader({ client: { baseUrl: "https://api.resend.com", async get(path, options) {
    assert.equal(path, "/emails/resend_bounded_12345678");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return { data: { id: "resend_bounded_12345678", last_event: "sent" }, error: null };
  } } });
  assert.equal((await reader({ providerMessageId: "resend_bounded_12345678" })).outcome, "pending");
});

test("stored provider, job and receipt identity bind historical Resend inspection", async (t) => {
  const db = await openTestDatabase(t);
  const { intent, message } = await syntheticEmailIntent(db.pool, { provider: "resend" });
  const resendId = `resend_${intent.jobId}`;
  let resendReads = 0;
  let cloudflareReads = 0;
  let result = { data: { id: resendId, last_event: "delivered" }, error: null };
  const resend = createResendReceiptReader({ client: { baseUrl: "https://api.resend.com", async get(path, options) {
    resendReads++;
    assert.equal(path, `/emails/${resendId}`);
    assert.equal(options.redirect, "error");
    return result;
  } } });
  const ledger = createPostgresEmailEffects({ pool: db.pool, readers: { resend,
    cloudflare: async () => { cloudflareReads++; throw new Error("wrong provider selected"); } } });
  await ledger.prepare(intent);
  await ledger.send(intent, message, { send: (_value, { fenceExternalEffect }) => fenceExternalEffect({ effectMayBeIssued: true }, async () => ({
    provider: "resend", providerMessageId: resendId, idempotencyKey: intent.idempotencyKey,
  })) });
  await assert.rejects(() => ledger.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey, provider: "cloudflare" }), /email_receipt_not_bound/);
  await assert.rejects(() => ledger.inspect({ jobId: "job_someone_else", idempotencyKey: intent.idempotencyKey }), /email_receipt_not_bound/);
  assert.equal(resendReads + cloudflareReads, 0);
  const inspected = await ledger.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey });
  assert.equal(inspected.outcome, "delivered");
  assert.equal(resendReads, 1);
  assert.equal(cloudflareReads, 0);
  result = { data: { id: "another_id", last_event: "delivered" }, error: null };
  await assert.rejects(() => ledger.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey }), /resend_inspection_unavailable/);
  result = { data: null, error: { statusCode: 401, message: "sending-only key" } };
  await assert.rejects(() => ledger.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey }), /resend_inspection_unavailable/);
  assert.equal((await ledger.readEffect(intent.jobId, intent.idempotencyKey)).state, "delivered");
});

test("opaque Cloudflare IDs and terminal failure survive readback without retry", async (t) => {
  const db = await openTestDatabase(t);
  const { intent, message } = await syntheticEmailIntent(db.pool);
  const opaque = opaqueId(intent);
  let issued = 0;
  let outcome = "failed";
  const ledger = createPostgresEmailEffects({ pool: db.pool, readers: { cloudflare: async ({ providerMessageId }) => {
    assert.equal(providerMessageId, opaque);
    return { providerMessageId, outcome, recordedAt: new Date().toISOString(), retryable: false,
      reasonCode: outcome === "failed" ? "cloudflare_delivery_failed" : null };
  } } });
  await ledger.prepare(intent);
  const transport = { send: (_value, { fenceExternalEffect }) => fenceExternalEffect({ effectMayBeIssued: true }, async () => {
    issued++;
    return { provider: "cloudflare", providerMessageId: opaque, idempotencyKey: intent.idempotencyKey };
  }) };
  await ledger.send(intent, message, transport);
  const failed = await ledger.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.retryable, false);
  assert.equal(failed.reasonCode, "cloudflare_delivery_failed");
  const saved = await ledger.readEffect(intent.jobId, intent.idempotencyKey);
  assert.equal(saved.state, "failed");
  assert.equal(saved.receipt.providerMessageId, opaque);
  await assert.rejects(() => ledger.send(intent, message, transport), /email_terminal_failure/);
  assert.equal(issued, 1);
  outcome = "delivered";
  await assert.rejects(() => ledger.inspect({ jobId: intent.jobId, idempotencyKey: intent.idempotencyKey }), /email_inspection_conflict/);
  assert.equal((await ledger.readEffect(intent.jobId, intent.idempotencyKey)).state, "failed");
});
