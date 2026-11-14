# Modèle de valorisation LightGBM : model card

_Version documentaire 0.1, 8 novembre 2026. Cette fiche décrit le code présent dans le dépôt et
l'état mesuré en production le 08/11/2026 (lecture seule). Elle ne vaut ni validation statistique,
ni autorisation d'activer un modèle._

## Identification

| Élément                | Valeur                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Clé de modèle          | `immojudis_market_value` (registre `public.valuation_model_versions`)                                     |
| Cadre                  | `lightgbm_quantile` : trois régressions quantiles LightGBM (p10, p50, p90), intervalle MAPIE CQR          |
| Segments               | `apartment`, `house`, `building`, `commercial`, `land` (un modèle par segment)                            |
| Cible                  | `log(prix au m²)` : surface bâtie, ou surface du terrain pour `land`                                      |
| Entraînement           | `services/data-pipeline/src/valuation_training.py`, workflow `valuation-model-training.yml`               |
| Porte d'activation     | `services/data-pipeline/src/valuation_activation_gate.py`, `scripts/lib/valuation-promotion-gate.mjs`     |
| Mélange servi          | `src/lib/hybrid-market-valuation.ts` ; rejoué à l'entraînement par `valuation_served_blend.py`            |
| Inférence              | `src/lib/lightgbm-inference.ts` (lecture du `dump_model()` des arbres, sans dépendance LightGBM)          |
| Retour arrière         | [`docs/runbooks/modeles-valorisation-retour-arriere.md`](runbooks/modeles-valorisation-retour-arriere.md) |
| Version de cette fiche | 0.1 ; à réviser à chaque changement de variables, de porte ou de pondération du mélange                   |

## Usage prévu

Le modèle complète l'estimation par comparables DVF de la fiche d'une vente : il n'est jamais montré
seul. Quand un modèle est actif pour le segment et que le moteur a trouvé des comparables (médiane,
p10 et p90), l'application mélange les deux (voir « Mélange servi ») et affiche le résultat comme
une « fourchette indicative », sans niveau de couverture annoncé.

Il ne doit pas servir à :

- présenter un prix de vente garanti ou une valeur d'expertise ;
- afficher seul, sans les comparables, une valeur pour un bien ;
- annoncer un intervalle « à 80 % » : la couverture du mélange servi n'est mesurée qu'en backtest
  (bloc `blend` du rapport), jamais sur les fiches ;
- valoriser un bien occupé comme un bien libre : le modèle apprend sur des ventes de gré à gré, sans
  information d'occupation.

## Données

- Source : `public.dvf_transactions`, ventes DVF de nature `Vente` uniquement. Les adjudications
  sont exclues de l'entraînement (elles sont réservées à l'Outcome Graph).
- Filtres : prix total positif, coordonnées présentes, surface bâtie ou terrain positive, segment
  reconnu par le code DVF ou le libellé du type de bien.
- Bornes de cible : bâti entre 300 et 50 000 €/m² avec au moins 9 m² ; terrain entre 1 et
  100 000 €/m².
- Volume : les `limit` ventes les plus récentes par segment (750 000 par défaut dans le workflow),
  au moins `min_rows` (500 par défaut) pour entraîner.
- Entrée locale possible (`--input`, fichier DVF géolocalisé) : ce chemin ne garde que les mutations
  à un seul bien. Le chemin Postgres, celui du workflow, ne fait pas ce filtre (constat de lecture,
  effet non mesuré : une mutation de plusieurs lots peut gonfler le prix au m² d'un lot).

## Variables

13 variables, dans l'ordre de `FEATURE_NAMES` ; l'inférence ne lit que celles de
`artifact.featureNames`.

| Variable                                                        | Contenu                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `surface_m2`, `log_surface_m2`                                  | surface bâtie (terrain pour `land`)                                           |
| `land_surface_m2`, `log_land_surface_m2`                        | surface du terrain, absente si nulle                                          |
| `rooms_count`                                                   | pièces principales                                                            |
| `latitude`, `longitude`                                         | coordonnées                                                                   |
| `sale_year`, `sale_month_sin`, `sale_month_cos`                 | date de la vente (au service : date du calcul)                                |
| `local_median_log`, `local_spread_log`, `local_sample_size_log` | marché local : statistiques de cellule H3 des ventes antérieures (ci-dessous) |

Marché local. Pour chaque vente, on prend la cellule H3 la plus fine qui compte au moins 5 ventes
antérieures (résolutions 9, 8, 7 ; 8, 7, 6 pour les maisons). `local_median_log` est la moyenne du
log du prix au m² de ces ventes, `local_spread_log` leur écart-type × 2,563 (largeur p10-p90,
plancher 0,05), `local_sample_size_log` = log(1 + min(n, 100)). Sans cellule assez fournie : moyenne
globale des ventes antérieures (après 30 ventes) et effectif 0. À l'entraînement, une vente ne voit
que les ventes strictement antérieures. Au service, les mêmes statistiques sont relues dans l'export
`localMarket` de l'artefact (cellules calculées sur toutes les ventes jusqu'à `fittedThrough`).

