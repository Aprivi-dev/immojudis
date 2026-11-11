<!-- Rapport du spécialiste `expert-postgres`, rendu le 11/11/2026 dans la mission « registre des pièces », après la mise en production du lot R1. Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Spécification du lot R2 (bascule du registre des pièces), côté base

Rien n'a été modifié ni exécuté. Dépôt lu en l'état dans `/home/user/immojudis`. [V] = lu dans le code, [S] = supposé sans mesure. Aucune requête n'a été lancée en production : toutes les mesures sont à confier à `qualite-donnees` (section F).

Je n'ai pas trouvé dans le dépôt le texte de ma relecture (« point B1 ») : le point 3 repart du code.

## A. Constats nouveaux qui pèsent sur R2

1. **[V] L'ancienne valeur tenue peut revenir par une colonne voisine.** `src/lib/surface.ts:64-70` affiche `app_surface_m2`, sinon `habitable_surface_m2`, sinon `carrez_surface_m2`. `asset_normalization_helpers.py:71-125` recalcule ces colonnes les unes à partir des autres, et `main.py:145-175` recopie depuis la base les colonnes absentes de la collecte. Une pièce retirée peut donc réapparaître par une colonne non tenue. Traité au point 3.
2. **[V] `app_surface_kind` et `surface_source` sont lus par les vues publiques** (`src/lib/sale-views.ts:52,54`). La valeur écrite par R1 (`fact_registry_<origine>`, `20261116100500:820-821`) publierait la nature de la source. Traité au point 4.
3. **[V] `recompute_scoring.py:598` lit `select=*` puis fusionne la ligne dans le dictionnaire brut (ligne 614).** `held_fields` y entrerait, et les colonnes tenues serviraient d'entrée à la normalisation. Traité au point 3.
4. **[V] `properties` et `judicial_sales` sont lisibles par `authenticated` sous RLS** (`20260706155000:215-216`) et écrites par le pipeline (`supabase_client.py:3693-3712`). `auction_features` et `auction_surfaces` reçoivent aussi des lignes tirées de la vente (lignes 3715-3719). Aucun fichier de `src/` ne lit `properties` ni `judicial_sales` (recherche de `.from("properties")` sans résultat).
5. **[V] L'identifiant d'une observation du pipeline contient `auction_sale_id`** (`fact_claims.py:197-205`). Après une fusion, la collecte réémet donc les observations pour la vente conservée. Cela tranche le cas de l'observation détachée (point 6).
6. **[V] Le pont cherche l'observation existante par `evidence_locator->>'information_agent_fact_id'` sans index** (`20261114100000:746-749`). C'est un parcours séquentiel par acceptation, et l'unicité n'est pas garantie. Traité au point 1.
7. **[V] La mention publique lit `raw_payload` à chaque fiche** (`20261114100000:855-862`). La bascule supprime cette lecture (point 5).
8. **[S] Une restauration de données seules échouerait sur une vente tenue.** La garde d'insertion `aaab_auction_sales_held_fields_insert_guard` est en mode `always`. À essayer sur base jetable et à écrire dans le runbook (points 7 et 11).

---

## B. Les treize points

### 1. Noyau : observation, décision, projection (Critique, L)

