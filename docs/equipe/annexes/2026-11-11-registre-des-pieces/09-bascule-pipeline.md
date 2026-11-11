<!-- Rapport du spécialiste `data-pipeline`, rendu le 11/11/2026 dans la mission « registre des pièces », après la mise en production du lot R1. Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Lot R2 du registre des pièces : spécification côté pipeline Python

## 0. Cadre, vérifications, légende

- **Légende.** [L] lu dans le code. [E] exécuté dans un essai hors dépôt. [S] supposé, non mesuré.
- **Dépôt.** Lu à `2130424f`. Pendant ma session, un autre agent a ajouté le commit `749278ad` (annexe 08, spécification R2 côté base). `git diff --stat 2130424f 749278ad -- services/data-pipeline supabase/migrations` est vide : l'analyse du code vaut pour les deux. J'ai lu l'annexe 08 et je signale trois désaccords (section 11).
- **Rien n'est modifié dans le dépôt** (`git status` vide), aucun workflow lancé, aucune requête en production.
- **Vérifications** sur une copie `git archive` du commit : `ruff check .` sans erreur ; `python -m pytest` : 6 374 réussis, 162 ignorés, 15 désélectionnés, en 217 s. Réserve : j'ai utilisé un environnement Python 3.12.3 déjà présent dans le scratchpad, que je n'ai pas installé moi-même depuis `requirements-dev.lock`.
- **Base jetable.** PostgreSQL 16 local, 468 migrations rejouées, 16 en échec. Toutes les 16 tiennent à l'absence de `pg_cron`, et aucune ne nomme le registre ni les tables citées ici. Les résultats [E] sur le déclencheur et la projection sont donc valables. Écart avec la consigne : le répertoire de données était sous `/tmp/r2pipe-pg-*` (PostgreSQL refuse de tourner en root) ; il est arrêté et supprimé.
- **Chemins courts.** `dp/` désigne `/home/user/immojudis/services/data-pipeline/`. Chemins absolus en section 13.

## 1. Décisions en une page

| Sujet                                              | Décision                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Écho                                               | Les deux côtés. Pipeline : une garde d'écho au point d'écriture de la collecte, sous le verrou existant. Base : la mémoire d'écho de l'annexe 08 comme filet.                               |
| Lecture de `held_fields`                           | Non. Un invariant l'interdit déjà (`scripts/check-security-invariants-fact-registry.mjs:698-728`). Seule lecture admise : la RPC `get_sale_field_baselines` de l'annexe 08, pour la fusion. |
| Valeur en mémoire                                  | La collecte garde la valeur affichée pour ses jugements (admission, complétude, score). Désaccord avec l'exigence P1 de l'annexe 08.                                                        |
| Observations                                       | Préalable de R2 : plus aucune observation `source_listing` tirée d'une colonne relue en base.                                                                                               |
| `properties`, `judicial_sales`, `auction_surfaces` | Cesser d'y écrire les colonnes du registre.                                                                                                                                                 |
| `recompute_scoring`                                | Liste de colonnes explicite, plus de `select=*`.                                                                                                                                            |
| Fusion                                             | Valeurs d'annonce substituées avant fusion, plus une garde de révision sur le balayage.                                                                                                     |

## 2. Point 1, l'écho de la collecte

**Priorité : Critique. Effort : M.**

### 2.1 Constat confirmé [E]

J'ai rejoué l'instruction d'écriture de la collecte (`insert … on conflict (source_url) do update set col = excluded.col`, `dp/src/storage/supabase_client.py:266-285`) avec un instantané lu avant une décision.

| Scénario                                            | Résultat                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Retrait pendant l'import                         | La valeur retirée revient : 3 pièces, 54 m², `surface_source = fact_registry_lawyer_email`. `held_fields` est nulle, aucun évènement, et la simulation de projection rend `changed = false`. Le contrôle quotidien de R1 ne le voit pas. |
| B. Remplacement 3 puis 4, réglage `keep_and_review` | Évènement `listing_changed_kept` avec `incoming = 3`. La valeur d'annonce mémorisée passe de 2 à 3. Après retrait des deux pièces, la fiche affiche 3 alors que l'annonce dit 2.                                                         |
| C. Même cas, réglage `listing_wins_and_review`      | L'écho libère le champ : la fiche affiche 3. La reprojection rend `pass_through`, donc la décision de l'administrateur est défaite durablement.                                                                                          |

Le déclencheur ne peut pas trancher seul : en A il n'est même pas appelé (clause `WHEN` fausse), en B et C il ne distingue pas un écho d'une annonce.

### 2.2 Les chemins qui recopient de la base vers la base

