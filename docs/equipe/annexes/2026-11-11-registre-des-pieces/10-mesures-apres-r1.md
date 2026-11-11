<!-- Rapport du spécialiste `qualite-donnees`, rendu le 11/11/2026 dans la mission « registre des pièces », moins d'une heure après la mise en production du lot R1. Lecture seule, comptages seulement. Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Mesures en production après R1 (lecture seule)

Relevés pris le 11/11/2026 entre 12:27 et 12:38 UTC, soit 42 à 53 minutes après l'application de R1 (11:45 UTC). Aucune écriture, aucune donnée personnelle lue ou affichée.

**À retenir d'emblée :** R1 est inerte sur tout ce qui est mesurable, mais **aucun import de source n'a démarré ni fini depuis 11:45**. Les critères d'observation de la section F ne peuvent donc pas encore être jugés. Les mesures de dimensionnement, elles, sont complètes.

## 1. Inertie de R1

| Mesure                                    | Résultat                                                                                                                                                                                                                                                  | Attendu                      | Conforme                | Ce que cela change                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| F1 ventes tenues / évènements / décisions | 0 / 0 / 0 sur 1 419 ventes ; compteurs d'insertions cumulés des deux journaux à 0                                                                                                                                                                         | 0, 0, 0                      | Oui                     | Rien n'a été retenu ni journalisé.                                                                                                      |
| Ventes écrites depuis R1                  | 27 lignes de `auction_sales` modifiées après 11:45 (file d'enrichissement), 0 tenue, 0 évènement                                                                                                                                                          | sans objet                   | Oui, échantillon faible | Les déclencheurs ont tourné sur 27 écritures seulement.                                                                                 |
| F2 mode des déclencheurs                  | `A` pour les 3 `aaab_` de `auction_sales`, les 6 des deux journaux, les 2 nouveaux de `auction_fact_claims`                                                                                                                                               | `A`                          | Oui                     | L'annexe 08 annonce cinq déclencheurs de journaux ; la migration en crée six et les six sont en `A`. Corriger le chiffre dans l'annexe. |
| F4 appels de la retenue                   | Non mesurable : `track_functions = none`, `pg_stat_user_functions` vide                                                                                                                                                                                   | 0                            | Non mesuré              | À activer par le propriétaire si la preuve directe est voulue.                                                                          |
| F3 coût de l'import                       | Pas de comparaison avant/après possible. Relevé de référence à 12:35 UTC : `insert into "public"."auction_sales"` par `postgres`, 5 528 appels, 1 101 946 ms cumulés, moyenne 199,34 ms, max 5 340 ms, 56 452 lignes (statistiques depuis le 05/11 10:05) | écart < 5 % sur 1 000 appels | En attente              | Aucun import depuis R1, donc ce relevé vaut « avant ». Coût après R1 = (total2 − 1 101 946) / (appels2 − 5 528).                        |
| F5 transactions longues pendant un import | 3 relevés (12:34:51, 12:37:29, 12:37:39) : aucune transaction ouverte hors ma session                                                                                                                                                                     | à relever pendant un import  | Non mesuré              | Aucun import en cours. À refaire pendant un run.                                                                                        |
| Dérive de schéma                          | Workflow d'application des migrations du 11/11 à 11:43 UTC : étape « Detect production schema drift » en succès                                                                                                                                           | vert                         | Oui                     | Critère rempli au moment de la pose.                                                                                                    |
| Erreurs 42501 / `held_fields`             | 0 tâche ouverte de la file ne mentionne `held_fields`, 42501 ou « permission denied » ; le seul run fini depuis R1 n'a aucune erreur                                                                                                                      | aucune                       | Oui, partiel            | Les journaux de l'API et de Postgres ne me sont pas accessibles.                                                                        |

## 2. Imports depuis l'application (`auction_runs`)

| Source                                                                                    | Runs finis après 11:45 UTC      | Durée     | Médiane 7 j (réussis)                          | p95 7 j                                           | Écart                        |
| ----------------------------------------------------------------------------------------- | ------------------------------- | --------- | ---------------------------------------------- | ------------------------------------------------- | ---------------------------- |
| enrichment-queue                                                                          | 1, réussi (12:00:55 à 12:26:38) | 1 542,8 s | 1 721,3 s (143 runs)                           | 1 933,7 s                                         | −10 %, dans la plage normale |
| enrichment-queue                                                                          | 1 en cours depuis 12:30:56      |           |                                                |                                                   |                              |
| agrasc, avoventes, cessions_etat, encheres_immobilieres, info_encheres, licitor, notaires | **0**                           |           | 88 / 996 / 1 178 / 747 / 459 / 2 338 / 1 297 s | 104 / 1 046 / 1 299 / 838 / 592 / 2 629 / 1 549 s | Non jugeable                 |

- Le dernier import de source est Licitor, démarré à 09:30 et fini en échec à 10:09, donc avant R1. Aucun écart net à signaler, faute de run.
- D'après la cadence de la veille, Licitor, avoventes, notaires, cessions_etat et encheres_immobilieres devraient passer entre 13:00 et 17:30 UTC. Je n'ai pas vérifié le planificateur.
- Échecs sur 7 jours, tous antérieurs à R1 : licitor 7 (cause connue), notaires 2, cessions_etat 1, encheres_immobilieres 1.
- **Trois sources n'ont plus de run** : `vench` depuis le 29/10 15:15, `petites_affiches` depuis le 30/10 05:15, `encheres_publiques` aucun en 30 jours. Elles portent 113, 7 et 21 ventes à venir. Je n'ai trouvé aucune mention d'une mise en pause dans `docs/operations/`. Le critère « au moins un import complet de chaque source » ne peut pas être rempli tel qu'écrit.

## 3. Dimensionnement

Base : 1 419 ventes, dont 996 à venir. Le statut `active` n'existe pas en production, seul `upcoming` compte.

**M1, durée d'un lot de publication (7 jours).** Formule de l'annexe 09, filtrée sur `started_at` (indexé) au lieu de `finished_at`.

| Source                | Runs | Ventes dédoublonnées (médiane) | Publication par run (médiane) | Lot p50 | Lot p95 | Lot max |
| --------------------- | ---- | ------------------------------ | ----------------------------- | ------- | ------- | ------- |
| agrasc                | 12   | 10                             | 12,0 s                        | 12,0 s  | 15,7 s  | 16,6 s  |
| avoventes             | 13   | 214                            | 223,9 s                       | 24,9 s  | 27,2 s  | 27,8 s  |
| cessions_etat         | 14   | 230                            | 201,6 s                       | 20,2 s  | 22,9 s  | 23,0 s  |
| encheres_immobilieres | 14   | 122                            | 136,9 s                       | 26,8 s  | 32,1 s  | 32,9 s  |
| info_encheres         | 12   | 63                             | 86,5 s                        | 28,8 s  | 37,8 s  | 45,4 s  |
| licitor               | 16   | 502                            | 411,0 s                       | 19,8 s  | 25,0 s  | 26,9 s  |
| notaires              | 22   | 812                            | 164,4 s                       | 5,0 s   | 6,0 s   | 6,0 s   |

- Attendu par l'annexe 09 : « quelques secondes en général » (supposition). **Mesuré : 20 à 29 s par lot en médiane pour cinq sources sur sept.**
- C'est un majorant de la durée du verrou. `early_supabase_seconds` (`/home/user/immojudis/services/data-pipeline/src/main.py:730-745`) couvre la transaction (`/home/user/immojudis/services/data-pipeline/src/storage/supabase_client.py:513-534`) et l'écriture des observations qui suit.
- L'instruction d'insertion seule coûte 0,2 s en moyenne côté base. L'essentiel du temps serait donc des allers-retours pendant que la transaction reste ouverte ; c'est une déduction, seul F5 pendant un import le confirmera.
- La seconde publication de fin de run (`supabase_seconds`) a le même profil : 4,5 à 28 s par lot.
- Les phases de publication cumulées représentent environ 6 % du temps sur 7 jours (estimation par les médianes).
- Conséquence : un délai de 3 s côté décision d'administrateur donnera `sale_busy` pendant presque toute la durée d'un lot qui tient la vente. Le réessai automatique et la réduction du verrou (étape PD) deviennent nécessaires.

**Autres mesures de dimensionnement**

| Mesure                                                  | Résultat                                                                                                                                                                                 | Attendu  | Ce que cela change                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2 largeur du verrou par code postal                    | 759 codes distincts, 116 ventes sans code ; médiane 1 vente par code, p95 4, p99 8, max 21 (06400), puis 12, 11, 10 ; 34 codes à 5 ventes ou plus                                        | non fixé | Une vente partage son code avec 2 autres en moyenne : un lot de 25 verrouille de l'ordre de 25 à 75 lignes sur 1 419. Verrou étroit, le problème est sa durée. |
| M3 ventes à venir sans `source_factual_snapshot`        | 45 sur 996 (4,5 %) : encheres_publiques 21 sur 21, notaires 18 sur 211, petites_affiches 4 sur 7, avoventes 2 sur 106 ; 113 tous statuts                                                 | non fixé | Le chemin « rien sans instantané » touche surtout deux sources qui ne tournent plus.                                                                           |
| M4 pages Vench restreintes                              | 81 sur 113 ventes Vench à venir (72 %)                                                                                                                                                   | non fixé | La vague d'invalidation de G5 porte sur 81 ventes, mais ne se produira qu'à la reprise de Vench. Compté sur `primary_source = 'vench'` seulement.              |
| M5 clé `held_fields` dans `raw_payload`                 | 0 sur 1 419                                                                                                                                                                              | 0        | Conforme, aucune clé interne déjà versée.                                                                                                                      |
| M7 `surface_m2` différent de `app_surface_m2` (à venir) | 55 sur 996 (5,5 %) : 43 annonce remplie et application nulle, 8 annonce nulle et application remplie (le cas de l'essai), 4 deux valeurs différentes                                     | non fixé | Au plus 55 faux « l'annonce a changé » à la première pose, 8 à 12 dans la forme reproduite par l'essai.                                                        |
| M9 ventes à venir à 2 URL ou plus                       | 334 sur 996 (33,5 %) ; 435 tous statuts                                                                                                                                                  | non fixé | Un tiers du catalogue est exposé aux faux conflits entre sources.                                                                                              |
| M10 durée des runs par source                           | voir bloc 2 ; maximum 2 752 s (licitor)                                                                                                                                                  | non fixé | La fenêtre d'écho doit couvrir au moins 46 minutes par run.                                                                                                    |
| F10 multi-lots et terrains (à venir)                    | 33 multi-lots (3,3 %), 89 terrains (8,9 %), sur 996                                                                                                                                      | non fixé | Portée des refus des points 1 et 2 : environ 12 % des ventes à venir.                                                                                          |
| F9 fréquence des fusions                                | 391 fusions, toutes le 28/10/2026 ; aucune depuis                                                                                                                                        | non fixé | Opération ponctuelle, pas de flux hebdomadaire.                                                                                                                |
| F13 contrainte de `event`                               | `auction_sale_field_hold_events_event_check`, valeurs : `listing_changed_kept`, `listing_changed_released`, `projection_held`, `projection_released`, `projection_blocked`, `conflicted` | nom réel | Nom à reprendre tel quel en A2.                                                                                                                                |

**M6, observations existantes (`auction_fact_claims`).** 13 097 observations rattachées à une vente, comptage exact. Une seule version (`auction_fact_claims_v2`), un seul statut (`candidate`, 0 acceptée), 0 rattachée à un lot, aucune créée depuis R1 (dernière à 11:01).

| Champ                         | source_field | source_block | document_extraction | field_evidence | text_evidence | Total |
| ----------------------------- | ------------ | ------------ | ------------------- | -------------- | ------------- | ----- |
| sale.sale_date                | 3 103        | 111          |                     |                |               | 3 214 |
| sale.starting_price_eur       | 2 856        | 14           | 202                 |                |               | 3 072 |
| property.occupancy_status     | 1 284        | 2            |                     |                | 1 253         | 2 539 |
| property.surface_m2           | 2 011        | 26           | 37                  | 46             |               | 2 120 |
| property.land_surface_m2      | 968          | 51           | 195                 | 93             |               | 1 307 |
| property.habitable_surface_m2 | 506          |              | 11                  | 15             |               | 532   |
| property.carrez_surface_m2    | 271          |              | 25                  | 17             |               | 313   |

- Part des `source_field` de surface sur des ventes dont `surface_source = 'pdf'` : 237 sur 2 011 pour `surface_m2` (11,8 %), 425 sur 3 756 pour les quatre clés de surface (11,3 %).
- Aucune observation pour pièces, chambres ou type de bien : l'étape PD part de zéro sur ces champs.
- **Observations orphelines** : la clé étrangère `auction_sale_id` est en `ON DELETE SET NULL`. Les statistiques du planificateur donnent 63 % de lignes sans vente, soit environ 23 800 sur 37 700. C'est une estimation : le comptage exact demanderait un parcours séquentiel, que je n'ai pas lancé. À traiter dans la reprise de l'existant.

**F6 et F8, reprise de l'existant**

| Mesure                                         | Résultat                                | Attendu | Conforme                                  |
| ---------------------------------------------- | --------------------------------------- | ------- | ----------------------------------------- |
| publications de l'agent d'information          | 0                                       | 0       | Oui                                       |
| faits acceptés                                 | 0 (table des candidats vide)            | 0       | Oui                                       |
| observations du pont                           | 0 sur les 13 097 rattachées à une vente | 0       | Oui, les orphelines ne sont pas couvertes |
| surfaces marquées `information_agent_verified` | 0 sur 1 419                             | 0       | Oui                                       |
| F8 doublons du pont                            | 0 ligne (aucune observation du pont)    | 0       | Oui                                       |

Le point 13 se réduit donc à sa version S.

## 4. Second facteur des administrateurs (F12)

| Mesure                                        | Résultat                                                                                        | Attendu          | Conforme |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------- | -------- |
| Interrupteur `admin_mfa_required`             | `false`, jamais modifié depuis sa création le 10/10/2026 07:44                                  | `true` avant R2c | **Non**  |
| Administrateurs                               | 1                                                                                               |                  |          |
| Administrateurs avec un facteur vérifié       | 0                                                                                               | au moins 1       | **Non**  |
| Facteurs enregistrés, tous comptes            | 0                                                                                               |                  |          |
| La fonction en base lit-elle l'interrupteur ? | Oui : `app_private.current_user_is_admin` le lit et exige `aal2`, `public.is_admin` lui délègue |                  | Oui      |

Le second facteur n'est ni exigé ni même enrôlé. `set_admin_mfa_required(true)` refusera tant qu'aucun facteur n'est vérifié (commentaire de `/home/user/immojudis/supabase/migrations/20261010002000_admin_mfa_switch.sql`). Ordre obligé : enrôlement sur `/admin/securite`, puis interrupteur en base, puis variable `ADMIN_MFA_REQUIRED` côté application. Cette variable n'est pas lisible en SQL.

## 5. Rôle du pipeline et lecteurs des copies (F7, F11, M8, M11)

| Question                                                                                    | Mesurable en SQL                                 | Résultat                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rôle qui écrit les ventes                                                                   | Oui, `pg_stat_statements` depuis le 05/11 10:05  | `postgres` : 5 646 insertions sur `auction_sales` (3 formes), plus les mises à jour directes. Rôle sans `superuser` mais avec `bypassrls`.                                                                                                                                                      |
| Distinguer le pipeline des autres usages de `postgres`                                      | Partiellement                                    | Non dans `pg_stat_statements` : ma propre session est aussi `postgres`. Oui à l'instant t dans `pg_stat_activity` : pipeline via `Supavisor` (2 connexions inactives), ma session via `mgmt-api`. Une liste blanche par rôle (point 9) ne séparera pas le pipeline d'une intervention manuelle. |
| Écritures par l'API                                                                         | Oui                                              | `service_role` via PostgREST, en lecture pour l'essentiel ; aucune insertion sur `auction_sales` par ce canal sur la période.                                                                                                                                                                   |
| Propriétaire des fonctions                                                                  | Oui                                              | `project_sale_fields` et `hold_projected_sale_fields` : `postgres`, `SECURITY DEFINER`. Les deux gardes `refuse_*` : `postgres`, sans `SECURITY DEFINER`.                                                                                                                                       |
| Lecteurs de `properties`, `judicial_sales`, `auction_surfaces` par l'API, 7 jours, par rôle | **Non** (journaux PostgREST, hors de mes outils) | Non mesuré tel que demandé.                                                                                                                                                                                                                                                                     |
| Substitut SQL sur 6 jours                                                                   | Oui, sans éviction (`dealloc = 0`)               | Seules instructions citant ces tables : les insertions du pipeline (5 556 appels chacune, rôle `postgres`). Aucune requête PostgREST par aucun rôle. `seq_scan = 0` et `idx_scan` d'environ 56 800 par table, ce qui correspond aux insertions avec conflit.                                    |
| Dépendances statiques                                                                       | Oui                                              | 0 vue et 0 fonction de `public` ou `app_private` ne cite ces tables.                                                                                                                                                                                                                            |
| Droits                                                                                      | Oui                                              | `anon` : aucun. `authenticated` : `SELECT` avec une politique `has_analysis_access()`.                                                                                                                                                                                                          |

Aucun lecteur n'apparaît sur 6 jours, mais un abonné peut techniquement lire ces tables par l'API. Limites du substitut : fenêtre de 6 jours et non 7, et une instruction préparée sous un autre texte m'échapperait.

## 6. File des documents

| Mesure (ventes à venir)                 | Matin du 11/11 | 12:35 UTC                                                                                   | Évolution |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- | --------- |
| Tâches `pdf` en attente (`queued`)      | environ 143    | **181**, plus 1 en cours                                                                    | +38       |
| Tâches `pdf` en échec (`failed`)        | environ 64     | **71**, dont 9 à tentatives épuisées                                                        | +7        |
| Documents `download_status = 'unknown'` |                | **1 204 sur 2 762** (44 %), dont 132 sur des ventes à venir (10 % de leurs 1 317 documents) |           |

- La file ne se vide pas : 20 tâches en attente créées aujourd'hui, mais 112 datent des 05 et 06/11, et 13 seulement ont été touchées depuis 06:00. Mon comptage joint les tâches aux ventes par `source_url` ; si le relevé du matin utilisait une autre définition, l'écart est à relativiser.
- Causes des 71 échecs : 62 « PDF document checkpoint was not persisted », 5 « Document extraction incomplete », 2 violations de `auction_sales_occupancy_status_check` (10/11, cessions_etat), 2 erreurs de type Python (comparaison entre chaîne et nombre, encheres_immobilieres). Aucune n'est liée au registre.
- Les documents en statut inconnu sont surtout sur des ventes passées ou retirées (1 072 sur 1 204). Autres statuts : 1 420 `verified`, 138 `downloaded`.
- Autres files ouvertes sur ventes à venir : `source_detail` 618 en attente (la plus ancienne du 16/09), `display_description` 328, `fact_extraction` 251.

## Ce qui n'a pas pu être mesuré

| Mesure                                                | Raison                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| F3 coût avant/après, M10 après R1, point 2 par source | Aucun import de source depuis 11:45 UTC. Relevé de référence fourni.                                                                         |
| F4 appels de la fonction de retenue                   | `track_functions = none`.                                                                                                                    |
| F5 / M11 transactions longues pendant un import       | Aucun import en cours pendant mes trois relevés.                                                                                             |
| F11 / M8 lecteurs par l'API sur 7 jours               | Journaux PostgREST hors de mes outils. Substitut SQL fourni.                                                                                 |
| Erreurs 42501 dans les journaux                       | Journaux Postgres et API non accessibles. Substitut : erreurs des runs et de la file.                                                        |
| F14, F15 (`explain analyze`)                          | `EXPLAIN ANALYZE` interdit par mes règles de charge, fonction hors liste blanche ; ces mesures sont de toute façon « avant et après C1/A6 ». |
| Variable `ADMIN_MFA_REQUIRED`                         | Réglage d'hébergement, pas en base.                                                                                                          |
| Nombre exact d'observations orphelines                | Demande un parcours séquentiel de `auction_fact_claims` ; estimation fournie.                                                                |
| Ventes où Vench est source secondaire (M4)            | Non comptées.                                                                                                                                |
| Pause de vench, petites_affiches, encheres_publiques  | Voulue ou non : non établi.                                                                                                                  |

Requêtes refusées par le garde-fou, non contournées : `pg_table_size`, `pg_get_expr`, `statement_timestamp`, et une requête dont un alias s'appelait `vacuum`. Remplacées par `pg_relation_size`, la vue `pg_policies`, la durée lue dans `pg_stat_statements`.

Adaptations du SQL des annexes :

- F1, F6, F10, M3, M5, M7, M9 : par lots de 500 sur la clé primaire, le plan d'origine étant un parcours séquentiel de `auction_sales`.
- M1 : filtre sur `started_at`.
- M6 : par plages de `auction_sale_id` sur l'index.
- F5 : `datname = 'postgres'` au lieu de `current_database()`.
- F7 : jointure sur `pg_roles` au lieu de `pg_get_userbyid`.
- `pg_stat_statements` est dans le schéma `extensions`.

## Les trois constats qui comptent le plus

1. **R1 est inerte, mais pas encore observé sous charge.** Tout est à zéro et la dérive de schéma est verte, sur 27 écritures seulement et aucun import. Refaire F1, F3 et F5 après un passage de chaque source ; le relevé de référence est pris. Le critère « chaque source » est à réécrire, puisque trois sources ne tournent plus depuis 12 jours ou plus.
2. **Un lot de publication dure 20 à 29 s, pas « quelques secondes ».** Le verrou est étroit mais long. Le délai de 3 s côté administrateur se heurtera à `sale_busy` pendant les imports. Il faut le réessai automatique, et sans doute avancer la réduction du verrou prévue en PD, après confirmation par F5 pendant un import.
3. **Le second facteur n'est ni exigé ni enrôlé** (1 administrateur, 0 facteur, interrupteur jamais activé). C'est le seul prérequis de R2c franchement non conforme, et il dépend d'une action humaine.

À suivre hors registre : la file `pdf` grossit (181 en attente, 71 en échec), et environ 63 % des observations seraient orphelines de leur vente.

Fichiers utiles :

- `/home/user/immojudis/docs/equipe/annexes/2026-11-11-registre-des-pieces/08-bascule-base-de-donnees.md` (section F)
- `/home/user/immojudis/docs/equipe/annexes/2026-11-11-registre-des-pieces/09-bascule-pipeline.md` (sections 7 et 10)
- `/home/user/immojudis/services/data-pipeline/src/main.py`
- `/home/user/immojudis/services/data-pipeline/src/storage/supabase_client.py`
- `/home/user/immojudis/supabase/migrations/20261116100000_fact_registry_tables.sql`
- `/home/user/immojudis/supabase/migrations/20261010002000_admin_mfa_switch.sql`
- `/home/user/immojudis/.claude/hooks/supabase-lecture-seule.mjs`
