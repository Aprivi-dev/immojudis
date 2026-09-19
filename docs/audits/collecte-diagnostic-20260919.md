# Diagnostic des erreurs de collecte — 19 septembre 2026

Diagnostic initial en lecture seule de la production Supabase `sgpakxtyvenlpeihuucm`, des dernières exécutions et du code local au commit `5a23d252`. Les métriques de fraîcheur consultées datent de 11:30 UTC (13:30 à Paris). La section finale décrit les corrections ensuite autorisées par l'utilisateur et leur validation.

## Conclusions et preuves

### 1. Notaires : conflit d'identité à la publication — priorité haute

- Dernière exécution `93f1ac48-4e03-404e-83ba-30dd5b0d81d1` : 830 annonces collectées, aucune erreur HTTP, inventaire complet ; publication échouée. Sept échecs consécutifs.
- Journal : 173 annonces publiées, 631 expirées selon la politique de rétention, 3 en quarantaine et **23 décisions `publication_failed`**. Ces 23 échecs ne signifient pas 23 collisions : un conflit peut faire échouer un lot.
- Erreur : `auction_sales.source_name is immutable for an existing source_url`.
- Collision confirmée par jointure des checkpoints et des ventes : l'URL Immo-interactif terminant par `/2075541` arrive avec `source_name=notaires`, alors que la ligne existante appartient à `agrasc`.
- `publication_identity.py`, fonction `merge_revision` : lorsque l'URL est identique, l'objet entrant conserve sa source ; la branche des URL différentes préserve explicitement la source existante. La protection SQL rejette donc la première branche.
- Reproduction locale, en mémoire avec deux annonces synthétiques à URL identique : source stockée `agrasc`, entrante `notaires`, fusionnée `notaires` ; violation confirmée. Aucune écriture en base pour cette reproduction.

**Correction proposée :** conserver l'identité canonique existante, enregistrer séparément la provenance et les preuves de chaque collecteur, et conserver les contrôles de conflit immobilier. Ne pas supprimer le trigger. Tester même URL/deux sources, fusion d'alias, conflit réel et atomicité du lot ; reprendre les publications en échec après validation.

### 2. Petites Affiches : durée maximale et reprise inefficace — priorité haute

- Dernière exécution `bf9535ea-e60b-4046-9cff-493169b65fcd` : arrêt après exactement 35 minutes, erreur `Execution budget exceeded; committed checkpoints preserved` ; huit échecs consécutifs.
- Des résultats sont néanmoins enregistrés : 343 décisions publiées (dont 23 alias), 7 quarantaines et 12 découvertes non finalisées. Le libellé « Indisponible » masque ce progrès partiel.
- 353 checkpoints dans la dernière exécution, aucun marqué comme restauré. L'exécution précédente en comptait 298, également sans restauration.
- La précédente exécution finit le 18 septembre à 22:21 UTC ; la suivante commence le 19 à 07:31 UTC. `source_checkpoint._context` ne recharge que les checkpoints de moins de six heures. Tous ceux de la précédente exécution sont donc inéligibles.
- `autonomous_runner.execute` impose 2 100 secondes. Après plusieurs échecs, `next_attempt` impose six heures d'attente, auxquelles s'ajoute l'attente du scheduler : cette combinaison est incompatible avec le TTL actuel.
- Erreur supplémentaire le 18 septembre dans `c20d3ad3-3c80-4ac5-9e08-d7499c0d6033` : observation rattachée à une URL canonique absente de `auction_sales` (`23503`). Le délai n'est donc pas le seul problème à traiter.

**Correction proposée :** reprise durable par page/département avec curseur, durée de conservation compatible avec les relances et contrôle de fraîcheur indépendant ; sortie propre avant la limite et publication progressive. Auditer les observations pour n'écrire que des références canoniques effectivement persistées, avec atomicité adaptée. Une hausse de durée peut aider provisoirement, mais ne résout ni la reprise ni la clé étrangère.

### 3. Enchères Immobilières : réseau et données incohérentes — priorité haute

