# Scénarios d'enchères : cliché des lots et rattrapage

Les « Scénarios d'enchères » (offre Analyse : fiche d'une vente, onglet Statistiques) et le tableau de
comparaison des tribunaux lisent un **cliché** des lots Licitor attestés, pas la vue source. Ce runbook dit
d'où vient le cliché, comment vérifier qu'il est à jour et comment le rattraper. Toute écriture en base
décrite ici est une action du propriétaire (`service_role`), jamais d'un agent.

## Chaîne de lecture

1. `src/lib/auction-scenarios.server.ts` appelle, avec la clé `service_role`, les fonctions
   `public.get_court_auction_scenarios(p_court_code, p_starting_price)` (une vente) et
   `public.get_court_auction_summaries()` (tous les tribunaux). Le plan est contrôlé par l'appelant.
2. Ces fonctions lisent `app_private.auction_scenario_observation_snapshot` (migration
   `20261031100800`) : code du tribunal, type de bien, mise à prix, adjudication, date de vente, toutes
   années confondues. La fenêtre de trois ans est appliquée à la lecture. Aucune donnée personnelle.
3. Le cliché est une copie de la vue `app_private.auction_scenario_observations` (qui passe par la porte
   statistique et le rattachement des tribunaux). Sans cliché, la vue coûtait 3,5 à 6 s par appel pour un
   délai de 8 s : c'est la cause de l'ancien « Les statistiques du tribunal n'ont pas pu être chargées ».
4. L'état du cliché est dans `app_private.auction_scenario_snapshot_state` (une ligne : `refreshed_at`,
   `observation_count`).
5. Une vente n'est comparée qu'aux lots de **sa tranche de mise à prix** (`app_private.starting_price_band`,
   migration `20261102110000`) : moins de 20 000 €, 20 000 à 35 000, 35 000 à 50 000, 50 000 à 75 000,
   75 000 à 100 000, 100 000 à 200 000, 200 000 € et plus (sept tranches, numérotées de 1 à 7 dans la clé
   `band` de la réponse). Les bornes sont reprises dans `src/lib/auction-scenarios.ts`
   (`STARTING_PRICE_BAND_UPPER_BOUNDS`) et comparées par un test. Le cache de la route est sous la clé `v2`
   depuis ce changement : changer la grille impose de changer cette clé.

## Qui remplit le cliché

`app_private.refresh_auction_scenario_observations(p_force boolean default true)` recopie la vue en entier
sous un verrou exclusif (les lectures voient l'ancienne copie jusqu'au `commit`). Elle est appelée :

