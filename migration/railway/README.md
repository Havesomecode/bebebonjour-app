# Candidat Railway/PostgreSQL — Bébé Bonjour

Préparation locale du 8 novembre 2026. Aucun changement de production. Les opérations clients restent dans Convex. Ce dossier est un incrément additif, pas une migration achevée ni un remplacement de l'interface opérateur.

## Parcours livré

Un service Node 22 exécute les routes existantes `/api/customer-flow/v1/*` et le webhook Stripe sur corps brut, avec un adaptateur PostgreSQL réel. Il réutilise les validations d'intake, le jeton privé de chaque commande, le chiffrement des réponses idempotentes et les transitions de fulfillment existantes. Intake et agrégat initial sont créés dans une transaction. Les transitions concurrentes sont sérialisées par verrou de ligne ; l'unicité des submissions et événements est durable. Aucun SDK Convex n'est invoqué par ce runtime.

Le candidat accepte **uniquement des données synthétiques et Stripe test**. Sans `BB_CANDIDATE_MODE=synthetic`, il refuse de démarrer. Il ne démarre aucun worker et n'expose aucune mutation opérateur : un jeton client ne donne donc pas accès aux approbations, à la publication ou à l'envoi. Les tests exercent ces transitions séparément avec les véritables commandes de rendu locales ; les effets Stripe/OpenAI/publication/mail y restent simulés et explicitement nommés.

## Exécuter localement

Depuis la racine du dépôt :

1. Utiliser Node 22 et vérifier `ffprobe -version` (FFmpeg), puis `npm ci --ignore-scripts` et `npm --prefix migration/railway ci --ignore-scripts`.
2. Fournir les variables de `.env.example` par l'environnement, sans fichier de production. Les redirections checkout restent HTTPS même si le serveur local écoute en HTTP.
3. Démarrer un PostgreSQL 16 jetable sur loopback avec une base dédiée `bb_candidate`. Ne pas utiliser une base existante. Exécuter `npm --prefix migration/railway run init-db` ; cet initialiseur refuse toute base distante et ne tourne jamais pendant build/start.
4. Démarrer `npm --prefix migration/railway start`. Dans un autre terminal, `BB_TEST_DATABASE_URL=<URL loopback de la base dédiée> npm --prefix migration/railway test` exécute les tests ; ils refusent toute URL distante ou base dont le nom ne commence pas par `bb_candidate`. Ils utilisent des identifiants uniques et ne détruisent aucune base/table.

Le test d'intégration doit échouer si la base manque, pas être silencieusement ignoré. `npm --prefix migration/railway run check` contrôle la syntaxe. Le healthcheck `/healthz` vérifie la connexion et le schéma ; il ne contient pas de nom de client ni de secret. SIGTERM ferme l'écoute HTTP et le pool.

## Hébergement préparé, non activé

