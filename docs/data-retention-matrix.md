# Matrice de conservation

Le cron `/api/cron/data-retention` appelle `public.run_data_retention` chaque semaine. Les durées
ci-dessous sont des règles techniques ; la validation juridique peut les réduire ou imposer une
archive intermédiaire plus stricte.

| Données                                                              | Durée / déclencheur          | Action                                                      | Justification                      |
| -------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| Notifications lues, rejetées ou échouées                             | 6 mois                       | Suppression                                                 | Utilité opérationnelle terminée    |
| Limites de débit                                                     | 2 jours                      | Suppression                                                 | Protection technique courte        |
| Événements d’usage, exports, estimations, placements, webhooks, runs | 24 mois                      | Suppression                                                 | Mesure, audit et exploitation      |
| Acceptations commerciales                                            | 10 ans après acceptation     | Suppression automatique, compte pseudonymisé à l’effacement | Preuve contractuelle/comptable     |
| Demandes RGPD/rétractation                                           | 5 ans après clôture          | Suppression automatique                                     | Preuve du traitement d’une demande |
| Favoris, alertes, rapports, notes, espaces et clés API               | Jusqu’à effacement du compte | Cascade après suppression Auth                              | Exécution du service               |
| Objets Storage utilisateur                                           | Jusqu’à effacement du compte | Suppression préalable via l’API Storage                     | Éviter les objets orphelins        |

## Contrôle trimestriel

1. Exécuter le cron avec une date réelle et conserver son résumé de compteurs.
2. Vérifier qu’aucune table liée à `auth.users` ne manque de stratégie d’effacement.
3. Vérifier les sauvegardes et durées propres à Supabase/Vercel/Stripe/Resend.
4. Examiner les demandes échues et les preuves arrivant à expiration.
5. Mettre à jour la politique publique si une finalité, base ou durée change.
