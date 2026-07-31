# Matrice de conservation

Le cron `/api/cron/data-retention` appelle `public.run_data_retention` chaque semaine. Les durées
ci-dessous sont des règles techniques ; la validation juridique peut les réduire ou imposer une
archive intermédiaire plus stricte.

| Données                                                                   | Durée / déclencheur                                                                     | Action                                                                                                                                   | Justification                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Notifications lues, rejetées ou échouées                                  | 6 mois                                                                                  | Suppression                                                                                                                              | Utilité opérationnelle terminée                                 |
| Limites de débit                                                          | 2 jours                                                                                 | Suppression                                                                                                                              | Protection technique courte                                     |
| Événements d’usage, exports, estimations, placements, webhooks, runs      | 24 mois                                                                                 | Suppression                                                                                                                              | Mesure, audit et exploitation                                   |
| Acceptations commerciales                                                 | 10 ans après acceptation                                                                | Suppression automatique, compte pseudonymisé à l’effacement                                                                              | Preuve contractuelle/comptable                                  |
| Demandes RGPD/rétractation                                                | 5 ans après clôture                                                                     | Suppression automatique                                                                                                                  | Preuve du traitement d’une demande                              |
| Favoris, alertes, rapports, notes, espaces et clés API                    | Jusqu’à effacement du compte                                                            | Cascade après suppression Auth                                                                                                           | Exécution du service                                            |
| Objets Storage utilisateur                                                | Jusqu’à effacement du compte                                                            | Suppression préalable via l’API Storage                                                                                                  | Éviter les objets orphelins                                     |
| Artefacts bruts des sources Outcome, dont texte Judilibre et fichiers DVF | **À fixer avant activation** ; correction, occultation ou suppression amont prioritaire | Bucket privé ; purge physique et propagation aux dérivés selon décision juridique ; aucune URL publique durable                          | Provenance et revue, avec minimisation des données personnelles |
| Fetches, extractions, candidats source et décisions de matching Outcome   | **À fixer avant activation** ; nouvelle version à chaque correction                     | Historique append-only ; isoler ou purger le contenu visé sans réécriture silencieuse ; conserver seulement la preuve minimale autorisée | Audit de provenance, qualité et reproductibilité                |
| Journal minimal de purge/correction Outcome                               | **À fixer avec le juridique**                                                           | Conserver identifiant technique, motif, dates et hash nécessaires ; ne jamais recopier le contenu supprimé                               | Prouver l’exécution des corrections et droits                   |

## Sources Outcome — état et garde de mise en service

Les durées Outcome ci-dessus ne sont pas encore implémentées dans `public.run_data_retention`. Le
fichier de migration d'ingestion prévoit le bucket privé `outcome-raw-artifacts`, mais cette migration
n'a pas été rejouée sur une base distante dans cette tranche ; le worker de purge physique et son
droit de suppression Storage ne sont pas encore livrés. En conséquence, aucune collecte Judilibre de
production ne doit être activée avant validation des durées, test de la purge Storage/base et
supervision des demandes en échec. Un janitor doit aussi supprimer les objets privés restés sans
ligne de provenance après un échec entre upload et commit.

Judilibre peut corriger ou supprimer une décision à tout moment. Son historique transactionnel doit
être consommé régulièrement ; les CGU recommandent de ne pas dépasser 72 heures entre deux mises à
jour, sous réserve de disponibilité. Une notification `deleted` ou `to_be_deleted` prime sur la durée
nominale et déclenche une demande de purge. Une éventuelle conservation sous legal hold doit être
autorisée, limitée et tracée séparément.

Les caches sous `services/data-pipeline/data/raw/outcome_sources/` sont locaux, ignorés par Git et ne
sont pas un archivage de production. Ils doivent être supprimés dès que la validation qui justifie
leur présence est terminée, sauf conservation explicitement approuvée et protégée.

## Contrôle trimestriel

1. Exécuter le cron avec une date réelle et conserver son résumé de compteurs.
2. Vérifier qu’aucune table liée à `auth.users` ne manque de stratégie d’effacement.
3. Vérifier les sauvegardes et durées propres à Supabase/Vercel/Stripe/Resend.
4. Examiner les demandes échues et les preuves arrivant à expiration.
5. Mettre à jour la politique publique si une finalité, base ou durée change.
6. Rapprocher les suppressions/corrections des sources Outcome des objets Storage, projections,
   checkpoints, dead-letter et preuves de purge, sans conserver le contenu supprimé dans les logs.