Contexte Docker = racine du dépôt ; Dockerfile = `migration/railway/Dockerfile`, configuration = `migration/railway/railway.json`. Avant une activation future, sélectionner explicitement ce chemin de configuration dans Railway (il n'est pas à la racine). L'image Node 22 est épinglée par digest et inclut FFmpeg/ffprobe, requis par les commandes de narration existantes. Le conteneur tourne sans root et écoute `0.0.0.0:$PORT`. Les variables sont explicitement requises ; aucune credential n'est embarquée. Le build n'applique pas de schéma. L'initialisation sera une action distincte après autorisation d'une base cible vide. Aucun trigger, cron ou génération n'est branché. Les contrôles d'accès et CORS des routes clients sont conservés, sans cookies supplémentaires.

Références techniques consultées : documentation officielle Railway, « Dockerfiles » et « Healthchecks » ; node-postgres, « Transactions » ; PostgreSQL 16, « Explicit Locking ». Leur configuration distante effective reste à qualifier.

## Correspondance et parité

Les contraintes SQL refusent les identités/versions manquantes. JSONB conserve les objets et identifiants, pas leur ordre de sérialisation ; les digests d'artefacts restent liés aux octets des fichiers, jamais à une re-sérialisation SQL. L'initialisation est destinée à une base vide, pas à mettre à jour un schéma d'essai antérieur.

| Source Convex / contrat | Candidat / état |
| --- | --- |
| `customerFlowJobs.jobId` / version | `bb_candidate.customer_jobs` : PK `job_id`, JSONB `job`, version dans l'agrégat ; aucune réattribution d'ID |
| `customerFlowSubmissions.idempotencyKey` | `submissions` : PK clé, digest, réponse AES-GCM ; FK vers job ; réponse privée jamais stockée en clair |
| `customerFlowProviderEvents.providerEventId` | `provider_events` : PK événement, fingerprint et résultat ; doublons/reprise persistants |
| `fulfillmentJobs.jobId` | `fulfillment_jobs` : PK/FK job, agrégat JSONB exact et transitions existantes |
| `fulfillmentReviewApprovals.approvalId` | `review_approvals` : PK approbation, document immuable ; pas de route publique |
| `customerFlowWorkItems` | Non porté : ancien bridge Kanban, ne pas activer pour les opérations clients |
| `customerFlowOperationsCommands` + indexes state/action/version/lease | Non porté ; file opérateur et capacités workers restent Convex |
| `customerFlowOperationsLoginThrottle` | Non porté ; auth/session/limites opérateur existantes restent dans le dépôt ops/Convex |
| `fulfillmentGenerationEditorialApprovals`, `fulfillmentGenerationArtifactSets` | Non portés ; chemins et approbations privées restent dans les stores existants |
| `fulfillmentCodexAuthState` | Non porté ; ne pas copier envelope, secret, lease ou credential |
| Blobs privés et publication Vercel | Non portés ; R2 différé tant que permissions, URLs, TTL et octets exacts ne sont pas qualifiés |
| Landing / ops séparés, Tally, cron, abonnements Convex | Non reroutés ; aucun remplacement fictif de réactivité ; requalification et branchement séparés |

Variables : `DATABASE_URL`, `BB_CANDIDATE_MODE`, `CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY`, `CUSTOMER_FLOW_TEST_ACCESS_TOKEN`, `CUSTOMER_FLOW_ALLOWED_ORIGINS`, `STRIPE_SECRET_KEY`, `STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET`, `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`, `PORT`. Réutiliser les secrets existants seulement lors d'une autorisation distincte ; les fixtures ne sont pas des credentials. Aucun compte utilisateur ou mot de passe n'est migré.

## Sources et composition mail

Socle imposé : `caa06ca6be0a8fd86600a79808ca2a90c0fe7ea5`, tree `0d8b58aa7c75f49c7255ffd530fadc297482c92e`. Le canonique est à `a4e9fab20ea97c694e32ac5509139085942f38fe`, avec ses propres changements ; il n'est pas rétrogradé. La branche privée ops contient des changements non committés, conservés. Landing observée à `ea4cc9165711801801bebceac175b47b67b06cdb`, ops à `2a7251a8a4e72b428c3f492900418264da4fa7a0` : aucune qualification de déploiement déduite de ces SHA.

Tous les nouveaux fichiers sont sous `migration/railway/`. Ni package/lock racine, ni mail, ni fichiers des worktrees pairs ne sont modifiés. La branche mail observée à `31e0ca1dc2d82496b453e9512e0c55599d1ff220` ne change que ses six fichiers mail, sans recouvrement. Composer ensuite les deux candidats après revue ; l'adaptateur mail n'est pas une dépendance de ce runtime sans envoi. Avant toute activation, réconcilier également les évolutions acceptées du canonique et du worktree ops : ce candidat ancien socle ne les remplace pas.

## Import à blanc et bascule future

Aucun export réel n'est demandé ou chargé. L'import existant reste **non qualifié**, pas de migration générique permissive : il faut d'abord exporter hors ligne les tables autorisées et inventorier IDs, relations, blobs, commandes en vol et preuves de paiement. Ne jamais exporter credentials Codex ni sessions en clair.

1. Avec une autorisation distincte, produire snapshot et delta ; valider compte par table, PK uniques, FK, digests des JSON/objets et restauration dans une base isolée. Les tables non portées ci-dessus empêchent une bascule complète.
2. Arrêter/drainer seulement les writers concernés (Tally, Stripe, UI ops, génération, completion, cron) ; conserver les événements entrants pour rejeu signé. Ne jamais laisser Convex et PostgreSQL écrire le même job.
3. Importer à blanc puis delta final, vérifier les relations et les approbations révision/digest, habilitations et limites. Rerouter un seul écrivain après revue et autorisation, puis vérifier paiement, génération, décision, publication exacte et réception réelle séparément.
4. Avant toute écriture cible : rollback du routage vers Convex, cible désactivée. Après une écriture cible : ne pas revenir aveuglément ; arrêter l'écrivain cible, réconcilier les nouveaux IDs/événements/effets, importer le delta vérifié puis seulement réactiver Convex. Ne jamais rejouer automatiquement une publication/un envoi dont le résultat est incertain.

La prochaine étape est la revue indépendante de ce candidat borné, pas un déploiement. La sortie complète de Convex/Vercel nécessite les adaptateurs ops, génération, publication/objets, reprise et import encore absents.
