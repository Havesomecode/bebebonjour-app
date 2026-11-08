# Vérification builder — raccord du cycle courant au ledger PostgreSQL

## Verdict et frontière

Candidat de **préparation locale**, à remettre à la revue indépendante sur `t_5ace5260`. Aucun PASS de release ou d'activation. Convex reste l'autorité opérationnelle.

- Socle backend accepté : `a5ec7602cf4f2d945978fe12b6fdf381f5e4b672`, arbre `dd032dfc96f0f37a5c3843af35b6a4c2f8c38d08`.
- Source courante conservée : `5f9e63928b7489f92b4d5e5e8f2807e4c1edbc7d`, arbre `82415b3abe5bbdfb559258f3e8a3639c713f2be2`; descendant signé du paiement accepté `f64d2f8030ee8a574f87491db5aa1368194b52cf`. Le builder initial `4859da6` reste distingué des corrections SR-01/confidentialité/paiement acceptées; sa présence dans l'histoire n'est pas une approbation.
- Mail corrigé réutilisé sans modification : `bf94f9a01057664b996a41ddde4ed94717b3fa03`, arbre `936a14d43f1e601f6872ec81387c6daeca246dbf`.

Les trois origines et le paiement ont des signatures SSH valides. Les références exactes du nouveau commit, de son arbre et du bundle sont dans le manifeste d'évidence et le handoff natif, pour ne pas créer de référence circulaire dans ce rapport committé.

## Ce que le raccord fait réellement

Le contexte PostgreSQL verrouille le document synthétique `deliveryLoopJobs`, puis exécute les handlers courants `authorizeProvider`, `fence`, `completeEmail` et `read`; ce n'est pas une nouvelle implémentation des décisions ou un remplacement du produit par `/api/customer-flow`. Les autres handlers ne servent qu'à créer les fixtures dans `convex-test`. Une FK exclusive lie chaque effet au domaine courant ou historique, avec vérification à l'admission.

Le message est construit côté serveur à partir de l'extraction exacte de `emailPayload`. Aucun message arbitraire ni booléen client d'approbation n'est accepté. Identité serveur, capability, bail, étape, révision, consentement, publication et décisions payantes sont vérifiés avant préparation puis de nouveau avant admission. Le minimum courant de capability de 16 caractères est préservé, sans changer celui de 32 du seam historique.

Le fence courant et l'admission one-shot sont committés ensemble avant le callback externe. Un fence source sans admission correspondante est refusé avant nouvel intent. L'incertitude ne rouvre pas l'effet, y compris après changement de lease, fournisseur, expiration ou redémarrage. La perte d'ACK de COMMIT peut laisser zéro callback et un effet `issued`; celle de l'ACK de persistance du reçu se réconcilie depuis le reçu durable, sans renvoi.

Le seul delta des contrôles copiés est `completeEmail` : fournisseur explicite, replay lié au fournisseur, ID opaque de 1 à 998 octets imprimables conservé exactement. Les autres octets sont vérifiés par manifeste. Les historiques portant déjà un fournisseur sont inspectés sans intent; les reçus anciens non attribués sont refusés jusqu'à qualification de provenance, jamais implicitement attribués à Cloudflare. Les observations restent séparées des reçus immuables et ne renouvellent pas l'activité de rétention.

## Banc réel et résultats

Exécution hôte avec **Node 22.23.4**, PostgreSQL **16.15** réel sur loopback. Base finale dédiée neuve `bb_candidate_delivery_bridge_v2`; aucune réinitialisation ou migration des bases parentes. Les fixtures sont fictives et leurs adresses sont en `.test`. Les fournisseurs et le SDK Resend utilisent exclusivement des fetch/callbacks injectés; aucun appel fournisseur réel.