| N°  | Chemin                                                                                                                                                                                 | Colonnes                                                                                                          | Délai entre lecture et écriture                                                                                                                                                                                           | Garde actuelle                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Annonce inchangée ou fiche en échec : `_backfill_raw_sale_from_known_detail` (`dp/src/main.py:1316-1322`, liste 145-193), appelée aux lignes 623 et 1516                               | Les dix colonnes demandées, plus `habitable_surface_m2`, `carrez_surface_m2`, `surface_scope`, `surface_evidence` | De quelques secondes (publication progressive, relecture `main.py:1178-1213`) à 35 minutes, 50 pour Licitor (`dp/src/autonomous_runner.py:699`). Les étapes finales (`main.py:407-426`) réutilisent le même dictionnaire. | Aucune                                                      |
| 2   | Fiche relue, valeur établie par un document : `dp/src/known_document_backfill.py:34-61` (surface, terrain) et `159-181` (occupation)                                                   | Groupe surface, terrain, occupation                                                                               | Idem                                                                                                                                                                                                                      | Aucune                                                      |
| 3   | Vench, page restreinte ou pauvre : `dp/src/sources/vench.py:156-197`, dans le collecteur                                                                                               | Surface, terrain, pièces, chambres, occupation                                                                    | Idem                                                                                                                                                                                                                      | Aucune                                                      |
| 4   | Fusion avec la ligne verrouillée : `merge_revision` (`dp/src/publication_identity.py:286-379`)                                                                                         | Toutes                                                                                                            | Nul pour la ligne lue sous verrou, mais l'entrant porte les échos 1 à 3                                                                                                                                                   | Verrou seul                                                 |
| 5   | Enrichissements qui relisent la ligne entière : `dp/src/queued_runner.py:605` puis `820`, `dp/src/document_backlog.py:570-632`, `dp/src/source_detail.py:121-173`, `main.py:1153-1161` | Toutes                                                                                                            | Minutes                                                                                                                                                                                                                   | `_guard_enrichment_revision` (`supabase_client.py:893-905`) |
| 6   | `dp/src/recompute_scoring.py:598`, `614`, `655`                                                                                                                                        | Toutes                                                                                                            | Minutes à heures                                                                                                                                                                                                          | Garde du chemin 5                                           |
| 7   | Balayage des doublons : `supabase_client.py:2797-2884`, écriture ligne 2865                                                                                                            | Toutes                                                                                                            | Secondes                                                                                                                                                                                                                  | Aucune, ni verrou                                           |
| 8   | Mémoires dans `raw_payload` : `baseline` de `pdf_fact_provenance` (`dp/src/pdf_fact_scope.py:262-276`, restaurée en 467-474), et `source_factual_snapshot` pollué par le chemin 3      | Surface, terrain, occupation, visites                                                                             | Sans limite                                                                                                                                                                                                               | Aucune                                                      |
| 9   | Colonne dérivée : sur un terrain, `app_surface_m2 = land_surface_m2` (`dp/src/asset_normalization_helpers.py:83-85`)                                                                   | `app_surface_m2`, `app_surface_kind`                                                                              | Jusqu'à l'import suivant                                                                                                                                                                                                  | Aucune                                                      |

Précisions :

- **Chemin 2.** La ligne 177 lit `known.get("occupancy_status") or trace.get("value")` : la colonne, donc la valeur tenue, passe avant la trace du document.
- **Chemin 4.** Entre deux sources, un entrant périmé remplit une colonne que la projection vient de vider. Un désaccord est inscrit dans `source_conflicts` avec la valeur tenue attribuée à l'URL de la fiche (`dp/src/dedupe.py:249-256`).
- **Chemin 5.** La garde suffit, parce que la projection change `updated_at` (`supabase/migrations/20261116100500_field_projection_and_hold.sql:963`).
- **Chemin 6.** Second écho pour les visites : `STORAGE_FALLBACK_SOURCE_FIELDS` (lignes 51 et 611-613) reprend `visit_dates` depuis `raw_payload` quand la colonne est vide, et la ligne 655 y a versé la colonne au recalcul précédent. À corriger avant de lever le verrou des visites.
- **Chemin 8.** La `baseline` ne joue que pour une vente sans `source_factual_snapshot` (mesure M3).
- **Chemin 9 [E].** Terrain tenu à 800 : la collecte écrit `app_surface_m2 = 800`. Après retrait, 800 reste affiché comme surface principale jusqu'au passage suivant, qui le remet à nul.

### 2.3 Correction côté pipeline : la garde d'écho

Règle : **un groupe que la collecte n'a fait que relire en base n'est pas réécrit si la base a bougé depuis.**

