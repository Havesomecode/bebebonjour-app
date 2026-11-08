# Source courante conservée pour le banc local

`source-manifest.json` fige les blobs du descendant signé `5f9e639` de la chaîne commerciale. Les fichiers non modifiés sont des sources Git exactes, pas des réimplémentations du moteur de livraison. `email-payload.mjs` extrait sans réécriture la construction du message et l'échappement HTML du provider courant.

Le seul delta de contrôle est dans `convex/deliveryLoop.js:completeEmail` : fournisseur explicitement validé et persisté, identifiant opaque imprimable de 1 à 998 octets conservé sans trim, replay lié aussi au fournisseur. Les handlers d'autorisation, de fence, de paiement, d'éditorial, de consentement et de révision sont inchangés. Les anciens reçus ne sont pas réétiquetés.

`test/source-provenance.mjs` vérifie signature, arbre, blobs et empreintes des origines, toutes les copies inchangées, l'extraction exacte du message et la borne exacte du delta `completeEmail`. Les empreintes des fichiers candidats sont dans le même manifeste; cela détecte la dérive, sans se substituer à la revue du diff.

Le contexte PostgreSQL n'appelle que l'autorisation, le fence, la complétion et la lecture. Les autres exports servent uniquement au banc `convex-test`, qui produit des fixtures en utilisant les mutations existantes. Aucun routeur, worker, déploiement ou scheduler ne découvre ces handlers automatiquement. Le schéma de fixture n'est pas un schéma Convex de déploiement.

La présence de décisions humaines ou de paiement dans les fixtures n'atteste aucune intervention humaine ou transaction réelle. Le chemin de qualification est exclusivement synthétique; l'autorité opérationnelle reste Convex.