Depuis le 14/11 (D2), un modèle actif n'est plus utilisé au service s'il n'a pas l'export
`localMarket`, ou si ses `training_metrics` n'ont pas la couverture mesurée par la porte
(`comparison.served_interval_coverage_pct`) au moins égale au plancher de mise en service
(`hybrid-market-valuation.ts`). L'ancienne approximation tirée des comparables du moteur
(`legacyLocalFeatures`) est supprimée. C'est le cas des deux modèles actifs au 08/11 (voir « État en
production ») : les nouvelles estimations de ces segments retombent sur les comparables seuls ; celles déjà
stockées restent jusqu'à leur recalcul (voir le cas dédié du runbook de retour arrière).

## Découpage et apprentissage

- Découpage chronologique : 70 % des ventes les plus anciennes pour l'apprentissage, 15 % pour la
  calibration, 15 % les plus récentes pour le test. Au moins 20 ventes par part.
- Hyperparamètres (`make_quantile_estimator`) : 350 arbres, taux 0,035, 31 feuilles, 30 ventes
  minimum par feuille, sous-échantillonnage 0,85 des lignes et 0,9 des colonnes, `reg_alpha` 0,05,
  `reg_lambda` 0,2, graine 42.
- Modèle de validation : appris sur les 70 %, calibré sur les 15 % suivants, évalué sur les 15 %
  les plus récents. Toutes les métriques du rapport et de `training_metrics` sont les siennes.
- Modèle publié : réappris sur les 85 % les plus anciens, recalibré sur les 15 % les plus récents.
  Il n'est donc pas celui qu'on a évalué (le rapport le dit dans `published_model`).

## Intervalle

- MAPIE `ConformalizedQuantileRegressor`, niveau nominal 80 % (`CONFIDENCE_LEVEL`).
- L'intervalle servi par `predictLightGbmQuantiles` n'appelle pas MAPIE : il décale les quantiles
  bruts p10 et p90 de deux corrections scalaires (médianes sur la fenêtre de calibration, planchers à
  zéro) puis les borne autour du p50. Le rapport mesure les deux : `interval_coverage_pct` (MAPIE)
  et `coverage.served_interval_pct` (intervalle servi du modèle seul, sur les ventes de test).
- Le mélange avec les comparables (ci-dessous) change encore cet intervalle : sa couverture est
  dans le bloc `blend` du rapport.

## Porte d'activation

Deux étages, appliqués par `train_frame_if_eligible`.

1. Seuils absolus (`validate_promotion`) : au moins 50 ventes de test, erreur médiane ≤ 30 %,
   MAPE ≤ 40 %, couverture MAPIE ≥ 72 %, largeur moyenne MAPIE ≤ 110 %. `--force` les contourne.
2. Porte relative (`decide_activation`), que `--force` ne contourne jamais :
   - au moins 300 ventes de test chronologiques ;
   - erreur médiane meilleure que le repère naïf le plus strict (moyenne géométrique de la cellule
     ou médiane de cellule des ventes d'apprentissage) et que le modèle actif, avec un intervalle
     bootstrap apparié à 95 % de l'écart (1 000 tirages) entièrement sous zéro ;
   - le modèle actif est noté avec ses propres variables locales (`own_export`), ou avec
     l'approximation du candidat s'il n'a pas d'export ; un modèle actif non évaluable vaut refus ;
   - au moins 70 % des ventes de test dans l'intervalle servi du modèle ;
   - **mélange servi (D19)** : à chaque palier de qualité des comparables, l'erreur médiane du
     mélange ne doit pas dépasser celle des comparables seuls ; un mélange non évalué vaut refus.

Le workflow publie en brouillon par défaut (`activate=false`) ; l'activation demande
`confirm_target=production`, ne tourne que depuis `main`, et le script de publication
`publish-valuation-models.mjs` refuse tout lot dont le rapport ne porte pas
`promotion.activate = true`.

## Mélange servi

`applyActiveHybridModel` (`hybrid-market-valuation.ts`) mélange géométriquement chaque quantile :
`exp((1 - w) × log(comparables) + w × log(modèle))`, puis borne p10 et p90 autour du p50 mélangé.

Poids du modèle `w` (`resolveModelWeight`) :

| Score de qualité des comparables | Poids de base |
| -------------------------------- | ------------- |
| ≥ 78 (« forte »)                 | 0,35          |
| ≥ 58 (« correcte »)              | 0,45          |
| < 58 (« fragile »)               | 0,60          |

Ajustement par la MAPE de test du modèle (`training_metrics.test_mape_pct`) :
`(16 - MAPE) / 100`, borné entre -0,12 et +0,08. Plafond : 0,30 si MAPE ≥ 35 %, 0,45 si
MAPE ≥ 25 %, 0,70 sinon. Plancher : 0,20. Ces nombres sont recopiés dans
`valuation_served_blend.py` ; un test relit le fichier TypeScript et échoue s'ils divergent.

Évaluation à l'entraînement (bloc `blend` du rapport, `training_metrics.comparison.blend` au
registre). Sur les ventes de test dont la cellule compte au moins 5 ventes antérieures :