- **Nouveau module** `dp/src/base_reads.py`, environ 90 lignes, qui ne nomme aucun objet du registre.
  - `note(row)` mémorise, par identifiant de ligne, les valeurs lues en base pendant le run. Appels : dans `fetch_known_sale_details` (`supabase_client.py`, vers la ligne 3100) et pour chaque ligne lue sous verrou dans `resolve_publication_identities` (`publication_identity.py:526-531`).
  - `suppress_echo(existing, incoming)` est appelée en tête de `merge_revision`, sur une copie de l'entrant, pour toutes les branches.
- **Règle par groupe** (surface à cinq colonnes, terrain, pièces, occupation, visites). Le groupe de l'entrant est remplacé par celui de la ligne verrouillée si deux conditions sont vraies :
  1. la base a bougé : le groupe de la ligne verrouillée n'est aucun de ceux lus pendant le run ;
  2. l'entrant n'apporte rien : chaque colonne de valeur est nulle ou égale à une valeur lue, et l'une au moins n'est pas nulle.
- **Surface.** La comparaison porte sur `surface_m2` et `app_surface_m2`, contre toute valeur de la famille lue (`surface_m2`, `app_surface_m2`, habitable, Carrez, terrain). Les trois libellés suivent le groupe.
- **Jamais de remplacement d'une valeur nulle sortante** : un garde-fou de normalisation doit pouvoir vider une valeur.
- **Compteur** `base_echo_suppressed` dans les `timings` du run.

Un prototype hors dépôt [E] donne le résultat attendu sur A, B et C. Deux enseignements :

- Comparer les cinq colonnes en bloc échoue : la collecte recalcule `app_surface_kind` (`built` au lieu du libellé du registre), donc l'écho n'est pas reconnu.
- Sans la condition 1, la garde bloquerait la propagation d'un changement de règle de normalisation. Avec elle, quand la base n'a pas bougé, l'écriture est identique à celle d'aujourd'hui.

Solutions écartées :

- **Cesser de recopier** : ces colonnes portent les résultats des documents et du modèle pour une annonce non relue.
- **Garde `updated_at` sur la collecte** : on ne peut pas écarter une écriture de collecte (prix, date, `last_seen_at`).

### 2.4 Pourquoi les deux côtés

