import { httpAction } from "./functions.mjs";
import { TERMS_VERSION } from './deliveryLoopPaidPolicy.js';

// Read-only, version-pinned terms. No admission flag, customer state or provider access.
export const termsPage = httpAction(async () => new Response(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Conditions de l’offre à 39 € · Bébé Bonjour</title>
<style>:root{color-scheme:light;font-family:system-ui,sans-serif;color:#243e31;background:#f8f4eb}body{margin:0;padding:clamp(20px,5vw,64px) 20px;line-height:1.6;overflow-wrap:anywhere}main{max-width:720px;margin:auto}h1{font:clamp(30px,6vw,46px) Georgia,serif;line-height:1.2}h2{font-size:1.25rem;margin-top:2em}a{color:inherit;text-decoration:underline}a:focus-visible{outline:3px solid currentColor;outline-offset:4px}</style></head>
<body><main aria-labelledby="terms-title"><p>Bébé Bonjour</p><h1 id="terms-title">Conditions de l’offre à 39 €</h1><p>Version : <strong>${TERMS_VERSION}</strong></p>
<section><h2>Votre annonce et son prix</h2>
<p>Bébé Bonjour crée votre annonce de naissance en français ou en arabe, avec narration audio incluse. Le prix est de 39 € au total, en une seule fois, sans abonnement. L’offre comprend deux corrections.</p>
<p>Cette offre s’adresse aux particuliers majeurs résidant en France métropolitaine et disposant des autorisations parentales nécessaires. Le service est proposé par HAVESOMECODE, SIRET 879 252 336 00034.</p></section>
<section><h2>Commande et paiement</h2>
<p>Après votre demande, nous la lisons avant toute création. Si nous l’acceptons, nous vous envoyons un lien de paiement de 39 €. La création commence après la confirmation du paiement. Si nous ne pouvons pas créer votre faire-part, aucun paiement ne vous est demandé.</p></section>
<section><h2>Corrections et approbation</h2>
<p>Vous recevez le lien de votre faire-part dès sa création. Deux corrections sont incluses. Vous approuvez la version finale ; la publication ne change pas de lien.</p>
<p>Le lien est non indexé et révocable. Toute personne disposant du lien peut consulter le faire-part : ne le partagez qu’avec les personnes de votre choix. Vous pouvez demander le retrait de la page.</p></section>
<section><h2>Livraison et hébergement</h2>
<p>La livraison intervient sous cinq jours ouvrés après la confirmation du paiement. L’hébergement dure douze mois à compter de la livraison finale, sans renouvellement automatique ni paiement récurrent.</p>
<p>Nous vous prévenons 30 jours avant la fermeture de la page hébergée. Avant cette fermeture, vous pouvez exporter le texte final, l’audio et une archive de la page. Conservez ces fichiers si vous souhaitez les garder après la fin de l’hébergement.</p></section>
<section><h2>Vos informations et votre annonce</h2>
<p>Fournissez seulement les prénoms nécessaires, le texte de l’annonce, la langue et votre courriel. L’offre initiale porte sur des vœux généraux. Ne transmettez ni photo de bébé, ni détail de santé, ni adresse précise, ni carnet de destinataires.</p>
<p>Bébé Bonjour ne réutilise vos commandes réelles ni pour le marketing, ni pour des démonstrations, ni pour l’entraînement de modèles.</p></section>
<section><h2>Annulation et droits légaux</h2>
<p>Vos droits légaux, notamment les garanties légales applicables et le droit de rétractation lorsqu’il s’applique, sont préservés. Pour un contrat conclu à distance, le délai légal de rétractation est en principe de 14 jours à compter de sa conclusion. Les exceptions légales ne s’appliquent que si leurs conditions sont réunies ; le paiement ne vaut pas renonciation à vos droits.</p>
<p>Contactez le support pour exercer vos droits, signaler un défaut ou demander l’annulation. L’annulation bloque la poursuite de la commande et l’accès à l’annonce ; elle ne constitue pas une confirmation de remboursement. Les remboursements dus au titre de vos droits légaux restent applicables.</p></section>
<section><h2>Essais accompagnés à 1 €</h2>
<p>Pendant la phase de test uniquement, une promotion encadrée permet au maximum cinq essais, avec 38 € de remise, soit 1 € à payer volontairement par essai. Ces essais ne constituent pas des ventes à 39 € et ne changent pas le prix de l’offre ordinaire. Ils suivent le même parcours que l’offre ordinaire. La promotion est désactivée à la fin des tests ; elle n’est pas une remise ouverte à tous.</p></section>
<section><h2>Nous contacter</h2>
<p>Support : <a href="mailto:contact@bebebonjour.com">contact@bebebonjour.com</a>. Réponse initiale sous deux jours ouvrés. Les signalements de retrait et de sécurité sont prioritaires.</p></section>
</main></body></html>`, {
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  },
}));