**Décision.** La signature et les droits de `app_private.apply_information_agent_fact(uuid, text, uuid, text)` ne changent pas (l'invariant `information-agent-no-automatic-publication-path` compare cette signature, `scripts/check-security-invariants.mjs:2126`). Le noyau n'écrit plus aucune colonne de fait.

| Clé du fait                                                        | Observation | Décision   | Projection              | Écriture sur la fiche                     |
| ------------------------------------------------------------------ | ----------- | ---------- | ----------------------- | ----------------------------------------- |
| `surface_m2`, `land_surface_m2`, `rooms_count`, `occupancy_status` | oui         | `accepted` | oui                     | par la projection seule                   |
| `starting_price_eur`, `sale_date`, `property_type`                 | oui         | `accepted` | non (champ non tenable) | aucune : valeur enregistrée, non affichée |
| `photo`, `document`                                                | non         | non        | non                     | comme aujourd'hui                         |
| `visit_information` et autres                                      | non         | non        | non                     | aucune                                    |

Précisions :

- **Occupation.** `owner_occupied` et `squatted` deviennent `occupied` avant l'insertion de l'observation ; `unknown` ne crée pas d'observation. Le déclencheur de validation refuse sinon l'acceptation (`20261116100000:380-385`), et l'observation, immuable, ne garde jamais « qui occupe ».
- **Observation.** `claim_status = 'candidate'` (le journal porte seul la décision), `created_by` = l'administrateur, `extractor_name = 'information_agent'`. `evidence_kind` : `professional_email` pour le corps du message, `email_attachment` ou `portal_upload` pour une pièce jointe, tous classés `lawyer_email` par `fact_claim_source_kind` [V `20261116100500:104-126`].
- **Lot.** `lot_attachment = 'unknown'` si `quality_flags ? 'multi_lot_sale'`, sinon `single_lot`. Une vente à plusieurs lots n'est donc jamais tenue par une réponse qui ne nomme pas son lot (choix 3). La correction passe par la RPC d'acceptation avec `supersedes_decision_id` (point 2).
- **Projection non posée** (`conflicted`, `blocked`, lot inconnu) : l'acceptation reste au journal, sans erreur ni annulation. La RPC rend `projection_state`.
- **Journal `information_agent_fact_publications`.** Une ligne par publication, mêmes colonnes. `previous_values` = colonnes lues sous verrou avant la projection. `new_values` = colonnes écrites par la projection (`{}` si rien n'est posé). `previous_provenance` reçoit une clé `registry` : `claim_id`, `decision_id`, `projection_state`.
- **Idempotence.** Trois barrières : le test « déjà publié » du noyau (ligne au journal), l'index `auction_fact_claim_decisions_fact_accepted_key` [V], et un nouvel index unique sur l'observation.
- **Verrous `auto_locked`.** Aucun n'est touché. Un appel `'auto'` est refusé d'entrée (55000), puis par les trois contraintes existantes.
- **`raw_payload.information_agent_verified_facts`.** Plus écrit pour les clés scalaires ni pour `visit_information` (qui y déposait un texte tiré du message). Gardé pour `photo` et `document` : `catalogue_readiness.py:359` le lit [V]. Le retrait des trois clés `llm_display_*` reste.

**Ordre de verrouillage : la vente d'abord.** `review_information_agent_fact_candidate` et le noyau verrouillent aujourd'hui le fait puis la vente [V `20261114100000:159-162`, `217-219`, `529-532`].

```sql
-- app_private.lock_sale_for_registry(p_sale_id uuid) returns void, aucun droit
v_previous := current_setting('lock_timeout');
perform set_config('lock_timeout', '3s', true);
begin
  perform 1 from public.auction_sales s where s.id = p_sale_id for no key update;
exception when lock_not_available then
  perform set_config('lock_timeout', v_previous, true);
  raise exception using errcode = '55P03', message = 'sale_busy';
end;
perform set_config('lock_timeout', v_previous, true);
```

Dans la RPC : lire `sale_id` du fait sans verrou, appeler `lock_sale_for_registry`, verrouiller le fait `for update`, puis vérifier que `sale_id` n'a pas changé (sinon 40001 `retry`). L'interface traduit `sale_busy` par « Import en cours sur cette vente, réessayez dans une minute ». Ordre complet : vente, fait candidat, observation, décision, projection, files d'enrichissement, journal.

**Le pont est supprimé** dans la même transaction que le nouveau noyau : `drop trigger information_agent_fact_claim_bridge` et `drop function app_private.bridge_accepted_information_agent_fact_claim()`. Trois raisons : il reverrouille la vente au commit, il refuserait une acceptation non posée, il créerait une seconde observation au statut `accepted`. Sans lui, une écriture directe du statut `accepted` ne produit rien (échec fermé).

**`review_auction_fact_claim` reste**, avec trois retouches :

- ordre vente puis observation, `for no key update`, même délai de verrou ;
- colonnes nommées au lieu de `select sale.*` [V `20260928180000:75-79`], qui lit `raw_payload` ;
- refus (55000) d'une observation d'origine professionnelle ou déjà décidée au journal.

L'égalité avec la fiche n'est pas relâchée. Cette RPC ne tient jamais un champ ; elle sera remplacée en R3.

**Index** (script `scripts/apply-supabase-concurrent-index-operations.mjs`, connexion directe) :

```sql
create unique index concurrently auction_fact_claims_agent_fact_key
  on public.auction_fact_claims ((evidence_locator->>'information_agent_fact_id'))
  where evidence_locator ? 'information_agent_fact_id';
```

Mesure du gain : `explain (analyze, buffers) select id from public.auction_fact_claims where evidence_locator ? 'information_agent_fact_id' and evidence_locator->>'information_agent_fact_id' = '<uuid>';`. Attendu avant : parcours séquentiel d'environ 17 000 lignes. Attendu après : parcours d'index, moins de 0,1 ms.

**Verrous et application.** `drop trigger` : ACCESS EXCLUSIVE bref sur `information_agent_fact_candidates`. Aucun verrou sur `auction_sales`. À appliquer hors import et hors séance de relecture.

**Tests pgTAP (`886_information_agent_core_registry.sql`).**

- Bout en bout pour les quatre clés tenables : observation candidate, décision, `held_fields`, colonnes, ligne de journal avec la clé `registry`.
- Les trois clés non tenables : observation et décision, aucune colonne modifiée.
- `visit_information` : ni observation ni écriture dans `raw_payload`.
- Double acceptation refusée ; appel `'auto'` refusé.
- Vente à plusieurs lots : décision `unknown`, rien de posé.
- `owner_occupied` ramené à `occupied`.
- Concordance : pour chaque fait accepté du jeu d'essai, la simulation rend le même ensemble que `held_fields`.
- Le pont n'existe plus ; un import qui réécrit `raw_payload` ne retire pas la mention.
- Concurrence à deux sessions (manuel) : import d'abord puis RPC (`sale_busy` après 3 s) ; RPC d'abord puis import (il attend et conserve la valeur tenue).

**Invariants.** Garder tels quels l'appel avec le littéral `'admin'` et les verrous. Ajouter :

- `registry-core-writes-no-fact-column` : le corps du noyau ne contient aucun `update public.auction_sales` sur une colonne tenue ;
- le déclencheur du pont n'est jamais recréé.

[S] Chercher avant la bascule si un test ou un invariant exige l'existence du pont.

### 2. RPC d'administration (Critique, L)

**Décision.** Quatre RPC publiques, une fonction interne sans droit.

```sql
public.accept_auction_fact_claim(p_claim_id uuid, p_lot_attachment text,
  p_lot_ref text default null, p_supersedes_decision_id uuid default null) returns jsonb
public.reject_auction_fact_claim(p_claim_id uuid, p_reason_code text) returns jsonb
public.withdraw_auction_fact_claim(p_claim_id uuid, p_reason_code text) returns jsonb
public.oppose_auction_fact_claim(p_claim_id uuid,
  p_reason_code text default 'professional_opposition') returns jsonb
app_private.decide_auction_fact_claim(p_claim_id uuid, p_decision text, p_reason_code text,
  p_lot_attachment text, p_lot_ref text, p_supersedes_decision_id uuid, p_actor_id uuid) returns jsonb
```

- `security definer`, `search_path = ''`.
- `revoke all … from public, anon, authenticated, service_role`, puis `grant execute … to authenticated` seul. Pas de `service_role` : l'auteur vient toujours d'un jeton d'administrateur.
- En tête : `v_actor := (select auth.uid()); if not public.is_admin() or v_actor is null then raise 42501`. `is_admin()` exige `aal2` quand l'interrupteur est actif [V `20261010002000:31-52`].
- `actor_kind = 'admin'` pour les quatre. L'opposition est saisie par un administrateur ; l'identité du professionnel n'est pas stockée.
- Motifs : la liste de M1, contrôlée avant l'insertion (22023 `invalid_reason_code`).
- Retour : `claim_id`, `decision_id`, `decision`, `sale_id`, `field_key`, `state`. Jamais d'autre colonne de la vente.

**Transitions** (dernière décision de l'observation, ordre de `seq`) :

| Action     | Dernière décision admise                                                                                                                      | Sinon                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| accepter   | aucune ; ou `rejected`, `withdrawn`, `contradicted`, `accepted` (correction du lot) en nommant cette décision dans `p_supersedes_decision_id` | `invalid_transition` ; après `opposed` : `opposed_final` |
| rejeter    | aucune, `accepted`, `contradicted`                                                                                                            | `invalid_transition`                                     |
| retirer    | `accepted`                                                                                                                                    | `invalid_transition`                                     |
| opposition | toute sauf `opposed`                                                                                                                          | `invalid_transition`                                     |

Refus d'acceptation propres à R2 :

- origine `document` : `origin_not_open` (ouverte en R3) ;
- annonce ou origine non classée : `origin_cannot_hold` ;
- `property.surface_m2` sur une vente de terrain (`property_type = 'land'`, `app_surface_kind = 'land'` ou `surface_scope = 'land'`) : `field_not_applicable` (voir point 4).

Pour rejeter, retirer ou s'opposer, `lot_attachment` reprend celui de la dernière décision, sinon `unknown`.

**Erreurs : liste fermée, message = code.**

| SQLSTATE | Messages                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 42501    | `admin_required`                                                                                                                                 |
| 22023    | `invalid_reason_code`, `invalid_lot_attachment`, `invalid_argument`                                                                              |
| P0002    | `claim_not_found`, `sale_not_found`                                                                                                              |
| 55000    | `invalid_transition`, `opposed_final`, `claim_detached`, `origin_not_open`, `origin_cannot_hold`, `field_not_applicable`, `registry_unavailable` |
| 55P03    | `sale_busy`                                                                                                                                      |
| 40001    | `retry`                                                                                                                                          |
| P0001    | `registry_write_failed`                                                                                                                          |

Le corps est dans un bloc `exception when others`. Il ne lit que `returned_sqlstate` et `constraint_name`, relève `registry_write_failed` sans `detail` ni `hint`, et n'appelle jamais `pg_exception_detail`. Le noyau du point 1 enveloppe de la même façon son appel à la projection. Côté application : la route ne relaie que `code` et `message`.

`registry_unavailable` : la fonction interne appelle d'abord `app_private.assert_fact_registry_triggers()` (point 11). Une projection sans retenue active est refusée.

**Lecture pour l'écran de relecture.** `public.get_admin_sale_field_registry(p_sale_id uuid) returns jsonb`, même contrôle `is_admin()`. Par champ : état, valeur tenue, valeur d'annonce mémorisée, origine, jour de réception, `claim_id`, `decision_id`, évènements non traités. L'application ne nomme ainsi jamais `held_fields`, et l'écran lit la valeur d'annonce au bon endroit.

**Verrous.** Création de fonctions seulement.

**Tests (`887_fact_claim_decision_rpcs.sql`).**

- Droits : `anon` et `service_role` ne peuvent pas exécuter, `authenticated` non administrateur reçoit 42501.
- Interrupteur MFA actif et jeton `aal1` : 42501.
- `actor_id` égal à `auth.uid()`, sans paramètre qui le fournisse.
- Chaque transition admise et refusée ; chaque motif hors liste.
- Retrait : la valeur d'annonce revient. Opposition : acceptation ultérieure refusée.
- Une violation 23514 provoquée sur `auction_sales` rend `registry_write_failed` sans aucune valeur de la ligne dans le message, le détail ou l'indice.
- `sale_busy` quand la vente est verrouillée par une autre session.

**Invariants.**

- Les cinq fonctions publiques ajoutées à la liste blanche de `supabase/tests/441_function_privileges.sql`.
- `registry-rpc-actor-from-jwt` : aucune de ces RPC n'a de paramètre d'auteur ; chacune contient `auth.uid()` et `public.is_admin()`.
- `registry-rpc-no-error-detail` : aucun `detail =`, `hint =` ni `pg_exception_detail` dans ces corps.
- `fact-registry-append-only` reste vrai (insertions dans des fonctions).

### 3. Écho de la collecte après retrait ou remplacement (Critique, L)

**Décision.** Deux protections : le pipeline cesse de prendre une valeur tenue pour une valeur d'annonce, et la base mémorise les anciennes valeurs tenues pour reconnaître un écho.

**a) Ce que la base mémorise.** Entrée de `held_fields` en version 2 :

```json
{"v":2,"state":"held","value":56,"echo":[54],"listing":{"app_surface_m2":50},"claim_id":"…","decision_id":"…"}
{"v":2,"state":"released","echo":[56,54],"released_by":"withdrawn","decision_id":"…","until":"2026-12-12","tolerance":{"abs":1,"rel":0.02}}
```

- `echo` : anciennes valeurs tenues de l'épisode, 5 au plus. La projection y ajoute la valeur précédente à chaque changement de valeur tenue.
- À la libération, l'entrée n'est plus supprimée : elle passe à `released` et garde `echo`. Cela vaut pour un retrait, une opposition, un rejet, une contradiction, et une libération par l'annonce (le déclencheur écrit alors l'entrée).
- `until` : absent après une opposition ou un retrait `authorization_withdrawn` (l'entrée vit autant que la vente) ; libération plus 30 jours dans les autres cas. [S] 30 jours à confirmer avec `data-pipeline` : il faut couvrir le plus long intervalle entre deux réécritures complètes d'une vente.
- Une entrée expirée est retirée par le déclencheur à l'écriture suivante, ou par toute projection. Aucune tâche planifiée n'écrit.
- Les lecteurs (mention, contrôle, RPC du pipeline) filtrent `state in ('held','conflicted')`.

**b) Règles du déclencheur de retenue.** I entrante, H tenue, L annonce mémorisée, E la liste `echo`.

Champ tenu :

| Écriture                     | Effet                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Colonne non écrite, ou I ≈ H | H reste, L inchangée                                                                    |
| I ≈ L                        | H reste                                                                                 |
| I ≈ une valeur de E          | H reste, L inchangée, évènement `echo_suppressed` (une fois par valeur et par décision) |
| I écrite et vide             | H reste, L vidée (point 8)                                                              |
| Autre                        | comme en R1                                                                             |

Champ libéré (`released`) :

| Écriture                                               | Effet                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| I ≈ une valeur de E, différente de la colonne actuelle | la colonne actuelle reste (groupe entier pour la surface), évènement `echo_suppressed` borné |
| Autre                                                  | passe, comme pour un champ libre                                                             |

**Colonnes voisines surveillées contre l'écho** (jamais tenues, constat A.1) :

- pour la surface : `habitable_surface_m2`, `carrez_surface_m2` ;
- pour le terrain : `surface_m2`, `app_surface_m2`, quand la surface n'est pas elle-même tenue.

Une valeur entrante sur ces colonnes, égale à H ou à une valeur de E et différente de la colonne actuelle, est remplacée par la colonne actuelle. Le déclencheur prend donc deux colonnes de plus dans sa liste `update of`.

Limite assumée : après un retrait, si l'annonce publie réellement la valeur retirée, elle est retenue jusqu'à `until` et visible en relecture par `echo_suppressed`. Pas de RPC de levée en R2.

**c) Ce que la base offre au pipeline.**

