# Alerte `pipeline.inventory.stale` (critique)

Aucune source **activée** n'a d'inventaire complet de moins de **18 heures** : plus rien n'est collecté.
Alerte indépendante, évaluée même quand le pilote est coupé (les alertes `.missed` par source ne le sont
pas dans ce cas). Elle s'ouvre aussi quand aucune source n'est activée.

## Diagnostic

1. `select details from operational_alerts where alert_key = 'pipeline.inventory.stale';`
   (`scheduler_enabled`, `enabled_sources`, `sources_with_recent_inventory`).
2. `scheduler_enabled = false` : voir `docs/runbooks/pipeline-scheduler-disabled.md`.
3. `enabled_sources = 0` : toutes les sources sont désactivées ; décision du propriétaire.
4. Pilote actif et sources activées : voir `docs/runbooks/pipeline-source-missed.md` pour chaque source,
   et le workflow `data-pipeline.yml` (dispatch par `operational-health`, donc aussi
   `docs/runbooks/operational-health-arret.md`).

## Fermeture

Automatique : un inventaire complet de moins de 18 h sur une source activée rend l'alerte inactive, puis elle
se ferme après deux heures.