- comparables seuls : médiane = moyenne géométrique de la cellule, p10 et p90 = médiane
  ∓ la moitié de `local_spread_log` en log ;
- modèle seul : quantiles tels qu'ils sont servis ;
- mélange servi : calculé à chacun des trois paliers de qualité, avec le poids qu'aurait ce modèle
  en production. Le score de qualité réel dépend du moteur de comparables, que le backtest n'a pas :
  on couvre donc tous les poids possibles.

Pour chacun : erreur médiane, erreur p75, couverture de l'intervalle, part sous et au-dessus.

## État en production au 08/11/2026

Mesuré en lecture seule dans `valuation_model_versions` :

- 2 lignes actives, segments `house` et `apartment`, version `lgbm-cqr-20260713`, cadre
  `lightgbm_quantile`, 350 000 lignes d'entraînement, activées le 27/07/2026 ;
- pas d'export `artifact.localMarket` : jusqu'au 14/11, les variables locales servies étaient
  l'approximation tirée des comparables, pas celles de l'entraînement ; depuis D2, ces modèles ne
  calculent plus de nouvelle estimation (les estimations stockées restent jusqu'à leur recalcul) ;
- pas de bloc `training_metrics.comparison` (clés présentes : `test_rows`, `train_rows`,
  `test_mape_pct`, `calibration_rows`, `confidence_level`, `test_p75_ape_pct`,
  `test_median_ape_pct`, `interval_coverage_pct`, `interval_mean_width_pct`) : ces modèles n'ont
  jamais été comparés au modèle actif, au repère naïf ni aux comparables, et leur mélange servi n'a
  jamais été évalué. Ils sont antérieurs à la porte n° 22 et à l'export.
- Aucun modèle actif pour `building`, `commercial` et `land` : ces segments sont servis par les
  comparables seuls.

Décision recommandée (D1, action du propriétaire) : action B du runbook de retour arrière pour les
deux segments, puis entraînement en brouillon (`activate=false`) audité avant toute activation.

## Limites connues

1. **Mélange (D19)** : l'évaluation remplace les comparables du moteur (pondérés par distance,
   ancienneté et surface, dans un rayon) par des statistiques de cellule H3 non pondérées. Elle
   approche ce qui est servi, elle ne le reproduit pas. La règle de la porte sur le mélange compare
   des erreurs médianes ponctuelles, sans intervalle bootstrap, et n'impose pas de nombre minimal de
   ventes avec comparables (le rapport donne `rows`).
2. **Couverture (D19, n° 5)** : la porte n'impose qu'un plancher de 70 % à l'intervalle du modèle
   seul. Un intervalle très large passe ; le biais (`below_pct` / `above_pct`) est rapporté mais ne
   bloque rien ; la limite de largeur de 110 % porte sur l'intervalle MAPIE, pas sur l'intervalle
   servi, et `--force` la contourne. La couverture du mélange est rapportée, sans plancher.
3. **Délai de publication DVF (D19, n° 6)** : à l'entraînement, chaque vente voit le marché jusqu'à
   la veille ; au service, l'export s'arrête à la fin des données, publiées avec environ six mois de
   retard, et le modèle vieillit encore ensuite. `sale_year` vaut l'année en cours au service, hors
   de la plage d'entraînement. L'erreur de test est donc probablement optimiste (non mesuré).
4. **Modèles actifs sans export** : écart entre variables d'entraînement et de service (ci-dessus).
5. **Métriques** : celles du modèle de validation, pas du modèle publié ; aucune évaluation par
   zone, par tranche de prix ou dans le temps.
6. **Pondération du mélange** fixée à la main, jamais ajustée sur des données.
7. **Workflow** : d'après qa-modeles (08/11), aucune exécution réussie sur 7 (non revérifié). Les
   lots d'artefacts du workflow ne sont conservés que 30 jours.
8. **Libellé** : en mode hybride, la fiche peut encore écrire « d'après N ventes comparables »
   alors qu'une part de la valeur vient du modèle (D2, traité à part).
9. Mutations de plusieurs lots non exclues sur le chemin Postgres (voir « Données »).

## Gouvernance

Toute activation passe par la porte relative et le script de publication ; une version activée
retire la précédente sans l'effacer. Le retour arrière et l'arrêt du modèle d'un segment sont
décrits dans le runbook ; ce sont des écritures en production réservées au propriétaire. Une
correction de variables, de porte ou de pondération du mélange crée une nouvelle version et une
révision de cette fiche.
