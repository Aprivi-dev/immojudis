# Alerte `pipeline.source.<source>.stale_listings` (avertissement)

Pour une source **activée** d'au moins 10 ventes actives, moins de 80 % des annonces actives ont été
revues dans leur fenêtre de fraîcheur sur **deux observations consécutives** (`freshness_ratio` dans
l'évidence et `previous_freshness_ratio`). Les annonces affichées comme à jour ne le sont plus.

## Fenêtre de fraîcheur (depuis `20261201100000`)

La politique de relecture est écrite une seule fois côté SQL, dans `app_private.listing_review_policy()`,
**jumelle** de `detail_reread_hours` (`services/data-pipeline/src/freshness.py`) : changer l'une, c'est changer
l'autre, dans le même lot. La santé applique la politique, sauf pour une audience proche, où elle applique une
**tolérance** nommée à part (`near_sale_health_window_hours`) : la relecture y suit l'inventaire de 12 h, et 24 h
en tolèrent un manqué, pas deux.

| Annonce                     | Politique de relecture (`reread_hours`…)          | Tâche `source_detail` due après | Fenêtre de la santé                    |
| --------------------------- | ------------------------------------------------- | ------------------------------- | -------------------------------------- |
| Audience dans plus de 7 j   | 72 h (`DETAIL_REREAD_HOURS`)                      | 71 h                            | 72 h                                   |
| Licitor, audience lointaine | 24 h (`SOURCE_DETAIL_FRESHNESS_HOURS`)            | 23 h                            | 24 h                                   |
| Audience dans les 7 jours   | 6 h (`NEAR_SALE_REREAD_HOURS`), chaque inventaire | 5 h                             | 24 h (`near_sale_health_window_hours`) |

La tâche `source_detail` tombe une heure avant la fin de la fenêtre (`source_detail_lead_hours`, lu par
`enqueue_due_source_details_unlocked` et `services/data-pipeline/src/source_detail_reuse.py`). Jusqu'au 16/11/2026,
la fenêtre de la santé était de 24 h pour toutes les ventes lointaines : Notaires, relue volontairement toutes les
72 h, restait à 0,46 et l'alerte ne se fermait jamais. Les valeurs appliquées sont dans les détails
(`reread_hours`, `near_sale_health_window_hours`).

## Une cause, une alerte

L'alerte ne s'ouvre pas pour une source dont `pipeline.source.<source>.missed` est vraie au même passage
ou encore ouverte (deux heures après le retour d'un inventaire complet). Des annonces non revues ne sont
alors que la conséquence de l'inventaire manquant : traiter `.missed` d'abord
([`pipeline-source-missed`](pipeline-source-missed.md)). Les détails le disent : `suppressed_by_missed`.

## Diagnostic

1. `select details->>'active_listings', details->>'fresh_listings', details->>'freshness_ratio',
details->>'reread_hours', details->>'suppressed_by_missed'
from operational_alerts where alert_key = 'pipeline.source.<source>.stale_listings';`
2. Mesure du moment, en lecture seule :
   `select * from public.auction_all_source_freshness(now()) where source_name = '<source>';`
3. Les revues viennent des inventaires et des tâches `source_detail`. Vérifier :
   `auction_pipeline_control.source_details_enabled`, la file (`pipeline.enrichment.stalled`) et la date du
   dernier inventaire de la source.
4. Un ratio bas juste après un long arrêt est normal : il remonte quand les tâches rattrapent.
5. Ratio bas pour une seule source alors que sa collecte tourne : comparer `reread_hours` à la valeur de
   `freshness.py` pour cette source. Un écart veut dire que les deux jumelles ne disent plus la même chose.

## Actions

- Cause en amont (inventaire, file bloquée) : traiter l'alerte correspondante d'abord.
- Politique de relecture changée côté collecte : changer `app_private.listing_review_policy()` par une
  migration dans le même lot.
- Rien à corriger en base : ne jamais marquer des annonces comme revues à la main.

## Fermeture

Automatique : un ratio de 80 % ou plus, ou une alerte `.missed` ouverte pour la source, rend l'alerte
inactive, puis elle se ferme après deux heures.