```sql
public.get_sale_field_baselines(p_sale_ids uuid[] default null)
returns table (sale_id uuid, field_key text, columns text[], listing jsonb)
-- security definer, service_role seul ; champs held ou conflicted seulement
-- jamais la valeur tenue, la pièce, la décision ni l'origine ; clé absente de listing = colonne nulle
```

Index partiel pour cette RPC sans argument et pour le contrôle quotidien (script d'index) :

```sql
create index concurrently auction_sales_held_fields_idx
  on public.auction_sales (id) where held_fields is not null;
```

Mesure : `explain (analyze, buffers) select id from public.auction_sales where held_fields is not null;`. Attendu avant : parcours séquentiel de toute la table. Attendu après : parcours d'index, moins de 1 ms. Coût d'écriture nul pour une ligne non tenue.

**d) Ce que la base exige du pipeline.**

| N°  | Exigence                                                                                                                                                                                           | Preuve côté base                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P1  | Remplacer les colonnes tenues par `listing` dans toutes les entrées : détails connus (`main.py:1316-1324`), `recompute_scoring.py`, fusion de doublons                                             | contrôle quotidien, indicateur d'écho                         |
| P2  | Marquer les champs recopiés depuis la base et n'en tirer aucune observation `source_listing`                                                                                                       | requête de contrôle sur les observations d'annonce égales à H |
| P3  | Dans `properties`, `judicial_sales`, `auction_surfaces`, `auction_features` : colonnes tenables prises dans la ligne rendue par l'écriture de `auction_sales`, jamais dans le dictionnaire entrant | contrôle quotidien, comparaison des copies                    |
| P4  | Tolérer que la ligne relue diffère de la ligne envoyée (`source_extraction_backfill.py`, repli REST)                                                                                               | sans objet                                                    |
| P5  | Plus de `select=*` sur `auction_sales` (`recompute_scoring.py:598`)                                                                                                                                | invariant de code, contrôle `raw_payload ? 'held_fields'`     |
| P6  | Ne jamais nommer `held_fields`, la projection ni son marqueur                                                                                                                                      | invariant existant                                            |

P1 doit être en production avant la bascule.

**Verrous.** `create or replace trigger aaab_auction_sales_hold_projected_fields` avec sa nouvelle liste de colonnes, puis `enable always` : SHARE ROW EXCLUSIVE sur `auction_sales`, hors import, `lock_timeout` 5 s. La contrainte de la colonne `event` est recréée avec `echo_suppressed` (table vide).

**Tests (`885_sale_field_hold_echo.sql`).**

- Retrait puis réimport de H : la colonne garde L, un seul évènement `echo_suppressed`.
- Remplacement 54 puis 56, réimport de 54 : 56 reste, L inchangée.
- Retrait avec L vide, puis `habitable_surface_m2 = H` entrant : refusé.
- Terrain retiré, puis `app_surface_m2 = H` entrant sur une vente de terrain : refusé.
- Entrée expirée : retirée, l'écriture passe.
- Après opposition : pas d'expiration.
- Nouvelle acceptation sur un champ `released` : `echo` conservé.
- `get_sale_field_baselines` ne rend ni valeur tenue ni identifiant de pièce, et n'est exécutable que par `service_role`.
- Écriture partielle (une seule colonne du groupe) et écriture complète.

**Invariants.** `hold-trigger-present-early` : ajouter les deux colonnes voisines à la liste attendue. Nouveau `pipeline-no-wildcard-sale-read` : aucun `select=*` ni `"select": "*"` visant `auction_sales` dans `services/data-pipeline/src/`.

### 4. Valeur écrite dans `app_surface_kind` et `surface_source` (Haute, S)

**Décision.**

- `surface_source = 'fact_registry'` : constante neutre, sans l'origine. L'origine reste dans `held_fields`.
- `app_surface_kind = 'built'` : valeur déjà employée par le pipeline pour « surface bâtie de nature non précisée » [V `asset_normalization_helpers.py:120-125`]. Le libellé public reste « Surface », jamais « Carrez » ni « habitable » [V `listing-public-information.ts:749-761`, `851-854`].
- `surface_confidence` : inchangé.

Une pièce de surface n'affirme donc aucune nature en R2 : le fait de l'agent n'en porte pas. La nature viendra en R3 avec les observations de documents, qui ont leurs propres clés.

**Terrain.** L'application traite comme terrain seul toute vente dont le genre ou la portée vaut `land` [V `surface.ts:234-246`]. Une pièce `property.surface_m2` y serait affichée comme un terrain : d'où le refus `field_not_applicable` du point 2. Un terrain se tient par `property.land_surface_m2`.

**Cohérence.**

