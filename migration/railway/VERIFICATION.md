# Vérification — candidat PostgreSQL/Railway Bébé Bonjour

## État et périmètre

Préparation locale du 8 novembre 2026, carte `t_62526e43`. Candidat additif sur `caa06ca6be0a8fd86600a79808ca2a90c0fe7ea5`, uniquement sous `migration/railway/`. Aucun fichier historique, mail, package/lock racine ou worktree pair modifié. Aucun fichier source supprimé. La production et les opérations clients restent sur leurs chemins existants.

L'incrément donne un parcours cible synthétique vérifié ; il ne constitue pas la sortie complète de Convex/Vercel. La matrice de parité, l'import non qualifié, le protocole à écrivain unique et le rollback sont dans `README.md` de ce dossier.

## Exécutions réelles

| Contrôle | Résultat |
| --- | --- |
| Node cible | `v22.23.4`, binaire de l'image officielle épinglée ; Node hôte initial `v24.21.0`, non retenu comme preuve cible |
| PostgreSQL | Serveur réel `16.15`, conteneur local `postgres:16-alpine`, base synthétique dédiée `bb_candidate_verified` |
| Tests candidat sur Node 22 | **10 passent, 0 échec, 0 ignoré** |
| Tests dans l'image finale, utilisateur `node` | **10 passent, 0 échec, 0 ignoré** ; inclut rendu réel, validation audio par ffprobe et arrêt du processus Node sur SIGTERM |
| `npm --prefix migration/railway run check` | PASS — syntaxe de tous les modules du candidat |
| `npm run build` | PASS — vérifications canoniques JS/Python/shell |
| `npm run test:integration` | PASS — tracer historique, 1 test |
| `npm run test:vercel-routing` | PASS — routes historiques inchangées ; pas une preuve de routage Railway en production |
| `node ops/test-a-completion-worker-audit.mjs` | PASS — portée historique du worker completion, sans activation |
| `npm test`, dernier passage Node 22 | **537 tests : 535 passent, 1 échoue, 1 ignoré** |
| `npm run test:production-audit` | ÉCHEC — ancien manifeste TEST-A lié à un périmètre exact ne couvre pas les nouveaux fichiers ; preuve historique non régénérée ni élargie pour obtenir un PASS |
| `npm --prefix migration/railway audit --omit=dev` | PASS — 0 vulnérabilité pour l'ajout PostgreSQL |
| `npm audit --omit=dev` racine | ÉCHEC — 4 vulnérabilités modérées préservées dans les dépendances racine : `@hono/node-server`, `hono`, `ajv`, `fast-uri` ; pas de correctif hors périmètre mail/package |
| `git diff --check` et contrôle des chemins historiques | PASS ; seules les additions du candidat sont présentes |

L'unique échec du dernier `npm test` est `successor consolidated audit binds the complete reviewed source boundary` : le manifeste Vercel/TEST-A ne correspond pas au nouveau périmètre. Deux passages précédents avaient aussi échoué sur `portable fallback rejects root substitution after authority binding`, dans des fichiers identiques au socle ; les 7 tests de ce fichier passent isolément et ce test passe au dernier run complet. Cette intermittence reste signalée, pas déclarée corrigée. Le test ignoré appartient à la suite historique.

## Parcours et frontières exercés

1. Intake synthétique avec consentement, rejet d'une adresse non synthétique, jeton de test et jeton privé par job ; jeton d'un autre job et origine non autorisée refusés. Aucune route opérateur ouverte.
2. PostgreSQL réel : création atomique des deux jobs et de la soumission, rollback après violation SQL finale, rejet des documents sans identifiant, réponse AES-GCM sans jeton en clair, clé incorrecte refusée, 20 mises à jour concurrentes sans perte.
3. Stripe SDK réel pour la signature sur corps brut : signature modifiée, mauvais montant, doublons et conflit de fingerprint ; reprise d'un résultat interrompu après paiement sans double avancement. La création Checkout est explicitement simulée, aucun appel Stripe distant.
4. Redémarrage par nouveau pool ; bail durable, worker concurrent, jeton de bail obsolète et completion expirée refusés. Retry de génération, révision/digests exacts et barrières d'approbation conservés.
5. Commandes locales réelles de revue/rendu/narration/approbation ; audio synthétique en remplacement explicite du réseau OpenAI ; publication `vercel-dry-run`, livraison `console-dry-run`, puis confirmation synthétique distincte. Aucun envoi ou déploiement réel revendiqué.

