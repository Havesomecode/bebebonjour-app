import { httpAction } from "./functions.mjs";
import { body, json, errorResponse, document } from "./deliveryLoopHttp.js";
import { pageArchive } from "./deliveryLoopExport.js";
const ref = name => `deliveryLoopData:${name}`;
export const dataControl = httpAction(async (ctx, request) => {
  try {
    const payload = await body(request);
    if (payload.action === "delete" && payload.confirmDeletion !== true) throw new Error("invalid_input");
    return json(await ctx.runMutation(ref("customerControl"), {
      jobId: payload.jobId, reviewToken: payload.token, action: payload.action,
    }));
  } catch (error) { return errorResponse(error); }
});
export const dataExport = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const args = { jobId: url.searchParams.get("jobId") || "", reviewToken: url.searchParams.get("token") || "" };
    const content = await ctx.runQuery(ref("exportContent"), args);
    const kind = url.searchParams.get("kind");
    const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow, noarchive" };
    if (kind === "text") return new Response(content.text, { headers: { ...headers, "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="texte.txt"' } });
    if (!["audio", "page"].includes(kind)) throw new Error("invalid_export");
    const audio = [];
    for (const file of content.audio) {
      const blob = await ctx.storage.get(file.storageId);
      if (!blob || blob.size > 12 * 1024 * 1024) throw new Error("audio_unavailable");
      audio.push(new Uint8Array(await blob.arrayBuffer()));
    }
    if (audio.length !== 1) throw new Error("audio_unavailable");
    await ctx.runQuery(ref("exportContent"), args);
    const bytes = kind === "audio" ? audio[0] : pageArchive(content, audio);
    return new Response(bytes, { headers: { ...headers, "content-type": kind === "audio" ? "audio/mpeg" : "application/zip", "content-disposition": `attachment; filename="${kind === "audio" ? "audio.mp3" : "annonce.zip"}"` } });
  } catch { return new Response("Téléchargement indisponible.", { status: 404, headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow, noarchive", "referrer-policy": "no-referrer" } }); }
});
export const dataOperatorControl = httpAction(async (ctx, request) => {
  try {
    const value = await body(request); const authorization = request.headers.get("authorization") || "";
    const args = { jobId: value.jobId, editorialToken: authorization.startsWith("Bearer ") ? authorization.slice(7) : "" };
    if (value.action === "inspect") return json(await ctx.runQuery(ref("inspect"), args));
    if (value.action === "delete" && value.confirmDeletion !== true) throw new Error("invalid_input");
    return json(await ctx.runMutation(ref("operatorControl"), { ...args, action: value.action }));
  } catch (error) { return errorResponse(error); }
});
export const dataOperatorPage = httpAction(async () => document("Contrôles de données", `<h1>Contrôles de données</h1><p>Accès humain protégé. L’inspection ne renvoie ni contenu ni adresse courriel. La suppression ferme l’annonce et efface ses fichiers ; certaines preuves financières et d’effets sont conservées séparément.</p><form id="data-operator"><label for="credential">Capacité éditoriale humaine</label><input id="credential" type="password" autocomplete="off" required><label for="job">Identifiant de commande</label><input id="job" maxlength="100" required><label for="action">Action</label><select id="action"><option value="inspect">Inspecter les contrôles et preuves</option><option value="revoke">Retirer la publication</option><option value="delete">Supprimer le contenu et l’audio</option></select><label class="check"><input id="confirm-delete" type="checkbox"> Je confirme la suppression définitive, si sélectionnée.</label><button>Exécuter</button></form><pre id="result" role="status"></pre><p><a href="/delivery/operator">Revenir à la revue éditoriale</a></p>`, `document.querySelector('#data-operator').addEventListener('submit',async event=>{event.preventDefault();const credential=document.querySelector('#credential');const result=document.querySelector('#result');const button=event.target.querySelector('button');button.disabled=true;try{const response=await fetch('/delivery/data/operator',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential.value},body:JSON.stringify({jobId:document.querySelector('#job').value,action:document.querySelector('#action').value,confirmDeletion:document.querySelector('#confirm-delete').checked})});const value=await response.json();result.textContent=JSON.stringify(value,null,2);}catch{result.textContent='Demande indisponible. Vérifiez avant de réessayer.';}finally{credential.value='';button.disabled=false;}});`));
