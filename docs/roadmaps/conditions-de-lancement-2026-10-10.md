# Conditions de lancement et gel du périmètre

Décision du 10 octobre 2026, issue du plan correctif (`docs/audits/2026-10-09-plan-correctif.md`).
Elle complète `decision-perimetre-2026-10-09.md` (France entière).

## Conditions pour ouvrir le site au public

Le site s'ouvre quand toutes les lignes suivantes sont cochées.

| Condition                                                             | Tâches du plan | État au 10/10/2026                                                                        |
| --------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| Compte admin sécurisé (mot de passe changé, double authentification)  | P0-01, P0-02   | Code livré, **enrôlement TOTP et changement de mot de passe à faire par le propriétaire** |
| Catalogue rapide, sans erreur 500, sans « 0 annonce » trompeur        | P1-01, P1-02   | Code et migration prêts, à déployer                                                       |
| Mentions légales renseignées en production                            | P1-03, P1-04   | **Valeurs à fournir par le propriétaire** (variables Vercel)                              |
| Pied de page, CGU et confidentialité à l'inscription                  | P1-05, P1-06   | Livré                                                                                     |
| Périmètre géographique tranché et aligné                              | P1-07          | Livré (France entière)                                                                    |
| Départements, coordonnées, statuts des ventes corrects                | P1-08, P1-09   | Code livré, réparation des données à lancer après déploiement                             |
| Facturation sûre : impayé, remboursement, compte, rétractation        | P1-11 à P1-14  | Livré                                                                                     |
| Stripe configuré en production                                        | P1-15          | **À faire par le propriétaire**                                                           |
| Licence Licitor ou retrait du module                                  | P1-17          | **À trancher par le propriétaire**                                                        |
| Frais, rendement, plafond justes                                      | P2-01 à P2-07  | Livré (barème à confirmer sur Légifrance par un juriste)                                  |
| Production alignée sur `main`, crons qui se rattrapent, base soulagée | P3-01 à P3-04  | Fusion livrée, déploiement et nettoyage de données à faire                                |

Tant que les mentions légales ne sont pas toutes renseignées ou que `STRIPE_ANALYSIS_PRICE_ID` est absent,
le paiement se ferme de lui-même (le code refuse le checkout et masque l'essai) : le site peut être public en
lecture, l'offre Analyse ne se vend pas.

## Chantier gelé : Outcome Graph

Jusqu'au lancement, **aucun nouveau développement** sur l'Outcome Graph (environ 30 tables), les statistiques
de tribunaux, JudiLibre et l'activité de la justice.

- Les drapeaux `TRIBUNAL_STATISTICS_ENABLED`, `OUTCOME_EVALUATION_ENABLED`, `JUDILIBRE_ENABLED` et
  `JUSTICE_ACTIVITY_ENABLED` restent fermés. Vérifié le 10/10/2026 : aucun n'est défini en production ;
  seuls trois existent en preview.
- `ADJUDICATION_PRICE_STATISTICS_ENABLED` est à `false` en production (modifié le 09/10/2026).
- Aucune PR « Outcome Graph » avant le lancement. Les workflows `outcome-*` ne doivent pas être planifiés.
- Le code reste dans `main` : le retirer coûterait plus cher qu'il ne rapporte tant qu'il est inactif.

## Ventes notariales et domaniales

Elles font partie du projet au même titre que les ventes au tribunal : les filtres « Chez le notaire » et
« Domaniales » et leurs pages d'entrée sont affichés par défaut. `NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED=false`
permet de les masquer (les annonces restent dans le catalogue). Les cessions de l'État sans date de vente
(appels d'offres, ventes amiables) ne sont pas listées : voir la décision en attente dans le rapport de suivi.

## Fréquence de collecte

Le pipeline est relancé toutes les 30 minutes (`auction_pipeline_control`, une expédition à `:15` et `:45`).
Avec quelques utilisateurs, une collecte horaire suffirait et soulagerait la base et les coûts. **Décision à
prendre** : le changement passe par la fonction SQL de répartition ; il n'est pas fait ici pour ne pas
retarder la collecte pendant la phase de stabilisation. À réexaminer une semaine après le déploiement,
quand les temps d'attente de la file seront connus.