Le parcours complet vérifié est narré. Le premier essai non narré s'est arrêté sur la garde existante `Non-narrated release requires the exact content-approved artifact digests` entre revue privée et bundle préparé. Cette parité n'est pas qualifiée ; aucune égalité de digests ni approbation artificielle n'a été injectée pour passer la garde.

## Image et configuration

Image locale testée : `sha256:396ddb7fe9e9e33c5da9aa29f2c79b44134ea5348adf237bd90c4c2372b00ae1`, utilisateur `node`. L'image est construite depuis une liste de fichiers source, sans `.git`, secret d'environnement ni dépendances hôte ; les dépendances sont réinstallées depuis les deux locks. FFmpeg/ffprobe est installé dans l'image. Le build ne se connecte à aucune base et ne crée pas de schéma.

Commande de reconstruction depuis le commit signé : `git archive HEAD | docker build -f migration/railway/Dockerfile -t bb-railway-candidate:review -`. Le contexte Dockerfile spécifique protège les builds modernes ; l'archive source évite également le transfert des dépendances locales avec le builder Docker classique.

`railway.json` a été parsé et ses chemins, builder Dockerfile, healthcheck et absence de pre-deploy/initialisation automatique ont été contrôlés. La documentation officielle confirme `DOCKERFILE`, `dockerfilePath` et `$PORT`. Le schéma distant Railway a renvoyé 403 : validation complète côté fournisseur non exécutée. Aucune ressource Railway, bucket R2, DNS ou secret réel créé.

L'initialiseur a été exécuté sur la base locale puis a refusé une URL distante avant connexion. Le serveur HTTP conteneurisé a répondu `200` au healthcheck, `201/payment_pending` à l'intake synthétique et `200/payment_pending` au statut privé, avec `Cache-Control: no-store`.

## Composition, revue et ressources temporaires

Branche mail observée : `31e0ca1dc2d82496b453e9512e0c55599d1ff220`, six fichiers mail, aucun recouvrement avec ce dossier. Aucune fusion ni activation mail effectuée. Avant toute bascule future, réconcilier aussi les sources plus récentes du canonique et les changements non committés du worktree ops ; préserver leurs fonctionnalités et décisions.

La prochaine action est la revue indépendante du candidat signé, de sa frontière synthétique et de cette matrice ; pas un déploiement. Auth/session/throttle opérateur, file de commandes, stores de génération, stockage/publication cible, données existantes et réception réelle restent non qualifiés. Aucune opération client n'a été déplacée dans Kanban.

Les tests de processus Node prouvent l'arrêt gracieux. L'arrêt/nettoyage Docker est séparément bloqué par la politique de l'exécution headless : `docker run --rm` et `docker stop` ont été refusés et n'ont pas été contournés. Deux conteneurs de test restent actifs, étiquetés `hermes.task=t_62526e43` : `bb-candidate-t62526e43` (PostgreSQL, loopback `32770`) et `bb-candidate-http-t62526e43` (ancienne image sans FFmpeg, loopback `32771`, uniquement données synthétiques). Les conteneurs `bb-node22-t62526e43` et `bb-candidate-tests*-t62526e43` sont créés/arrêtés. Ils ne sont pas de la production ; leur retrait natif reste à effectuer après la consommation de la revue, avec l'autorité de lifecycle requise. Aucun conteneur pair touché.
