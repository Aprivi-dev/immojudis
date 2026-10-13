# Conditions de lancement et gel du périmètre

Décision du 10 octobre 2026, issue du plan correctif (`docs/audits/2026-10-09-plan-correctif.md`).
Elle complète `decision-perimetre-2026-10-09.md` (France entière).

## Conditions pour ouvrir le site au public

Le site s'ouvre quand toutes les lignes suivantes sont cochées.

| Condition                                                             | Tâches du plan | État au 10/10/2026                                                                                          |
| --------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| Compte admin sécurisé (mot de passe changé, double authentification)  | P0-01, P0-02   | Code livré, **enrôlement TOTP et changement de mot de passe à faire par le propriétaire**                   |
| Catalogue rapide, sans erreur 500, sans « 0 annonce » trompeur        | P1-01, P1-02   | Code et migration prêts, à déployer                                                                         |
| Mentions légales renseignées en production                            | P1-03, P1-04   | **Valeurs à fournir par le propriétaire** (variables Vercel)                                                |
| Pied de page, CGU et confidentialité à l'inscription                  | P1-05, P1-06   | Livré                                                                                                       |
| Périmètre géographique tranché et aligné                              | P1-07          | Livré (France entière)                                                                                      |
| Départements, coordonnées, statuts des ventes corrects                | P1-08, P1-09   | Code livré, réparation des données à lancer après déploiement                                               |
| Facturation sûre : impayé, remboursement, compte, rétractation        | P1-11 à P1-14  | Livré                                                                                                       |
| Stripe configuré en production                                        | P1-15          | **À faire par le propriétaire**                                                                             |
| Licence Licitor ou retrait du module                                  | P1-17          | **Source retirée du catalogue** (interrupteur en base, voir « Licitor » ci-dessous) ; migration à appliquer |
| Frais, rendement, plafond justes                                      | P2-01 à P2-07  | Livré (barème à confirmer sur Légifrance par un juriste)                                                    |
| Production alignée sur `main`, crons qui se rattrapent, base soulagée | P3-01 à P3-04  | Fusion livrée, déploiement et nettoyage de données à faire                                                  |

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

Décision du 11 octobre 2026 : chaque source est collectée **au plus toutes les 12 heures** (6 heures auparavant).
La planification (`claim_autonomous_pipeline_run`, appelée toutes les 15 minutes par la tâche
`operational-health`) lance une collecte quand une source est due, et le traitement de la file
d'enrichissement (descriptions, fiches détail, PDF) au plus toutes les 30 minutes ; cette cadence-là est inchangée.
La cadence des sources est fixée à deux endroits : `INVENTORY_CADENCE` (`services/data-pipeline/src/autonomous_runner.py`,
échéance posée à la fin de la collecte) et la fonction SQL (attente pendant que la collecte lancée est en cours),
migration `20261016100000_source_inventory_cadence_12h.sql`.

## Licitor : source retirée du catalogue (décision du propriétaire)

Faute de licence écrite (droit sui generis des bases de données, CPI L. 341-1 et L. 342-1), la source Licitor est
retirée du catalogue. Un accord oral sur les statistiques de prix ne couvre ni la collecte des annonces, textes,
photos et PDF, ni leur réaffichage dans une offre payante. Le retrait est **réversible par un seul interrupteur** et
**ne supprime aucune donnée** : `auction_source_state.catalogue_withdrawn` (ligne `licitor`), posé et levé par
`public.set_catalogue_source_withdrawal`.

### Ce que le retrait fait

- **Collecte arrêtée** : plus d'inventaire d'annonces, plus de fiches détail, plus de tick de l'historique des
  adjudications ; pas d'alerte `pipeline.source.licitor.missed` (une source retirée est aussi désactivée).
- **Catalogue masqué** : une vente dont la seule source est Licitor est mise en quarantaine par le marqueur existant
  `raw_payload.publication_quarantine = 'source_withdrawn'` : elle disparaît de la recherche publique et connectée, de
  la carte, des comptages, du sitemap, des alertes et de la fiche (la fiche publique répond 404). Toutes les vues et
  fonctions de lecture respectaient déjà ce marqueur, aucune n'est réécrite.
- **Ventes fusionnées** (Licitor et une autre source) : elles restent visibles, sans lien, photo ni pièce hébergés
  par `licitor.com` (`src/lib/withdrawn-sources.ts`). Les textes (titre, description) ne portent pas leur provenance
  champ par champ et ne sont pas filtrés.
- **Statistiques et scénarios d'enchères des tribunaux** : déjà masqués (drapeaux `TRIBUNAL_STATISTICS_ENABLED`,
  `ADJUDICATION_PRICE_STATISTICS_ENABLED`, fermés en production). Ne pas les ouvrir tant que Licitor est retiré.

### Activer le retrait en production

La migration est livrée à l'état « retiré » : l'appliquer **est** l'activation. Rien n'a été appliqué par l'équipe.

1. Fusionner la branche, puis appliquer `20261021110000_licitor_source_withdrawal.sql` (workflow « Apply Supabase
   Migrations » ou `npm run db:migrate`). Elle pose la colonne, la contrainte, le déclencheur, les deux fonctions, et
   retire Licitor (réécriture de `raw_payload` de ses seules ventes, sans déclencher le journal des ventes).
2. Déployer le site et le pipeline. Le code part de l'état « retiré » même si la migration n'est pas encore
   appliquée (source retirée par défaut en cas de doute).
3. Vérifier (lecture seule) :
   ```sql
   select source_name, enabled, catalogue_withdrawn from public.auction_source_state where source_name = 'licitor';
   select count(*) from public.auction_sales where raw_payload->>'publication_quarantine' = 'source_withdrawn';
   ```
4. Fermer le chantier côté légal : prévenir les avocats et textes juridiques du retrait si besoin.

### Lever le retrait (le jour où une licence écrite existe)

Geste explicite, en base, avec le rôle `service_role` ou `postgres` :

```sql
select public.set_catalogue_source_withdrawal('licitor', false);
```

Une seule transaction : remet à l'affichage les ventes Licitor (marqueur retiré), réactive la source (`enabled = true`)
qui sera collectée au prochain passage du planificateur, et rouvre l'historique des adjudications. Le site relit
l'interrupteur au plus une minute plus tard. Ensuite, si besoin : fournir `SUPABASE_DB_URL` en lecture à l'audit
manuel de couverture, et archiver la licence hors dépôt (référence dans `docs/model-card-tribunal-statistics.md`).
Pour retirer de nouveau : `select public.set_catalogue_source_withdrawal('licitor', true, 'raison');`.