- Dernières exécutions : timeout sur `https://encheresimmobilieres.fr/biens-en-vente`, aucune annonce émise dans la dernière ; huit échecs consécutifs. Fraîcheur : 21/213.
- Une exécution du 18 septembre (`f2c82631-d856-4688-91f2-e0fbb647b489`) avait accédé aux données, puis échoué sur `auction_sales_rooms_bedrooms_check` : 3 pièces, 4 chambres. Son erreur montre aussi une URL d'annonce 9486 associée à un texte « Réf. annonce : 9490 ». Cela justifie de vérifier l'association carte/détail ; la cause de cette divergence n'est pas encore établie.
- L'analyse du collecteur confirme l'absence de comparaison des identifiants avant fusion carte/détail : l'identifiant extrait du détail ne figure pas dans `DETAIL_OVERRIDE_FIELDS`. La boucle de pagination utilise également `PaginationCoverage.accept` sans signal terminal explicite : vérifier ce second obstacle à la certification une fois l'accès rétabli. La provenance exacte du couple 3 pièces/4 chambres reste à reproduire ; les fusions doivent aussi préserver l'invariant après normalisation.

**Correction proposée :** sonde limitée depuis l'environnement réel du collecteur pour séparer lenteur du site, connectivité et refus ; vérifier les réponses et la pagination avant d'ajuster le transport ou les délais. Ajouter validation pièces/chambres et contrôle d'identité carte/détail avant publication. Isoler les données contradictoires et préserver leurs preuves, sans bloquer tout un lot ni inventer des valeurs.

### 4. Enchères Publiques : refus HTTP explicite — priorité dépendante de l'accès

