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
3. Lire ce qui bloque, écrit à chaque run dans la couverture (et en annotation `Publication incomplète (<source>)`
   du journal de `data-pipeline.yml`) :
   `select coverage->'publication_blockers', coverage->'publication_blocker_details',
coverage->'publication_stuck_items', coverage->>'publication_blocked_since', coverage->>'stop_reason'
from auction_source_state where source_name = '<source>';`
   - `inventory_incomplete` : `publication_blocker_details.inventory_incomplete` donne `stop_reason`
     (`source_errors`, `page_limit_or_count_mismatch`, `repeated_page`, `empty_page_unverified`), le nombre
     d'erreurs, d'échecs de liste et de fiche (`detail_failures_sample`) et les raisons du certificat. Une seule
     fiche détail en erreur à chaque run suffit à garder `coverage_complete` faux et le run en échec
     (`CollectionIncompleteError`) : c'est la cause à chercher en premier.
   - `publication_pending` : `decisions` dit lesquelles. `publication_failed` et `normalization_failed`
     persistent d'un run à l'autre (`publication_stuck_items` : 5 fiches avec la raison) ; `discovered`,
     `normalized` et `admitted` se résorbent quand un run va jusqu'au bout.
   - `run_not_succeeded` : le run s'est terminé en échec (budget, `CollectionIncompleteError`).
4. Les deux dates anciennes : voir `docs/runbooks/pipeline-source-missed.md`.
5. Requête en lecture seule pour confirmer sur la production le cas Enchères Immobilières (ne rien écrire) :
   `select r.id, r.status, r.started_at,
r.summary->'scrape_coverage'->'encheres_immobilieres'->'publication_blockers' as blockers,
r.summary->'scrape_coverage'->'encheres_immobilieres'->>'stop_reason' as stop_reason,
r.summary->'scrape_coverage'->'encheres_immobilieres'->'errors' as errors,
r.summary->'scrape_coverage'->'encheres_immobilieres'->'detail_failures' as detail_failures
from auction_runs r where r.source = 'encheres_immobilieres' order by r.started_at desc limit 10;`
   Les runs antérieurs au 23/10/2026 n'ont pas `publication_blockers` (`null`) : `stop_reason`, `errors` et
   `detail_failures` suffisent alors. Puis, pour un `run_id` donné :
   `select decision, count(*) from auction_collection_items where run_id = '<run_id>' and source_name =
'encheres_immobilieres' group by 1;`

## Actions

- Corriger la cause (couverture, publication) dans le code de la source : fiche détail qui échoue toujours
  (parseur, page retirée), annonce qui échoue à la normalisation ou à la publication (voir
  `docs/runbooks/pipeline-source-publication.md`). Le run suivant le dit dans `publication_blockers`.
- Source qu'on ne sait pas rendre complète : la désactiver (`enabled = false`) est une décision du
  propriétaire ; l'alerte ne concerne que les sources activées.

## Fermeture

Automatique : une publication complète rend l'alerte inactive, elle se ferme deux heures plus tard.