- `habitable_surface_m2`, `carrez_surface_m2`, `surface_scope` : non tenus, issus de l'annonce si P1 est respecté, protégés contre l'écho.
- `surface_evidence` : ni tenu ni écrit. Le noyau cesse d'y déposer un extrait du message. Le tenir mettrait un texte d'annonce, qui peut contenir une donnée personnelle, hors de portée de `redact_personal_data`.
- Règle pour l'application (lot R2 côté application ou R4) : quand `surface_source = 'fact_registry'`, ne présenter ni `surface_evidence` ni les deux surfaces voisines comme preuve ou libellé de la valeur affichée. `fact-reliability.ts:704` lit aujourd'hui `surface_source` et `surface_evidence` ensemble.

**Tests.** Dans 883 et 886 : après pose, `surface_source = 'fact_registry'`, `app_surface_kind = 'built'`, `surface_evidence` inchangé ; aucune valeur commençant par `fact_registry_` ; après retrait, le bloc `listing` rend le genre et la source de l'annonce.

**Invariant.** `registry-neutral-surface-labels` : la dernière définition de la projection ne concatène rien à `'fact_registry'`.

### 5. Mention publique (Haute, M)

**Décision.** Le nom, le type de retour et les droits de `get_public_sale_lawyer_fact_sources` ne changent pas (`create or replace`). L'application reste telle quelle : elle ne lit que trois colonnes [V `src/lib/lawyer-fact-sources.ts:34-52`]. La fonction `app_private` lit `held_fields`, jamais `raw_payload` :

```sql
select case entry.key when 'property.surface_m2' then 'surface_m2'
                      when 'property.land_surface_m2' then 'land_surface_m2'
                      when 'property.rooms_count' then 'rooms_count'
                      when 'property.occupancy_status' then 'occupancy_status' end,
       case when entry.value->>'received_on' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            then (entry.value->>'received_on')::date end,
       'manual'
from public.auction_sales s
cross join lateral jsonb_each(s.held_fields) entry
where s.id = p_sale_id and s.held_fields is not null
  and app_private.auction_sale_is_publicly_visible(s.id)
  and entry.value->>'state' in ('held','conflicted')
  and entry.value->>'recipient_kind' = 'source_lawyer'
  and entry.value->>'source_kind' in ('lawyer_email','lawyer_form')
  and entry.value->>'publication_mode' = 'manual'
  -- et la colonne est encore égale à entry.value->'value'
```

- La colonne n'est pas exposée : fonction `security definer` dans `app_private`, enveloppe publique `security invoker` (le test 441 interdit à `anon` toute fonction `security definer` de `public` [V]).
- Pas de repli sur `raw_payload` : la mention tombe pour une publication antérieure à la bascule (échec fermé, point 13).
- Prix, date et type : plus de mention, puisque rien n'est affiché.

**Greffe, notaire, autre professionnel, document, saisie de l'équipe.** Jamais attribué à l'avocat. Nouvelle fonction, séparée pour qu'une ancienne version de l'application ne puisse pas mal attribuer :

```sql
public.get_public_sale_field_origins(p_sale_id uuid)
returns table (fact_key text, origin text, received_on date)   -- origin = 'other_source', rien d'autre
```

Elle rend les champs tenus dont l'origine n'est pas l'avocat poursuivant, sans distinguer greffe, notaire, document ou équipe. Affichage : valeur au statut « signalée », sans source d'annonce. Le texte relève du juriste (section E) ; d'ici là, aucune mention nommée.

**Visites.** Non tenues (contrainte `auction_fact_fields_visit_dates_locked` [V]). Leur mention vient de l'annonce seule, comme aujourd'hui. Un fait `visit_information` accepté n'écrit rien et ne produit aucune mention. Aucune des deux fonctions ne rend `sale.visit_dates`.

**Mesure du gain.** `explain (analyze, buffers) select * from app_private.get_public_sale_lawyer_fact_sources('<id d'une vente publique>');` avant et après. Attendu : disparition des lectures TOAST de `raw_payload`.

**Tests (`889_public_field_origins.sql`).**

- Mention rendue après un import qui réécrit `raw_payload`.
- Aucune ligne pour `source_contact`, `manual_professional`, un document, une entrée `released`, une vente non publique.
- `get_public_sale_field_origins` ne rend que `other_source`.
- `anon` n'a aucun droit sur `held_fields`.

**Invariant.** `public-origin-functions-closed-columns` : ces fonctions ne sélectionnent ni `claim_id`, ni `decision_id`, ni `source_kind`, ni `value`.

### 6. Fusion de doublons (Haute, L)

**Décisions.**

1. **Report des pièces.** Rien n'est déplacé. Les décisions gardent l'identifiant de la vente absorbée, les observations sont détachées par leur clé étrangère, la projection lit déjà les ventes absorbées [V `20261116100500:619-626`]. On ajoute la reprojection dans `app_private.carry_sale_user_data_to_merged_sale()`, après l'écriture de `auction_sale_merges` :

```sql
update public.information_agent_fact_publications p set sale_id = v_target where p.sale_id = old.id;
if old.held_fields is not null or exists (
     select 1 from public.auction_fact_claim_decisions d where d.sale_id = old.id) then
  perform app_private.project_sale_fields(
    v_target, null, true, app_private.sale_field_merge_hints(old.held_fields));
end if;
```

2. **Valeur d'annonce mémorisée.** La fusion écrit la vente conservée avant de supprimer l'absorbée ; ses colonnes peuvent déjà porter la valeur tenue de l'absorbée. La projection reçoit un quatrième paramètre `p_listing_hints jsonb default null`. À la première prise d'un champ, si les colonnes actuelles égalent la valeur ou un écho de l'indice, le bloc `listing` est celui de l'indice ; sinon c'est l'instantané des colonnes. La liste `echo` est reprise. L'ancienne signature à trois paramètres est supprimée.

3. **Observation détachée.** Une décision sur une observation détachée porte l'identifiant de la vente absorbée (règle de validation actuelle [V `20261116100000:357-363`]). La RPC résout la vente conservée par `auction_sale_merges` et la projette. Une observation détachée jamais décidée ne peut plus l'être : `claim_detached`. Le pipeline la réémet pour la vente conservée (constat A.5).

4. **Libération durable et vente absorbée.** Règle unique, sur la séquence commune (point 7) : un évènement `listing_changed_released` de la vente conservée écarte toute décision de l'ensemble (vente conservée et absorbées) dont `seq` est inférieur au sien. Un évènement d'une vente absorbée n'écarte que les décisions de cette vente (règle R1).

5. **`auction_sale_merges`.** Aucun changement de structure. La table reste à plat [V `20261029150000:46-54`], et `merged_at` ne sert jamais à ordonner.

6. **Journal des publications.** Reporté par `UPDATE`. La clé étrangère en cascade est gardée : la supprimer exigerait un verrou sur `auction_sales` [S].

7. **Dossiers de l'agent.** Non reportés en R2 : ils disparaissent en cascade comme aujourd'hui [V `20260825103748:9,34`]. Les pièces acceptées survivent sans eux.

**Risque d'interblocage.** Dans le repli REST, la suppression verrouille l'absorbée puis la conservée, hors de l'ordre par identifiant de `publication_identity.py:449-451`. La reprojection n'est donc appelée que s'il existe une pièce à reporter. Résidu : le détecteur d'interblocage annule une des deux transactions. À rejouer en test de concurrence.

**Verrous.** Remplacement de fonctions ; le déclencheur appelle la fonction par son nom.

**Tests (`888_registry_on_sale_merge.sql`).**

- Absorbée tenue, conservée libre et contaminée : champ tenu, `listing` = celui de l'absorbée, puis retrait qui rend la vraie valeur d'annonce.
- Les deux tenues par deux origines qui se contredisent : `conflicted`, affichage inchangé.
- Fusion en deux temps (A dans B, B dans C).
- Libération par l'annonce de la conservée, puis fusion d'une absorbée à pièce plus ancienne : le champ reste libre.
- Retrait après fusion sur une observation détachée : décision portée par l'ancien identifiant, vente conservée reprojetée.
- Observation détachée jamais décidée : `claim_detached`.
- Le journal des publications suit la vente conservée.
- Suppression sans vente conservée : aucun appel de la projection.

