# Suivi de la justesse du repère « Pépite »

Protocole de mesure a posteriori du label (compte-rendu du 27/10/2026, n° 25 ; rapport `qa-modeles` n° 10 et
`statisticien` n° 5). Document de procédure : rien ici ne s'exécute tout seul, et aucune lecture de
`sale_market_estimate_snapshots` n'est faite par le code de l'application (le critère d'arrêt automatique du n° 19 du
26/10 reste à écrire, voir « Ce qui n'est pas automatisé »).

## Ce que l'on mesure

Le label affirme deux choses sur une vente de tribunal (une seule sur une vente notariale) :

- **B, chances de l'emporter** : au moins 70 % des ventes comparables passées ont été adjugées sous l'enchère plafond
  de référence ;
- **C, achat nettement sous la valeur** : le coût total, frais compris, au prix probable, est au plus 75 % de la
  valeur centrale (65 % en vente notariale).

La mesure compare ces annonces à ce qui s'est réellement passé à l'audience.

## Unité d'analyse

Une pépite publiée à J-7, ou à la dernière évaluation avant l'audience, avec la version de la règle
(`pepite_rule_version`), du modèle de valeur (`estimate_model_version`) et le moteur (`estimate_engine_kind`).

Depuis le n° 24, le traitement planifié ne réécrit plus l'évaluation d'une vente dont l'audience est passée tant que le
pipeline ne l'a pas fait sortir du statut « à venir » : l'instantané lit donc la dernière évaluation avant l'audience
et non plus un « non applicable ». Les instantanés écrits avant cette correction peuvent porter `pepite_status =
'not_applicable'` : les écarter de la mesure (voir le contrôle ci-dessous).

## Où sont les données

| Donnée                               | Table                                                                                                                                                                 | Remarques                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Évaluation archivée de la pépite     | `app_private.sale_market_estimate_snapshots` (`pepite_*`, `estimate_model_version`, `estimate_engine_kind`, `pepite_reason_codes`, `pepite_mode`, `pepite_frozen_at`) | Une ligne par vente, écrite à la sortie du statut « à venir » ou à la purge. Pseudonymisée, conservée 36 mois après l'audience. |
| Prix d'adjudication, tribunal        | `app_private.auction_scenario_observation_snapshot` (`hammer_price_eur`)                                                                                              | Rapprochement sur (tribunal, jour d'audience, mise à prix, groupe de nature).                                                   |
| Prix d'adjudication, vente notariale | `sale_market_estimate_snapshots.adjudication_price_eur`, `sale_result`                                                                                                | Seulement si la source l'a publié à la sortie de statut.                                                                        |

Migration des colonnes : `20261108140000_pepite_estimate_versions_and_snapshot_columns.sql`. Les instantanés
antérieurs à son application ont ces colonnes à `null` (version du modèle inconnue).

## Contrôle préalable (à faire d'abord)

```sql
select pepite_status, pepite_is_pepite, count(*)
from app_private.sale_market_estimate_snapshots
group by 1, 2
order by 3 desc;
```

Résultat attendu après le n° 24 : surtout `pepite` / `not_pepite`, très peu de `not_applicable`. Mesuré en base le
27/10/2026 : 19 instantanés seulement, dont 1 `not_applicable`. Tant que le nombre de pépites archivées est faible, ne
tirer aucune conclusion.

## Requête de mesure (lecture seule, agrégats seulement)

Rapprochement exact d'un instantané de tribunal et d'une adjudication : une seule adjudication possible pour la clé
(tribunal, jour, mise à prix, groupe). Les rapprochements ambigus sont écartés. Les groupes de moins de 5 ventes ne
sont pas restitués, et la sortie ne contient jamais de ligne à ligne (limite Licitor sur la réutilisation des prix).

```sql
with pairs as (
  select
    s.snapshot_key,
    s.pepite_rule_version,
    s.estimate_model_version,
    s.estimate_engine_kind,
    s.pepite_is_pepite,
    s.pepite_chance_share,
    s.pepite_reference_ceiling_eur,
    s.pepite_probable_price_eur,
    s.value_p50_eur,
    o.hammer_price_eur,
    count(*) over (partition by s.snapshot_key) as matches
  from app_private.sale_market_estimate_snapshots s
  join app_private.auction_scenario_observation_snapshot o
    on o.court_code = s.court_code
   and o.sale_date = s.sale_date
   and o.starting_price_eur = s.starting_price_eur
   and app_private.scenario_property_group(o.property_type) is not distinct from s.property_group
  where s.sale_venue_type = 'tribunal'
    and s.pepite_status in ('pepite', 'not_pepite')
    and s.sale_date >= current_date - interval '90 days'
),
exact as (select * from pairs where matches = 1)
select
  pepite_rule_version,
  estimate_model_version,
  pepite_is_pepite,
  count(*) as n,
  -- B réalisé : adjudication au plus égale à l'enchère plafond de référence.
  avg((hammer_price_eur <= pepite_reference_ceiling_eur)::int) as b_realise,
  -- Borne haute de Wilson à 95 % de B réalisé (règle d'arrêt ci-dessous).
  (
    (avg((hammer_price_eur <= pepite_reference_ceiling_eur)::int) + 1.959964^2 / (2 * count(*)))
    + 1.959964 * sqrt(
        avg((hammer_price_eur <= pepite_reference_ceiling_eur)::int)
          * (1 - avg((hammer_price_eur <= pepite_reference_ceiling_eur)::int)) / count(*)
        + 1.959964^2 / (4 * count(*)^2)
      )
  ) / (1 + 1.959964^2 / count(*)) as b_realise_wilson_haut,
  -- B annoncé, à comparer à B réalisé.
  avg(pepite_chance_share) as b_annonce_moyen,
  -- Prix d'adjudication rapporté à la valeur centrale (hors frais) et erreur du prix probable.
  percentile_cont(0.5) within group (order by (hammer_price_eur / value_p50_eur)::double precision) as adjudication_sur_p50_median,
  percentile_cont(0.5) within group (order by abs(ln((pepite_probable_price_eur / hammer_price_eur)::double precision))) as erreur_prix_probable_mediane,
  percentile_cont(0.75) within group (order by abs(ln((pepite_probable_price_eur / hammer_price_eur)::double precision))) as erreur_prix_probable_p75
from exact
where pepite_reference_ceiling_eur > 0 and pepite_probable_price_eur > 0 and hammer_price_eur > 0
group by 1, 2, 3
having count(*) >= 5
order by 1, 2, 3 desc;
```

