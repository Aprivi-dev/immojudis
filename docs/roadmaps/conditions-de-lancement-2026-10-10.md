# Conditions de lancement et gel du périmètre

Décision du 10 octobre 2026, issue du plan correctif (`docs/audits/2026-10-09-plan-correctif.md`).
Elle complète `decision-perimetre-2026-10-09.md` (France entière).

## Conditions pour ouvrir le site au public

Le site s'ouvre quand toutes les lignes suivantes sont cochées.

| Condition                                                             | Tâches du plan | État au 10/10/2026                                                                                                      |
| --------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Compte admin sécurisé (mot de passe changé, double authentification)  | P0-01, P0-02   | Code livré, **enrôlement TOTP et changement de mot de passe à faire par le propriétaire**                               |
| Catalogue rapide, sans erreur 500, sans « 0 annonce » trompeur        | P1-01, P1-02   | Code et migration prêts, à déployer                                                                                     |
| Mentions légales renseignées en production                            | P1-03, P1-04   | **Valeurs à fournir par le propriétaire** (variables Vercel)                                                            |
| Pied de page, CGU et confidentialité à l'inscription                  | P1-05, P1-06   | Livré                                                                                                                   |
| Périmètre géographique tranché et aligné                              | P1-07          | Livré (France entière)                                                                                                  |
| Départements, coordonnées, statuts des ventes corrects                | P1-08, P1-09   | Code livré, réparation des données à lancer après déploiement                                                           |
| Facturation sûre : impayé, remboursement, compte, rétractation        | P1-11 à P1-14  | Livré                                                                                                                   |
| Stripe configuré en production                                        | P1-15          | **À faire par le propriétaire**                                                                                         |
| Licence Licitor ou retrait du module                                  | P1-17          | **Décision du propriétaire : Licitor conservé** (licence écrite non obtenue ; interrupteur de retrait gardé en réserve) |
| Frais, rendement, plafond justes                                      | P2-01 à P2-07  | Livré (barème à confirmer sur Légifrance par un juriste)                                                                |
| Production alignée sur `main`, crons qui se rattrapent, base soulagée | P3-01 à P3-04  | Fusion livrée, déploiement et nettoyage de données à faire                                                              |

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

## Licitor : conservé, avec un interrupteur de retrait gardé en réserve (décision du propriétaire)

Décision du propriétaire du 13/10/2026 : Licitor reste collecté et affiché, « c'est une des meilleures sources ». Une
première version du chantier retirait Licitor par défaut ; cette décision est annulée. Aucune licence écrite n'est
obtenue à ce jour (droit sui generis des bases de données, CPI L. 341-1 et L. 342-1) : la question juridique reste
posée, la décision de conserver la source est celle du propriétaire.

Le chantier garde l'**interrupteur de retrait** comme infrastructure, pour un usage futur : il est **réversible**,
**ne supprime aucune donnée** et **ne retire aucune source par défaut** : `auction_source_state.catalogue_withdrawn`
(une ligne par source), posé et levé par `public.set_catalogue_source_withdrawal`.

### Ce que ferait un retrait (quand il est posé pour une source)

- **Collecte arrêtée** : plus d'inventaire d'annonces, plus de fiches détail, plus de tick de l'historique des
  adjudications (pour Licitor) ; pas d'alerte `pipeline.source.<source>.missed` (une source retirée est aussi
  désactivée).
- **Catalogue masqué** : une vente dont la seule source est la source retirée est mise en quarantaine par le marqueur
  existant `raw_payload.publication_quarantine = 'source_withdrawn'` : elle disparaît de la recherche publique et
  connectée, de la carte, des comptages, du sitemap, des alertes et de la fiche (la fiche publique répond 404). Toutes
  les vues et fonctions de lecture respectaient déjà ce marqueur, aucune n'est réécrite.
- **Ventes fusionnées** (la source retirée et une autre) : elles restent visibles, sans lien, photo ni pièce hébergés
  par la source retirée (`src/lib/withdrawn-sources.ts`). Les textes (titre, description) ne portent pas leur
  provenance champ par champ et ne sont pas filtrés.

Les drapeaux de statistiques et de scénarios d'enchères des tribunaux (`TRIBUNAL_STATISTICS_ENABLED`,
`ADJUDICATION_PRICE_STATISTICS_ENABLED`) relèvent d'une décision distincte : ils ne dépendent pas de cet interrupteur.

### Mise en production

La migration `20261021110000_licitor_source_withdrawal.sql` ne retire **aucune** source : l'appliquer pose seulement la
colonne, la contrainte, le déclencheur et les deux fonctions, sans réécrire une seule vente. Rien n'a été appliqué par
l'équipe.

1. Fusionner la branche, puis appliquer la migration (workflow « Apply Supabase Migrations » ou `npm run db:migrate`).
2. Déployer le site et le pipeline. Le code part de l'état « aucune source retirée » même si la migration n'est pas
   encore appliquée (fonction absente ou base injoignable : rien n'est masqué ni arrêté).
3. Vérifier (lecture seule) :
   ```sql
   select source_name, enabled, catalogue_withdrawn from public.auction_source_state where catalogue_withdrawn;
   select count(*) from public.auction_sales where raw_payload->>'publication_quarantine' = 'source_withdrawn';
   ```
   Les deux requêtes doivent ne rien renvoyer / renvoyer 0.

### Retirer une source, puis lever le retrait

Geste explicite, en base, avec le rôle `service_role` ou `postgres` :

```sql
select public.set_catalogue_source_withdrawal('licitor', true, 'raison');   -- retirer
select public.set_catalogue_source_withdrawal('licitor', false);            -- lever
```

Une seule transaction : le retrait désactive la source et met en quarantaine ses ventes ; la levée remet à l'affichage
les ventes (marqueur retiré), réactive la source (`enabled = true`), collectée au prochain passage du planificateur, et
rouvre l'historique des adjudications. Le site relit l'interrupteur au plus une minute plus tard. Si l'interrupteur est
illisible (base injoignable, `SUPABASE_DB_URL` absent d'un lancement local ou de l'audit manuel de couverture), aucune
source n'est considérée comme retirée : un retrait posé n'est alors pas vu.