**Invariants.** `fact-claims-never-repointed` et `registry-no-fk-to-auction-sales` inchangés. `held-fields-projection-only` : la fonction de report lit `old.held_fields` sans jamais l'affecter (lecture à autoriser).

### 7. Ordre entre les deux journaux : séquence commune (Haute, M)

**Décision.** Une séquence `app_private.fact_registry_seq` alimente `seq` des deux journaux. La projection compare `released.seq > latest.seq` au lieu de `released.created_at >= latest.decided_at` [V `20261116100500:706`].

**Migration corrective sur M1, sûre à quatre conditions.**

```sql
lock table public.auction_fact_claim_decisions, public.auction_sale_field_hold_events
  in access exclusive mode;
do $$ begin
  if exists (select 1 from public.auction_fact_claim_decisions)
     or exists (select 1 from public.auction_sale_field_hold_events) then
    raise exception using errcode = '55000', message = 'fact registry journals are not empty';
  end if;
end $$;
create sequence if not exists app_private.fact_registry_seq as bigint;
revoke all on sequence app_private.fact_registry_seq from public, anon, authenticated, service_role;
alter table public.auction_fact_claim_decisions alter column seq drop identity if exists;
alter table public.auction_sale_field_hold_events alter column seq drop identity if exists;
-- les déclencheurs BEFORE INSERT (validate…, stamp…) imposent new.seq := nextval(…)
```

1. **Tables vides** : vérifié sous verrou, sinon la migration échoue sans effet.
2. **Aucun écrivain** : rien n'insère dans ces tables avant la bascule ; le déclencheur de retenue n'y écrit que pour une vente tenue.
3. **Aucun verrou sur `auction_sales` ni `auction_fact_claims`.**
4. **Même garantie que `generated always`** : l'écrivain ne choisit pas `seq`, imposé par les déclencheurs en mode `always`. `seq` reste `not null` et unique.

M1 n'est pas modifiée : c'est une nouvelle migration, donc pas de dérive entre production et base d'ombre.

**Pourquoi l'ordre est exact.** Une séquence suit l'ordre d'attribution, pas l'ordre de validation. Toute écriture du registre pour une vente se fait sous le verrou de ligne de cette vente, pris avant l'insertion de la décision (points 1 et 2). Pour une vente, l'ordre de `seq` est donc l'ordre réel.

**Restauration.** Après une restauration de données seules : `setval` au maximum des deux tables plus un. À écrire dans le runbook, avec le constat A.8.

**Aussi dans cette migration.** `updated_at` monotone dans la projection : `greatest(statement_timestamp(), updated_at + interval '1 microsecond')`.

**Tests (`884_fact_registry_common_sequence.sql`).** Les deux `seq` viennent de la même séquence ; un `seq` fourni par l'écrivain est remplacé ; une libération suivie d'une décision écrite avec une date falsifiée respecte l'ordre de `seq` ; deux écritures d'une même instruction.

**Invariants.** `fact-registry-append-only` : ajouter que les deux fonctions de déclencheur contiennent `nextval('app_private.fact_registry_seq')`, et qu'aucune migration ne fait `setval` ni `alter sequence` dessus.

### 8. Valeur d'annonce mémorisée périmée (Moyenne, S)

**Décision.** Pour un champ tenu, quand une écriture change explicitement une colonne (`new.col is distinct from old.col`) et que la valeur entrante ne dit rien, le bloc `listing` perd cette colonne. Sans évènement. Pour l'occupation, `unknown` est mémorisé tel quel. Une colonne non écrite, ou égale à H, ne change rien.

Effet : si l'annonce cesse de donner la valeur, le retrait rend un champ vide et non l'ancienne valeur d'annonce. Cela vaut aussi quand le pipeline retire volontairement une surface non établie.

Condition : P1. Sans lui, une vente inchangée reçoit H par recopie, jamais une valeur vide, et L reste périmée. Le contrôle quotidien compte les champs tenus dont `listing` n'a pas bougé depuis plus de 30 jours.

**Tests.** Dans 885 : écriture explicite de NULL puis retrait (colonne vide) ; écriture partielle d'une autre colonne (L inchangée) ; occupation `unknown` ; groupe de surface vidé colonne par colonne.

### 9. Gardes par rôle : liste blanche (Haute, S)

**Décision.** Liste blanche. Les deux gardes n'acceptent qu'un rôle : le propriétaire de la projection.

```sql
-- app_private.refuse_api_role_held_fields_write(), security invoker
if current_user in ('anon', 'authenticated', 'service_role', 'authenticator')      -- gardé
   or current_user is distinct from (
     select pg_catalog.pg_get_userbyid(p.proowner)
     from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = 'project_sale_fields')
then raise exception using errcode = '42501', message = '…'; end if;
```

Même règle pour `refuse_api_role_registry_origin` (origines réservées de `auction_fact_claims`). La recherche passe par `pg_proc` et non par `regprocedure`, qui exige un droit sur le schéma. Elle ne s'exécute que lorsque `held_fields` change.

**Limite, à dire clairement.** [S] Si le chemin SQL direct du pipeline (`SUPABASE_DB_URL`) se connecte avec le rôle propriétaire des fonctions, aucune garde par rôle ne le distingue de la projection. La liste blanche ferme tous les autres rôles, présents et futurs. Pour ce chemin, la protection reste l'invariant de code. Elle ne devient réelle qu'avec un rôle de connexion propre au pipeline, non propriétaire : chantier séparé pour `devops-ci` et `securite-applicative`. La mesure F.7 dit quel rôle écrit aujourd'hui.

**Verrous.** Remplacement de deux fonctions.

**Tests.** Dans 884 : un rôle créé pour le test, hors liste d'exclusion, est refusé même avec le marqueur posé ; la projection passe ; `service_role` reste refusé.

**Invariant.** `hold-trigger-present-early` exige déjà la liste d'exclusion dans le corps (`check-security-invariants-fact-registry.mjs:587-598`) : y ajouter l'exigence de la comparaison au propriétaire.

### 10. RPC qui rendent la ligne entière, et `auction_sale_history` (Haute, S)

**RPC.** [V] `set_auction_sale_readiness_override` et `clear_auction_sale_readiness_override` font `returning * into result` et rendent `public.auction_sales` (`20260919123000:243,268,282,300`). Elles sont exécutables par `authenticated`. L'application ne lit que `error` [V `src/lib/admin-catalogue-readiness.ts:304-312`].

Décision : `drop function` puis `create function` dans la même transaction, mêmes arguments, `returns jsonb` avec `id` et les cinq colonnes `premium_readiness_override*`. Mêmes droits. L'ordre de déploiement est indifférent. Les types générés sont à régénérer.

**Historique.** [V] `log_auction_sale_change` (`20261109140000:17-72`) écrirait pour `held_fields` une empreinte à chaque mise à jour de la valeur d'annonce. Décision : `held_fields` est exclu, comme `raw_payload` (mis à NULL sur la copie locale, ajouté à la liste des clés ignorées). Les colonnes tenues restent journalisées : c'est l'historique normal de la fiche. Conséquence pour le juriste : la valeur d'une pièce retirée reste 12 mois dans `auction_sale_history` (purge `20261009186000:156`).

**Verrous.** Fonctions seulement.

**Tests.** Aucune fonction de `public` ne rend `public.auction_sales` (`pg_proc.prorettype`) ; les deux RPC rendent six clés ; une projection n'ajoute à l'historique aucune clé `held_fields`.

**Invariant.** `no-whole-sale-row-returned` : aucune dernière définition de fonction de `public` ne contient `returns public.auction_sales`, `returns setof public.auction_sales`, ni `returning *` sur `auction_sales`.

### 11. Rattrapage qui coupe les déclencheurs (Haute, S)

