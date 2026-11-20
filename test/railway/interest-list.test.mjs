import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createInterestList, CONSENT_TEXT } from "../../src/interest/interest-list.mjs";
import { createCloudflareEmailTransport } from "../../src/fulfillment/cloudflare-email-transport.mjs";

const origin = "https://www.bebebonjour.com";
const post = (path, body, headers = {}) => new Request(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const form = (path, t) => new Request(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t }).toString() });
const token = (text, route) => new RegExp(`/interest/${route}\\?t=([A-Za-z0-9_-]{43})`).exec(text)[1];

async function setup(t, extra = {}) {
  const database = new PGlite(); const sent = []; let clock = new Date("2026-11-20T10:00:00Z");
  const list = await createInterestList({ database, publicOrigin: origin, operationsToken: "ops-token-32-characters-long-xxxxx", now: () => clock, sendEmail: async m => { sent.push(m); }, ...extra });
  t.after(() => database.close());
  return { list, database, sent, advance: ms => { clock = new Date(clock.getTime() + ms); } };
}

test("subscribe, confirm, count, unsubscribe", async t => {
  const { list, sent } = await setup(t);
  const bad = await list.handle(post("/interest/subscribe", { email: "nope", consent: true })); assert.equal(bad.status, 400);
  const noConsent = await list.handle(post("/interest/subscribe", { email: "a@example.org", consent: false })); assert.equal(noConsent.status, 400); assert.equal((await noConsent.json()).error, "consent");
  assert.equal(sent.length, 0);
  const ok = await list.handle(post("/interest/subscribe", { email: " Parent@Example.org ", consent: true, website: "", source: "landing" }, { "x-forwarded-for": "1.2.3.4" }));
  assert.equal(ok.status, 200); assert.equal(sent.length, 1); assert.equal(sent[0].to, "parent@example.org");
  assert.match(sent[0].idempotencyKey, /^bebe-interest:int_[a-f0-9]{24}:1:confirmation$/);
  assert.equal((await list.stats()).confirmed_total, 0);
  const confirmToken = token(sent[0].text, "confirm"), unsubToken = token(sent[0].text, "unsubscribe");
  // a GET (mail scanner) never confirms
  const preview = await list.handle(new Request(`${origin}/interest/confirm?t=${confirmToken}`)); assert.equal(preview.status, 200); assert.match(await preview.text(), /<form method="post"/);
  assert.equal((await list.stats()).confirmed_total, 0);
  assert.equal((await list.handle(form("/interest/confirm", confirmToken))).status, 200);
  assert.equal((await list.stats()).confirmed_total, 1);
  assert.equal((await list.handle(form("/interest/confirm", confirmToken))).status, 200); // idempotent
  const unsubGet = await list.handle(new Request(`${origin}/interest/unsubscribe?t=${unsubToken}`)); assert.equal(unsubGet.status, 200);
  assert.equal((await list.stats()).confirmed_total, 1);
  assert.equal((await list.handle(form("/interest/unsubscribe", unsubToken))).status, 200);
  const stats = await list.stats(); assert.equal(stats.confirmed_total, 0); assert.equal(stats.weeks[0].unsubscribed, 1);
  assert.equal((await list.handle(new Request(`${origin}/interest/confirm?t=${"x".repeat(43)}`))).status, 404);
});

