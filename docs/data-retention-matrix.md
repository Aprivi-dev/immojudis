# Matrice de conservation

Le cron `/api/cron/data-retention` appelle `public.run_data_retention` chaque semaine. Les durées
ci-dessous sont des règles techniques ; la validation juridique peut les réduire ou imposer une
archive intermédiaire plus stricte.

| Données                                                                 | Durée / déclencheur                                                      | Action                                                                                                                                   | Justification                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Notifications lues, rejetées ou échouées                                | 6 mois                                                                   | Suppression                                                                                                                              | Utilité opérationnelle terminée                            |
| Limites de débit                                                        | 2 jours                                                                  | Suppression                                                                                                                              | Protection technique courte                                |
| Événements d’usage, exports, estimations, placements, webhooks, runs    | 24 mois                                                                  | Suppression                                                                                                                              | Mesure, audit et exploitation                              |
| Acceptations commerciales                                               | 10 ans après acceptation                                                 | Suppression automatique, compte pseudonymisé à l’effacement                                                                              | Preuve contractuelle/comptable                             |
| Demandes RGPD/rétractation                                              | 5 ans après clôture                                                      | Suppression automatique                                                                                                                  | Preuve du traitement d’une demande                         |
| Favoris, alertes, rapports, notes, espaces et clés API                  | Jusqu’à effacement du compte                                             | Cascade après suppression Auth                                                                                                           | Exécution du service                                       |
| Objets Storage utilisateur                                              | Jusqu’à effacement du compte                                             | Suppression préalable via l’API Storage                                                                                                  | Éviter les objets orphelins                                |
| Artefacts bruts Judilibre                                               | 24 mois maximum ; correction, occultation ou suppression amont immédiate | Bucket privé ; purge physique quotidienne, projection structurée et hashes conservés sans texte ; aucune URL publique durable            | Provenance bornée et minimisation des données personnelles |
| Autres artefacts bruts des sources Outcome                              | Selon la politique de chaque source ; correction amont prioritaire       | Bucket privé ; purge physique et propagation selon la politique enregistrée                                                              | Provenance et reproductibilité                             |
| Fetches, extractions, candidats source et décisions de matching Outcome | **À fixer avant activation** ; nouvelle version à chaque correction      | Historique append-only ; isoler ou purger le contenu visé sans réécriture silencieuse ; conserver seulement la preuve minimale autorisée | Audit de provenance, qualité et reproductibilité           |
| Journal minimal de purge/correction Outcome                             | **À fixer avec le juridique**                                            | Conserver identifiant technique, motif, dates et hash nécessaires ; ne jamais recopier le contenu supprimé                               | Prouver l’exécution des corrections et droits              |

## Sources Outcome — état et garde de mise en service

La rétention Judilibre est exécutée par `scripts/run_outcome_retention.py`. Le worker traite les
demandes de suppression avec bail et reprise, supprime physiquement les objets Storage, conserve une
preuve minimale append-only et nettoie les objets sans provenance après un délai de grâce de 24
heures. Les artefacts bruts Judilibre de plus de 730 jours sont mis en purge ; les projections sûres,
hashes et décisions de revue restent disponibles sans conserver le texte intégral.

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