**Constat.** [V] `supabase/repairs/20261029100200_recompute_past_quarantined_deadlines.sql:130,140` fait `disable trigger user` puis `enable trigger user`. Le second remet tous les déclencheurs en mode ordinaire.

**Décision, en trois parties.**

1. **Réécrire le fichier** (par `developpeur`). Il ne coupe plus que les déclencheurs qu'il veut taire, par leur nom : un bloc `do` parcourt `pg_trigger` pour `public.auction_sales`, ne garde que ceux en mode ordinaire (`tgenabled = 'O'`) dont le nom ne commence pas par `aaab_`, les note dans une table temporaire, puis rétablit exactement ceux-là. Un déclencheur `always` n'est jamais touché. Le fichier sort alors de la liste `HISTORICAL_REPAIRS` (`check-security-invariants-fact-registry.mjs:74-84`) et retombe sous l'invariant, qui refuse `disable trigger user`.

2. **Fonction de contrôle.**

```sql
app_private.assert_fact_registry_triggers() returns void   -- aucun droit
-- lève 55000 'registry_unavailable' si l'un des trois déclencheurs aaab_ de auction_sales,
-- ou l'un des déclencheurs des journaux et de auction_fact_claims, n'est pas en tgenabled = 'A'
```

Appelée par les RPC de décision et le noyau avant toute écriture (échec fermé), par le contrôle quotidien, et en dernière instruction de tout rattrapage qui écrit `auction_sales`.

3. **Runbook.** Une restauration de données seules se fait après retrait des trois déclencheurs `aaab_` de la base cible, recréés ensuite par la migration (constat A.8).

**Tests.** `assert_fact_registry_triggers` passe en l'état ; lève après un `enable trigger` simple (test en transaction annulée) ; les RPC rendent alors `registry_unavailable`. Le test des rattrapages (`services/data-pipeline/tests/test_chantier_f_repairs_sql.py`) rejoue le fichier réécrit et vérifie le mode des déclencheurs après application.

**Invariant.** Tout fichier de `supabase/repairs/` postérieur au lot qui écrit `auction_sales` se termine par `select app_private.assert_fact_registry_triggers();` avant son `commit`.

### 12. Contrôle quotidien (Haute, M)

**Décision.** Pas de tâche `pg_cron` directe : elle ne sait pas alerter. Selon la règle de `docs/operations/planification.md` (une tâche quotidienne est une entrée Vercel Cron), une route `/api/cron/fact-registry-check` supervisée appelle une fonction en lecture seule :

```sql
public.check_fact_registry_consistency(p_limit integer default 500) returns jsonb
-- security definer, service_role seul ; n'écrit rien ; simule par project_sale_fields(…, false)
```

Horaire : 05:28 UTC, seuil `cron.stale` de 27 heures. À inscrire dans `vercel.json`, `planification.md` et `src/lib/scheduled-jobs.test.ts`.

| Contrôle                                                                                                                                        | Alerte (`operational_alerts`)          | Gravité  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- |
| Vente tenue, ou vente dont une pièce a pour dernière décision une acceptation tenable : la simulation rend `changed = true`                     | `fact_registry.projection_drift`       | Critique |
| Un déclencheur du registre hors du mode `always`                                                                                                | `fact_registry.triggers_not_always`    | Critique |
| Colonne tenue différente de la valeur de l'entrée ; `surface_source` différent de `fact_registry`                                               | `fact_registry.column_mismatch`        | Critique |
| Colonne voisine ou copie (`properties`, `judicial_sales`, `auction_surfaces`) égale à une valeur tenue ou à un écho, et différente de l'annonce | `fact_registry.echo_suspected`         | Haute    |
| `raw_payload ? 'held_fields'` sur une vente tenue                                                                                               | `fact_registry.internal_column_copied` | Haute    |
| Plus de 50 évènements en 24 heures                                                                                                              | `fact_registry.events_burst`           | Moyenne  |
| Champ tenu dont `listing` n'a pas bougé depuis 30 jours ; surface tenue sur une vente passée en `surface_scope = 'land'`                        | `fact_registry.stale_listing`          | Basse    |

L'alerte porte des comptes et au plus 20 identifiants de vente, jamais une valeur. Coût [S] : quelques sondes d'index par vente tenue, grâce à l'index partiel du point 3 ; moins d'une seconde pour quelques centaines de ventes. Livré en R2a, il doit rendre zéro partout avant la bascule.

**Tests (dans 889).** La fonction n'écrit rien (aucun `xmin` changé, aucune ligne de journal) ; elle détecte une dérive provoquée, un déclencheur hors mode, une colonne voisine en écho ; droits fermés.

**Invariant.** `field-projection-not-callable-by-api` reste vrai : la route nomme `check_fact_registry_consistency`, jamais la projection.

### 13. Reprise de l'existant (Haute, S à M selon la mesure)

**Ce que l'ancien noyau a écrit** [V `20261114100000`] :

- les colonnes en place (lignes 243-335), avec `app_surface_kind` et `surface_source` à `information_agent_verified` pour la surface ;
- une entrée dans `raw_payload.information_agent_verified_facts` (412-439) ;
- une ligne de journal avec `previous_values` (478-484) ;
- par le pont, une observation au statut `accepted` (754-811).

Les faits acceptés avant cette migration n'ont pas de ligne de journal (commentaire, lignes 35-38). **Un journal vide ne prouve donc pas qu'aucune valeur n'a été publiée.** La mesure porte sur trois tables (F.6).

**Cas vide** (les trois comptes à zéro). La migration de bascule ne reprend rien et ne lit pas `raw_payload`. Elle contrôle : si `information_agent_fact_publications` contient une ligne, elle émet un `raise notice` avec le compte, sans échouer.

**Cas non vide.** La migration ne remplit ni `held_fields` ni les journaux : une acceptation est une décision humaine datée, et l'invariant interdit toute insertion dans un journal hors d'une fonction. Elle n'échoue pas. Conséquences : la mention tombe pour ces ventes (échec fermé), la valeur reste dans la colonne jusqu'à la collecte suivante, comme aujourd'hui. Puis, dans l'ordre :

1. **Rattrapage** `supabase/repairs/…_restore_listing_values_before_registry.sql` (comptage par défaut, hors import). Pour chaque ligne du journal dont les colonnes égalent encore `new_values`, il rend `previous_values`. Sans cela, la première prise mémoriserait la valeur de l'avocat comme valeur d'annonce, et un retrait ne retirerait rien. Les faits sans ligne de journal sont listés pour un traitement à la main.
2. **Nouvelle acceptation** par un administrateur, fait par fait, avec `accept_auction_fact_claim` sur l'observation créée par le pont (elle n'a pas de décision, la transition est admise). La décision porte son vrai auteur et sa vraie date.

En défense : à la première prise, la projection ne mémorise pas un bloc `listing` dont `surface_source` vaut `information_agent_verified`.

**Tests.** Dans 886 : une observation du pont sans décision ne tient rien, puis tient après acceptation par la RPC ; la projection ignore un bloc d'annonce marqué `information_agent_verified`. Le rattrapage est testé comme les autres fichiers de `supabase/repairs/`.

---

## C. Plan de migrations ordonné

Chaque fichier commence par `set local lock_timeout = '5s'; set local statement_timeout = '60s';`. Vercel déploie avant la migration : tout code qui appelle un objet nouveau tolère son absence (`PGRST202`, `42883`).