| Vérification | Résultat observé |
| --- | --- |
| `npm --prefix migration/railway run test:delivery-loop` | **33 PASS**, 0 FAIL, 0 SKIP : 28 contrôles de raccord, 4 compositions mail courant, 1 provenance source |
| `npm --prefix migration/railway test` | **16 PASS**, 0 FAIL, 0 SKIP, PostgreSQL réel |
| `npm --prefix migration/railway run test:mail-composition` | **3 PASS**, 0 FAIL, 0 SKIP, delta corrigé matérialisé et SDK réel avec fetch simulé |
| `npm --prefix migration/railway run check` | PASS, syntaxe `.mjs` et `.js`, artefacts temporaires exclus |
| `npm test` | **534 PASS / 2 FAIL / 1 SKIP**, 537 tests au dernier passage; attestation historique et substitution du root filesystem rouges |
| `npm run build` | PASS, build syntaxique du dépôt |
| `npm run test:integration` | **1 PASS**, traceur historique |
| `npm run test:vercel-routing` | PASS, six routes historiques; pas de nouvelle route courante |
| `npm run test:production-audit` | FAIL sur l'attestation historique; ne pas la réécrire pour approuver ce candidat |
| `node ops/test-a-completion-worker-audit.mjs` | PASS |
| `node --test test/fulfillment/secure-filesystem-snapshot.test.mjs` | **7 PASS** en isolation, alors que la suite complète reproduit le défaut; aucune correction ni levée de ce risque hérité |
| `npm audit --omit=dev --json` | 4 paquets modérés hérités : `@hono/node-server`, `hono`, `fast-uri`, `ajv`; 0 haut/critique |
| `npm --prefix migration/railway audit --omit=dev --json` | 0 avis |
| `git diff --check` | PASS |

Cas exercés : vingt tentatives concurrentes, substitutions avant admission, perte de consentement, mauvaise identité serveur et capability, révision/URL/destinataire/publication altérés, effet source pré-fencé sans ledger, crash d'un vrai processus après admission, ACK de COMMIT perdu et reçu durable avec ACK perdu. Le cycle réel de mutations de correction puis approbation conserve deux révisions et trois reçus distincts. Les décisions payantes sont des fixtures internes, pas des paiements ou revues humaines réels.

La composition corrigée conserve l'ID Cloudflare opaque de **998 octets** jusque dans le reçu courant et après réouverture; `deliveryFailed`, `failed`, `rejected` restent des échecs terminaux persistés, sans nouveau callback. La sélection Cloudflare pour les nouveaux envois ne reroute pas les lectures Resend historiques. Les réponses contradictoires ne remplacent pas un état terminal.

Les régressions manquantes ont été observées rouges avant leurs corrections : raccord absent, substitution du domaine historique, inspection historique absente, capability valide de 16 caractères et fence source importé sans ledger. Les logs RED restent privés dans l'évidence; aucune sortie n'est fabriquée.

## Limites, suppressions et prochain effet autorisé

Aucun fichier source existant supprimé; aucune base effacée ou remise à zéro. Les copies temporaires du mail sont retirées par leurs tests; le candidat et ses preuves sont conservés pour le reviewer. Deux bases de travail nouvelles restent synthétiques : `bb_candidate_delivery_bridge` et `bb_candidate_delivery_bridge_v2`. Aucun conteneur créé, arrêté ou inspecté : les refus Docker des parents sont respectés, sans contournement. L'image finale **n'a pas été reconstruite ni exécutée**; le Dockerfile ajoute seulement la copie nécessaire des sources du contrôle.

Ne sont pas portés : auth/session/throttle opérateur, scheduler/claim et queues, génération/narration, stockage/publication, rafraîchissement client, import/export/restauration réels, qualification des reçus sans fournisseur, événements fournisseur et inbox, ni déploiement Railway. Aucun writer opérationnel n'est raccordé à PostgreSQL; la totalité de leurs transactions doit être portée avant toute bascule pour éviter les doubles writers.

**Prochain effet : revue indépendante de ce nouvel arbre sur la même carte.** Aucun accès client, secret réel, paiement, envoi, DNS, ressource distante, push, déploiement ou bascule n'est autorisé. Les limites SPF/DKIM/DMARC, preview Cloudflare, lecture Resend et rollback restent celles des parents; ce raccord ne les qualifie pas.
