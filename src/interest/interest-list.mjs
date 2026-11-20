import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Interest list for bebebonjour.com: double opt-in, one-click unsubscribe.
// Spec: ~/Documents/marketing/listes-interet/SCHEMA.md and bebebonjour.md.
export const LIST = "bebebonjour";
export const CONSENT_VERSION = "v1-2026-11-20";
export const CONSENT_TEXT = "Je souhaite recevoir par courriel des nouvelles de Bébé Bonjour.";
const CONFIRM_TTL_MS = 7 * 24 * 3600 * 1000;
const RESEND_MIN_MS = 3600 * 1000;
const GLOBAL_REQUESTS_PER_HOUR = 300;
const IP_REQUESTS_PER_HOUR = 5;
const EMAIL = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+\.[^\s@<>,;"()[\]\\]+$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const token = () => randomBytes(32).toString("base64url");
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const digest = value => createHash("sha256").update(String(value)).digest();

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · Bébé Bonjour</title><style>:root{color-scheme:light}body{margin:0;padding:clamp(24px,6vw,72px) 20px;background:#f5f0e6;color:#20251f;font:18px/1.6 Georgia,serif}main{max-width:560px;margin:auto}h1{font-size:clamp(30px,6vw,42px);line-height:1.15;margin:0 0 .5em}a{color:#2f5443}button{font:inherit;min-height:48px;padding:0 24px;border:1px solid #2f5443;border-radius:8px;background:#2f5443;color:#fffdf8;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #2f5443;outline-offset:3px}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}<p><a href="https://www.bebebonjour.com/">Retour à bebebonjour.com</a></p></main></body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

const json = (status, value) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export function confirmationEmail({ confirmUrl, unsubscribeUrl, privacyUrl }) {
  const intro = "Vous avez demandé à être prévenu·e des nouveautés de Bébé Bonjour. Pour confirmer que cette adresse est bien la vôtre :";
  const outro = "Ce lien est valable 7 jours. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : rien ne sera enregistré et vous ne recevrez rien.";
  const text = `Bonjour,\n\n${intro}\n\nConfirmer mon adresse : ${confirmUrl}\n\n${outro}\n\nBébé Bonjour\nFaire-part de naissance à écouter\nSe désinscrire : ${unsubscribeUrl} · Confidentialité : ${privacyUrl}`;
  const html = `<div style="font-family:Georgia,serif;color:#20392d;max-width:580px"><p>Bonjour,</p><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(confirmUrl)}">Confirmer mon adresse</a></p><p>${escapeHtml(outro)}</p><p>Bébé Bonjour<br>Faire-part de naissance à écouter<br><small><a href="${escapeHtml(unsubscribeUrl)}">Se désinscrire</a> · <a href="${escapeHtml(privacyUrl)}">Confidentialité</a></small></p></div>`;
  return { subject: "Confirmez votre adresse — Bébé Bonjour", text, html };
}

export async function createInterestList({ database, sendEmail, publicOrigin, operationsToken, now = () => new Date() } = {}) {
  if (!database) throw new Error("database_required");
  const origin = publicOrigin ? new URL(publicOrigin).origin : null;
  await database.query(`CREATE TABLE IF NOT EXISTS interest_list (
    id text PRIMARY KEY, list text NOT NULL, email text NOT NULL, status text NOT NULL CHECK (status IN ('pending','confirmed','unsubscribed')),
    created_at timestamptz NOT NULL, consent_text text NOT NULL, consent_version text NOT NULL, confirmed_at timestamptz, unsubscribed_at timestamptz,
    source text NOT NULL, confirm_token text, unsub_token text NOT NULL UNIQUE, confirm_sent_at timestamptz, confirm_send_count integer NOT NULL DEFAULT 0,
    UNIQUE (list, email))`);
  const ipHits = new Map();

  const query = (sql, params = []) => database.query(sql, params);
  const first = async (sql, params) => (await query(sql, params)).rows[0] ?? null;

  function ipAllowed(ip) {
    const t = now().getTime(); const hits = (ipHits.get(ip) ?? []).filter(h => t - h < 3600 * 1000);
    if (hits.length >= IP_REQUESTS_PER_HOUR) { ipHits.set(ip, hits); return false; }
    hits.push(t); ipHits.set(ip, hits);
    if (ipHits.size > 5000) for (const [key, value] of ipHits) if (!value.some(h => t - h < 3600 * 1000)) ipHits.delete(key);
    return true;
  }

  async function purge() {
    const cutoff = new Date(now().getTime() - CONFIRM_TTL_MS);
    await query("DELETE FROM interest_list WHERE list=$1 AND status='pending' AND COALESCE(confirm_sent_at, created_at) < $2", [LIST, cutoff]);
  }

  async function deliverConfirmation(row) {
    const urls = {
      confirmUrl: `${origin}/interest/confirm?t=${row.confirm_token}`,
      unsubscribeUrl: `${origin}/interest/unsubscribe?t=${row.unsub_token}`,
      privacyUrl: `${origin}/confidentialite/`,
    };
    await sendEmail({ to: row.email, ...confirmationEmail(urls), idempotencyKey: `bebe-interest:${row.id}:${row.confirm_send_count}:confirmation` });
  }

  // Marks the send as started, then sends. A failed send clears the mark so the
  // visitor can retry immediately.
  async function issueConfirmation(row) {
    const stamp = now();
    const updated = await first("UPDATE interest_list SET confirm_token=$2, confirm_sent_at=$3, confirm_send_count=confirm_send_count+1 WHERE id=$1 RETURNING *", [row.id, token(), stamp]);
    try { await deliverConfirmation(updated); } catch (error) {
      await query("UPDATE interest_list SET confirm_sent_at=NULL WHERE id=$1", [row.id]);
      throw error;
    }
  }

  async function subscribe({ email, consent, website, ip }) {
    if (typeof website === "string" && website !== "") return { status: 200, body: { ok: true } };
    const address = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!address || address.length > 254 || /[\x00-\x1f\x7f]/u.test(address) || !EMAIL.test(address)) return { status: 400, body: { error: "email" } };
    if (consent !== true) return { status: 400, body: { error: "consent" } };
    if (!ipAllowed(ip || "unknown")) return { status: 429, body: { error: "rate" } };
    await purge();
    const recent = await first("SELECT count(*)::int AS n FROM interest_list WHERE list=$1 AND created_at > $2", [LIST, new Date(now().getTime() - 3600 * 1000)]);
    if (recent.n >= GLOBAL_REQUESTS_PER_HOUR) return { status: 429, body: { error: "rate" } };
    const existing = await first("SELECT * FROM interest_list WHERE list=$1 AND email=$2", [LIST, address]);
    let row = existing;
    if (!existing) {
      row = await first("INSERT INTO interest_list (id,list,email,status,created_at,consent_text,consent_version,source,unsub_token) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8) RETURNING *",
        ["int_" + randomBytes(12).toString("hex"), LIST, address, now(), CONSENT_TEXT, CONSENT_VERSION, "landing", token()]);
    } else if (existing.status === "unsubscribed") {
      row = await first("UPDATE interest_list SET status='pending', created_at=$2, consent_text=$3, consent_version=$4, confirmed_at=NULL, unsubscribed_at=NULL, confirm_sent_at=NULL WHERE id=$1 RETURNING *", [existing.id, now(), CONSENT_TEXT, CONSENT_VERSION]);
    } else if (existing.status === "confirmed") {
      return { status: 200, body: { ok: true } };
    } else if (existing.confirm_sent_at && now().getTime() - new Date(existing.confirm_sent_at).getTime() < RESEND_MIN_MS) {
      return { status: 200, body: { ok: true } };
    }
    try { await issueConfirmation(row); } catch { return { status: 500, body: { error: "server" } }; }
    return { status: 200, body: { ok: true } };
  }

  async function pendingByToken(value) {
    if (!TOKEN.test(value || "")) return null;
    const row = await first("SELECT * FROM interest_list WHERE list=$1 AND confirm_token=$2", [LIST, value]);
    return row;
  }
  const expired = row => now().getTime() - new Date(row.confirm_sent_at ?? row.created_at).getTime() > CONFIRM_TTL_MS;
  const invalidLink = () => page("Ce lien n'est plus valable.", "<p>Vous pouvez demander un nouveau courriel de confirmation depuis bebebonjour.com.</p>", 404);
  const noted = () => page("C'est noté.", "<p>Nous vous écrirons quand Bébé Bonjour a du nouveau. Vous pouvez vous désinscrire à tout moment depuis n'importe lequel de nos courriels.</p>");

  async function confirmPage(value) {
    const row = await pendingByToken(value);
    if (!row) return invalidLink();
    if (row.status === "confirmed") return noted();
    if (row.status !== "pending" || expired(row)) return invalidLink();
    return page("Confirmer votre adresse", `<p>Un dernier clic pour confirmer que cette adresse est bien la vôtre.</p><form method="post" action="/interest/confirm"><input type="hidden" name="t" value="${escapeHtml(value)}"><button type="submit">Confirmer mon adresse</button></form>`);
  }

  async function confirm(value) {
    const row = await pendingByToken(value);
    if (!row) return invalidLink();
    if (row.status === "confirmed") return noted();
    if (row.status !== "pending" || expired(row)) return invalidLink();
    await query("UPDATE interest_list SET status='confirmed', confirmed_at=$2 WHERE id=$1 AND status='pending'", [row.id, now()]);
    return noted();
  }

  const badUnsubscribe = () => page("Ce lien n'est pas valable.", "<p>Pour vous désinscrire, écrivez à contact@bebebonjour.com.</p>", 404);
  async function unsubscribePage(value) {
    if (!TOKEN.test(value || "") || !(await first("SELECT 1 FROM interest_list WHERE list=$1 AND unsub_token=$2", [LIST, value]))) return badUnsubscribe();
    return page("Se désinscrire", `<p>Un clic pour ne plus recevoir nos courriels.</p><form method="post" action="/interest/unsubscribe"><input type="hidden" name="t" value="${escapeHtml(value)}"><button type="submit">Me désinscrire</button></form>`);
  }
  async function unsubscribe(value) {
    if (!TOKEN.test(value || "")) return badUnsubscribe();
    const row = await first("SELECT * FROM interest_list WHERE list=$1 AND unsub_token=$2", [LIST, value]);
    if (!row) return badUnsubscribe();
    if (row.status !== "unsubscribed") await query("UPDATE interest_list SET status='unsubscribed', unsubscribed_at=$2, confirm_token=NULL WHERE id=$1", [row.id, now()]);
    return page("Vous êtes désinscrit·e.", "<p>Nous ne vous écrirons plus. Si c'était une erreur, vous pouvez vous réinscrire depuis bebebonjour.com.</p>");
  }

  // Weeks run Monday to Sunday, Europe/Paris. Internal test addresses are excluded.
  async function stats(weeks = 12) {
    const where = "list=$1 AND email !~ '\\.(test|invalid)$'";
    const weekly = column => query(`SELECT to_char(date_trunc('week', ${column} AT TIME ZONE 'Europe/Paris'), 'YYYY-MM-DD') AS week, count(*)::int AS n FROM interest_list WHERE ${where} AND ${column} IS NOT NULL GROUP BY 1`, [LIST]);
    const [requests, confirmed, unsubscribed] = await Promise.all([weekly("created_at"), weekly("confirmed_at"), weekly("unsubscribed_at")]);
    const by = new Map();
    for (const [key, result] of [["requests", requests], ["confirmed", confirmed], ["unsubscribed", unsubscribed]]) for (const r of result.rows) { by.set(r.week, { week_start: r.week, requests: 0, confirmed: 0, unsubscribed: 0, ...by.get(r.week), [key]: r.n }); }
    const total = await first(`SELECT count(*)::int AS n FROM interest_list WHERE ${where} AND status='confirmed'`, [LIST]);
    return { list: LIST, confirmed_total: total.n, weeks: [...by.values()].sort((a, b) => b.week_start.localeCompare(a.week_start)).slice(0, weeks) };
  }

  async function erase(email) {
    const address = String(email || "").trim().toLowerCase();
    const result = await query("DELETE FROM interest_list WHERE list=$1 AND email=$2", [LIST, address]);
    return result.rowCount ?? 0;
  }

  function authorized(request) {
    const header = request.headers.get("authorization") || "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    return Boolean(operationsToken) && presented !== "" && timingSafeEqual(digest(presented), digest(operationsToken));
  }

  async function handle(request) {
    const url = new URL(request.url); const method = request.method;
    try {
      if (url.pathname === "/interest/subscribe" && method === "POST") {
        if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json(415, { error: "content_type" });
        const text = await request.text(); if (text.length > 4096) return json(413, { error: "too_large" });
        let body; try { body = JSON.parse(text); } catch { return json(400, { error: "email" }); }
        if (!body || typeof body !== "object") return json(400, { error: "email" });
        const forwarded = String(request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
        const result = await subscribe({ ...body, ip: forwarded });
        return json(result.status, result.body);
      }
      if (url.pathname === "/interest/confirm" && method === "GET") return await confirmPage(url.searchParams.get("t"));
      if (url.pathname === "/interest/confirm" && method === "POST") return await confirm(new URLSearchParams(await request.text()).get("t"));
      if (url.pathname === "/interest/unsubscribe" && method === "GET") return await unsubscribePage(url.searchParams.get("t"));
      if (url.pathname === "/interest/unsubscribe" && method === "POST") return await unsubscribe(new URLSearchParams(await request.text()).get("t"));
      if (url.pathname === "/interest/stats" && method === "GET") return authorized(request) ? json(200, await stats()) : json(401, { error: "unauthorized" });
      if (url.pathname === "/interest/erase" && method === "POST") {
        if (!authorized(request)) return json(401, { error: "unauthorized" });
        return json(200, { erased: await erase((await request.json()).email) });
      }
      return new Response("Not found", { status: 404 });
    } catch { return json(500, { error: "server" }); }
  }

  return { handle, subscribe, purge, stats, erase };
}
