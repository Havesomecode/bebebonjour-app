import { httpActionGeneric, makeFunctionReference } from "convex/server";
import { SLIDESHOW_SCRIPT } from "../src/delivery-loop/slideshow-script.mjs";
import { paidEnabled, PAID_MODE } from "./deliveryLoopPaidPolicy.js";
import { paidIntakeDocument, paidReviewDocument as renderPaidReview, paidOperatorDocument } from "./deliveryLoopPaidViews.js";

const ref = (name) => makeFunctionReference(`deliveryLoop:${name}`);
const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { ...PRIVATE, "content-type": "application/json; charset=utf-8" } }); }
export function errorResponse(error) {
  const allowed = ["checkout_in_progress", "checkout_unavailable", "paid_route_unavailable", "paid_permissions_required", "payment_already_settled", "operator_launch_required", "correction_limit", "order_cancelled", "customer_decision_required", "paid_offer_mismatch", "paid_waiver_forbidden", "payment_evidence_mismatch", "payment_evidence_conflict", "payment_configuration_invalid", "payment_account_mismatch", "intake_rate_limited", "invalid_magic_password", "consent_required", "invalid_email", "invalid_baby_name", "invalid_intake", "invalid_input", "invalid_feedback", "feedback_required", "idempotency_conflict", "stale_revision", "draft_not_delivered", "review_not_available", "revision_limit", "trial_unavailable", "forbidden_actor", "forbidden", "not_found", "body_too_large", "json_required", "invalid_json", "job_capacity_reached"];
  const code = allowed.find((c) => new RegExp(`\\b${c}\\b`).test(error?.message || "")) || "request_failed";
  const status = code === "intake_rate_limited" ? 429 : code === "not_found" ? 404 : ["forbidden", "forbidden_actor", "invalid_magic_password"].includes(code) ? 403 : ["checkout_in_progress", "payment_already_settled", "idempotency_conflict", "stale_revision", "draft_not_delivered", "review_not_available", "revision_limit"].includes(code) ? 409 : code === "body_too_large" ? 413 : code === "json_required" ? 415 : ["checkout_unavailable", "trial_unavailable", "request_failed"].includes(code) ? 503 : 400;
  return json({ status: "error", code }, status);
}
export async function body(request) {
  const origin = request.headers.get("origin");
  // The public origin (same-domain proxy) is accepted next to the HTTP-actions origin itself.
  const publicOrigin = process.env.BEBEBONJOUR_DELIVERY_LOOP_ORIGIN;
  if (origin && origin !== new URL(request.url).origin && origin !== publicOrigin) throw new Error("forbidden");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new Error("forbidden");
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) throw new Error("json_required");
  if (Number(request.headers.get("content-length")) > 16000) throw new Error("body_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_json");
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16000) { await reader.cancel(); throw new Error("body_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; } catch { throw new Error("invalid_json"); }
}
const style = `@font-face{font-family:'Newsreader';src:url('/fonts/newsreader.woff2') format('woff2');font-weight:200 800;font-display:swap}@font-face{font-family:'Instrument Sans';src:url('/fonts/instrument-sans.woff2') format('woff2');font-weight:400 700;font-display:swap}:root{color-scheme:light;--paper:#F5F0E6;--card:#FFFDF8;--ink:#20251F;--muted:#575B52;--forest:#2F5443;--clay:#94432F;--line:#8A8676;--rule:#E2DBCB;font-family:'Instrument Sans','Avenir Next',system-ui,sans-serif;color:var(--ink);background:var(--paper)}body{margin:0;padding:clamp(20px,5vw,56px) 20px;line-height:1.55}main{max-width:600px;margin:auto}h1,h2{font-family:'Newsreader',Georgia,serif;font-weight:400;letter-spacing:-.02em;line-height:1.1}h1{font-size:clamp(30px,7vw,44px);margin:18px 0}form,.panel{padding:20px;background:var(--card);border:1px solid var(--rule);border-radius:16px}@media(min-width:600px){form,.panel{padding:24px}}label{display:block;margin:16px 0 6px;font-size:.875rem;font-weight:500}input:not([type=checkbox]),select,textarea{box-sizing:border-box;width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font-family:inherit;font-size:16px}textarea{min-height:120px}:focus-visible{outline:3px solid var(--forest);outline-offset:2px}button{padding:14px 18px;background:var(--forest);color:#FFFDF8;border:0;border-radius:12px;font-family:inherit;font-weight:600;font-size:1rem;min-height:48px;margin-top:18px;cursor:pointer}form button[type=submit],#paid-intake button{width:100%}#refresh{background:transparent;color:var(--forest);border:1px solid var(--rule)}button:disabled{opacity:.45;cursor:wait}a{color:var(--forest)}input[type=checkbox]{accent-color:var(--forest);width:20px;height:20px;flex:none}.check{display:flex;gap:10px;align-items:flex-start;font-size:.9375rem;line-height:1.45}.muted{color:var(--muted);font-size:.8125rem}.brand{font:500 1.125rem 'Newsreader',Georgia,serif}.notice{padding:14px;background:#EFE8DA;border-radius:10px}.eyebrow{font-size:.75rem;letter-spacing:.05em;text-transform:uppercase;color:var(--clay);font-weight:600;margin:24px 0 4px}[role=status]{white-space:pre-line}footer{margin:24px 0;font-size:.85rem;color:var(--muted)}`;
export function document(title, content, script = "") {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)} · Bébé Bonjour</title><style>${style}</style></head><body><main><span class="brand">Bébé Bonjour</span>${content}<footer>Une annonce créée avec soin. Gardez votre lien de révision privé.</footer></main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`, { headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` } });
}
const commonScript = `const messages={awaiting_operator:'Nous lisons votre demande.',refused:'Nous ne pouvons pas créer ce faire-part. Écrivez-nous à contact@bebebonjour.com.',generation_queued:'Votre faire-part est en cours de création.',generation_running:'Votre faire-part est en cours de création.',draft_email_queued:'Votre faire-part est prêt. Le courriel arrive.',draft_email_running:'Votre faire-part est prêt. Le courriel arrive.',awaiting_review:'Votre faire-part est prêt. Demandez une correction ou approuvez-le.',final_email_queued:'Votre approbation est enregistrée.',final_email_running:'Votre approbation est enregistrée.',approved_sent:'Votre faire-part est prêt à partager.',reconciliation_required:'Un envoi doit être vérifié par notre équipe. Aucun doublon ne sera envoyé automatiquement.',failed:'La création a rencontré un problème. Nous revenons vers vous.'};const errors={intake_rate_limited:'Trop de tentatives. Réessayez dans 15 minutes.',stale_revision:'Cette version a changé. Actualisez avant de décider.',draft_not_delivered:'Le courriel de votre faire-part doit être envoyé avant votre décision.',idempotency_conflict:'Une autre demande utilise déjà cet identifiant.',feedback_required:'Décrivez la correction souhaitée.',forbidden:'Ce lien privé est invalide.'};async function post(path,payload){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(errors[result.code]||'Impossible d’enregistrer cette demande. Réessayez.');return result;}`;
const complimentaryIntakePage = async () => document("Votre annonce", `<h1>Bienvenue, petit bonheur.</h1><p>Créez une annonce de naissance en français ou en arabe, avec une voix si vous le souhaitez.</p><p class="notice">Nous lisons chaque demande avant de créer le faire-part. Vous pourrez ensuite demander une correction ou l’approuver.</p><form id="intake"><p class="eyebrow">Ce que vous voulez dire</p><label for="request">Votre message (facultatif)</label><textarea id="request" name="request" maxlength="1500"></textarea><p class="muted">Les prénoms, le ton, une phrase qui vous tient à cœur. Pas de photo ni d’adresse.</p><label for="meaning">Ce que son prénom signifie pour vous (facultatif)</label><textarea id="meaning" name="meaning" placeholder="Clarté, lumière, le prénom de sa grand-mère…" maxlength="400" rows="3"></textarea><p class="muted">Écrivez-le sans son prénom : l’annonce le garde pour la fin.</p><p class="eyebrow">L’annonce</p><label for="language">Langue</label><select id="language" name="language"><option value="fr">Français</option><option value="ar">العربية — Arabe</option></select><label for="voice">Voix de la narration</label><select id="voice" name="voice"><option value="pere">Voix d’homme, chaleureuse</option><option value="mere">Voix de femme, douce</option></select><label for="gender">Bébé</label><select id="gender" name="gender"><option value="neutral">Neutre</option><option value="girl">Fille</option><option value="boy">Garçon</option></select><label for="context">Contexte</label><select id="context" name="context"><option value="general">Vœux généraux</option><option value="islam">Vœux dans un contexte musulman</option></select><label for="birthDate">Date de naissance (facultatif)</label><input id="birthDate" name="birthDate" type="date"><p class="eyebrow">Son prénom, à la fin</p><label for="babyName">Prénom de bébé</label><input id="babyName" name="babyName" maxlength="100" required><p class="eyebrow">Vous</p><label for="email">Votre adresse courriel</label><input id="email" name="email" type="email" maxlength="254" required autocomplete="email"><label class="check"><input type="checkbox" name="voiceEnabled" checked> Ajouter une narration audio</label><label class="check"><input type="checkbox" name="fictional"> Les informations de cette annonce sont fictives (essai)</label><label for="magicPassword">Mot de passe de l’offre</label><input id="magicPassword" name="magicPassword" type="password" maxlength="256" required autocomplete="off"><p class="muted">Cette offre dispense du paiement. Aucun paiement ne sera enregistré.</p><label class="check"><input type="checkbox" name="consent" required> J’accepte que ces informations soient utilisées pour créer et publier l’annonce à son lien non indexé, et pour m’envoyer les courriels de révision et de livraison. Toute personne ayant le lien de l’annonce peut la consulter.</label><button type="submit">Créer mon annonce offerte</button></form><p id="result" role="status" aria-live="polite"></p><div id="links"></div>`, `${commonScript}
Object.assign(errors,{invalid_magic_password:'Le mot de passe offert est incorrect.'});const form=document.querySelector('#intake');if(location.hash.startsWith('#code=')){try{form.elements.magicPassword.value=decodeURIComponent(location.hash.slice(6));}catch{}history.replaceState(null,'',location.pathname+location.search);}let key=crypto.randomUUID();form.addEventListener('input',()=>{key=crypto.randomUUID();});form.addEventListener('submit',async(event)=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;const data=new FormData(form);const out=document.querySelector('#result');try{const result=await post('/delivery/intake',{idempotencyKey:key,magicPassword:data.get('magicPassword'),intake:{email:data.get('email'),babyName:data.get('babyName'),gender:data.get('gender'),language:data.get('language'),voice:data.get('voice'),context:data.get('context'),voiceEnabled:data.has('voiceEnabled'),consent:data.has('consent'),fictional:data.has('fictional'),birthDate:data.get('birthDate')||null,request:(data.get('request')||'')+(data.get('meaning').trim()?'\\n\\nSens du prénom : '+data.get('meaning').trim():'')}});form.elements.magicPassword.value='';out.textContent='Demande reçue. Nous la lisons, puis nous créons votre faire-part.';const container=document.querySelector('#links');container.replaceChildren();for(const [label,url] of [['Suivre ma commande',result.reviewUrl]]){const p=document.createElement('p');const a=document.createElement('a');a.textContent=label;a.href=url;p.append(a);container.append(p);}form.hidden=true;}catch(error){out.textContent=error.message;button.disabled=false;}});`);
export const intakePage = httpActionGeneric(async (ctx, request) => {
  if (new URL(request.url).searchParams.get("mode") === "offert") return complimentaryIntakePage();
  let terms;
  try { terms = paidEnabled(); } catch {
    return document("Les commandes sont fermées pour le moment.", "<h1>Les commandes sont fermées pour le moment.</h1><p>Écrivez-nous à contact@bebebonjour.com.</p>");
  }
  return paidIntakeDocument(document, commonScript, terms, escape);
});
export const operatorPage = httpActionGeneric(async () => paidOperatorDocument(document));
export const operatorSubmit = httpActionGeneric(async (ctx, request) => {
  try {
    const value = await body(request);
    const authorization = request.headers.get("authorization") || "";
    const args = { editorialToken: authorization.startsWith("Bearer ") ? authorization.slice(7) : "", jobId: value.jobId };
    if (value.action === "read") return json(await ctx.runQuery(ref("paidOperatorRead"), args));
    args.expectedRevision = value.expectedRevision;
    if (value.action === "reconcile_payment") return json(await ctx.runAction(makeFunctionReference("deliveryLoopProviders:reconcilePaidPayment"), { ...args, providerPaymentId: value.providerPaymentId }));
    if (value.action === "cancel") return json(await ctx.runMutation(ref("paidControl"), { ...args, action: value.action }));
    throw new Error("invalid_input");
  } catch (error) { return errorResponse(error); }
});
export const checkoutSubmit = httpActionGeneric(async (ctx, request) => {
  try {
    const value = await body(request);
    return json(await ctx.runAction(makeFunctionReference("deliveryLoopProviders:createCheckout"), { jobId: value.jobId, reviewToken: value.reviewToken, expectedRevision: value.expectedRevision }));
  } catch (error) { return errorResponse(error); }
});
export const intakeSubmit = httpActionGeneric(async (ctx, request) => {
  try {
    const value = await body(request);
    const args = { intake: value.intake, idempotencyKey: value.idempotencyKey };
    for (const key of ["magicPassword", "orderMode"]) if (value[key] !== undefined) args[key] = value[key];
    const result = await ctx.runMutation(ref("submit"), args);
    if (result.error) return errorResponse(new Error(result.error));
    return json(result);
  } catch (error) { return errorResponse(error); }
});
export const reviewPage = httpActionGeneric(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const current = await ctx.runQuery(ref("status"), { jobId: url.searchParams.get("jobId") || "", reviewToken: url.searchParams.get("token") || "" });
    if (url.searchParams.get("format") === "json") return json(current);
    if (current.orderMode === PAID_MODE) return renderPaidReview(document, commonScript, current, escape);
    return document("Votre faire-part", `<h1>Votre faire-part, à votre image.</h1><div class="panel"><p id="state" role="status" aria-live="polite"></p><p>Version publiée : <span id="revision">${current.revision}</span></p>${current.publicUrl ? `<p><a href="${escape(current.publicUrl)}" target="_blank" rel="noopener noreferrer">Voir mon faire-part</a></p>` : ""}<p class="notice">Votre décision porte uniquement sur la version affichée.</p><form id="review"><label for="feedback">Correction souhaitée</label><textarea id="feedback" name="feedback" maxlength="2000" placeholder="Décrivez ce que vous souhaitez changer."></textarea><button type="submit" name="action" value="request_changes" ${current.canReview ? "" : "disabled"}>Demander une correction</button><button type="submit" name="action" value="approve" ${current.canReview ? "" : "disabled"}>Approuver cette version</button></form><p id="result" role="status" aria-live="polite"></p><button id="refresh" type="button">Actualiser l’état</button></div>`, `${commonScript}
let revision=${current.revision};const form=document.querySelector('#review');const out=document.querySelector('#result');const search=new URLSearchParams(location.search);const update=(result)=>{revision=result.revision;document.querySelector('#revision').textContent=String(revision);document.querySelector('#state').textContent=messages[result.status]||result.status;for(const b of form.querySelectorAll('button'))b.disabled=!result.canReview;};async function refresh(){const response=await fetch('/delivery/review?'+new URLSearchParams({jobId:search.get('jobId'),token:search.get('token'),format:'json'}));const result=await response.json();if(!response.ok)throw new Error('Ce lien privé est invalide.');update(result);}document.querySelector('#refresh').addEventListener('click',()=>refresh().catch(error=>{out.textContent=error.message;}));let pending=null;form.addEventListener('input',()=>{pending=null;});form.addEventListener('submit',async(event)=>{event.preventDefault();const action=event.submitter.value;const feedback=form.elements.feedback.value;if(action==='request_changes'&&!feedback.trim()){out.textContent='Décrivez la correction souhaitée.';return;}if(!pending||pending.action!==action||pending.expectedRevision!==revision)pending={jobId:search.get('jobId'),reviewToken:search.get('token'),action,expectedRevision:revision,feedback,idempotencyKey:crypto.randomUUID()};for(const b of form.querySelectorAll('button'))b.disabled=true;try{const result=await post('/delivery/review',pending);update(result);out.textContent=action==='approve'?'Votre approbation est enregistrée.':'Votre correction est enregistrée. Nous la lisons, puis nous préparons la nouvelle version.';pending=null;}catch(error){out.textContent=error.message;await refresh().catch(()=>{});}});refresh().catch(error=>{out.textContent=error.message;});setInterval(()=>{if(!document.hidden)refresh().catch(()=>{});},10000);`);
  } catch (error) { return errorResponse(error); }
});
export const reviewSubmit = httpActionGeneric(async (ctx, request) => {
  try {
    const value = await body(request);
    const args = { jobId: value.jobId, expectedRevision: value.expectedRevision, action: value.action, idempotencyKey: value.idempotencyKey };
    for (const key of ["reviewToken", "feedback", "actor"]) if (value[key] !== undefined) args[key] = value[key];
    const authorization = request.headers.get("authorization") || "";
    if (authorization.startsWith("Bearer ")) args.workerToken = authorization.slice(7);
    return json(await ctx.runMutation(ref("requestReview"), args));
  } catch (error) { return errorResponse(error); }
});
// CSP hash of the one inline script rendered announcements carry; computed on first use, not at import.
let slideshowHash;
const slideshowScriptHash = () => slideshowHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(SLIDESHOW_SCRIPT)).then((bytes) => "sha256-" + btoa(String.fromCharCode(...new Uint8Array(bytes))));
export const announcement = httpActionGeneric(async (ctx, request) => {
  const path = new URL(request.url).pathname;
  const audio = /^\/announcements\/([a-f0-9]{64})\/audio\/([1-9][0-9]*)\/(fr|ar)$/.exec(path);
  if (audio) {
    const file = await ctx.runQuery(ref("publicAudio"), { publicToken: audio[1], revision: Number(audio[2]), language: audio[3] });
    const blob = file ? await ctx.storage.get(file.storageId) : null;
    if (!blob) return json({ status: "error", code: "not_found" }, 404);
    const headers = { ...PRIVATE, "content-type": "audio/mpeg", "accept-ranges": "bytes" };
    // One byte range so the slideshow can seek the voice when the reader taps a screen.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
    if (range && (range[1] || range[2])) {
      const size = blob.size, start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
      return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
    }
    return new Response(blob, { headers: { ...headers, "content-length": String(blob.size) } });
  }
  const match = /^\/announcements\/([a-f0-9]{64})\/?$/.exec(path);
  if (!match) return json({ status: "error", code: "not_found" }, 404);
  const page = await ctx.runQuery(ref("publicPage"), { publicToken: match[1] });
  if (!page) return document("Annonce en préparation", '<h1>Un petit bonheur se prépare.</h1><p>Le faire-part sera disponible ici dès qu’il sera prêt.</p><p>Actualisez cette page dans quelques instants, ou utilisez votre lien privé de suivi.</p>');
  const banner = page.draft ? '<aside data-delivery-draft style="padding:16px;background:#fff3cc;color:#403b2c;font:16px system-ui;text-align:center">Version en attente d’approbation</aside>' : "";
  const controls = (page.contentHtml.includes('data-slideshow') ? [] : page.audioLanguages).map((language) => `<section style="padding:16px;text-align:center"><p>${language === "ar" ? "الاستماع إلى الإعلان" : "Écouter l’annonce"}</p><audio controls preload="none" src="/announcements/${match[1]}/audio/${page.revision}/${language}"></audio></section>`).join("");
  let html = page.contentHtml;
  // Approval changes presentation, not the archived revision's content digest.
  if (!page.draft) html = html.replace(/<!--delivery-loop-draft:start-->[\s\S]*?<!--delivery-loop-draft:end-->/g, "");
  html = /<body\b[^>]*>/i.test(html) ? html.replace(/<body\b[^>]*>/i, (tag) => tag + banner) : banner + html;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, controls + "</body>") : html + controls;
  return new Response(html, { headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8", "x-bebebonjour-revision": String(page.revision), "x-bebebonjour-review-status": page.draft ? "draft" : "approved", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'; script-src '${await slideshowScriptHash()}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts` } });
});