- **Pipeline** : lui seul sait qu'une valeur sortante n'est qu'une relecture. La garde est exacte et sa fenêtre se compte en minutes.
- **Base** (mémoire d'écho, annexe 08, point 3 a et b) : elle couvre les chemins que Python oubliera. Elle repose sur une égalité de valeurs pendant une durée, donc elle retiendrait à tort une annonce qui publie réellement la valeur retirée. La garde réduit ce cas : `echo_suppressed` doit rester à zéro et devient l'indicateur d'un chemin oublié.
- **Durée `until`** (question posée par l'annexe 08) : côté collecte, 7 jours suffisent. Une vente est réécrite à chaque passage de sa source, et l'écho ne vit que le temps d'un run commencé avant la décision. Garder « vie de la vente » après une opposition.

## 3. Point 2, les autres écrivains

**Priorité : Important. Effort : M au total.**

| Écrivain                                                                                                                                                                     | Quand un champ est tenu                                                                                                                                                                                                                         | À changer                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dp/src/source_extraction_backfill.py`                                                                                                                                       | [E] Le plan d'une ligne tenue contient `app_surface_kind` seul, et le contiendra à chaque nouveau plan. La base retient la valeur (essai D2) et rend 200 ; les lignes 794-797 comptent `applied`.                                               | Exclure du plan les groupes rendus par `get_sale_field_baselines`. Comparer la ligne rendue aux valeurs envoyées et compter `retained`. Ajouter un `select=` explicite à la requête (`Prefer: return=representation` rend aujourd'hui toute la ligne). S.                                                                                  |
| `dp/src/recompute_scoring.py`                                                                                                                                                | [E] `raw_payload.held_fields` est écrit avec ses identifiants de pièce et de décision, ainsi que `id`, `updated_at` et `premium_readiness_override`. Les colonnes tenues entrent dans la normalisation. L'écriture est gardée par `updated_at`. | Remplacer `select=*` par `DATA_REFRESH_SALE_SELECT` (`dp/src/storage/known_sale_projection.py:230-232`). Après un changement de parseur, lancer le recalcul par tranches : il émet un évènement par champ tenu dont la relecture diffère (alerte `events_burst` à 50 par 24 heures). S.                                                    |
| PATCH de complétude (`recompute_scoring.py:211-240`)                                                                                                                         | Colonnes `premium_readiness_*` seules.                                                                                                                                                                                                          | Rien.                                                                                                                                                                                                                                                                                                                                      |
| `dp/scripts/backfill_fact_claims.py`                                                                                                                                         | N'écrit que des observations, mais lit `raw_payload`, qui contient les colonnes recopiées : même défaut que la section 6.                                                                                                                       | Corrigé par G2, le code est partagé.                                                                                                                                                                                                                                                                                                       |
| Autres fichiers de `dp/scripts/`                                                                                                                                             | [L, par recherche] Aucun n'écrit `auction_sales`.                                                                                                                                                                                               | Rien.                                                                                                                                                                                                                                                                                                                                      |
| Balayage des doublons et `delete_secondary_sales_in_supabase`                                                                                                                | La valeur tenue d'une ligne absorbée entre dans la ligne conservée comme une valeur ordinaire. L'annexe 08 (point 6) le rattrape par des indices à la reprojection.                                                                             | Substituer les valeurs d'annonce (RPC) dans les lignes candidates avant `merge_duplicate_sales`. Ajouter verrou et comparaison de `updated_at` avant l'écriture de la ligne 2865. M. Exposition faible : le balayage est coupé par défaut, et le nettoyage en cours de run ne tourne que pour `--source all` sans limite (`main.py:1023`). |
| `_shared_listing_primary` (`publication_identity.py:455-472`)                                                                                                                | Même contamination entre deux lignes Vench et Petites Affiches.                                                                                                                                                                                 | Risque résiduel, cas étroit.                                                                                                                                                                                                                                                                                                               |
| Repli REST `_upsert_with_rest` (`supabase_client.py:3245`)                                                                                                                   | Retenu par la base, sans garde d'écho possible.                                                                                                                                                                                                 | Rien : hors production (`.github/workflows/data-pipeline.yml:295` exige `SUPABASE_DB_URL`).                                                                                                                                                                                                                                                |
| `touch_last_seen_*` (3133-3189), `dp/src/probable_duplicates.py:127`                                                                                                         | `last_seen_at` ou `quality_flags` seuls.                                                                                                                                                                                                        | Rien.                                                                                                                                                                                                                                                                                                                                      |
| SQL direct : `dp/src/storage/fact_claim_rows.py:161-173`, `hold_identity` (`publication_identity.py:277`), `dp/src/address_positions.py:116-135`, `autonomous_runner.py:492` | Aucun ne touche les neuf colonnes. `fact_claim_rows` n'insère que des candidats `source_listing` ou `source_document`.                                                                                                                          | Test statique : natures d'observation limitées à ces deux valeurs.                                                                                                                                                                                                                                                                         |

Remarque : le README (`dp/README.md:119`) documente une connexion directe sous `postgres.<projet>`. Une garde par rôle ne distingue donc pas le pipeline de la projection. C'est la limite déjà écrite au point 9 de l'annexe 08 ; côté Python, la protection reste l'invariant de code.

## 4. Point 3, `properties`, `judicial_sales` et `auction_surfaces`

**Priorité : Important. Effort : S.**

- **Qui écrit [L].** La collecte, dans la transaction de publication : `supabase_client.py:3693-3712` et `3715-3721`. `auction_surfaces` reçoit les mêmes colonnes (`dp/src/asset_normalization.py:418-435`) ; la question ne la citait pas. `auction_features` n'en porte aucune.
- **Qui lit [E].** Personne dans `src/`. Sur la base rejouée : aucune vue, vue matérialisée, fonction ni déclencheur ne les référence. Les quatre tables restent lisibles par `authenticated` sous `has_analysis_access()`, donc par l'API.
- **Décision : cesser d'y écrire les colonnes du registre** (nul, ou liste vide pour `judicial_sales.visit_dates`).
  - Les aligner demande une seconde retenue pour des copies sans lecteur.
  - Les laisser, même prises dans la ligne rendue par l'écriture (exigence P3 de l'annexe 08), garde une copie figée entre deux imports. Après un retrait ou une opposition, la valeur resterait lisible par l'API jusqu'au passage suivant.
- **Préalable.** Mesure M8 : aucun lecteur par l'API.
- **Suite, hors R2.** Fermer la lecture, puis supprimer ces tables.

## 5. Point 4, ce que la collecte doit savoir d'un champ tenu

**Priorité : Important. Effort : S à M.**

**Décision.** Elle ne lit pas `held_fields` ; elle doit seulement tolérer que la base rende autre chose que ce qu'elle a écrit. `select to_jsonb(s)` (`publication_identity.py:526`) est à remplacer par une liste de colonnes explicite, pour que la colonne ne quitte plus la base.

Endroits qui relisent ou comparent :

| Endroit                                                  | Effet avec un champ tenu                                                                                                                                                                                                       | Action                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `_guard_enrichment_revision`                             | Correct : toute projection écarte l'enrichissement en cours.                                                                                                                                                                   | Voir ligne suivante.                                                                                                                   |
| `queued_runner.py:820`                                   | [L] La valeur de retour de l'écriture n'est pas lue. [S] Je n'ai pas tracé le sort du travail quand l'écriture est écartée. Avec la file de validation de R3, chaque clic écartera un enrichissement en vol.                   | Test, puis remise en file si l'écriture est écartée.                                                                                   |
| `document_backlog.py:574` et `632-633` (`new_facts`)     | Un fait lu dans un document puis retenu compte pour zéro ; une projection intercalée compte comme un fait du document.                                                                                                         | Statistique à documenter.                                                                                                              |
| `pdf_fact_scope.py:461-466`                              | Une colonne différente de la trace est tenue pour une correction manuelle et préservée.                                                                                                                                        | Rien, le comportement est bon.                                                                                                         |
| Détection de changement (`dp/src/freshness.py:118-158`)  | Insensible aux pièces, car l'empreinte vient de `source_factual_snapshot`. Exception Vench (chemin 3) : poser ou retirer une pièce change l'empreinte, ce qui invalide l'analyse et relance modèle et lecture des pièces.      | G5 : les champs repris de la base n'entrent ni dans l'instantané ni dans l'empreinte.                                                  |
| `_sales_changed_since_publication` (`main.py:1754-1773`) | Empreintes en mémoire, aucune relecture.                                                                                                                                                                                       | Rien.                                                                                                                                  |
| Drapeaux dérivés [E]                                     | Une surface tenue sur un appartement sans surface d'annonce reçoit `surface_type_unverified` et `app_surface_kind = built`.                                                                                                    | Côté application.                                                                                                                      |
| `source_conflicts`                                       | Sur une vente à plusieurs sources, la relecture d'une source secondaire inscrit un faux désaccord entre sources (valeur tenue contre annonce). Il est lu par l'affichage de fiabilité (`src/lib/fact-reliability.ts:639-655`). | Côté application : ignorer conflits et réserves du pipeline pour un champ tenu.                                                        |
| Colonne dérivée du terrain (chemin 9)                    | Valeur retirée encore affichée jusqu'à l'import suivant.                                                                                                                                                                       | À trancher avec le spécialiste : la projection du terrain gouverne aussi `app_surface_m2`, ou elle met un travail de recalcul en file. |

## 6. Point 5, les observations émises par la collecte

**Priorité : Critique pour le préalable. Effort : S à M.**

**Complètes ? Non [L].** `_FIELD_SPECS` (`dp/src/fact_claims.py:29-109`) couvre la date, la mise à prix, trois surfaces, le terrain et l'occupation. Il n'y a rien pour le nombre de pièces, les chambres ni les visites. Les observations de document n'existent que pour les surfaces, le terrain, le prix et la date (lignes 318-361), et l'occupation n'a aucune extraction de document (ligne 325).

**À jour ? Non [E].** L'observation la plus fiable (0,92) lit la clé de premier niveau du `raw_payload` :

```python
if _has_value(payload.get(field)):
    provenances.append(("source_listing", {"kind": "source_field", ...}, 0.92, payload.get(field), None))
```

Or `raw_payload` est le dictionnaire brut entier, colonnes recopiées comprises (`dp/src/normalize.py:1266-1270`). Essai : une annonce Licitor muette, sur une vente qui tient 54 m², 800 m² de terrain et « loué », émet trois observations `source_listing` de ces valeurs, attribuées à l'URL Licitor. Même résultat par `recompute_scoring`.

Conséquence : la table est immuable et sans purge (`docs/data-retention-matrix.md:91`). Après un retrait ou une opposition, la valeur de l'avocat y reste, attribuée à l'annonce, et R3 ou R4 pourraient la reproposer. Le défaut existe déjà pour les valeurs lues dans les documents ; [S] une part des 10 839 candidats est donc mal étiquetée.

**Travail préalable en R2 (G2) :**

- `source_field` ne lit plus que `raw_payload.source_factual_snapshot`. Cet instantané est construit avant les reprises de la base (`main.py:1268-1271`) et conservé tel quel pour une annonce inchangée. Sans instantané, pas d'observation.
- Passer `FACT_CLAIMS_VERSION` à `auction_fact_claims_v3`, pour que R3 puisse écarter les lignes v2.
- G5 pour Vench : sans lui, l'instantané porte la valeur relue.

**Besoins de R3, hors R2 :**

- Observations `source_document` pour les pièces, les chambres et l'occupation, depuis `pdf_rooms_candidates`, `pdf_bedrooms_candidates`, `pdf_occupancy_candidates` et la lecture des documents, avec l'URL du document présente dans le manifeste, son empreinte, la page et l'extrait.
- Le lot (colonne `lot_id`, jamais remplie par le pipeline).
- Un moyen de dire quelle observation est courante : l'identifiant change à chaque valeur ou extrait, et rien ne marque les anciennes.
- Une règle sur les extraits d'occupation. Dans mon essai, la citation contenait le nom et le téléphone fictifs d'un occupant, et `redact_storage_row` ne les retirait pas non plus du texte de la fiche. Je n'ai pas étudié les règles de ce filtre.
- [S] L'extrait `text_evidence` peut venir d'un texte de document ajouté à `raw_text`.

## 7. Point 6, coût et verrous

**Priorité : Important. Effort : S pour les mesures, M pour l'option.**

**Structure [L].** Une transaction par lot de 25 ventes au plus (`supabase_client.py:503-508`), avec `lock_timeout` 15 s et `statement_timeout` 120 s (515-516). Elle prend :

- un verrou consultatif commun à toutes les publications (517) ;
- un verrou `for no key update` sur toutes les lignes candidates : mêmes URL, même empreinte, alias, et **même code postal** qu'une des 25 ventes (`publication_identity.py:435-451`) ;
- puis lecture des lignes entières, fusion, écriture des ventes, observations, copies, tables d'actifs (six suppressions et des insertions, dont une lecture des textes de documents en 3747), travaux et décisions.

**Durée typique.** Non mesurée dans le dépôt. Deux repères : 0,053 s par lot sur un banc synthétique (`docs/audits/collecte-repasse-correctifs-2026-09-11.md:20`), et un lot de recalcul qui a attendu plus de 15 s le 03/11 (`docs/audits/2026-11-04-post-mortem-vidage-pieces.md:46`). [S] Quelques secondes en général, parfois plus de 15.

**Conséquence pour une décision d'administrateur :**

- Elle attend si la vente est dans le lot en cours, ou si elle partage un code postal avec l'une de ses ventes, pour la durée restante de ce lot et non de l'import.
- Avec les 3 secondes de l'annexe 08, l'administrateur verra parfois `sale_busy`. L'interface doit réessayer seule.
- Dans l'autre sens, la collecte attend la décision quelques millisecondes.
- Le déclencheur de retenue ne coûte que sur les lignes tenues.

**Option, à décider après mesure.** Ne verrouiller que les lignes réellement rapprochées et lire les voisines de code postal sans verrou. Les publications sont déjà sérialisées par le verrou consultatif ; le verrou large ne protège que contre les écrivains hors pipeline.

## 8. Point 7, les tests

**Priorité : Important. Effort : M.**

**Python, avec doublures :**

- `dp/tests/test_base_echo_guard.py` (nouveau), table de vérité de la garde : retrait, remplacement, première pose, régime permanent tenu sans remplacement, changement de règle de nature qui passe, valeur nulle sortante non remplacée, vraie nouvelle valeur non remplacée, surface dérivée de l'habitable, terrain, visites, ligne jamais lue, deux lectures successives, égalité entre `Decimal` et flottant.
- `test_publication_identity.py` : `merge_revision` sur même source avec instantané périmé ; branche entre sources (un entrant périmé ne remplit pas une colonne libérée et n'inscrit aucun `source_conflicts`) ; lignes verrouillées notées.
- `test_run_pipeline_stages.py` : lecture, projection simulée, publication finale, compteur présent.
- `test_fact_claims.py` et `test_backfill_fact_claims.py` : aucune observation depuis une colonne relue ; observation depuis l'instantané ; rien sans instantané ; version v3 ; ligne de recalcul ; Vench restreint.
- `test_recompute_scoring.py` : liste explicite ; aucune clé hors modèle dans `raw_payload`.
- `test_source_extraction_backfill.py` : PATCH partiel dont la réponse diffère (compteur `retained`) ; groupes tenus exclus du plan ; `select=` présent.
- `test_dedupe_sweep.py` : substitution des valeurs d'annonce ; ligne absorbée tenue ; ligne changée depuis la lecture, donc groupe sauté.
- `test_schema_contract.py` : les copies ne portent plus les colonnes du registre.
- `test_queued_runner.py` : écriture écartée, travail remis en file.

**Contre une vraie base** (schéma complet, comme la suite pgTAP). Le service PostgreSQL de `.github/workflows/ci.yml:194-204` est vide : il faut y charger les migrations du registre sur des tables minimales, ou exécuter ces tests dans la base jetable complète.

- L'écriture réelle `_transaction_write` sur une ligne tenue : valeur tenue, valeur d'annonce, valeur nouvelle, valeur nulle. Aucune erreur, évènements attendus.
- Les scénarios A, B et C de bout en bout avec `upsert_sales_to_supabase` et une seconde connexion pour la décision.
- Deux sessions : lot de publication contre la RPC à 3 secondes, puis l'inverse.
- PATCH partiels, déjà rejoués à la main [E] : `bedrooms_count = 5` seul sur 3 pièces tenues (refusé sans erreur, un évènement), `app_surface_kind` seul, valeurs nulles.
- La garde `updated_at` face à une projection.
- La fusion d'une ligne absorbée tenue, avec le test 888 de l'annexe 08.
- `verify_publication` sur une vente tenue : aucun évènement après annulation.
- Le coût d'un lot de 25 avec 0, 1 et 25 lignes tenues.

## 9. Découpage en étapes livrables

| Étape | Contenu                                                                                                                                                                   | Comportement                                                                                                                                                                                                                 | Quand                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| PA    | G3 (liste explicite dans `recompute_scoring` et `publication_identity`), G1 (garde d'écho), G2 (observations et version v3), G5 (Vench), tests                            | Fiches inchangées tant que la base ne bouge pas pendant un import. G2 change seulement une table que rien ne lit. G5 change une fois l'empreinte des pages Vench restreintes : une vague d'invalidation à dimensionner (M4). | Avant le sous-lot R2a de l'annexe 08 |
| PB    | Copies sans colonnes du registre ; fusion (valeurs d'annonce et garde de révision) ; `source_extraction_backfill`                                                         | Aucun effet visible. Dépend de la RPC `get_sale_field_baselines` (A7) et de M8.                                                                                                                                              | Avant R2b                            |
| PC    | Rien à déployer le jour de la bascule                                                                                                                                     | Ordre imposé : PA et PB en production depuis au moins un passage complet de chaque source, `base_echo_suppressed` et contrôle quotidien à zéro, puis C1.                                                                     | Avec R2c                             |
| PD    | Observations de documents pour pièces, chambres et occupation ; remise en file après écriture écartée ; recalcul après projection ; réduction du verrou si M1 le justifie |                                                                                                                                                                                                                              | Avant R3                             |

## 10. Mesures à faire en production, en lecture seule

- **M1, durée d'un lot de publication.** `select source, percentile_cont(0.5) within group (order by d), percentile_cont(0.95) within group (order by d) from (select source, (summary->'timings'->>'early_supabase_seconds')::numeric / greatest(1, ceil((summary->>'deduplicated')::numeric / 25)) d from public.auction_runs where finished_at > now() - interval '7 days' and summary->'timings' ? 'early_supabase_seconds') t group by 1;`
- **M2, largeur du verrou.** `select postal_code, count(*) from public.auction_sales group by 1 order by 2 desc limit 20;`
- **M3, ventes sans instantané de source** (chemin 8). `select count(*) from public.auction_sales where status in ('active','upcoming') and not (raw_payload ? 'source_factual_snapshot');`
- **M4, pages Vench restreintes** (chemin 3 et vague de G5). Compter les ventes Vench à venir dont `raw_payload->>'source_detail_status' = 'restricted'`.
- **M5, clé interne déjà versée.** `select count(*) from public.auction_sales where raw_payload ? 'held_fields';`
- **M6, observations existantes.** Par `field_key`, `extractor_version` et `evidence_locator->>'kind'`. Puis la part des `source_field` de surface sur des ventes dont `surface_source = 'pdf'`.
- **M7, faux « l'annonce a changé » à la première pose.** Compter les ventes à venir où `surface_m2 is distinct from app_surface_m2`. Essai [E] : une vente dont `surface_m2` était nulle et `app_surface_m2 = 50` reçoit un évènement `listing_changed_kept` dès le premier import après la pose.
- **M8, lecteurs des copies par l'API.** Mesure F.11 de l'annexe 08, étendue à `auction_surfaces`.
- **M9, exposition aux faux conflits.** Compter les ventes à venir décrites par deux URL ou plus (`jsonb_array_length(source_urls) >= 2`).
- **M10, fenêtre d'écho.** Durée des runs par source sur 7 jours (`finished_at - started_at`).
- **M11.** Mesures F.5 (transactions longues pendant un import) et F.7 (rôle de connexion) de l'annexe 08.

## 11. Trois désaccords avec l'annexe 08, à arbitrer

1. **P1, « remplacer les colonnes tenues par la valeur d'annonce dans toutes les entrées ».** Je le retiens pour la fusion seulement. Appliqué aux détails connus et au recalcul, il fait juger la vente sur la valeur d'annonce. Essai [E] sur une annonce muette qu'une pièce complète (surface, pièces, occupation) :

   | Hydratation                   | Score de complétude | Champs manquants             | Sans mise à prix                                                     |
   | ----------------------------- | ------------------- | ---------------------------- | -------------------------------------------------------------------- |
   | Valeur affichée (aujourd'hui) | 71                  | visites                      | Écrite                                                               |
   | Valeur d'annonce (P1)         | 60                  | surface, occupation, visites | Refus d'écriture `missing_price_and_surface`, statut `internal_only` |

   Une pièce posée ne compterait plus pour la complétude, et la collecte cesserait d'écrire certaines ventes. La garde d'écho, G2 et la mémoire d'écho traitent le défaut sans cette régression. Porter P1 partout demanderait deux valeurs par champ en mémoire, soit un effort L.

2. **Point 8, « valeur entrante vide : la valeur d'annonce mémorisée est vidée ».** Il dépend de P1. Sans P1, une valeur vide peut venir d'un garde-fou appliqué à la valeur tenue, et viderait à tort la mémoire. Je propose de garder la règle de R1 et de s'en tenir à l'alerte `stale_listing`.
3. **P3, copies prises dans la ligne rendue par l'écriture.** Voir section 4 : cesser d'écrire plutôt qu'aligner.

## 12. Risques résiduels

- **Coïncidence rare.** Une annonce relue publie exactement la valeur d'une pièce retirée pendant le même import : la garde garde la valeur de la base. Correction à la relecture suivante de la fiche, sous 24 heures (72 pour les notaires, 6 dans la semaine de la vente ; `freshness.py:60-79`).
- **Copies dans `raw_payload` et dans les observations embarquées.** Elles gardent la valeur d'une pièce retirée jusqu'au passage suivant de la source. Internes (aucune vue ne rend `raw_payload` [E]), mais à connaître pour une opposition.
- **Faux désaccords entre sources** sur les ventes à plusieurs sources, tant que l'application lit `source_conflicts` pour un champ tenu.
- **Affichage d'un terrain retiré** jusqu'à l'import suivant, tant que le point n'est pas tranché côté base.
- **Enrichissements écartés** plus fréquents avec R3.
- **Chemin SQL direct** sous un rôle que les gardes par rôle ne distinguent pas.
- **Fusion Vench et Petites Affiches** par `_shared_listing_primary`, non couverte.

## 13. Résultat des vérifications, et les trois points les plus urgents

`ruff` : aucune erreur. `pytest` : 6 374 réussis, 162 ignorés, 15 désélectionnés. Base jetable : scénarios A à E rejoués, détails ci-dessus.

1. **Arbitrer P1 avant d'écrire la migration A3.** Il conditionne le point 8 côté base et tout le périmètre Python.
2. **G2 avant le premier champ tenu.** Une observation fausse dans une table immuable et sans purge ne se corrige pas.
3. **G1 et G3 ensemble**, avec les tests des scénarios A, B et C contre une vraie base.

Fichiers :

- Essais, dans `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r2-pipeline/` : `echo.sql`, `partial.sql`, `exp1.py` à `exp5.py`, `proto_guard.py`, `pytest.log`, `replay-errors.log`, et `repo/` (copie du commit).
- `/home/user/immojudis/services/data-pipeline/src/main.py`
- `/home/user/immojudis/services/data-pipeline/src/publication_identity.py`
- `/home/user/immojudis/services/data-pipeline/src/known_document_backfill.py`
- `/home/user/immojudis/services/data-pipeline/src/fact_claims.py`
- `/home/user/immojudis/services/data-pipeline/src/recompute_scoring.py`
- `/home/user/immojudis/services/data-pipeline/src/source_extraction_backfill.py`
- `/home/user/immojudis/services/data-pipeline/src/dedupe.py`
- `/home/user/immojudis/services/data-pipeline/src/freshness.py`
- `/home/user/immojudis/services/data-pipeline/src/pdf_fact_scope.py`
- `/home/user/immojudis/services/data-pipeline/src/asset_normalization_helpers.py`
- `/home/user/immojudis/services/data-pipeline/src/asset_normalization.py`
- `/home/user/immojudis/services/data-pipeline/src/queued_runner.py`
- `/home/user/immojudis/services/data-pipeline/src/document_backlog.py`
- `/home/user/immojudis/services/data-pipeline/src/source_detail.py`
- `/home/user/immojudis/services/data-pipeline/src/sources/vench.py`
- `/home/user/immojudis/services/data-pipeline/src/storage/supabase_client.py`
- `/home/user/immojudis/services/data-pipeline/src/storage/column_sets.py`
- `/home/user/immojudis/services/data-pipeline/src/storage/known_sale_projection.py`
- `/home/user/immojudis/services/data-pipeline/src/storage/fact_claim_rows.py`
- `/home/user/immojudis/services/data-pipeline/scripts/backfill_fact_claims.py`
- `/home/user/immojudis/supabase/migrations/20261116100500_field_projection_and_hold.sql`
- `/home/user/immojudis/scripts/check-security-invariants-fact-registry.mjs`
- `/home/user/immojudis/src/lib/fact-reliability.ts`
- `/home/user/immojudis/docs/equipe/annexes/2026-11-11-registre-des-pieces/08-bascule-base-de-donnees.md`
