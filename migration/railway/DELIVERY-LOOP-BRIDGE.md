# Raccord synthétique du delivery loop courant

## Frontière de source

Le socle backend est `a5ec7602cf4f2d945978fe12b6fdf381f5e4b672`; le mail corrigé reste `bf94f9a01057664b996a41ddde4ed94717b3fa03`. La chaîne `t_d4163412` a produit `4859da6`, rejeté pour narration cachée, puis les correctifs SR-01/confidentialité composés et le paiement `f64d2f8030ee8a574f87491db5aa1368194b52cf` ont reçu leurs PASS locaux indépendants. Le descendant conservé `5f9e639` ajoute la promotion contrôlée : sa présence ne transforme pas le premier candidat rejeté en candidat approuvé et ne vaut pas PASS de ce raccord.

Les sources nécessaires du contrôle courant sont conservées dans `current-loop/`, avec manifeste d'origine Git et SHA-256 avant modification. Ce sont les mêmes handlers `authorizeProvider`, `fence` et `completeEmail`, non un nouveau moteur de commandes. Le chemin historique `/api/customer-flow` ne devient pas l'autorité du cycle courant.

## Incrément local

Une table dédiée conserve **le document courant** `deliveryLoopJobs` synthétique, sans traduction en commande historique. Un adaptateur de contexte limité exécute les vrais handlers sur ce document, sous verrou PostgreSQL. Il n'implémente ni scheduler, claim, intake, génération, publication ni nouvelle décision client. Il n'est accessible par aucune route HTTP et aucun worker de production n'est branché.

1. L'identité serveur est injectée à la construction du raccord, jamais lue depuis un booléen client. L'appel accepte uniquement job, révision, étape et capability de bail. Le fournisseur est une configuration serveur explicite. Les capabilities du contrôle courant restent acceptées dès 16 caractères, avec leur contenu exact; le seam historique conserve son minimum propre de 32.
2. Avant préparation et admission, verrouiller le document courant et exécuter `authorizeProvider` : identité serveur, capability, expiration, étape, révision, statut et règles payantes sont ceux du contrôle existant. Vérifier aussi le consentement courant et dériver le message exact côté serveur, sans payload arbitraire.
3. Dans la même transaction que l'admission SQL one-shot, revalider ces contrôles et le digest exact, puis exécuter `fence`. Aucun appel fournisseur sous verrou. Les transitions d'approbation, permissions, paiement, éditorial, annulation et publication ne sont pas remplacées par un flag `approved`.
4. Conserver le reçu fournisseur avant de terminer le contrôle courant. Un crash après admission ou un reçu durable dont la complétion reste incertaine ne rouvre jamais l'effet. Un fence déjà présent dans le document courant sans admission correspondante dans ce ledger est également incertain : refuser avant de préparer un nouvel intent. La reprise ne réémet pas. Les identifiants Cloudflare restent opaques; la complétion locale doit conserver leurs octets et le fournisseur explicitement.

Le banc importe seulement des fixtures créées par les vrais handlers courants dans `convex-test`, puis exerce les contrôles et le ledger sur PostgreSQL réel dédié. Ce transfert synthétique n'est pas un import de production. Les appels réseau des fournisseurs sont remplacés et refusés hors fixtures.

Les reçus historiques déjà liés et portant un fournisseur explicite ont un chemin d'inspection sans création d'intent ni admission. Les observations sont persistées séparément des reçus immuables et gardent leur fournisseur; la configuration des nouveaux envois ne les reroute pas. Un reçu ancien sans fournisseur est refusé : sa provenance doit être qualifiée lors d'un futur import, jamais devinée à partir de l'ID ou d'un champ client. La qualification et l'import des reçus de production restent hors portée.

Le ledger conserve une clé étrangère exclusive vers le document courant **ou** la fixture historique, vérifiée aussi à l'admission. Les deux domaines ne sont pas interchangeables même avec le même identifiant de job. Le schéma est celui d'une base synthétique neuve : aucune migration ni réinitialisation d'une base existante.

## Hors portée

Convex reste l'autorité opérationnelle. Auth/session/throttle opérateur, claim/scheduler, queues, génération/narration, stockage/publication, réactivité client, import/export/restauration de données réelles et bascule ne sont pas portés. Les mutations des décisions courantes restent leurs handlers d'origine. Le port de tous leurs writers est un préalable distinct à toute activation; aucun double writer n'est autorisé. Aucun secret, client, paiement, envoi réel, DNS, ressource distante, push ou déploiement.

Les défauts hérités filesystem, attestation historique et advisories restent visibles. Ce nouvel arbre exige sa revue indépendante; ni le PASS backend ni le PASS mail ne l'approuvent.