- Erreur HTTP 403 sur une fiche détail ; source suspendue jusqu'au 19 septembre à 20:16:54 UTC (22:16:54 Paris). Fraîcheur : 0/22.
- La suspension est enregistrée par le worker de vérification des détails ; l'absence de `last_run_id` ne signifie pas absence d'activité.
- Le refus est prouvé, mais sa cause exacte (politique d'accès, protection, environnement réseau) ne l'est pas.

**Correction proposée :** conserver le délai de reprise et effectuer un contrôle limité après celui-ci. Si le refus persiste, rechercher une API, un flux ou un accès autorisé auprès de la source. Éviter les relances intégrales répétées ; signaler clairement le blocage et la vieillesse des fiches.

### 5. AGRASC : périmètre de certification trop large pour les annonces actives

- Dernière exécution `38187c33-c56b-49b9-8633-21bcf6f3a040` : 9 requêtes réussies, 0 erreur réseau, 7 annonces émises ; 5 publiées, 1 expirée, 1 exclue pour absence de prix et surface.
- Certificat : `public_cards_without_identifiers`, avec 26 cartes sans lien toutes marquées vendues ; inventaire public adressable certifié, découverte publique globale non certifiée.
- `catalogue_proof.py` distingue déjà ces deux périmètres. Le résultat global reste incomplet et `main.py` lève `Collection incomplete; catalogue cleanup is disabled`, ce qui fait échouer le run. Huit échecs consécutifs malgré les publications effectuées.

**Correction proposée :** rendre explicites le périmètre actif/adressable et les archives vendues sans identifiant, avec preuve d'exclusion conservée. Autoriser un statut de réussite partielle justifié et une certification ciblée lorsque les critères sont satisfaits. Conserver la protection qui interdit le nettoyage sur inventaire incomplet.

## Plan d'action proposé

1. **Fiabiliser la publication commune** : identité Notaires/AGRASC, références canoniques Petites Affiches, validation Enchères Immobilières. Ajouter des tests de non-régression et d'isolation des erreurs par lot.
2. **Réparer la reprise Petites Affiches** : curseur durable, sauvegardes réutilisables après l'attente réelle, arrêt propre, métriques de progression. Valider une interruption suivie d'une reprise sans recommencer les fiches déjà traitées ni rajeunir artificiellement leur date de contrôle.
3. **Qualifier l'accès aux deux sources d'enchères** : probes bornées dans l'environnement du worker ; choix du transport et du timeout selon résultats. Pour un refus persistant, engager la piste d'un accès autorisé.
4. **Clarifier AGRASC et la supervision** : distinguer accès, inventaire, publication et fraîcheur ; afficher cause, étape, date, nombre d'éléments affectés et prochaine reprise. Notaires doit signaler « publication partielle » même si le site est accessible ; Petites Affiches doit conserver sa progression quand le processus expire.
5. **Reprendre de façon ciblée et observer** : rattrapage des éléments échoués, puis au moins deux cycles automatiques réussis. Critères : aucun échec de publication inexpliqué, aucune référence orpheline, reprise démontrée et objectif de fraîcheur proposé de 95 % par source accessible. Documenter séparément les refus externes persistants et les exclusions justifiées.

Les cinq autres sources ont un dernier inventaire et une publication complets. Cela ne garantit pas la fraîcheur de chaque fiche : Avoventes reste à 169/193 (88 %) et mérite un contrôle de la file de vérification après les blocages prioritaires. Le budget IA visible dans la capture n'explique pas les erreurs identifiées : les collectes automatiques sont lancées avec `--no-llm` ; son éventuel effet sur l'enrichissement relève d'un contrôle distinct.

## Repères techniques

- `services/data-pipeline/src/publication_identity.py` : `merge_revision`.
- `supabase/migrations/20260714160149_protect_auction_sale_source_identity.sql` : trigger d'identité.
- `services/data-pipeline/src/autonomous_runner.py` : `next_attempt`, `finish_source`, `execute`.
- `services/data-pipeline/src/source_checkpoint.py` : `_context`, `CheckpointSales`.
- `services/data-pipeline/src/main.py` : publication anticipée/finale et garde de nettoyage.
- `services/data-pipeline/src/catalogue_proof.py` : certification et cartes sans identifiant.
- `services/data-pipeline/src/source_detail_worker.py` : suspension sur refus HTTP.
- `src/components/admin/AdminPipelinePanel.tsx` : affichage des statuts et erreurs.

Limites du diagnostic initial : les constats ci-dessus reposent sur les erreurs persistées, les journaux de décisions, les checkpoints, le code et la reproduction locale indiquée. Les causes réseau précises et l'origine historique des incohérences de contenu restent à qualifier.

## Correctifs et validation avant mise en production

Après accord de l'utilisateur pour implémenter et publier :

- Identité canonique conservée pour une URL partagée par plusieurs collecteurs, avec provenance et observations récentes préservées. Les contraintes SQL restent actives.
- Valeurs pièces/chambres contradictoires retirées des champs structurés, preuves conservées ; vérification du parent canonique avant écriture des observations et refus du repli REST non transactionnel après une erreur PostgreSQL.
- Enchères Immobilières : rejet des détails dont l'identifiant diffère de celui de la carte ; conservation de la carte sans réhydratation des anciens détails incohérents ; une page vide ne prouve jamais la fin de l'inventaire.
- Petites Affiches : curseurs persistants par partition/page, conservation des checkpoints pendant 24 heures sans modifier la date réelle de contrôle, arrêt du collecteur avant la limite du processus. Une reprise sur des pages anciennes exige ensuite une nouvelle vérification avant de certifier l'inventaire courant.
- AGRASC : succès partiel explicite pour le catalogue public adressable lorsque sa preuve est complète. Les archives vendues sans lien ne deviennent pas artificiellement complètes et aucun nettoyage n'est autorisé par ce certificat limité.
- Administration : séparation des publications partielles, collectes à reprendre, délais réseau dépassés et refus d'accès ; dernière tentative et compteurs de publication visibles.

Validation locale : suite Python complète avec PostgreSQL 17 jetable en UTF-8 (1 471 réussis, 14 ignorés), suite web (991 réussis, 1 ignoré), parcours administration Chromium (7 réussis, 1 ignoré), typage, lint, invariants de sécurité et de planification, budgets du build. Les tests ignorés correspondent aux prérequis optionnels des suites existantes.

Deux sondes bornées depuis GitHub Actions ont donné, pour Enchères Immobilières, un HTTP 200 en 988 ms puis un dépassement de 45 secondes. L'accès est donc intermittent ; aucun contournement ni augmentation aveugle des délais n'est introduit. Enchères Publiques reste soumise à son délai de reprise après HTTP 403. La validation en production et l'observation des cycles doivent être consignées séparément après déploiement ; les tests locaux ne prouvent pas le rétablissement d'une source externe.
