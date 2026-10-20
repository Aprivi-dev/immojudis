# Alerte `pipeline.source.<source>.drop` (avertissement)

Le dernier inventaire **complet** d'une source activée contient moins de 70 % de la moyenne de ses
28 derniers inventaires complets (référence d'au moins 10 ventes). Soit la source a vraiment retiré des
annonces, soit son décodage ou son accès s'est dégradé et l'inventaire est tronqué.

## Diagnostic

1. `select details->>'inventory_count', details->>'inventory_baseline', details->'decisions'
from operational_alerts where alert_key = 'pipeline.source.<source>.drop';`
2. Comparer au site de la source à la main : le nombre d'annonces affichées est-il proche de
   `inventory_count` ou de `inventory_baseline` ?
3. Regarder `decisions` (excluded, quarantined, normalization_failed) : une hausse de ces décisions
   indique un décodage qui rejette des annonces valides.

## Actions

- Baisse réelle (la source a retiré des ventes) : rien à faire, l'alerte se ferme quand la moyenne rattrape.
  Les ventes absentes sont retirées du catalogue par `catalogue.source_absence.<source>`
  (voir `docs/runbooks/catalogue-source-absence.md`), jamais en masse.
- Inventaire tronqué (décodage, pagination) : corriger dans `services/data-pipeline/`, relancer la source ;
  ne rien supprimer en base.

## Fermeture

Automatique, deux heures après un inventaire complet de taille normale.
