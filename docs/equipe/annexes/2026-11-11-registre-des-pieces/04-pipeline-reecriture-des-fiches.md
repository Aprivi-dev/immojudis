<!-- Rapport du spécialiste `data-pipeline`, rendu le 11/11/2026 dans la mission « registre des pièces ». Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Conception de l'étape 2 bis : préserver les faits de l'avocat face à la collecte

Base : `origin/main` à c9387579, lu dans un worktree détaché à moi, supprimé depuis. La branche du dépôt principal n'a pas bougé. Rien n'a été modifié, écrit en base ni poussé.
Vérifications : `ruff` et `pytest` non lancés, car la mission est une conception en lecture seule. Aucun test pgTAP rejoué. Tout vient de la lecture du code.
Dans le scratchpad, le dossier `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/wt` existait déjà : copie ancienne, non git, que je n'ai pas créée ni touchée. `main-ref` et `wt-greffe` sont aussi des worktrees qui n'étaient pas à moi.
Les chemins ci-dessous partent de `services/data-pipeline/` pour `src/…` (sauf mention `supabase/…` ou `src/lib/…`).

---

## 1. Constat exact

### 1.1 Le défaut est confirmé

Pour chaque collecte d'une annonce déjà connue, la même source réécrit toute la ligne : `src/publication_identity.py:303-308` fait `result = incoming.model_copy(deep=True)`. Seuls `source_checks`, `source_presence` et `source_conflicts` sont repris de l'existant.

`raw_payload.information_agent_verified_facts` n'est donc jamais repris. Il n'est pas non plus dans `KNOWN_ENRICHMENT_PAYLOAD_FIELDS` (`src/main.py:195-262`).

L'écriture est un `insert … on conflict (source_url) do update set col = excluded.col` sur toutes les colonnes de `UPSERT_COLUMNS` (`src/storage/supabase_client.py:266-285`, appelé ligne 592, liste dans `src/storage/column_sets.py:18-85`). Y figurent toutes les colonnes écrites par le noyau, plus `raw_payload`.

Les colonnes absentes de `UPSERT_COLUMNS` ne sont jamais écrasées. C'est le mécanisme de l'override administrateur `premium_readiness_override*` (`supabase/migrations/20260919123000_premium_catalogue_readiness.sql:11-15`).

### 1.2 Ce que le noyau écrit (migration 20261114100000, fonction `app_private.apply_information_agent_fact`)

