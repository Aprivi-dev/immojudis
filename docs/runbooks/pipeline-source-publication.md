# Alerte `pipeline.source.<source>.publication` (critique)

Le dernier run d'une source activée a au moins une annonce en `publication_failed`
(`auction_collection_items.decision`) : l'annonce a été découverte et normalisée mais n'a pas pu être
publiée au catalogue.

## Diagnostic

1. `select details->'decisions', details->>'failed_publication', details->>'run_id'
from operational_alerts where alert_key = 'pipeline.source.<source>.publication';`
2. Lignes en cause :
   `select source_url, reason, evidence from auction_collection_items
where run_id = '<run_id>' and decision = 'publication_failed' limit 20;`
3. `reason` donne la cause (contrainte, valeur hors format, doublon). Chercher la même erreur dans le
   journal du workflow `data-pipeline.yml`.

## Actions

- Cause de données (champ invalide) : corriger le décodage ou la normalisation dans
  `services/data-pipeline/`, puis laisser le prochain run republier.
- Cause de base (contrainte, droit) : traiter par migration relue, jamais par réparation de données dans une
  migration (`supabase/README.md`).
- Si la source ne publie jamais complètement, voir aussi
  `docs/runbooks/pipeline-source-publication-stale.md`.

## Fermeture

Automatique : le run suivant sans `publication_failed` rend l'alerte inactive, puis elle se ferme après
deux heures.