| N°         | Fichier                                                         | Contenu                                                                             | Verrous                                                         | Pendant un import                                             | Retour arrière                                                                            |
| ---------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A1         | `20261117100000_fact_registry_common_sequence.sql`              | Point 7                                                                             | ACCESS EXCLUSIVE sur les deux journaux (vides)                  | Possible, déconseillé                                         | Tables encore vides : rétablir l'identité                                                 |
| A2         | `20261117100100_fact_registry_guards.sql`                       | Point 9, `assert_fact_registry_triggers`, évènement `echo_suppressed`               | ACCESS EXCLUSIVE bref sur la file d'évènements                  | Possible                                                      | Fonctions et contrainte de M1                                                             |
| A3         | `20261117100200_field_hold_and_projection_v2.sql`               | Points 3, 4, 6 (indices), 8 ; projection à 4 paramètres ; déclencheur recréé        | SHARE ROW EXCLUSIVE sur `auction_sales`                         | **Non**                                                       | Réappliquer les définitions de `20261116100500`, tant que `held_fields` est nulle partout |
| A4         | `20261117100300_sale_history_skips_held_fields.sql`             | Point 10, historique                                                                | Aucun                                                           | Oui                                                           | Définition de `20261109140000`                                                            |
| A5         | `20261117100400_readiness_override_rpcs_summary.sql`            | Point 10, deux RPC                                                                  | Aucun                                                           | Oui                                                           | Définitions de `20260919123000`                                                           |
| A6         | Script d'index, hors transaction                                | `auction_fact_claims_agent_fact_key`, `auction_sales_held_fields_idx`               | SHARE UPDATE EXCLUSIVE ; attend la fin des transactions longues | Possible, plus rapide hors import                             | `drop index concurrently`                                                                 |
| A7         | `20261117100500_fact_registry_baselines_and_check.sql`          | `get_sale_field_baselines`, `check_fact_registry_consistency`                       | Aucun                                                           | Oui                                                           | `drop function`                                                                           |
| B1         | `20261118100000_fact_claim_decision_rpcs.sql`                   | Point 2, **sans `grant` à `authenticated`** ; `review_auction_fact_claim` retouchée | Aucun                                                           | Oui                                                           | `drop function` ; ancienne `review_auction_fact_claim`                                    |
| B2         | `20261118100100_carry_registry_on_sale_merge.sql`               | Point 6                                                                             | Aucun                                                           | **Non** (une fusion en cours changerait de fonction en route) | Définition de `20261029150000`                                                            |
| C1         | `20261119100000_information_agent_core_registry.sql`            | Points 1, 5, 13 ; pont supprimé ; `grant` des RPC                                   | ACCESS EXCLUSIVE bref sur `information_agent_fact_candidates`   | **Non**, et hors relecture                                    | Voir ci-dessous                                                                           |
| Rattrapage | `supabase/repairs/…_restore_listing_values_before_registry.sql` | Point 13, cas non vide                                                              | Lignes ciblées                                                  | **Non**                                                       | Table de sauvegarde                                                                       |

**Retour arrière de C1**, dans cet ordre :

1. suspendre la relecture dans l'interface ;
2. retirer par la RPC chaque pièce posée depuis la bascule (motif `other`) : les valeurs d'annonce reviennent ;
3. rétablir le noyau, la RPC de relecture, le pont et la mention de `20261114100000` ;
4. ne retirer les déclencheurs de R1 que si `held_fields` est nulle partout.

Les journaux sont gardés.

**À ne jamais faire pendant un import** : A3, B2, C1, tout rattrapage, toute création de déclencheur ou de contrainte sur `auction_sales`.

---

## D. Découpage en sous-lots

R2 est trop gros pour une seule PR : trois sous-lots, chacun réversible.

