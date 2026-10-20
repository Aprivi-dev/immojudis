# Alerte `pipeline.scheduler.disabled` (avertissement)

Le pilote automatique de collecte est coupé (`auction_pipeline_control.enabled = false`) depuis plus de
**24 heures**. Jusqu'au 20/10/2026 l'observateur rendait `{enabled: false}` sans aucune alerte. Tant que le
pilote est coupé, aucune collecte automatique ne part et les alertes par source (`.missed`, `.drop`,
`.publication`…) ne sont plus évaluées : voir aussi `pipeline.inventory.stale`.

La date de coupure est `auction_pipeline_control.updated_at` (posée par la route d'administration à chaque
changement ; un réglage modifié plus tard, par exemple le budget, la repousse).

## Diagnostic

1. `select enabled, updated_at, last_dispatch_at from auction_pipeline_control;`
2. La coupure est-elle voulue (maintenance, incident de source, coût) ? Chercher la décision dans le journal
   des changements et `docs/runbooks/pipeline-autonomy-progress.md`.

## Actions

- Coupure voulue et durable : l'alerte est un rappel (avertissement) ; la décision de rallumer appartient au
  propriétaire.
- Rallumage : bouton « pilote » de l'administration (PATCH `/api/admin/pipeline/control`, `enabled: true`).
  Vérifier qu'au moins une source est activée et que `pipeline.inventory.stale` se calme dans les 18 h.

## Fermeture

Automatique : pilote actif, l'alerte devient inactive puis se ferme après deux heures.
