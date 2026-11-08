# Contrat local des effets mail — complément au candidat Railway

Précision opérateur du 8 novembre 2026 : le PASS mail porte sur le delta corrigé `bf94f9a01057664b996a41ddde4ed94717b3fa03`, pas sur son prédécesseur. Ce PASS ne qualifie pas son intégration avec le backend.

## Préserver le produit courant

Le canonique avait été lu sans modification lors de la préparation backend. Le raccord actuel fige maintenant le descendant commercial signé `5f9e639`, avec sa chaîne de corrections acceptées explicitée dans `DELIVERY-LOOP-BRIDGE.md`; il ne rebascule ni canonique ni worktree de vente. Le contrat courant publie/envoie la première version avant révision humaine, conserve les corrections sur une URL stable, les anciennes révisions, la narration Cedar et les reçus. Le parcours historique `/api/customer-flow` ne remplace **pas** cette autorité, ses approbations ni ses writers. Ne pas transférer à ce delivery loop les anciennes barrières de revue TEST-A.

Aucun worker, route opérateur, sélection de fournisseur ou reçu courant n'est modifié. Le port intégral de `deliveryLoop` (auth, consentement, waiver réel sans faux paiement, génération, corrections, assets, publication, reprise) reste à faire sur une source acceptée. Les refus filesystem/attestation, la lecture Resend limitée par les scopes et les avis de dépendances restent visibles. Aucun envoi ou accès fournisseur réel n'est autorisé ici.

## Admission PostgreSQL one-shot

Le nouveau ledger `bb_candidate.email_effects` est un contrat interne de préparation synthétique, pas une habilitation HTTP ou un worker activé.

1. Un contrôle de confiance prépare un intent immuable : job existant synthétique, révision, étape `draft_email`/`final_email`, fournisseur explicite, clé canonique `bebe-loop:…`, digest du message exact, digest du bail et expiration. Aucun mot de passe, texte de message ou destinataire n'est stocké dans ce ledger.
2. L'envoi passe uniquement par `send(intent, message, transport)`. Une transaction verrouille l'intent et marque l'admission **avant** le callback réseau, une seule fois. Le contrôle du bail utilise l'horloge PostgreSQL. L'unicité `(job, révision, étape)` interdit de contourner la clôture en changeant de fournisseur ou de clé.
3. Aucun verrou SQL n'est tenu pendant l'appel externe. Si l'issue est inconnue, le ledger reste `issued` ou `reconciliation_required` : pas de remise à zéro après timeout, expiration ou redémarrage. Un nouveau callback n'est jamais admis pour cet effet.
4. Un reçu accepté est persisté avant de retourner. Un rejeu identique restitue ce reçu sans callback. Une collision d'identité, un reçu différent, une panne de persistance ou un état incertain ne déclenchent aucun retry réseau. La preuve ne promet pas exactement-un-envoi : un crash après admission et avant réseau peut produire zéro envoi, ce qui exige une réconciliation plutôt qu'un doublon.

La préparation d'intent est une API interne de confiance. Son raccordement synthétique aux vrais handlers courants est décrit dans `DELIVERY-LOOP-BRIDGE.md` et qualifié séparément par `test:delivery-loop`; aucune route client, aucun worker ni autorité opérationnelle n'est activé. La présence d'une fonction de préparation ne vaut pas autorisation de s'en servir sur des données existantes.

## Fournisseur et reçus

Le reçu est lié au job, à l'intent et au **fournisseur persistant**. Le routage d'inspection ne dépend ni du fournisseur actuellement configuré pour les nouveaux envois ni du format supposé de l'ID. Un reçu Resend ne peut pas être lu chez Cloudflare, et inversement. L'absence de fournisseur dans un export ancien exige une provenance vérifiée ; aucun défaut implicite ne transforme un ancien reçu en reçu Cloudflare.

Les identifiants Cloudflare sont opaques : conserver exactement 1 à 998 caractères ASCII imprimables, sans trim, minuscule ou supposition UUID. Ne pas les injecter dans une URL de chemin. Le transport corrigé utilise des variables JSON/GraphQL et un match exact. Les identifiants Resend restent soumis au contrat de leur propre lecteur.

L'inspection Resend utilise uniquement le GET `/emails/{id}` du SDK Resend sur l'origine exacte `https://api.resend.com`, sans redirection et avec signal d'expiration de 30 secondes, pour un reçu Resend déjà lié. L'ID retourné doit être identique. Un HTTP 401, une réponse inconnue ou un ID différent ne deviennent jamais `delivered`. L'inspection Cloudflare appelle le `status` du delta corrigé ; `pending`, `delivered` et `failed` restent distincts. Les échecs terminaux et leurs codes sont persistés avec `retryable=false`, sans renvoi. Un état terminal ne peut pas être remplacé silencieusement par un état contradictoire.

## Vérification et portée

Les tests par défaut utilisent PostgreSQL réel et des callbacks/lecteurs synthétiques explicitement identifiés. Un test de composition séparé doit matérialiser le **seul delta corrigé signé** sans écrire dans sa branche, l'appeler avec le véritable fence PostgreSQL et un fetch simulé, puis vérifier concurrence, reprise incertaine, ID opaque et inspection d'échec terminal. Il ne doit faire aucun appel Cloudflare ou Resend réel.

Le test de composition n'autorise pas une activation. Le banc `test:delivery-loop` raccorde localement les capacités/baux courants au ledger, mais ne porte pas tous leurs writers; qualifier séparément imports, attestation des artefacts, interfaces et provenance des reçus historiques avant toute action réelle. Les candidats backend, contrôle courant et mail gardent leurs frontières et leurs revues propres.
