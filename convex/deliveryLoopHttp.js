import { httpActionGeneric, makeFunctionReference } from "convex/server";
import { paidEnabled, PAID_MODE } from "./deliveryLoopPaidPolicy.js";
import { paidIntakeDocument, paidReviewDocument as renderPaidReview, paidOperatorDocument } from "./deliveryLoopPaidViews.js";

const ref = (name) => makeFunctionReference(`deliveryLoop:${name}`);
const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { ...PRIVATE, "content-type": "application/json; charset=utf-8" } }); }
function errorResponse(error) {
  const allowed = ["paid_route_unavailable", "paid_permissions_required", "content_approval_required", "preview_consent_required", "preview_expired", "paid_preview_locked", "correction_limit", "order_cancelled", "customer_decision_required", "paid_offer_mismatch", "paid_waiver_forbidden", "payment_evidence_mismatch", "payment_evidence_conflict", "payment_configuration_invalid", "payment_account_mismatch", "editorial_approval_required", "preview_renewal_unavailable", "intake_rate_limited", "invalid_magic_password", "consent_required", "invalid_email", "invalid_baby_name", "invalid_intake", "invalid_input", "invalid_feedback", "feedback_required", "idempotency_conflict", "stale_revision", "draft_not_delivered", "review_not_available", "revision_limit", "trial_unavailable", "forbidden_actor", "forbidden", "not_found", "body_too_large", "json_required", "invalid_json", "job_capacity_reached"];
  const code = allowed.find((c) => new RegExp(`\\b${c}\\b`).test(error?.message || "")) || "request_failed";
  const status = code === "intake_rate_limited" ? 429 : code === "not_found" ? 404 : ["forbidden", "forbidden_actor", "invalid_magic_password"].includes(code) ? 403 : ["idempotency_conflict", "stale_revision", "draft_not_delivered", "review_not_available", "revision_limit"].includes(code) ? 409 : code === "body_too_large" ? 413 : code === "json_required" ? 415 : ["trial_unavailable", "request_failed"].includes(code) ? 503 : 400;
  return json({ status: "error", code }, status);
}
async function body(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Error("forbidden");
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
const style = `:root{color-scheme:light;font-family:system-ui,sans-serif;color:#243e31;background:#f8f4eb}body{margin:0;padding:clamp(20px,5vw,64px) 20px}main{max-width:620px;margin:auto}h1{font:clamp(32px,6vw,48px) Georgia,serif;margin:18px 0}p{line-height:1.6}form,.panel{padding:24px;background:#fffdf8;border:1px solid #dfdccd;border-radius:18px}label{display:block;margin:16px 0 7px}input:not([type=checkbox]),select,textarea{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bbbfb2;border-radius:8px;background:white;font:inherit}textarea{min-height:120px}button{padding:13px 20px;background:#284d3c;color:white;border:0;border-radius:8px;font:inherit;margin-top:18px;cursor:pointer}button:disabled{opacity:.45;cursor:wait}a{color:#284d3c}.check{display:flex;gap:10px;align-items:flex-start}.muted{color:#566356;font-size:.9rem}.brand{text-transform:uppercase;letter-spacing:.15em;font-size:.8rem}.notice{padding:14px;background:#eee9d8;border-radius:8px}[role=status]{white-space:pre-line}footer{margin:24px 0;font-size:.85rem;color:#566356}`;
function document(title, content, script = "") {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)} · Bébé Bonjour</title><style>${style}</style></head><body><main><span class="brand">Bébé Bonjour</span>${content}<footer>Une annonce créée avec soin. Gardez votre lien de révision privé.</footer></main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`, { headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` } });
}
const commonScript = `const messages={generation_queued:'Votre annonce est en préparation.',generation_running:'Votre annonce est en cours de création.',draft_email_queued:'Votre annonce est publiée. Le courriel de révision est en préparation.',draft_email_running:'Le courriel de révision est en cours d’envoi.',awaiting_review:'Votre annonce est prête à être révisée.',final_email_queued:'Votre approbation est enregistrée. Le courriel final est en préparation.',final_email_running:'Le courriel final est en cours d’envoi.',approved_sent:'Votre annonce est approuvée et le courriel final a été envoyé.',reconciliation_required:'Un envoi doit être vérifié par notre équipe. Aucun doublon ne sera envoyé automatiquement.',failed:'La préparation a rencontré un problème. Notre équipe doit intervenir.'};const errors={invalid_magic_password:'Le mot de passe offert est incorrect.',intake_rate_limited:'Trop de tentatives. Réessayez dans 15 minutes.',stale_revision:'Cette version a changé. Actualisez avant de décider.',draft_not_delivered:'Le courriel de première version doit être envoyé avant votre décision.',idempotency_conflict:'Une autre demande utilise déjà cet identifiant.',feedback_required:'Décrivez la correction souhaitée.',forbidden:'Ce lien privé est invalide.'};async function post(path,payload){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(errors[result.code]||'Impossible d’enregistrer cette demande. Réessayez.');return result;}`;
const complimentaryIntakePage = async () => document("Votre annonce", `<h1>Bienvenue, petit bonheur.</h1><p>Créez une annonce de naissance en français ou en arabe, avec une voix si vous le souhaitez.</p><p class="notice">Votre première version est créée et envoyée avant révision humaine. Vous pourrez ensuite demander une correction ou l’approuver.</p><form id="intake"><label for="email">Votre adresse courriel</label><input id="email" name="email" type="email" maxlength="254" required autocomplete="email"><label for="babyName">Prénom de bébé</label><input id="babyName" name="babyName" maxlength="100" required><label for="gender">Bébé</label><select id="gender" name="gender"><option value="neutral">Neutre</option><option value="girl">Fille</option><option value="boy">Garçon</option></select><label for="language">Langue</label><select id="language" name="language"><option value="fr">Français</option><option value="ar">العربية — Arabe</option></select><label for="context">Contexte</label><select id="context" name="context"><option value="general">Vœux généraux</option><option value="islam">Vœux dans un contexte musulman</option></select><label class="check"><input type="checkbox" name="voiceEnabled" checked> Ajouter une narration audio</label><label class="check"><input type="checkbox" name="fictional"> Les informations de cette annonce sont fictives (essai)</label><label for="magicPassword">Mot de passe de l’offre</label><input id="magicPassword" name="magicPassword" type="password" maxlength="256" required autocomplete="off"><p class="muted">Cette offre dispense du paiement. Aucun paiement ne sera enregistré.</p><label class="check"><input type="checkbox" name="consent" required> J’accepte que ces informations soient utilisées pour créer et publier l’annonce à son lien non indexé, et pour m’envoyer les courriels de révision et de livraison. Toute personne ayant le lien de l’annonce peut la consulter.</label><button type="submit">Créer mon annonce offerte</button></form><p id="result" role="status" aria-live="polite"></p><div id="links"></div>`, `${commonScript}
const form=document.querySelector('#intake');let key=crypto.randomUUID();form.addEventListener('input',()=>{key=crypto.randomUUID();});form.addEventListener('submit',async(event)=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;const data=new FormData(form);const out=document.querySelector('#result');try{const result=await post('/delivery/intake',{idempotencyKey:key,magicPassword:data.get('magicPassword'),intake:{email:data.get('email'),babyName:data.get('babyName'),gender:data.get('gender'),language:data.get('language'),context:data.get('context'),voiceEnabled:data.has('voiceEnabled'),consent:data.has('consent'),fictional:data.has('fictional')}});form.elements.magicPassword.value='';out.textContent='Votre demande offerte a été enregistrée. '+(messages[result.status]||result.status);const container=document.querySelector('#links');container.replaceChildren();for(const [label,url] of [['Suivre et réviser mon annonce',result.reviewUrl],['Ouvrir le lien de mon annonce',result.publicUrl]]){const p=document.createElement('p');const a=document.createElement('a');a.textContent=label;a.href=url;p.append(a);container.append(p);}form.hidden=true;}catch(error){out.textContent=error.message;button.disabled=false;}});`);
export const intakePage = httpActionGeneric(async (ctx, request) => {
  if (new URL(request.url).searchParams.get("mode") !== PAID_MODE) return complimentaryIntakePage(ctx, request);
  try { return paidIntakeDocument(document, commonScript, paidEnabled(), escape); }
  catch (error) { return errorResponse(error); }
});
export const privatePreview = httpActionGeneric(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const preview = await ctx.runQuery(ref("preview"), { jobId: url.searchParams.get("jobId") || "", reviewToken: url.searchParams.get("token") || "", expectedRevision: Number(url.searchParams.get("revision")) });
    return new Response(preview.contentHtml, { headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox" } });
  } catch (error) { return errorResponse(error); }
});
export const operatorPage = httpActionGeneric(async () => paidOperatorDocument(document));
export const operatorSubmit = httpActionGeneric(async (ctx, request) => {
  try {
    const value = await body(request);
    const authorization = request.headers.get("authorization") || "";
    const args = { editorialToken: authorization.startsWith("Bearer ") ? authorization.slice(7) : "", jobId: value.jobId };
    if (value.action === "read") return json(await ctx.runQuery(ref("paidOperatorRead"), args));
    args.expectedRevision = value.expectedRevision;
    if (value.action === "editorial") return json(await ctx.runMutation(ref("paidEditorial"), { ...args, previewDigest: value.previewDigest, reviewerId: value.reviewerId, humanReviewed: value.humanReviewed }));
    if (value.action === "reconcile_payment") return json(await ctx.runAction(makeFunctionReference("deliveryLoopProviders:reconcilePaidPayment"), { ...args, providerPaymentId: value.providerPaymentId }));
    if (["renew_preview", "cancel"].includes(value.action)) return json(await ctx.runMutation(ref("paidControl"), { ...args, action: value.action }));
    throw new Error("invalid_input");
  } catch (error) { return errorResponse(error); }
});
export const intakeSubmit = httpActionGeneric(async (ctx, request) => {
  try {
    const value = await body(request);
    const args = { intake: value.intake, idempotencyKey: value.idempotencyKey };
    for (const key of ["magicPassword", "orderMode", "previewConsent"]) if (value[key] !== undefined) args[key] = value[key];
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
    return document("Réviser votre annonce", `<h1>Votre annonce, à votre image.</h1><div class="panel"><p id="state" role="status" aria-live="polite">État : ${escape(current.status)}</p><p>Version publiée : <span id="revision">${current.revision}</span></p><p><a href="${escape(current.publicUrl)}" target="_blank" rel="noopener noreferrer">Ouvrir mon annonce</a></p><p class="notice">La première version a été publiée avant révision. Votre décision porte uniquement sur la version affichée.</p><form id="review"><label for="feedback">Correction souhaitée</label><textarea id="feedback" name="feedback" maxlength="2000" placeholder="Décrivez ce que vous souhaitez changer."></textarea><button type="submit" name="action" value="request_changes" ${current.canReview ? "" : "disabled"}>Demander une correction</button><button type="submit" name="action" value="approve" ${current.canReview ? "" : "disabled"}>Approuver cette version</button></form><p id="result" role="status" aria-live="polite"></p><button id="refresh" type="button">Actualiser l’état</button></div>`, `${commonScript}
let revision=${current.revision};const form=document.querySelector('#review');const out=document.querySelector('#result');const search=new URLSearchParams(location.search);const update=(result)=>{revision=result.revision;document.querySelector('#revision').textContent=String(revision);document.querySelector('#state').textContent=messages[result.status]||result.status;for(const b of form.querySelectorAll('button'))b.disabled=!result.canReview;};async function refresh(){const response=await fetch('/delivery/review?'+new URLSearchParams({jobId:search.get('jobId'),token:search.get('token'),format:'json'}));const result=await response.json();if(!response.ok)throw new Error('Ce lien privé est invalide.');update(result);}document.querySelector('#refresh').addEventListener('click',()=>refresh().catch(error=>{out.textContent=error.message;}));let pending=null;form.addEventListener('input',()=>{pending=null;});form.addEventListener('submit',async(event)=>{event.preventDefault();const action=event.submitter.value;const feedback=form.elements.feedback.value;if(action==='request_changes'&&!feedback.trim()){out.textContent='Décrivez la correction souhaitée.';return;}if(!pending||pending.action!==action||pending.expectedRevision!==revision)pending={jobId:search.get('jobId'),reviewToken:search.get('token'),action,expectedRevision:revision,feedback,idempotencyKey:crypto.randomUUID()};for(const b of form.querySelectorAll('button'))b.disabled=true;try{const result=await post('/delivery/review',pending);update(result);out.textContent=action==='approve'?'Votre approbation est enregistrée.':'Votre correction est enregistrée. La version précédente reste consultable pendant la préparation.';pending=null;}catch(error){out.textContent=error.message;await refresh().catch(()=>{});}});refresh().catch(error=>{out.textContent=error.message;});setInterval(()=>{if(!document.hidden)refresh().catch(()=>{});},10000);`);
  } catch (error) { return errorResponse(error); }
});
export const reviewSubmit = httpActionGeneric(async (ctx, request) => {
  try {
    const value = await body(request);
    if (value.action === "accept_permissions") return json(await ctx.runMutation(ref("paidPermissions"), {
      jobId: value.jobId, reviewToken: value.reviewToken, expectedRevision: value.expectedRevision,
      termsVersion: value.termsVersion, termsAccepted: value.termsAccepted, publication: value.publication,
    }));
    const args = { jobId: value.jobId, expectedRevision: value.expectedRevision, action: value.action, idempotencyKey: value.idempotencyKey };
    for (const key of ["reviewToken", "feedback", "actor"]) if (value[key] !== undefined) args[key] = value[key];
    const authorization = request.headers.get("authorization") || "";
    if (authorization.startsWith("Bearer ")) args.workerToken = authorization.slice(7);
    return json(await ctx.runMutation(ref("requestReview"), args));
  } catch (error) { return errorResponse(error); }
});
export const announcement = httpActionGeneric(async (ctx, request) => {
  const path = new URL(request.url).pathname;
  const audio = /^\/announcements\/([a-f0-9]{64})\/audio\/([1-9][0-9]*)\/(fr|ar)$/.exec(path);
  if (audio) {
    const file = await ctx.runQuery(ref("publicAudio"), { publicToken: audio[1], revision: Number(audio[2]), language: audio[3] });
    const blob = file ? await ctx.storage.get(file.storageId) : null;
    if (!blob) return json({ status: "error", code: "not_found" }, 404);
    return new Response(blob, { headers: { ...PRIVATE, "content-type": "audio/mpeg", "content-length": String(blob.size) } });
  }
  const match = /^\/announcements\/([a-f0-9]{64})\/?$/.exec(path);
  if (!match) return json({ status: "error", code: "not_found" }, 404);
  const page = await ctx.runQuery(ref("publicPage"), { publicToken: match[1] });
  if (!page) return document("Annonce en préparation", '<h1>Un petit bonheur se prépare.</h1><p>L’annonce sera disponible ici dès que sa première version sera prête.</p><p>Actualisez cette page dans quelques instants, ou utilisez votre lien privé de suivi.</p>');
  const banner = page.draft ? '<aside data-delivery-draft style="padding:16px;background:#fff3cc;color:#403b2c;font:16px system-ui;text-align:center">Première version — en attente de révision</aside>' : "";
  const controls = page.audioLanguages.map((language) => `<section style="padding:16px;text-align:center"><p>${language === "ar" ? "الاستماع إلى الإعلان" : "Écouter l’annonce"}</p><audio controls preload="none" src="/announcements/${match[1]}/audio/${page.revision}/${language}"></audio></section>`).join("");
  let html = page.contentHtml;
  // Approval changes presentation, not the archived revision's content digest.
  if (!page.draft) html = html.replace(/<!--delivery-loop-draft:start-->[\s\S]*?<!--delivery-loop-draft:end-->/g, "");
  html = /<body\b[^>]*>/i.test(html) ? html.replace(/<body\b[^>]*>/i, (tag) => tag + banner) : banner + html;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, controls + "</body>") : html + controls;
  return new Response(html, { headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8", "x-bebebonjour-revision": String(page.revision), "x-bebebonjour-review-status": page.draft ? "draft" : "approved", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox" } });
});