Limites connues de cette requête (écrite à partir des schémas des migrations, non exécutée : à valider sur une base
de test avant le premier usage) :

- **C réalisé** (coût total, frais compris, au prix d'adjudication, rapporté à la valeur centrale) n'est pas calculable
  en SQL : les frais viennent du moteur de plafond (`totalCostAt`, TypeScript). La requête donne
  l'adjudication rapportée à la valeur centrale hors frais ; le calcul complet se fait en ajoutant les frais du
  régime au prix d'adjudication, hors de la base.
- Le tribunal n'a pas de `sale_result` : pas d'invendus ni de reports, la justesse est calculée sur les ventes
  adjugées (biais de survie). L'adjudication n'est pas une valeur de marché : l'erreur du modèle de valeur se mesure
  par le rétro-test DVF chronologique (`valuation-backtest.ts`), pas par ces paires.
- Pour une vente notariale, remplacer la jointure par `adjudication_price_eur` des instantanés.

## Découpes et témoins

À produire à chaque revue, toujours en agrégats avec un effectif minimal :

- tribunal ou vente notariale ; bien libre, occupé ou loué (`occupancy`) ; mise à prix sous ou au-dessus de 30 % de la
  valeur centrale (`pepite_starting_share_of_value`) ; moteur (`estimate_engine_kind`) ;
- B réalisé par décile de B annoncé (`pepite_chance_share`) ;
- invendus et reports, par type de vente, quand la source les publie ;
- **témoins** : les « presque pépites » (un seul critère manqué, lisible dans `pepite_reason_codes`) et un tirage
  aléatoire de ventes de même rapport mise à prix / valeur estimée. Sans témoin, un bon B réalisé peut venir du
  seul choix des ventes à mise à prix basse.

## Règles fixées à l'avance

- **Taille.** Pour une part observée de 70 %, 150 pépites donnent environ ± 7,5 points (95 %). Avec 5 à 10 % de
  pépites parmi les ventes évaluées, cela suppose 1 500 à 3 000 paires, donc plusieurs trimestres. Revue de fond à
  chaque tranche de 150 paires.
- **Arrêt.** Avec au moins 40 paires sur 90 jours, si la borne haute de Wilson (95 %) de B réalisé est inférieure à
  70 %, ou celle de C réalisé inférieure à 60 %, suspendre le repère (`suspend_sale_pepites`, bouton
  « Suspendre les pépites » de `/admin/pepites`). La décision de réouverture suit une revue des critères.
- **Changement de modèle de valeur.** Avant l'activation d'un nouveau modèle, rejouer la règle sur les ventes à venir
  avec l'ancien et le nouveau modèle et noter combien de pépites entrent ou sortent (seuil indicatif : au plus
  ± 30 %). Après l'activation, comparer B et C réalisés par `estimate_model_version`.
- **Sortie.** Agrégats uniquement (effectifs, médianes, parts) : jamais de ligne à ligne, ni de prix d'adjudication
  par vente, conformément à la limite Licitor.

## Ce qui n'est pas automatisé

- Aucun code ne lit `sale_market_estimate_snapshots` : la requête ci-dessus est lancée à la main, avec un accès en
  lecture seule, par la personne qui tient le suivi.
- La règle d'arrêt est une règle de décision humaine ; son automatisation est un chantier à part.

## Page publique d'historique : pas pour l'instant

Aucune page publique n'est créée. Ce qu'il faudrait pour la publier honnêtement :

1. **Un volume suffisant** : au moins 20 résultats (puis 150 pour une conclusion), affichés avec leur intervalle de
   Wilson. En dessous, afficher l'effectif et pas de pourcentage.
2. **Ratés compris** : toutes les pépites publiées à J-7 ou à la dernière évaluation, pas seulement celles qui ont
   réussi ; ventes non adjugées signalées à part quand la source les publie.
3. **Une table agrégée dédiée**, mise à jour par une tâche planifiée à partir des instantanés (mois, régime, version
   de règle) : effectif, B réalisé, intervalle, adjudication sur plafond. Jamais d'accès public aux instantanés.
4. **Un texte relu par `juridique-rgpd`** : la page affirme une performance passée ; elle doit dire ce que le repère ne
   promet pas, et rappeler la limite Licitor (agrégats, pas de prix par vente).
5. **La date de mise en service de la règle et du modèle** (`pepite_rule_version`, `estimate_model_version`) à côté de
   chaque série, pour ne pas mélanger deux règles.
6. Une mise à jour mensuelle, avec la date de dernière mesure affichée.
