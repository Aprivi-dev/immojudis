# Alerte `pipeline.source.<source>.publication_stale` (critique)

Une source **activée** n'a pas de publication complète (`last_publication_complete_at` : inventaire
complet ET publication sans échec) depuis plus de **36 heures**, ou n'en a jamais eu (la date d'activation
de l'observation fait alors foi). `.missed` ne voit pas ce cas : l'inventaire peut se terminer sans que la
publication aboutisse. Cas connus au 20/10/2026 : Enchères Immobilières (figée au 08/10) et Agrasc (aucun
inventaire complet).

## Diagnostic

1. `select enabled, last_inventory_complete_at, last_publication_complete_at, availability,
coverage->>'coverage_complete', last_error from auction_source_state where source_name = '<source>';`
2. `last_inventory_complete_at` récent mais `last_publication_complete_at` ancien : la publication échoue ;
   voir `docs/runbooks/pipeline-source-publication.md`.
3. `coverage_complete` faux à chaque run (Agrasc) : la couverture n'est jamais déclarée complète par la
   source ; lire `coverage` du dernier run et le code de la source dans `services/data-pipeline/src/sources/`.
4. Les deux dates anciennes : voir `docs/runbooks/pipeline-source-missed.md`.

## Actions

- Corriger la cause (couverture, publication) dans le code de la source.
- Source qu'on ne sait pas rendre complète : la désactiver (`enabled = false`) est une décision du
  propriétaire ; l'alerte ne concerne que les sources activées.

## Fermeture

Automatique : une publication complète rend l'alerte inactive, elle se ferme deux heures plus tard.