test("honeypot, double submit, expiry, re-subscribe, erase, auth", async t => {
  const { list, sent, advance, database } = await setup(t);
  assert.equal((await list.handle(post("/interest/subscribe", { email: "bot@example.org", consent: true, website: "http://spam" }))).status, 200);
  assert.equal(sent.length, 0);
  await list.handle(post("/interest/subscribe", { email: "a@example.org", consent: true }));
  await list.handle(post("/interest/subscribe", { email: "a@example.org", consent: true }));
  assert.equal(sent.length, 1, "no second mail within the hour");
  advance(2 * 3600 * 1000);
  await list.handle(post("/interest/subscribe", { email: "a@example.org", consent: true })); assert.equal(sent.length, 2);
  advance(8 * 24 * 3600 * 1000);
  assert.equal((await list.handle(form("/interest/confirm", token(sent[1].text, "confirm")))).status, 404, "expired link");
  await list.purge(); assert.equal((await database.query("SELECT count(*)::int AS n FROM interest_list")).rows[0].n, 0, "unconfirmed address purged after 7 days");
  // fresh signup, confirm, unsubscribe, re-subscribe needs a new confirmation
  await list.handle(post("/interest/subscribe", { email: "b@example.org", consent: true }));
  const m = sent.at(-1); await list.handle(form("/interest/confirm", token(m.text, "confirm"))); await list.handle(form("/interest/unsubscribe", token(m.text, "unsubscribe")));
  await list.handle(post("/interest/subscribe", { email: "b@example.org", consent: true })); assert.equal(sent.at(-1).idempotencyKey.endsWith(":2:confirmation"), true);
  assert.equal((await list.stats()).confirmed_total, 0);
  assert.equal((await list.handle(new Request(`${origin}/interest/stats`))).status, 401);
  const withToken = await list.handle(new Request(`${origin}/interest/stats`, { headers: { authorization: "Bearer ops-token-32-characters-long-xxxxx" } })); assert.equal(withToken.status, 200);
  const erase = await list.handle(new Request(`${origin}/interest/erase`, { method: "POST", headers: { authorization: "Bearer ops-token-32-characters-long-xxxxx" }, body: JSON.stringify({ email: "b@example.org" }) }));
  assert.equal((await erase.json()).erased, 1);
});

test("send failure is reported and retryable at once; per-address rate limit", async t => {
  let fail = true; const sent = [];
  const { list } = await setup(t, { sendEmail: async m => { if (fail) throw new Error("x"); sent.push(m); } });
  assert.equal((await list.handle(post("/interest/subscribe", { email: "c@example.org", consent: true }))).status, 500);
  fail = false;
  assert.equal((await list.handle(post("/interest/subscribe", { email: "c@example.org", consent: true }))).status, 200); assert.equal(sent.length, 1);
  for (let i = 0; i < 4; i++) await list.handle(post("/interest/subscribe", { email: `d${i}@example.org`, consent: true }));
  assert.equal((await list.handle(post("/interest/subscribe", { email: "e@example.org", consent: true }))).status, 429);
});

test("the real Cloudflare transport accepts the confirmation message", async () => {
  const calls = [];
  const transport = createCloudflareEmailTransport({ environment: { BEBEBONJOUR_CLOUDFLARE_EMAIL_TOKEN: "t".repeat(40) },
    config: { provider: "cloudflare", enabled: true, accountId: "a".repeat(32), zoneId: "b".repeat(32), from: "Bébé Bonjour <bonjour@mail.havesomecode.io>", replyTo: "contact@bebebonjour.com" },
    fetch: async (url, options) => { const body = JSON.parse(options.body); calls.push(body); return Response.json({ success: true, errors: [], result: { message_id: "<m@x>", delivered: [body.to], queued: [], permanent_bounces: [] } }); } });
  const list = await createInterestList({ database: new PGlite(), publicOrigin: origin, sendEmail: m => transport.send(m, { fenceExternalEffect: async (_e, issue) => issue() }) });
  assert.equal((await list.handle(post("/interest/subscribe", { email: "f@example.org", consent: true }))).status, 200);
  assert.equal(calls.length, 1); assert.match(calls[0].subject, /Confirmez/); assert.ok(CONSENT_TEXT);
});

test("the server purges stale unconfirmed addresses on its own, without any new sign-up", async t => {
  const { PGlite: Pg } = await import("@electric-sql/pglite"); const { startRailwayServer } = await import("../../server/railway.mjs");
  const database = new Pg(); const sent = [];
  const app = await startRailwayServer({ database, publicOrigin: origin, advisoryLock: false, schedulerIntervalMs: 3600000, sweepIntervalMs: 50, sendInterestEmail: async m => { sent.push(m); } });
  t.after(async () => { await app.close(); await database.close(); });
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/interest/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "stale@example.org", consent: true }) });
  assert.equal(res.status, 200);
  await database.query("UPDATE interest_list SET created_at = now() - interval '8 days', confirm_sent_at = now() - interval '8 days'");
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 50)); if ((await database.query("SELECT count(*)::int AS n FROM interest_list")).rows[0].n === 0) return; }
  assert.fail("stale pending address was not purged by the scheduled sweep");
});