| Clé de fait          | Colonnes écrites (lignes)                                                                                                                                                                                                             | Autres effets                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `surface_m2`         | `surface_m2`, `app_surface_m2`, `app_surface_kind='information_agent_verified'`, `surface_source='information_agent_verified'`, `surface_confidence` (greatest(conf, 0.85)), `surface_evidence` (extrait du message, ≤2000) (265-273) | estimation de marché en file |
| `land_surface_m2`    | `land_surface_m2` (288)                                                                                                                                                                                                               | estimation                   |
| `rooms_count`        | `rooms_count` (298)                                                                                                                                                                                                                   | estimation                   |
| `occupancy_status`   | `occupancy_status` (307)                                                                                                                                                                                                              | estimation                   |
| `starting_price_eur` | `starting_price_eur` (317)                                                                                                                                                                                                            | estimation                   |
| `sale_date`          | `sale_date` = date sans heure (324)                                                                                                                                                                                                   | aucun                        |
| `property_type`      | `property_type` (332)                                                                                                                                                                                                                 | estimation                   |
| `photo`              | `raw_payload.source_images` (ajout d'une URL) (350-358)                                                                                                                                                                               | aucun                        |
| `document`           | ligne `auction_documents` (insert, conflit sur `source_url, document_url`) (374-405)                                                                                                                                                  | aucun                        |

Pour toutes les clés (412-439), le noyau écrit aussi :

- `raw_payload.information_agent_verified_facts[clé]` = `{value, display_value, fact_id, evidence_asset_id, source_page, reviewed_at, source:'professional_email', publication_mode, received_at, recipient_kind}` ;
- il retire `llm_display_description`, `llm_display_description_word_count` et `llm_prompt_version` ;
- il crée un job `display_description` (441-467) ;
- il écrit la ligne de `information_agent_fact_publications` (478-484), avec `previous_values`, `previous_provenance`, `new_values`, `actor_kind`, `recipient_kind` et `response_received_at`.

Les faits acceptés avant 20260920144219 viennent des versions de 20260825103748 et 20260825131944. Ils n'ont ni `publication_mode`, ni `recipient_kind`, ni `received_at`, ni ligne de journal. La projection publique les lit comme « manual » (879 : lignes 845-896).

Le noyau verrouille la vente en `FOR UPDATE` (217-219), après le verrou du fait (159-162).

### 1.3 Chemins qui écrivent `auction_sales`

**Colonnes du noyau + `raw_payload` entier (les dangereux)**

1. `upsert_sales_to_supabase` → `_write_sale_revisions` (`supabase_client.py:484-545`, `546-608`).
   - Appelants : `main.py:732` (publication précoce), `main.py:1000` (finale), `main.py:1158`, `main.py:1534`, `queued_runner.py:820` (file PDF/LLM), `document_backlog.py:509`, `verify_publication.py:30,36`, `recompute_scoring.py:309,371,695`.
   - Seule la collecte (`refresh_last_seen=True`) passe par `resolve_publication_identities` et `merge_revision`. Les enrichissements passent par `_guard_enrichment_revision` (893-906) : verrou `for no key update` plus comparaison de `updated_at`. Une écriture dont l'objet en mémoire précède l'acceptation est donc déjà écartée (« Discarding obsolete enrichment »).
   - Repli REST sans connexion : `_upsert_with_rest`, `supabase_client.py:3245`. Il n'est pas atteint en production : `.github/workflows/data-pipeline.yml:295` exige `SUPABASE_DB_URL`.
2. `reconcile_duplicate_sales_in_supabase` (`supabase_client.py:2797`, écriture ligne 2865) : upsert complet des lignes fusionnées sur une connexion à part, sans verrou ni relecture. C'est le seul chemin sans protection de concurrence.
3. `_prune_stale_document_rows` (`supabase_client.py:3931-3994`) : après chaque révision « complete », supprime de `auction_documents` toute ligne absente de la liste de l'annonce. Cela détruit les faits `document` acceptés (pièces `information-agent-approved`). Les faits `photo` sont perdus avec `raw_payload.source_images`, remplacé par celui de l'annonce.

**Écritures ciblées (ne touchent pas les colonnes du noyau)**

- `jsonb_set` sur `document_analysis` : checkpoint PDF, `supabase_client.py:2034`.
- `raw_payload || …` : `src/address_positions.py:116-135` (géocodage : latitude, longitude, quality_flags, `raw_payload`), `publication_identity.py:277` (`hold_identity`), `autonomous_runner.py:492` (`source_presence`).
- PATCH de `last_seen_at` seul (`supabase_client.py:3143-3175`).
- PATCH des colonnes `premium_readiness_*` : `recompute_scoring.py:211-240`.
- `redact_personal_data.py:206`.

Ces chemins fusionnent ou n'atteignent pas les colonnes du noyau : aucun effacement du fait.

**SQL**
Aucune fonction récurrente (RPC ou déclencheur) ne réécrit ces colonnes, hors `review_information_agent_fact_candidate` et le noyau. Les autres migrations qui les touchent sont des rattrapages ponctuels (`20261111013457`, `20261111020814`, …). Il existe déjà environ 15 déclencheurs BEFORE/AFTER sur `auction_sales`.

### 1.4 Valeurs « posées par un humain ou un tiers » déjà préservées

- **Colonnes hors `UPSERT_COLUMNS`** : override de publication (voir 1.1). Mécanisme d'exclusion, valable seulement pour des colonnes dédiées.
- **Valeurs établies par les PDF** : `src/known_document_backfill.py:34-62` copie les colonnes de surface depuis la ligne connue si la fiche collectée est vide. Cela vaut seulement si `surface_source == 'pdf'`, donc pas pour `information_agent_verified`. Pour le prix (65-95), la valeur connue est reprise sauf si l'annonce dit autre chose, auquel cas l'annonce l'emporte et les PDF réarbitrent. C'est exactement la règle du propriétaire. L'appel se fait dans `main.py:1256-1313`, sur un instantané ancien (`known_details`, lecture `repeatable read` à `supabase_client.py:2960`, parfois des heures avant l'écriture) et sans verrou.
- **Fiche inchangée** : `KNOWN_UNCHANGED_BACKFILL_FIELDS` (`main.py:145-193`) recopie les colonnes de la base quand l'annonce n'a pas changé (`_hydrate_known_unchanged_sales`, `main.py:1217`). Les colonnes de l'avocat survivent donc pour une page inchangée, mais pas `raw_payload.information_agent_verified_facts`. La mention disparaît (la projection exige l'entrée), la valeur reste. Pour une page modifiée, tout est perdu.
- **`source_presence` et `source_conflicts`** repris de l'existant (`publication_identity.py:306-308`), ainsi que `publication_identity_conflict` (366-368).
- **Claims** : `auction_fact_claims` est une table d'observations (claims `accepted` créées par le pont). Elle n'alimente aucune colonne : « the catalogue fields are still the operational read model » (`src/fact_claims.py:1-9`).