- **par la collecte Licitor**, après chaque attestation
  (`services/data-pipeline/src/sources/licitor_history_refresh.py`, lancée par le planificateur après la file
  d'enrichissement) : forcée quand de nouveaux lots ont été attestés, sinon au plus une fois par jour (sans
  `p_force`, la fonction ne fait rien si la copie a moins d'un jour et renvoie `null`) ;
- **une fois par la migration `20261031100800`** elle-même, pour la première copie.

Le compte rendu de la collecte (`scenario_snapshot`) vaut `refreshed` (avec le nombre de lots), `skipped`
(copie de moins d'un jour) ou `error` : en cas d'erreur, l'ancienne copie est conservée et le code de sortie
de la collecte Licitor est noté dans `auction_runs.summary` (`licitor_history_exit_code`).

## Vérifier

En lecture seule (SQL Editor de Supabase, ou connexion `service_role`) :

```sql
select refreshed_at, observation_count, now() - refreshed_at as age
from app_private.auction_scenario_snapshot_state;

select count(*), min(sale_date), max(sale_date)
from app_private.auction_scenario_observation_snapshot;
```

- Pas de ligne dans `auction_scenario_snapshot_state` ou `observation_count = 0` : le cliché n'a jamais été
  rempli (ou la vue est vide) ; voir « Rattraper ».
- `age` de plus de quelques jours alors que la collecte tourne : la collecte Licitor est bloquée ou la copie
  échoue ; voir `docs/runbooks/licitor-collecte-bloquee.md`.
- Le nombre de lots du cliché doit rester proche de celui de la vue (même requête sur
  `app_private.auction_scenario_observations`, qui prend plusieurs secondes : hors heures de pointe).

## Symptômes

| Symptôme                                                              | Cause probable                                                                                                     | Où regarder                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| « Les statistiques du tribunal n'ont pas pu être chargées »           | erreur de la fonction RPC : `permission denied for function …`, délai dépassé, cliché absent                       | journaux Vercel de la route (`PostgrestError` : message et `code`) |
| `permission denied for function starting_price_band`                  | droit `service_role` manquant sur une fonction `app_private` appelée par une fonction non `security definer`       | migration `20261031100600` ; `npm run test:security-invariants`    |
| Scénarios vides pour un tribunal, tableau des tribunaux sans lignes   | cliché vide, ou moins de 10 lots pour ce tribunal (seuil du tableau)                                               | requêtes ci-dessus                                                 |
| Chiffres qui ne bougent plus alors que des adjudications sont tombées | copie de plus d'un jour non rafraîchie : collecte Licitor arrêtée, ou nouvelles adjudications pas encore attestées | `auction_runs.summary`, `licitor_history_exit_code`                |

Une fonction appelée par `service_role` qui n'est pas `security definer` s'exécute avec les droits de
l'appelant : chaque fonction `app_private` qu'elle appelle doit être accordée à `service_role` dans la
migration qui la crée (règle 8 de `supabase/README.md`).

## Rattraper (propriétaire)

Recopier la vue, immédiatement et sans attendre la collecte :

```sql
select app_private.refresh_auction_scenario_observations(true);
```

La fonction renvoie le nombre de lots copiés. Elle prend un verrou exclusif sur la table du cliché
pendant la copie mais ne bloque pas les lectures. Revérifier ensuite l'état (`refreshed_at`,
`observation_count`). Ne jamais éditer le cliché à la main : il se reconstruit toujours depuis la vue.

Après le rattrapage, ouvrir la fiche d'une vente d'un tribunal connu (`/sales/<id>`, onglet Statistiques) : les
scénarios doivent s'afficher.

## Estimations d'avant l'audience : collecte et appariement (point 17)

Une « valeur de marché x ratio adjudication / valeur de marché du ressort » ne peut être évaluée qu'avec des
paires (estimation faite **avant** l'audience, prix d'adjudication connu **après**). Avant la migration
`20261102110100`, aucune paire n'existait : la ligne d'estimation (`auction_sale_market_estimates`) disparaît quand la
vente quitte les statuts `active` / `upcoming` ou est purgée à l'heure de l'audience, avant la publication du
résultat, et le cliché des lots Licitor n'a ni identifiant de vente ni estimation. Constaté en production le
23/10/2026 : 1 vente avec prix d'adjudication, 0 avec prix et estimation, 1 595 estimations en tout.

**Ce qui est collecté.** Table privée `app_private.sale_market_estimate_snapshots` (RLS, `service_role` en lecture
seule) : un instantané par vente de tribunal, avec tribunal (`court_code`), département, type de bien et groupe de
comparaison (`property_group`, celui des scénarios), mise à prix, jour d'audience (heure de Paris), estimation
P10 / P50 / P90, `actionable`, nombre de comparables, indice de confiance, moteur, version du modèle et date de
l'instantané. Ni adresse, ni commune, ni identifiant de vente (`snapshot_key` est l'empreinte SHA-256 de
l'identifiant, qui ne se rattache à aucune ligne restante). Aucun affichage, aucune lecture par l'application.

**Quand.** Juste avant la disparition de la ligne d'estimation, une seule fois par vente, si l'audience est passée,
si la vente est une vente de tribunal avec code de tribunal et mise à prix, si elle n'est ni reportée, ni annulée, ni
retirée, ni en quarantaine, ni fusionnée, et si l'estimation est `ready` (une estimation en attente de recalcul
porte une valeur d'avant la modification du bien) : déclencheur `before delete` sur `auction_sales` (la purge à
l'audience) et déclencheur `before update of status` (sortie de `active` / `upcoming`). Une panne de l'écriture
n'empêche jamais la purge : elle est journalisée en avertissement (`snapshot_sale_market_estimate: not written`).

**Conservation.** 36 mois après le jour d'audience (la fenêtre des scénarios), purge hebdomadaire par
`run_data_retention` (`sale_market_estimate_snapshots` dans son compte rendu). Durée proposée, à faire valider
(`docs/data-retention-matrix.md`).

**Suivre la collecte** (lecture seule) :

```sql
select count(*) as instantanes,
       count(*) filter (where actionable) as exploitables,
       min(sale_date) as premiere_audience, max(captured_at) as dernier_instantane
from app_private.sale_market_estimate_snapshots;
```

### Apparier aux résultats d'adjudication

Les résultats viennent du cliché Licitor (`app_private.auction_scenario_observation_snapshot` : `court_code`,
`property_type`, `starting_price_eur`, `hammer_price_eur`, `sale_date`). Un instantané et un lot se rapprochent par
**(tribunal, jour d'audience, mise à prix, groupe de nature)** :

- les deux côtés rangent le type de bien dans le groupe des scénarios (`app_private.scenario_property_group`, null
  pour immeuble / mixte / autre : ces biens ne s'apparient pas) ;
- seul un appariement **un pour un** est retenu : si plusieurs instantanés ou plusieurs lots ont la même clé
  (même tribunal, même jour, même mise à prix, même groupe), la clé est écartée ;
- seules les estimations `actionable` servent, comme pour l'écart au marché affiché sur la fiche.

L'accord de Licitor ne porte que sur des **agrégats** de prix (`docs/model-card-tribunal-statistics.md`) : l'appariement
se fait dans la base, en lecture seule, et seuls des agrégats en sortent (effectifs, médianes, erreurs). Ne jamais
exporter une table ligne à ligne qui rapproche un prix d'adjudication d'une estimation.

Nombre de paires (à lancer d'abord) :

```sql
with snap as (
  select court_code, app_private.scenario_property_group(property_type) as grp,
         starting_price_eur, sale_date, value_p50_eur,
         count(*) over (partition by court_code, app_private.scenario_property_group(property_type),
                        starting_price_eur, sale_date) as n
  from app_private.sale_market_estimate_snapshots
  where actionable
),
lots as (
  select court_code, app_private.scenario_property_group(property_type) as grp,
         starting_price_eur, hammer_price_eur, sale_date,
         count(*) over (partition by court_code, app_private.scenario_property_group(property_type),
                        starting_price_eur, sale_date) as n
  from app_private.auction_scenario_observation_snapshot
)
select count(*) as paires, count(distinct snap.court_code) as tribunaux
from snap
join lots using (court_code, grp, starting_price_eur, sale_date)
where snap.n = 1 and lots.n = 1 and snap.grp is not null;
```

### Test confirmatoire (quand il y aura assez de paires)

Question : sur des ventes passées, la référence « estimation P50 x ratio médian adjudication / estimation du
tribunal » prédit-elle le prix d'adjudication mieux que la simple « mise à prix x ratio médian national
adjudication / mise à prix » ? On compare l'**erreur médiane en logarithme** (|ln(prédit / réel)|) des deux
méthodes, chaque paire étant prédite **sans elle-même** (validation « leave-one-out »), la méthode (a) revenant au
ratio national quand le tribunal a moins de 10 autres paires. Requête complète, en lecture seule :

```sql
with snap as (
  select court_code, app_private.scenario_property_group(property_type) as grp,
         starting_price_eur, sale_date, value_p50_eur,
         count(*) over (partition by court_code, app_private.scenario_property_group(property_type),
                        starting_price_eur, sale_date) as n
  from app_private.sale_market_estimate_snapshots
  where actionable
),
lots as (
  select court_code, app_private.scenario_property_group(property_type) as grp,
         starting_price_eur, hammer_price_eur, sale_date,
         count(*) over (partition by court_code, app_private.scenario_property_group(property_type),
                        starting_price_eur, sale_date) as n
  from app_private.auction_scenario_observation_snapshot
),
pairs as (
  select row_number() over () as id, snap.court_code, snap.starting_price_eur as start_price,
         lots.hammer_price_eur as hammer, snap.value_p50_eur as p50
  from snap
  join lots using (court_code, grp, starting_price_eur, sale_date)
  where snap.n = 1 and lots.n = 1 and snap.grp is not null
),
loo as (
  select p.hammer, p.p50, p.start_price,
    (select count(*) from pairs q where q.id <> p.id and q.court_code = p.court_code) as n_court,
    (select percentile_cont(0.5) within group (order by q.hammer / q.p50)
       from pairs q where q.id <> p.id and q.court_code = p.court_code) as r_court,
    (select percentile_cont(0.5) within group (order by q.hammer / q.p50)
       from pairs q where q.id <> p.id) as r_national,
    (select percentile_cont(0.5) within group (order by q.hammer / q.start_price)
       from pairs q where q.id <> p.id) as s_national
  from pairs p
)
select count(*) as paires,
       percentile_cont(0.5) within group (order by abs(ln(
         p50 * case when n_court >= 10 then r_court else r_national end / hammer))) as erreur_estimation,
       percentile_cont(0.5) within group (order by abs(ln(start_price * s_national / hammer))) as erreur_mise_a_prix
from loo;
```

Lecture, **seuils proposés** (à faire valider par le propriétaire avant tout affichage) :

- au moins **150 paires** au total et au moins 5 tribunaux ayant 10 paires ou plus, sinon ne pas conclure ;
- la référence « estimation » n'est retenue que si son erreur médiane est inférieure d'au moins **20 %** (en valeur
  relative) à celle de la mise à prix, et si le résultat tient sur chacun des deux sous-ensembles (maisons,
  appartements) ayant au moins 50 paires ;
- sinon, ne rien afficher : la référence DVF reste masquée et les scénarios restent ceux des rapports à la mise à prix.

Si le test est favorable, l'affichage reste derrière un interrupteur explicite, désactivé par défaut, avec le libellé
« repère indicatif » et l'effectif des paires, et seulement pour une vente dont l'estimation est `actionable`
(valeur de marché `ready` à jour, jamais une surface estimée).

## Fermeture

Le cliché est à jour (`age` de moins d'un jour, ou la collecte Licitor récente sans nouvelle attestation) et
les scénarios s'affichent. Si la cause était un défaut de migration ou de droit, la corriger par une nouvelle
migration (jamais en modifiant une migration appliquée) et la signaler au propriétaire.