| Sous-lot               | Contenu                                                                                                                                                 | Ce qui reste inerte                                                                                           | Critère pour passer au suivant                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R2a, durcissement**  | A1 à A7 ; rattrapage réécrit (point 11) ; contrôle quotidien et sa route ; tests 884, 885, 889 (partie contrôle) ; invariants ; côté pipeline : P1 à P5 | Tout : aucune décision, aucun champ tenu, la RPC des valeurs d'annonce rend zéro ligne                        | Critères de la section F tenus ; contrôle quotidien à zéro sur deux passages ; durée des imports inchangée après A3                                                         |
| **R2b, fusion et RPC** | B1, B2 ; tests 887, 888                                                                                                                                 | Les RPC existent sans droit d'exécution ; la reprojection à la fusion n'est appelée que s'il existe une pièce | P1 en production et vérifié par l'indicateur d'écho ; répétition complète sur base jetable (import réel rejoué, pose, retrait, fusion) ; mesure F.6 lue par le propriétaire |
| **R2c, bascule**       | C1 ; application (écran de relecture, messages d'erreur, origine `other_source`) ; test 886 ; rattrapage éventuel                                       | Plus rien : première acceptation réelle possible                                                              | Après la première pièce posée : contrôle quotidien à zéro, mention affichée, retrait essayé sur une vente interne                                                           |

Effort : R2a L (2 à 3 jours), R2b L, R2c L.

---

## E. Questions pour le propriétaire ou un juriste

**Pour `juridique-rgpd` ou un avocat :**

| N°  | Question                                                                                                                                                                                                                        | Option la plus prudente                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| J1  | Après une opposition, la valeur reste dans l'observation (immuable), dans la file d'évènements, dans la liste `echo` et 12 mois dans `auction_sale_history`. La cessation d'affichage suffit-elle, ou faut-il pouvoir effacer ? | Opposition = fin d'affichage et blocage du retour de la valeur. Une demande d'effacement se traite à la main, hors R2 |
| J2  | Garder la valeur opposée pour reconnaître son retour (logique de liste de suppression) est-il fondé ?                                                                                                                           | Oui, limité à la vie de la vente : l'entrée disparaît avec elle                                                       |
| J3  | Texte affiché pour une valeur venue d'un greffe, d'un notaire, d'un autre professionnel ou d'un document                                                                                                                        | Aucune mention nommée : valeur « signalée », sans source, tant que le texte n'est pas validé                          |
| J4  | Durée de conservation des deux journaux, identifiant de l'administrateur après suppression de son compte (déjà au plan, section 9)                                                                                              | Garder, sans texte libre                                                                                              |
| J5  | `properties` et `judicial_sales`, lisibles par les comptes connectés, peuvent porter une valeur retirée                                                                                                                         | Retirer le droit de lecture à `authenticated` si la mesure F.11 confirme qu'aucun lecteur ne passe par l'API          |

**Pour le propriétaire :**

| N°  | Question                                                                                                                                                   | Option la plus prudente                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| O1  | Mise à prix, date de vente et type de bien acceptés d'un avocat : enregistrés et non affichés en R2. Les rendre tenables ?                                 | Non affichés tant que la règle « annonce contre pièce » n'est pas choisie pour ces champs |
| O2  | Le noyau publie toujours une pièce jointe acceptée comme document téléchargeable, alors que le choix 6 dit « aucun document téléchargeable par le public » | Suspendre l'acceptation de la clé `document` jusqu'à décision                             |
| O3  | Durée de la mémoire d'écho hors opposition : 30 jours                                                                                                      | 30 jours, à réviser après mesure du cycle de collecte                                     |
| O4  | L'exigence de second facteur est-elle active en production (F.12) ? Sinon « MFA compris » ne vaut rien                                                     | L'activer avant R2c                                                                       |
| O5  | Cas non vide du point 13 : rendre la valeur d'annonce puis revalider fait par fait                                                                         | Oui, rien d'automatique                                                                   |
| O6  | Rôle de connexion propre au pipeline (point 9)                                                                                                             | L'ouvrir comme chantier séparé, sans bloquer R2                                           |

---

## F. Mesures à confier à `qualite-donnees` (lecture seule) et critères d'observation

**Critères qui autorisent R2a après 24 heures de R1** (pas avant le 12/11/2026 à 11:45 UTC, et après au moins un import complet de chaque source) : mesures 1 à 5 conformes, aucune erreur 42501 liée à `held_fields` dans les journaux, contrôle de dérive de schéma au vert.

1. Aucun champ tenu, aucun évènement, aucune décision. Attendu : 0, 0, 0.

```sql
select (select count(*) from public.auction_sales where held_fields is not null) as ventes_tenues,
       (select count(*) from public.auction_sale_field_hold_events) as evenements,
       (select count(*) from public.auction_fact_claim_decisions) as decisions;
```

2. Mode et ordre des déclencheurs. Attendu : `A` pour les trois `aaab_`, les cinq déclencheurs des journaux et les deux de `auction_fact_claims`.

```sql
select c.relname, t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal and c.relname in ('auction_sales','auction_fact_claims',
  'auction_fact_claim_decisions','auction_sale_field_hold_events') order by 1, 2;
```

3. Coût de l'import avant et après. Attendu : écart de `mean_exec_time` inférieur à 5 % sur au moins 1 000 appels. [S] Si aucun relevé n'a été pris avant le 11/11, comparer la durée des imports des 7 jours précédents dans `auction_runs`.

```sql
select calls, mean_exec_time, max_exec_time, left(query, 80) from pg_stat_statements
where query ilike 'insert into "public"."auction_sales"%' order by calls desc limit 5;
```

4. Appels de la retenue. Attendu : 0, si `track_functions` le permet.

```sql
show track_functions;
select funcname, calls from pg_stat_user_functions
where funcname in ('hold_projected_sale_fields','refuse_inserted_held_fields','refuse_api_role_held_fields_write');
```

5. Verrous longs pendant un import, pour confirmer le délai de 3 secondes. À relever trois fois pendant un import.

```sql
select pid, usename, now() - xact_start as duree_transaction, state, left(query, 60)
from pg_stat_activity where xact_start is not null and datname = current_database()
order by xact_start limit 10;
```

6. Reprise de l'existant (point 13). Attendu : 0 partout.

```sql
select 'publications' as quoi, count(*) from public.information_agent_fact_publications
union all select 'faits_acceptes', count(*) from public.information_agent_fact_candidates
  where status = 'accepted' and fact_key in ('surface_m2','land_surface_m2','rooms_count',
    'occupancy_status','starting_price_eur','sale_date','property_type')
union all select 'observations_du_pont', count(*) from public.auction_fact_claims
  where evidence_locator ? 'information_agent_fact_id'
union all select 'surfaces_marquees', count(*) from public.auction_sales
  where surface_source = 'information_agent_verified';
```

Si non nul, détail par vente (aucune lecture de `raw_payload`) :

```sql
select p.sale_id, p.fact_key, p.published_at, p.recipient_kind, p.previous_values, p.new_values
from public.information_agent_fact_publications p order by p.published_at;
```

7. Rôle qui écrit les ventes, et propriétaire des fonctions (point 9).

```sql
select r.rolname, sum(s.calls) from pg_stat_statements s join pg_roles r on r.oid = s.userid
where s.query ilike '%auction_sales%' and s.query ilike 'insert%' group by 1;
select p.proname, pg_get_userbyid(p.proowner) from pg_proc p
where p.proname in ('project_sale_fields','hold_projected_sale_fields');
```

8. Doublons avant l'index unique. Attendu : 0 ligne.

```sql
select evidence_locator->>'information_agent_fact_id', count(*) from public.auction_fact_claims
where evidence_locator ? 'information_agent_fact_id' group by 1 having count(*) > 1;
```

9. Fréquence des fusions.

```sql
select date_trunc('week', merged_at) as semaine, count(*) from app_private.auction_sale_merges
group by 1 order by 1 desc limit 8;
```

10. Ventes à plusieurs lots et ventes de terrain parmi les ventes à venir (portée des refus des points 1 et 2).

```sql
select count(*) filter (where quality_flags ? 'multi_lot_sale') as multi_lots,
       count(*) filter (where property_type = 'land' or app_surface_kind = 'land' or surface_scope = 'land') as terrains,
       count(*) as total
from public.auction_sales where status in ('active','upcoming');
```

11. Lecteurs de `properties` et `judicial_sales` par l'API : compter sur 7 jours, dans les journaux PostgREST de Supabase, les requêtes `GET /rest/v1/properties` et `GET /rest/v1/judicial_sales` par rôle. Attendu : aucune hors `service_role`.

12. Second facteur des administrateurs. Attendu : `true` avant R2c.

```sql
select enabled, updated_at from app_private.security_switches where switch_name = 'admin_mfa_required';
```

13. Nom réel de la contrainte de la colonne `event`, à recréer en A2.

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.auction_sale_field_hold_events'::regclass and contype = 'c';
```

14. Avant et après C1, coût de la mention publique : `explain (analyze, buffers) select * from app_private.get_public_sale_lawyer_fact_sources('<id d'une vente publique>');`. Attendu après : plus aucune lecture TOAST.

15. Avant et après A6 : les deux `explain` des points 1 et 3.

**À vérifier sur base jetable par `developpeur`, pas en production :**

- restauration de données seules d'une vente tenue (constat A.8) ;
- existence d'un test ou d'un invariant qui exige le pont (point 1) ;
- les trois cas de concurrence de R1, plus la fusion par le repli REST face à un lot SQL (point 6) ;
- 30 jours de mémoire d'écho face au cycle réel des sources.

## Fichiers lus

- `/home/user/immojudis/docs/equipe/2026-11-11-registre-des-pieces.md`
- `/home/user/immojudis/docs/equipe/annexes/2026-11-11-registre-des-pieces/03-base-de-donnees-arbitrage.md`
- `/home/user/immojudis/docs/architecture/registre-des-pieces.md`
- `/home/user/immojudis/docs/operations/planification.md`
- `/home/user/immojudis/supabase/migrations/20261116100000_fact_registry_tables.sql`
- `/home/user/immojudis/supabase/migrations/20261116100100_fact_claims_kinds_truncate.sql`
- `/home/user/immojudis/supabase/migrations/20261116100300_auction_sales_held_fields.sql`
- `/home/user/immojudis/supabase/migrations/20261116100500_field_projection_and_hold.sql`
- `/home/user/immojudis/supabase/migrations/20261114100000_information_agent_publication_core.sql`
- `/home/user/immojudis/supabase/migrations/20261115100000_information_agent_auto_publication_simulation.sql`
- `/home/user/immojudis/supabase/migrations/20260928200000_information_agent_fact_claim_bridge.sql`
- `/home/user/immojudis/supabase/migrations/20260928180000_admin_auction_fact_claim_review.sql`
- `/home/user/immojudis/supabase/migrations/20260928140000_auction_fact_claims.sql`
- `/home/user/immojudis/supabase/migrations/20261029150000_carry_reminder_dispatches_on_sale_merge.sql`
- `/home/user/immojudis/supabase/migrations/20261028110000_carry_user_data_on_sale_merge.sql`
- `/home/user/immojudis/supabase/migrations/20260919123000_premium_catalogue_readiness.sql`
- `/home/user/immojudis/supabase/migrations/20261109140000_light_history_trigger_and_projection_payloads.sql`
- `/home/user/immojudis/supabase/migrations/20261010002000_admin_mfa_switch.sql`
- `/home/user/immojudis/supabase/repairs/20261029100200_recompute_past_quarantined_deadlines.sql`
- `/home/user/immojudis/supabase/repairs/README.md`
- `/home/user/immojudis/supabase/tests/441_function_privileges.sql`
- `/home/user/immojudis/supabase/tests/883_sale_field_projection.sql` (plan seulement)
- `/home/user/immojudis/scripts/check-security-invariants-fact-registry.mjs`
- `/home/user/immojudis/scripts/check-security-invariants.mjs` (lignes 2054 à 2243)
- `/home/user/immojudis/src/lib/surface.ts`
- `/home/user/immojudis/src/lib/listing-public-information.ts`
- `/home/user/immojudis/src/lib/sale-views.ts`
- `/home/user/immojudis/src/lib/lawyer-fact-sources.ts`
- `/home/user/immojudis/src/lib/fact-reliability.ts`
- `/home/user/immojudis/src/lib/admin-information-agent.ts`
- `/home/user/immojudis/services/data-pipeline/src/main.py`
- `/home/user/immojudis/services/data-pipeline/src/recompute_scoring.py`
- `/home/user/immojudis/services/data-pipeline/src/fact_claims.py`
- `/home/user/immojudis/services/data-pipeline/src/asset_normalization_helpers.py`
- `/home/user/immojudis/services/data-pipeline/src/publication_identity.py`
- `/home/user/immojudis/services/data-pipeline/src/storage/supabase_client.py`
- `/home/user/immojudis/services/data-pipeline/src/catalogue_readiness.py`
