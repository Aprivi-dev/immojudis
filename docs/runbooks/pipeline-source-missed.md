# Alerte `pipeline.source.<source>.missed` (critique)

Une source activée n'a pas terminé d'inventaire complet depuis plus de **18 heures**
(`last_inventory_complete_at`, à défaut la date d'activation de l'observation). Seuil : cadence de 12 h,
plus dispatch et exécution, plus deux passages de l'ordonnanceur (`20261020120019`). Une source qui ne se
termine plus ne publie plus : ses ventes vieillissent sans que personne le voie.

## Diagnostic

1. Lire l'alerte : `select details from operational_alerts where alert_key = 'pipeline.source.<source>.missed';`
   (`availability`, `last_inventory_complete_at`, `run_id`, `inventory_count`).
2. État de la source : `select enabled, suspended_until, suspension_reason, consecutive_failures,
last_attempt_at, last_error, availability from auction_source_state where source_name = '<source>';`
3. Dernier run : `select status, started_at, finished_at, errors from auction_runs where id = <run_id>;` puis
   le workflow `data-pipeline.yml` correspondant (GitHub Actions).
4. `availability = access_denied` ou `unavailable` : la source bloque ou est tombée. Contrôler à la main
   l'adresse de la source ; ne pas contourner un blocage (robots.txt, conditions d'utilisation).

## Actions

- Source tombée ou bloquée : laisser faire l'ordonnanceur (nouvelle tentative au prochain passage) ; si le
  blocage dure, suspendre la source (`suspended_until`, `suspension_reason`) plutôt que laisser l'alerte
  ouverte sans fin, et noter la cause.
- Run bloqué (`running` depuis plus de 3 h) : voir `pipeline.import.unhealthy` dans
  `docs/operations-phase-3.md`.
- Pilote coupé ou plus aucune source récente : `docs/runbooks/pipeline-scheduler-disabled.md` et
  `docs/runbooks/pipeline-inventory-stale.md`.
- Cause de code (décodage de la source cassé) : corriger dans `services/data-pipeline/`, jamais en base.

## Fermeture

Automatique : elle se ferme deux heures après le premier inventaire complet suivant. Aucune remise à zéro
manuelle. Cas connu : `licitor` (ouverte depuis le 16/09), dont la cause est traitée par un autre chantier ;
l'alerte est gardée tant que l'inventaire n'aboutit pas.