Modèle à suivre : le prix PDF (garder si l'annonce se tait, l'annonce l'emporte si elle diffère). Il faut en refaire le calcul sous le verrou de la ligne, pas sur l'instantané.

### 1.5 Mécanismes qui jouent déjà en notre faveur

- **Mention publique** : `app_private.get_public_sale_lawyer_fact_sources` (20261114100000, lignes 825-927) n'affiche une mention que si l'entrée existe et que la colonne vaut encore la valeur transmise. Pour la surface, il faut aussi `surface_source='information_agent_verified'` (lignes 901-905). Elle échoue donc fermée : une valeur écrasée ne montre plus de mention. Aujourd'hui l'effacement de la mention est un effet de bord, et la valeur de l'avocat est perdue en même temps.
- **Seuils de divergence** : `conflicts_with_sale` (`src/information_agent_fact_candidates.py:233-251`) fixe la surface à `app_surface_m2` avec repli `surface_m2`, une tolérance de 0,5 m² pour les surfaces et 0,01 ailleurs, la date comparée sur 10 caractères, le type de bien et le texte en casefold.

---

## 2. Options comparées

|                                      | (a) Garde Python au point d'écriture                                                                                                                                                                                                                                                                                                                                                                                                                                                          | (b) Déclencheur BEFORE UPDATE                                                                                                                                                                                                                                                                      | (c) Table de valeurs tenues + vue ou affichage                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Concurrence import / acceptation** | Bonne en production. L'identité (`publication_identity.py:522`, `for no key update`) ou `_guard_enrichment_revision` verrouille la ligne avant `_write_sale_revisions`. Le noyau fait `for update` sur la vente : ils s'excluent. En READ COMMITTED, la relecture après verrou voit le fait validé. Pas de cycle de verrous (le noyau prend fait puis vente, le pipeline seulement des ventes). Le défaut actuel est un write-skew : `existing` est lu avant et écrit après sans comparaison. | Atomique par construction (OLD relu sous le verrou de ligne).                                                                                                                                                                                                                                      | Atomique, mais l'affichage lit des colonnes non protégées.                                                                                    |
| **Couverture des chemins**           | Tous les appelants d'`upsert_sales_to_supabase` (collecte, file, backlog, recompute). À ajouter explicitement : la réconciliation des doublons (`supabase_client.py:2865`, il faut aussi un verrou) et le repli REST (non utilisé en production). Aucune écriture SQL récurrente à couvrir.                                                                                                                                                                                                   | Tous les chemins, y compris REST, SQL et réconciliation.                                                                                                                                                                                                                                           | Ne protège rien : scoring, estimation de marché, exports, requêtes TS, `catalogue_search` lisent les colonnes de `auction_sales` directement. |
| **Coût sur l'import**                | 1 requête indexée par lot de 25 (`information_agent_fact_candidates(sale_id)`, index existant, `status='accepted'`). La lecture du `raw_payload` ne concerne que les ventes ayant un fait.                                                                                                                                                                                                                                                                                                    | Un déclencheur de plus sur la table chaude. `CREATE TRIGGER` prend un `SHARE ROW EXCLUSIVE` (précédent : `20261028100200`, `lock_timeout 5s`). Sonder le journal pour chaque ligne. Lire `OLD.raw_payload` (plusieurs centaines de Ko) sur chaque UPDATE si on ne filtre pas avant.                | Négligeable à l'écriture, élevé à la lecture.                                                                                                 |
| **Régression**                       | Moyenne, maîtrisée par des tests Python. Aucune migration pour la protection elle-même.                                                                                                                                                                                                                                                                                                                                                                                                       | Élevée. Le déclencheur ne peut pas distinguer le noyau du pipeline sans modifier le noyau (drapeau transactionnel) : une 2e publication sur la même clé serait annulée. Il doit aussi réimplémenter les tolérances et fusionner du jsonb en plpgsql. L'ordre des déclencheurs `zzzz_` est délicat. | Élevée (toute la lecture).                                                                                                                    |
| **Effort**                           | M                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | L                                                                                                                                                                                                                                                                                                  | L                                                                                                                                             |

**Recommandation : (a)** avec une relecture sous verrou au point d'écriture unique `_write_sale_revisions`, plus une sonde de détection en base (voir §3.8). Le déclencheur (b) reste un filet possible plus tard.

---

## 3. Recommandation détaillée

### 3.1 Fichiers

1. **Nouveau** `src/information_agent_fact_guard.py` (~250 lignes, limite 1500 sans souci) :
   - `HELD_KEYS` : spécification par clé (colonnes détenues, comparateur, tolérance, valeurs « vides »).
   - `load_held_facts(connection, source_urls)` : une requête qui joint `auction_sales` (`source_url = any(%s)`) et `information_agent_fact_candidates` (`status='accepted'`, `fact_key` dans la liste fermée) pour ne lire le `raw_payload->'information_agent_verified_facts'` que des ventes concernées. Lecture sous le verrou déjà pris.
   - `apply_held_facts(sale, held) -> list[Supersession]` : pure, testable sans base.
   - `record_supersessions(connection, rows)`.
2. `src/storage/supabase_client.py` : un appel dans `_write_sale_revisions`, après les lignes 561-570 et avant `ensure_room_bedroom_consistency`/`apply_catalogue_readiness`, seulement si `_PUBLICATION_CONNECTION.get()` n'est pas `None`. Un `record_supersessions` après la ligne 592. Environ 8 lignes. Le plafond du module est 4526 pour 4369 lignes actuelles, soit 157 de marge. Aucun relèvement.
3. `_prune_stale_document_rows` : ne pas supprimer les `auction_documents` dont `raw_payload->>'source' = 'information_agent'`. Ce point dépend de la décision 1 du propriétaire (§Questions).
4. Réconciliation des doublons (`supabase_client.py:2797-2885`) : faire passer ses lignes par le même garde, sous verrou. Fichier déjà dans le plafond, donc faire l'appel depuis le nouveau module.
5. Option propre : un second affichage (admin) :
   - `src/lib/admin-information-agent.ts:132` (`listAdminInformationAgentReview`) : ajouter une 3e liste, `listingConflicts`.
   - Carte dans l'onglet Réponses.
   - Route d'action et RPC de classement (voir 3.5).
6. Migration (voir 3.6).

### 3.2 Détection « l'annonce dit autre chose »

Fait pour chaque clé de `information_agent_verified_facts` de la ligne existante verrouillée.

Valeur détenue = `entry.value.value` (ce qu'a dit l'avocat), pas la colonne.

- **Entrée périmée** : si la colonne de l'existant ne vaut plus la valeur détenue (surface : aussi si `surface_source ≠ 'information_agent_verified'`), on l'écarte sans cas de relecture (la projection publique l'a déjà masquée).
- **Valeur de l'annonce** :
  - surface : `incoming.app_surface_m2`, repli `surface_m2`, comme `information_agent_fact_candidates.py:233-251` ;
  - autres : la colonne directe.
- **Considérée comme vide** : `None`, `''`, nombres ≤ 0 (les validateurs du noyau les refusent, 245/284/294/313), `occupancy_status='unknown'`. À vérifier dans `normalize.py` si `property_type='other'` est un défaut de repli : si oui, le traiter comme vide, sinon faux conflits.
- **Tolérances** : 0,5 m² pour `surface_m2` et `land_surface_m2`, 0,01 € pour le prix, égalité entière pour les pièces, casefold pour les chaînes. Extraire ces constantes dans un seul module partagé avec `conflicts_with_sale`, avec un test de parité.
- **Date** : comparer en `Europe/Paris` (le noyau écrit une date sans heure, l'annonce a une heure). Même jour : on garde la valeur de l'annonce (plus précise) et l'entrée. Jour différent : conflit.

Trois issues :

1. **Vide** : on réapplique dans `sale` toutes les colonnes de la clé, en copiant la provenance depuis l'existant (pour la surface : les 6 colonnes), et on reporte l'entrée dans `raw_payload`.
2. **Même valeur** : on garde la valeur, la provenance et la mention.
3. **Différente** : l'annonce garde ses colonnes, l'entrée n'est pas reportée dans `raw_payload`, et un cas de relecture est écrit.

**Même valeur, ma proposition : garder la mention.**

- Sur une fiche inchangée, le pipeline recopie lui-même la colonne de la base (`KNOWN_UNCHANGED_BACKFILL_FIELDS`). Une « même valeur » est alors indiscernable d'une valeur reprise, sauf pour la surface (`surface_source` le dit). La supprimer ferait disparaître la mention à chaque collecte d'une page inchangée.
- C'est vrai, l'avocat a bien transmis cette valeur.
- Une annonce qui concorde ne justifie pas de relecture.

Cela diverge du commentaire de la projection (879, 901 : « La même valeur réécrite depuis l'annonce change la provenance : plus de mention »). Il suffit de garder `surface_source='information_agent_verified'` pour que la projection reste cohérente.

**Cas particuliers à coder et tester**

- Pièces : si garder les pièces de l'avocat violerait l'invariant `rooms >= bedrooms` (`publication_identity.py:~190` ; contrainte SQL), traiter comme conflit avec le motif `rooms_below_bedrooms` plutôt que de laisser `ensure_room_bedroom_consistency` effacer la valeur sans trace.
- Surface multi-colonnes : comparer `app_surface_m2`, pas `habitable_surface_m2` ni `carrez_surface_m2`.
- Valeurs de photo et document : voir la décision 1.

### 3.3 Où créer le cas de relecture

**Ne pas réutiliser `information_agent_fact_candidates` au statut `conflict`.** Quatre raisons :

- `message_id` et `case_id` sont `not null`.
- Une 2e ligne sur le même message serait bloquée par `unique (message_id, fact_key, display_value)` et `information_agent_fact_candidates_provenance_key`.
- Surtout : l'écran Réponses (`admin-information-agent.ts:141`) liste `pending` et `conflict` avec un bouton Accepter. Accepter appellerait le noyau avec la valeur de l'annonce attribuée à l'avocat, ce qui serait une fausse attribution.
- Le noyau refuse de republier un fait déjà publié (183-189).

**Ne pas réutiliser le journal des publications** : sa contrainte `actor_kind in ('admin','auto')` et `information_agent_fact_publications_auto_locked` sont verrouillées. Il est conçu en écriture seule par le noyau.

**Proposition : une table dédiée**, `public.information_agent_listing_conflicts` (nom à valider), en écriture et lecture seules serveur, même RLS que le journal :

- `id`, `sale_id` (FK, `on delete cascade`), `fact_key`.
- `fact_id` (sans FK, comme le journal), `lawyer_value` jsonb (valeur et affichage), `received_at`, `recipient_kind`.
- `listing_value` jsonb, `listing_source_name`, `run_id`.
- `reason` (code snake_case, par ex. `listing_differs`, `rooms_below_bedrooms`), `detected_at`.
- `status` (`open` / `reviewed`), `reviewed_by`, `reviewed_at`.
- Index unique partiel `(sale_id, fact_key) where status='open'`, avec `on conflict do nothing` : idempotence.

Écriture par le pipeline, dans la transaction de publication, après l'écriture de la vente (`select id from auction_sales where source_url = …`). Atomique avec elle.

Classement par une RPC `SECURITY DEFINER` réservée à l'administrateur, calquée sur `review_information_agent_fact_candidate` : `reviewed_by` + `status='reviewed'`. L'écran montre les deux valeurs, la date de réception de la réponse de l'avocat, la source de l'annonce, et le lien vers la fiche.

Alternative à examiner si l'on veut éviter une table : une claim candidate dans `auction_fact_claims` (statuts `candidate` / `conflicted`, écran existant `/api/admin/fact-claims/review`), mais elle exige une preuve de source et une chaîne `supersedes_claim_id` lourde, et le pipeline ne l'émet que si l'annonce porte une preuve champ à champ. Je ne la recommande pas.

### 3.4 Retirer la mention publique

Rien à écrire. Quand l'annonce l'emporte, l'entrée n'est plus reportée dans `raw_payload` et la colonne porte la valeur de l'annonce. `get_public_sale_lawyer_fact_sources` ne rend plus la clé (échec fermé double : entrée absente, colonne différente). Le noyau n'a pas à changer. Le `display_description` n'est pas à régénérer : aucun fichier du pipeline ne lit les faits de l'avocat pour le texte. L'estimation de marché est relancée par le déclencheur existant sur changement de colonnes.

À noter, non traité ici :

- la claim `accepted` du pont (`20261114100000:754-811`) reste « acceptée » après le remplacement : à marquer `superseded` plus tard (décision 5) ;
- le scoring calculé avant le garde ne voit pas la valeur reprise, jusqu'au prochain `recompute_scoring` (même limite qu'aujourd'hui pour le noyau).

### 3.5 Faits acceptés avant le correctif

- **Encore intacts en base** (entrée présente, colonne égale) : couverts dès le déploiement. Les faits d'avant 20261114100000 n'ont pas de `publication_mode` : le garde se fonde sur `fact_id`, `value` et la ligne candidate (statut `accepted`), tout comme la projection.
- **Déjà effacés par une collecte** (entrée absente) : le garde n'a rien à reprendre. Le journal garde les valeurs pour les faits publiés après le 14/11, les candidats acceptés les gardent tant que le dossier n'est pas purgé. Je ne propose pas de rejeu automatique : le noyau refuse la republication d'un fait déjà publié (183-189). Il faudrait une RPC administrateur « rétablir » qui passe par le noyau (décision 2).

### 3.6 Migration

Une seule : la table de 3.3 et la RPC de classement. Aucun déclencheur, aucune modification de `auction_sales`.

- `begin; set local lock_timeout = '5s';` en tête, comme les migrations voisines ;
- `create table if not exists`, `alter table … enable row level security`, `revoke all … from public, anon, authenticated, service_role`, `grant select … to service_role` ;
- `create or replace function` pour la RPC, avec droits d'exécution à `service_role` seulement (à ajouter à `supabase/tests/441_function_privileges.sql`) ;
- `notify pgrst, 'reload schema'` ;
- aucun verrou sur `auction_sales`.

Retour arrière : supprimer la RPC puis la table (aucune donnée à reprendre). Le garde Python doit tolérer l'absence de la table (la tester avec `to_regclass`, comme `_write_fact_claims_postgres`, ligne 619 environ) pour permettre un déploiement du code avant la migration.

### 3.7 Idempotence et reprise

La décision se calcule à chaque écriture depuis la ligne existante verrouillée. Après une collecte, l'entrée a disparu et la colonne vaut la valeur de l'annonce : la collecte suivante ne produit plus de conflit. La table a un index unique partiel. Un échec fait annuler la transaction entière (vente et cas). Le checkpoint ancien de `merge_revision` (lignes 292-297) renvoie la ligne existante : le garde ne change rien.

### 3.8 Détection des contournements

Un rapport SQL en lecture seule (par exemple dans `docs/runbooks/`), ou une sonde de santé, qui liste les faits `accepted` dont la colonne ou l'entrée `raw_payload` ne correspond plus à la fiche. Il sert à repérer la réconciliation des doublons ou un écrasement venu d'ailleurs, sans déclencheur.

---

## 4. Plan de tests

**Python** (`services/data-pipeline/tests/`, nouveaux `test_information_agent_fact_guard.py` et ajouts à `test_publication_identity.py` / `test_supabase_client.py`) :

- La pure `apply_held_facts`, par clé, pour : l'annonce se tait (None, `''`, 0, `unknown`) ; même valeur ; valeur différente ; écart dans la tolérance (0,4 contre 0,6 m²) ; plusieurs clés dont une seule en conflit ; vente sans fait ; entrée périmée ; fait antérieur (sans `publication_mode`).
- Surface : repli `surface_m2` / `app_surface_m2`, provenance recopiée (6 colonnes), `habitable_surface_m2` ≠ `app_surface_m2`.
- Date : fuseau `Europe/Paris`, minuit contre 14 h.
- Pièces contre chambres (motif `rooms_below_bedrooms`).
- Tests de parité des tolérances avec `conflicts_with_sale`.
- Intégration avec une connexion factice : l'ordre (garde avant `ensure_room_bedroom_consistency` et `apply_catalogue_readiness`) ; aucune écriture REST ; reprise après échec partiel (transaction annulée, aucun cas persisté) ; relance identique, aucun doublon de cas ; fiche inchangée (`_known_unchanged`).
- Garde-fous : `tests/test_source_file_sizes.py` passe (plafond `supabase_client.py` inchangé), `ruff check .`.

**pgTAP** (`supabase/tests/`, nouveau fichier après 880, PostgreSQL 16 + `pgtap`, migrations rejouées dans une base jetable) :

- Table : RLS, droits (rien pour `anon` / `authenticated`), contrainte et index unique partiel (le doublon est ignoré).
- RPC de classement : refus d'un non-administrateur, `reviewed_by` et `reviewed_at` posés, rejeu refusé.
- Régression : `get_public_sale_lawyer_fact_sources` ne rend plus la clé après remplacement.
- Test de concurrence en deux sessions (`for update` du noyau pendant un `insert … on conflict` du pipeline) : à lancer à la main sur la base jetable.

**Cas limites listés dans la demande** : valeur nulle, zéro, même valeur, valeur différente, plusieurs clés, vente sans fait, fait accepté pendant l'import, reprise après échec partiel.

---

## 5. Ce que la lecture ne permet pas d'établir (à mesurer en lecture seule en production)

1. Nombre de ventes avec au moins un fait accepté : `information_agent_fact_candidates` (`status='accepted'`, par `fact_key`, par date), et combien ont encore l'entrée et la colonne aujourd'hui (comparaison avec `raw_payload` et les colonnes).
2. Combien de ces faits ont déjà été effacés, par clé, et depuis combien de collectes. Fréquence réelle des réécritures par vente : `last_seen_at` et `auction_collection_items` sur ces ventes.
3. Part de ventes dont l'annonce change entre deux collectes (conflit potentiel) et de celles où l'annonce porte déjà une valeur différente pour le champ.
4. Le temps de verrou réel d'une acceptation administrateur pendant un lot (le verrou `for no key update` prend aussi les lignes de même code postal, `publication_identity.py:~434`).
5. Si `property_type` « other » est un repli de normalisation (et donc un faux conflit).
6. Si les tables normalisées `properties` / `judicial_sales` (`_sync_normalized_sale_tables_with_rest`) divergent déjà de la fiche après une acceptation, puisque le noyau n'y écrit pas.
7. La date d'acceptation des faits de la table `information_agent_fact_candidates` par rapport à la purge des dossiers (`20261101150000_information_agent_cases_retention.sql`) : combien de faits effacés n'ont plus de candidat lisible.

---

## Questions qui relèvent du propriétaire

1. **Photos et documents** : les inclure dans la règle ? Aujourd'hui une photo acceptée est effacée de `raw_payload.source_images` à chaque collecte, et un document accepté est supprimé par `_prune_stale_document_rows` (`supabase_client.py:3931-3994`). Les « garder si l'annonce se tait » est simple (carte de la table `auction_documents`, liste d'images). « L'annonce dit autre chose » n'a pas de sens pour un fichier.
2. **Faits déjà effacés** : voulez-vous une action administrateur « rétablir » (nouvelle RPC passant par le noyau, avec un nouveau fait) pour les ventes déjà touchées, ou on les laisse perdus ?
3. **Même valeur** : valider « garder la mention », ou préférer la retirer (le garde ne peut alors la retirer que pour la surface, où `surface_source` distingue le report d'une lecture de l'annonce).
4. **Les PDF comptent-ils comme « l'annonce »** ? Une lecture de PDF qui diffère de la valeur de l'avocat écrase-t-elle la valeur et ouvre-t-elle un cas, comme la collecte ? Je l'ai supposé : tout passe par le même point d'écriture.
5. **Claim `accepted` du pont** : après un remplacement par l'annonce, la passer en `superseded` (nécessite une claim candidate de l'annonce) ou laisser l'historique tel quel ?
6. **Zéro et valeurs sentinelles** : confirmer que 0 (ou `unknown`) venant de l'annonce signifie « ne dit rien » et non « dit autre chose ».
7. **Réconciliation des doublons** : si la ligne supprimée porte des faits d'avocat, ils partent en cascade (candidats et journal). Faut-il les reporter sur la ligne conservée (comme `carry_user_data_on_sale_merge`) ? C'est hors périmètre de cette étape.
8. **Repli REST sans base directe** : le garder non protégé (hors production seulement) ou refuser d'écrire une vente portant un fait accepté ?
9. **Relecture** : un administrateur peut seulement « classer » le cas (valeur de l'annonce retenue), ou aussi « rétablir la valeur de l'avocat » (voir la question 2) ?
