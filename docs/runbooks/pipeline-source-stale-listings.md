# Alerte `pipeline.source.<source>.stale_listings` (avertissement)

Pour une source **activée** d'au moins 10 ventes actives, moins de 80 % des annonces actives ont été
revues dans leur fenêtre de fraîcheur sur **deux observations consécutives** (`freshness_ratio` dans
l'évidence et `previous_freshness_ratio`). Les annonces affichées comme à jour ne le sont plus.

## Fenêtre de fraîcheur (depuis `20261201100000`)

La fenêtre suit la politique de relecture de la collecte. Elle est écrite une seule fois côté SQL, dans
`app_private.listing_review_policy()`, **jumelle** de `detail_reread_hours`
(`services/data-pipeline/src/freshness.py`) : changer l'une, c'est changer l'autre, dans le même lot.

| Annonce                    | Relecture par la collecte               | Fenêtre de la santé |
| -------------------------- | --------------------------------------- | ------------------- |
| Vente dans plus de 7 jours | 72 h (`DETAIL_REREAD_HOURS`)            | 72 h                |
| Licitor, vente lointaine   | 24 h (`SOURCE_DETAIL_FRESHNESS_HOURS`)  | 24 h                |
| Vente dans les 7 jours     | à chaque inventaire (12 h), 6 h au plus | 24 h                |

Pour une vente proche, 24 h tolèrent un inventaire de 12 h manqué, pas deux. Jusqu'au 16/11/2026, la
fenêtre était de 24 h pour toutes les ventes lointaines : Notaires, relue volontairement toutes les 72 h,
restait à 0,46 et l'alerte ne se fermait jamais. Les fenêtres appliquées sont dans les détails
(`review_hours`, `near_sale_review_hours`).

## Une cause, une alerte

L'alerte ne s'ouvre pas pour une source dont `pipeline.source.<source>.missed` est vraie au même passage
ou encore ouverte (deux heures après le retour d'un inventaire complet). Des annonces non revues ne sont
alors que la conséquence de l'inventaire manquant : traiter `.missed` d'abord
([`pipeline-source-missed`](pipeline-source-missed.md)). Les détails le disent : `suppressed_by_missed`.

## Diagnostic

1. `select details->>'active_listings', details->>'fresh_listings', details->>'freshness_ratio',
details->>'review_hours', details->>'suppressed_by_missed'
from operational_alerts where alert_key = 'pipeline.source.<source>.stale_listings';`
2. Mesure du moment, en lecture seule :
   `select * from public.auction_all_source_freshness(now()) where source_name = '<source>';`
3. Les revues viennent des inventaires et des tâches `source_detail`. Vérifier :
   `auction_pipeline_control.source_details_enabled`, la file (`pipeline.enrichment.stalled`) et la date du
   dernier inventaire de la source.
4. Un ratio bas juste après un long arrêt est normal : il remonte quand les tâches rattrapent.
5. Ratio bas pour une seule source alors que sa collecte tourne : comparer `review_hours` à la valeur de
   `freshness.py` pour cette source. Un écart veut dire que les deux jumelles ne disent plus la même chose.

## Actions

- Cause en amont (inventaire, file bloquée) : traiter l'alerte correspondante d'abord.
- Politique de relecture changée côté collecte : changer `app_private.listing_review_policy()` par une
  migration dans le même lot.
- Rien à corriger en base : ne jamais marquer des annonces comme revues à la main.

## Fermeture

Automatique : un ratio de 80 % ou plus, ou une alerte `.missed` ouverte pour la source, rend l'alerte
inactive, puis elle se ferme après deux heures.
