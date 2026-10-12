# Admin : requêtes lourdes et dépassements de 300 s (P3-11, constats LIVE-07 et CODE-07)

Analyse du 10 octobre 2026. Les journaux d’exécution du 4 octobre ne sont plus consultables
(Vercel Hobby ne conserve les journaux qu’une heure) : les routes concernées ont donc été
retrouvées **par lecture du code et de la base**, pas par mesure du 4 octobre. Aucun
`EXPLAIN ANALYZE` n’a été lancé en production ; seuls des `EXPLAIN` simples, des tailles de
tables et un `CREATE INDEX` essayé dans une transaction annulée l’ont été.

## Taille des tables lues par l’admin (production, 10 octobre)

| Table                           | Lignes | Taille totale | Remarque                                                                         |
| ------------------------------- | -----: | ------------: | -------------------------------------------------------------------------------- |
| `auction_sales`                 |  2 837 |        289 Mo | `raw_payload` (jsonb) : 102 Mo stockés, 38 Ko en moyenne, 2,9 Mo au maximum      |
| `auction_score_factors`         | 25 533 |         63 Mo | comptage exact à chaque ouverture du tableau de bord                             |
| `auction_pipeline_observations` | 21 989 |         17 Mo | dernière ligne par source : index `(source_name, observed_at desc)` déjà utilisé |
| `auction_fact_claims`           | 17 136 |         11 Mo |                                                                                  |
| `auction_runs`                  | ~1 540 |         66 Mo | 1,2 Mo de lignes, 50 Mo de JSON `summary` / `errors`                             |
| tables de l’agent IA            |      0 |      < 0,1 Mo | missions, faits, messages, dossiers, pièces                                      |

Toutes ces tables sont petites : aucune requête n’y est lente à cause d’un index manquant. Le
coût vient du **volume de `raw_payload` relu**.

## Routes les plus lourdes

1. `GET /api/admin/dashboard` (avant P3-11). Chaque appel faisait cinq comptages exacts, puis
   lisait par pages de 1 000 lignes, **toutes** les ventes avec `raw_payload->…` (quatre champs
   JSON) pour calculer la couverture des synthèses IA : environ 102 Mo à décompresser. Le
   client relançait cet appel toutes les 10 s tant qu’un run était actif, et chaque onglet
   ouvert en faisait autant : plusieurs lectures complètes pouvaient s’empiler sur la base.
   C’est le meilleur candidat pour les dépassements de 300 s, **sans que le 4 octobre ait pu
   être vérifié**.
2. `GET /api/admin/data-quality`. Relit tout le catalogue par pages de 250 identifiants à
   travers `v_auction_sales_app`, dont le filtre de visibilité évalue
   `raw_payload ->> 'publication_quarantine'` et `sale_catalogue_entry_is_live_materialized(…)`
   ligne par ligne : une lecture complète de `raw_payload` par rapport.
3. `GET /api/admin/readiness`. Ouvre trois connexions Postgres directes sans délai de connexion
   ni de requête ; l’une relit `raw_payload` des ventes actives pour la couverture IA.

Les autres routes (`pipeline`, `publications`, `subscriptions`, `lawyers`, `privacy-requests`,
`catalogue-readiness`, `fact-claims/review`, agent IA) lisent des tables de moins de 25 000
lignes avec pagination ou index : rien d’inquiétant.

## `EXPLAIN` (sans `ANALYZE`) des requêtes concernées

| Requête                                                                              | Plan                                                 | Coût planifié |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------: |
| 25 derniers runs (`order by created_at desc nulls last limit 25`)                    | scan séquentiel de `auction_runs` + tri              |         205,9 |
| idem, avec `auction_runs_created_at_desc_idx` (transaction annulée)                  | parcours d’index, arrêt après 25 lignes              |           3,2 |
| file de maturité du catalogue, page 1                                                | `idx_auction_sales_status` + tri de ~2 500 lignes    |       1 598,6 |
| idem avec un index `(premium_readiness_score desc, sale_date)` (transaction annulée) | parcours d’index                                     |          32,8 |
| idem, page à l’offset 2 400                                                          | parcours d’index                                     |       1 594,0 |
| faits à vérifier (vue `v_auction_fact_claims_read_model`)                            | scan de `auction_fact_claims` + tri                  |       1 613,7 |
| comptage des faits à vérifier                                                        | parcours d’index seul                                |         949,3 |
| `count(id)` de `auction_score_factors`                                               | parcours d’index seul (clé primaire)                 |       2 076,2 |
| dernière observation d’une source                                                    | `auction_pipeline_observations_source_time`          |           1,0 |
| 250 identifiants dans `v_auction_sales_app`                                          | boucle imbriquée, filtre sur `raw_payload` par ligne |         453,6 |

L’`EXPLAIN` ne mesure pas le coût de décompression de `raw_payload` : c’est pourquoi aucun index
ne règle les points 1 à 3 ci-dessus.

## Décisions

- **Index créé** (migration `20261010100000_admin_query_indexes.sql`, non appliquée) :
  `auction_runs (created_at desc nulls last)`. Coût planifié divisé par environ 65 pour la requête la
  plus sollicitée de l’admin ; table minuscule, donc construction instantanée dans la
  transaction de migration (pas de `CONCURRENTLY`).
- **Index refusé** sur la file de maturité du catalogue : il ne profite qu’aux premières pages
  (le tri disparaît mais le filtre `premium_readiness_status <> 'premium_ready' or … = 'hold'`
  force la lecture des lignes), pour un gain absolu de quelques millisecondes, et il alourdirait
  les écritures de la table la plus chaude du pipeline.
- **Aucun index** sur `auction_fact_claims`, `information_agent_*`, `listing_publication_requests`
  : tables vides ou de quelques milliers de lignes, parcours d’index déjà utilisés.
- **Corrigé dans le code** (la vraie cause) : le tableau de bord est découpé en trois sections
  (`?section=runs|ai|counts`) ; la couverture IA n’est calculée que sur les pages qui
  l’affichent, mise en cache 60 s côté serveur avec partage des lectures simultanées, relue au
  plus une fois par minute côté navigateur ; les 25 derniers runs (rapides) sont seuls relus
  toutes les 10 s. Chaque route admin a désormais un délai de 28 s (`maxDuration` = 30) avec
  un message clair, et connecte Postgres avec un délai de 8 s.

## À faire ensuite (hors périmètre de P3-11)

Sortir de `raw_payload` les champs que l’admin et le diagnostic relisent en boucle
(`llm_prompt_version`, `llm_display_status`, `llm_display_quality_version`, longueur de la
description affichée, `publication_quarantine`) vers des colonnes générées ou une table
satellite : les comptages deviendraient des lectures d’index, et la vue `v_auction_sales_app`
n’aurait plus à décompresser le JSON pour filtrer. Cela demande une migration de données sur
`auction_sales` (donc le script d’index concurrents) et ne doit pas être improvisé.
