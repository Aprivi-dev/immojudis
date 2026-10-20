# Alerte `pipeline.source.<source>.stale_listings` (avertissement)

Pour une source **activée** d'au moins 10 ventes actives, moins de 80 % des annonces actives ont été
revues récemment (6 h pour une vente dans les 7 jours, 24 h sinon) sur **deux observations consécutives**
(`freshness_ratio` dans l'évidence et `previous_freshness_ratio`). Les annonces affichées comme à jour ne le
sont plus.

## Diagnostic

1. `select details->>'active_listings', details->>'fresh_listings', details->>'freshness_ratio'
from operational_alerts where alert_key = 'pipeline.source.<source>.stale_listings';`
2. Les revues viennent des inventaires et des tâches `source_detail`. Vérifier :
   `auction_pipeline_control.source_details_enabled`, la file (`pipeline.enrichment.stalled`) et la date du
   dernier inventaire de la source (`pipeline.source.<source>.missed`).
3. Un ratio bas juste après un long arrêt est normal : il remonte quand les tâches rattrapent.

## Actions

- Cause en amont (inventaire, file bloquée) : traiter l'alerte correspondante d'abord.
- Rien à corriger en base : ne jamais marquer des annonces comme revues à la main.

## Fermeture

Automatique : un ratio de 80 % ou plus rend l'alerte inactive, puis elle se ferme après deux heures.
