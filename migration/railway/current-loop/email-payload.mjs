// Extracted verbatim from 5f9e63928b7489f92b4d5e5e8f2807e4c1edbc7d:convex/deliveryLoopProviders.js; see source-manifest.json.
export function emailPayload(job, stage, revision) {
  const firstName = job.intake.baby.firstName;
  const final = stage === 'final_email';
  if (job.orderMode === 'paid_route_a' && !final) {
    const intro = 'Votre aperçu privé est prêt. Il n’est pas publié et la narration finale sera créée après votre accord, le paiement vérifié et la révision éditoriale. Vous disposez de 24 heures pour examiner cette version. Deux corrections éditoriales sont incluses.';
    return { to: job.intake.customer.email, subject: `${firstName} — votre aperçu privé est prêt`,
      text: `${intro}\n\nAperçu et révision : ${job.reviewUrl}\n\nSupport : contact@bebebonjour.com`,
      html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(job.reviewUrl)}">Examiner l’aperçu privé</a></p><p>contact@bebebonjour.com</p>`,
      idempotencyKey: `bebe-loop:${job.jobId}:${revision}:${stage}` };
  }
  const subject = final ? `${firstName} — votre annonce approuvée` : `${firstName} — ${revision > 1 ? 'votre annonce corrigée' : 'votre première annonce'} est prête`;
  const intro = final ? 'Votre annonce a été approuvée. Elle est prête à être partagée avec vos proches.'
    : 'Votre première version a été créée automatiquement, avant révision humaine. Vous pouvez la consulter, demander une correction ou l’approuver.';
  const text = `${intro}\n\nVotre annonce : ${job.publicUrl}\n${final ? '' : `\nRévision et corrections : ${job.reviewUrl}\n`}\nBébé Bonjour`;
  const html = `<div style="font-family:Georgia,serif;color:#20392d;max-width:580px"><h1>${escapeHtml(subject)}</h1><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(job.publicUrl)}">Ouvrir votre annonce</a></p>${final ? '' : `<p><a href="${escapeHtml(job.reviewUrl)}">Réviser, corriger ou approuver</a></p>`}<p>Bébé Bonjour</p></div>`;
  return { to: job.intake.customer.email, subject, text, html,
    idempotencyKey: `bebe-loop:${job.jobId}:${revision}:${stage}` };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
