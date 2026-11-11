<!-- Rapport du spécialiste `expert-postgres`, rendu le 11/11/2026 dans la mission « registre des pièces ». Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Arbitrage : registre des pièces, où appliquer la règle (expert-postgres, lecture seule)

Je n'ai rien modifié et rien exécuté en base. Avant de rédiger, j'ai relu `docs/equipe/2026-11-10-enrichissement-automatique-fiches.md` : l'étape 2 bis y est « en attente de validation », et le rapport note qu'aucune vente n'a d'information d'avocat acceptée en production. Dans ce rapport, [V] signale ce que j'ai vérifié dans le code et [S] ce que je suppose sans mesure.

---

## 1. Verdict : une troisième voie, avec un déclencheur en base qui ne fait que retenir

La protection doit vivre en base, mais pas sous la forme proposée par l'architecte. Je sépare deux rôles :

- **un déclencheur de retenue, passif.** Il ne calcule aucun gagnant et ne lit ni les observations, ni la préséance, ni `raw_payload`. Il remet seulement l'ancienne valeur des champs déjà tenus.
- **une projection appelée explicitement.** C'est la seule écriture qui change une fiche à partir des pièces. Le déclencheur ne l'appelle jamais.

Les valeurs de l'annonce restent dans les colonnes actuelles tant qu'aucune pièce ne les tient. On ne réimplémente donc pas en SQL la logique de surface du pipeline : les pièces « annonce » et « PDF » ne tiennent jamais un champ dans la première version.

### Pourquoi la base et pas Python

- **[V] Plusieurs chemins écrivent les 5 colonnes hors de `_write_sale_revisions`** :
  - repli REST, `_upsert_with_rest` (`supabase_client.py:595`) ;
  - fusion de doublons, `_postgres_upsert` puis repli REST (`supabase_client.py:2865` et `2875`) ;
  - `source_extraction_backfill.py`, un PATCH par ligne sur `surface_m2`, `rooms_count`, `visit_dates`… (lignes 50-87 et 781) ;
  - `address_positions.py:116,127`, `redact_personal_data.py:206`, et les réparations.

  Une garde Python en oublie forcément.

- **[V] La garde Python serait exposée à une course.** La ligne entrante est construite à partir d'une lecture faite bien avant l'écriture (rétro-remplissage `main.py:1316-1324`). En lecture validée, `insert … on conflict do update` et un `UPDATE` réévaluent la dernière version de la ligne une fois le verrou pris. Le déclencheur BEFORE voit donc toujours le `OLD` validé par une acceptation concurrente. Python ne le voit que s'il relit sous verrou, ce que le repli REST ne peut pas faire.

### Réponses aux objections du spécialiste du pipeline

| Objection                                                  | Réponse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un déclencheur de plus sur la table chaude                 | Le déclencheur est `BEFORE UPDATE OF <colonnes tenues>, held_fields`, avec `WHEN (old.held_fields is not null or new.held_fields is distinct from old.held_fields)`. Pour plus de 99 % des lignes, seule la clause WHEN est évaluée (deux tests de nullité) : aucun appel PL/pgSQL. Pas de branche INSERT : une ligne neuve ne tient rien, et `on conflict do update` passe par la branche UPDATE.                                                                                                   |
| Verrou `SHARE ROW EXCLUSIVE` à la création                 | Il est réel. Migration dédiée, `lock_timeout 5s`, hors import, sur le modèle de `20261028100200:29-31`.                                                                                                                                                                                                                                                                                                                                                                                              |
| Impossible de distinguer le noyau du pipeline sans drapeau | La règle est : « `held_fields` change dans le même UPDATE, donc c'est la projection ». Une seconde publication sur la même clé réécrit `held_fields` et passe. En défense en profondeur, un changement de `held_fields` exige `current_setting('app.sale_field_projection', true) = new.id::text`, posé en local par la projection. Sinon : exception 42501. Le pipeline n'écrit jamais `held_fields` : il est absent de `UPSERT_COLUMNS` (`column_sets.py:20-90`) [V], et un invariant le garantit. |
| Tolérances et fusion de `jsonb` en PL/pgSQL                | Pas de fusion : un champ tenu l'est en entier. La tolérance numérique est copiée dans l'entrée `held_fields` par la projection, donc le déclencheur ne lit aucune table. `visit_dates` se compare comme tableau trié de dates normalisées.                                                                                                                                                                                                                                                           |
| Lecture de `OLD.raw_payload`                               | Jamais. Interdire `to_jsonb(new)` et `to_jsonb(old)` dans cette fonction. Les autres déclencheurs (garde des observations, lignes 321 et 340) utilisent ce motif, qui détoasterait toute la ligne.                                                                                                                                                                                                                                                                                                   |
| Ordre des déclencheurs (`zzzz_`)                           | Il faut l'inverse de `zzzz_` : le nommer `aaab_auction_sales_hold_projected_fields`, juste après `aaaa_auction_sales_retention_tombstone_guard_update` [V]. Ainsi `auction_sales_ai_review_publication_guard`, les projections `zzzz_`, la visibilité `zzzzz_` et la clause WHEN de `zzzzzz_auction_sales_content_changed_at` (`20261028100200:57-72`) voient la valeur finale. Une réécriture annulée par la retenue ne date alors pas `content_changed_at`.                                        |

### Concurrence

- **[V] Ordre des verrous.**
  - Noyau : fait candidat `FOR UPDATE` (`20261114100000:159-162`), puis vente `FOR UPDATE` (ligne 217-219).
  - Pipeline : verrou consultatif, puis ventes `order by id for no key update` (`publication_identity.py:449-451`), puis `on conflict do update`.

  Aucun interblocage, car le noyau ne verrouille qu'une vente.

- **Recommandation.** Que la projection prenne `FOR NO KEY UPDATE` et non `FOR UPDATE`. `FOR UPDATE` bloque les `FOR KEY SHARE` des clés étrangères : insertion d'observations ou de travaux d'enrichissement visant la vente pendant l'acceptation.
- **Ordre unique à documenter :** vente, puis observations, puis décisions.
- **[V] Effet sur les écritures optimistes.** La projection avance `updated_at`, comme le noyau aujourd'hui. Le PATCH optimiste de `source_extraction_backfill` et `_guard_enrichment_revision` (`supabase_client.py:893-905`) abandonnent alors proprement une écriture périmée.

### Ce qu'il faut quand même faire en Python (petit, sans valeur de sécurité)

Marquer les champs rétro-remplis (`sale["_backfilled_fields"]` dans `_backfill_raw_sale_from_known_detail`) et ne pas en tirer d'observation `source_listing` dans `fact_claims.py`. Sinon le registre affichera « l'annonce dit 54 » en écho de l'avocat. [S] Je n'ai pas tracé si le dictionnaire brut rétro-rempli finit dans `raw_payload` lu par `_source_snapshots` (`fact_claims.py:228-235`) : c'est à vérifier par le développeur.

### Défaut actuel qui pèse en faveur de la bascule

[V] Le noyau écrit `raw_payload.information_agent_verified_facts` (`20261114100000:412-439`). La collecte réécrit tout `raw_payload` (`_transaction_write`, `supabase_client.py:266-285`, `do update set raw_payload = excluded.raw_payload`). Dans le pipeline, seul `catalogue_readiness.py:359` nomme cette clé. Elle n'apparaît ni dans `KNOWN_ENRICHMENT_PAYLOAD_FIELDS` ni dans `KNOWN_SALE_RAW_PAYLOAD_KEYS`.

[S, forte] La mention « avocat poursuivant » lue par `get_public_sale_lawyer_fact_sources` disparaît donc à la collecte suivante, même si la valeur survivait. Mesure 4 ci-dessous.

---

## 2. Schéma recommandé

Toutes les nouvelles tables : RLS activée, aucune politique, `revoke all … from public, anon, authenticated, service_role`, `grant select … to service_role` seulement. Écriture uniquement par des fonctions `SECURITY DEFINER` avec `search_path = ''`.

**Aucune clé étrangère vers `auction_sales`** dans les nouvelles tables. Créer une FK prend `SHARE ROW EXCLUSIVE` sur la table référencée, donc sur la table chaude. Et un `on delete cascade` effacerait l'audit lors d'une fusion.

### a) `public.auction_fact_fields` (une ligne par champ, données versionnées par migration)

```sql
field_key text primary key check (field_key in ('property.surface_m2','property.land_surface_m2',
  'property.rooms_count','property.occupancy_status','sale.visit_dates')),
held_columns text[] not null,            -- surface : {surface_m2,app_surface_m2,app_surface_kind,surface_source,surface_confidence}
value_type text not null check (value_type in ('numeric','integer','enum','date_list')),
abs_tolerance numeric, rel_tolerance numeric check (rel_tolerance is null or rel_tolerance between 0 and 0.2),
on_listing_change text not null default 'keep_and_review'
  check (on_listing_change in ('keep_and_review','listing_wins_and_review')),
hold_enabled boolean not null default false
```

- **`surface_evidence` reste hors du groupe tenu.** [V] Le noyau y écrit un extrait du message (`20261114100000:271`). Le tenir empêcherait `redact_personal_data` de l'effacer. Point à signaler à `juridique-rgpd` : un extrait de message d'avocat dans une colonne de la fiche.
- **Choix 2 bis.** `listing_wins_and_review` est ce que propose le rapport du 10/11 (2 bis). `keep_and_review` est plus sûr (« aucune fiche ne change par accident »). Le choix revient au propriétaire et se fait champ par champ, en données.

### b) `public.auction_fact_source_precedence`

```sql
field_key text references public.auction_fact_fields(field_key),
source_kind text check (source_kind in ('admin','lawyer_form','lawyer_email','document','listing')),
rank smallint not null check (rank between 1 and 100),   -- 1 = le plus fort
can_hold boolean not null default false,
primary key (field_key, source_kind),
constraint auction_fact_source_precedence_listing_never_holds
  check (not can_hold or source_kind in ('admin','lawyer_form','lawyer_email'))
```

Valeurs de départ :

| Source       | Rang | Tient le champ |
| ------------ | ---- | -------------- |
| admin        | 10   | oui            |
| lawyer_form  | 20   | oui            |
| lawyer_email | 30   | oui            |
| document     | 50   | non            |
| listing      | 60   | non            |

`hold_enabled` vaut vrai pour la surface, le terrain, les pièces et l'occupation (acceptée à la main seulement). Pour les visites, il reste faux tant qu'il n'existe pas de fait de visite structuré : le noyau ne publie pas de visites [V].

### c) `public.auction_fact_claim_decisions` (journal en ajout seul)

```sql
id uuid primary key default gen_random_uuid(),
claim_id uuid not null references public.auction_fact_claims(id) on delete restrict,
sale_id uuid not null,                  -- sans FK : survit à la fusion, suivi via app_private.auction_sale_merges
field_key text not null,
decision text not null check (decision in ('accepted','rejected','withdrawn','opposed','contradicted')),
lot_attachment text not null check (lot_attachment in ('single_lot','matched','unmatched','unknown')),
lot_ref text check (lot_ref is null or char_length(btrim(lot_ref)) between 1 and 40),
actor_kind text not null check (actor_kind in ('admin','lawyer','system')),
actor_id uuid,                          -- sans FK : un "on delete set null" serait un UPDATE refusé par l'ajout seul
reason text check (reason is null or char_length(btrim(reason)) between 1 and 500),
information_agent_fact_id uuid,         -- sans FK (purge des messages)
recipient_kind text check (recipient_kind in ('source_lawyer','source_contact','manual_professional')),
received_at timestamptz,
publication_mode text not null default 'manual',
supersedes_decision_id uuid references public.auction_fact_claim_decisions(id),
decided_at timestamptz not null default statement_timestamp(),
constraint auction_fact_claim_decisions_reason_check
  check (decision in ('accepted') or reason is not null),
constraint auction_fact_claim_decisions_auto_locked check (publication_mode <> 'auto')
```

- **Index.**
  - `(sale_id, field_key, decided_at desc, id desc)` ;
  - `(claim_id, decided_at desc)` ;
  - `unique (information_agent_fact_id) where decision = 'accepted' and information_agent_fact_id is not null`, pour l'idempotence des publications.
- **Déclencheurs.** `before update or delete` pour chaque ligne et `before truncate` pour l'instruction, avec exception 55000, sur le modèle de `20261115100000:209-229`.
- **Statut effectif d'une observation.** C'est la dernière décision du journal. À défaut, c'est `auction_fact_claims.claim_status`, ce qui évite d'amorcer le journal par migration.
- **[S] RGPD.** `actor_id` est conservé sans FK, et le journal survit à la purge de la vente : à signaler à `juridique-rgpd` (durée de conservation).

### d) `public.auction_sale_field_hold_events` (ajout seul, rare)

`id`, `sale_id` (sans FK), `field_key`, `event` (`listing_changed_kept`, `listing_changed_released`, `projection_held`, `projection_released`, `conflicted`), `held_value jsonb`, `listing_value jsonb`, `incoming_value jsonb`, `decision_id uuid`, `created_at`.

Elle reçoit une ligne seulement quand l'annonce change sur un champ tenu. Elle sert de file de relecture. Mêmes déclencheurs d'ajout seul et de TRUNCATE.

### e) `public.auction_sales.held_fields jsonb` (nulle, sans défaut)

`add column` sans défaut ne touche que les métadonnées. Contrainte `held_fields is null or jsonb_typeof(held_fields) = 'object'`, en `not valid` puis `validate`.

Pas de seconde colonne `field_provenance` : `held_fields` est la provenance des champs tenus, et un champ non tenu vient de l'annonce. Forme d'une entrée :

```json
{
  "property.surface_m2": {
    "v": 1,
    "value": 54,
    "state": "held",
    "listing": {
      "surface_m2": 50,
      "app_surface_m2": 50,
      "app_surface_kind": "...",
      "surface_source": "...",
      "surface_confidence": 0.7
    },
    "claim_id": "…",
    "decision_id": "…",
    "source_kind": "lawyer_email",
    "rank": 30,
    "received_on": "2026-11-12",
    "publication_mode": "manual",
    "recipient_kind": "source_lawyer",
    "tolerance": { "abs": 1, "rel": 0.02 },
    "on_listing_change": "keep_and_review"
  }
}
```

- **Contenu exclu :** aucun extrait, aucun email, aucun nom.
- **Taille :** environ 0,5 Ko par champ tenu, et seulement sur moins de 1 % des lignes. Ailleurs, c'est un NULL.
- **Garder l'annonce « à part » sans gonfler la ligne :** c'est le bloc `listing`. Il n'existe que pour un champ tenu et sert à restaurer la valeur de l'annonce au retrait.
- **Droits :** colonne non accordée à `authenticated` (droits par colonne existants [V], invariant `auction-sales-column-grants`). À ajouter à la liste des colonnes internes.

### f) Ce qu'il faut toucher dans `auction_fact_claims`, et ce qui est risqué

À faire :

- **Élargir `evidence_kind`** avec `professional_email`, `professional_form` et `admin_entry`. Aujourd'hui, le pont étiquette `manual_review` un fait venu du corps d'un email d'avocat (`20261114100000:775-785`), ce qui ferait classer l'avocat comme administrateur. Procédure : `drop constraint` puis `add constraint … not valid` puis `validate`. Le nom `auction_fact_claims_evidence_kind_check` est [S] : mesure 6.
- **Ajouter un déclencheur `before truncate`.** [V] Il n'existe que `before update or delete` (lignes 399-401).

À ne pas faire :

- **Ajouter des colonnes.** La garde compare `to_jsonb(new)` à `to_jsonb(old)` (lignes 340-375) : une nouvelle colonne serait immuable et impossible à remplir pour les lignes existantes. Le lot et le statut vont donc dans le journal des décisions.
- **Re-pointer `auction_sale_id` lors d'une fusion.** La garde ne l'autorise que vers NULL, dans une FK imbriquée (lignes 352-374). La relâcher casserait l'immuabilité. On suit les fusions par `decisions.sale_id` et `app_private.auction_sale_merges`.
- **Changer les écrivains du pipeline** (`fact_claim_rows.py:161-173`, `fact_claims.py:186-225`). Ils insèrent `on conflict (id) do nothing` avec un identifiant uuid5 qui dépend de `FACT_CLAIMS_VERSION`, de la valeur, de `source_url` et du `evidence_locator`. Toute modification de ces entrées crée des doublons, et la file de reprise REST (`fact_claims_rest_v2`) rejoue des instantanés au format actuel. Le correctif de l'écho doit **retirer** des candidats, jamais changer l'identité.

### g) Représentation du lot

- Ce que dit la pièce (« lot 2 ») va dans `lot_ref`.
- Le jugement porté au moment de la décision va dans `lot_attachment`.
- `auction_fact_claims.lot_id` (lots de l'Outcome Graph) reste facultatif.
- La projection ne tient un champ que si `lot_attachment in ('single_lot','matched')`.

---

## 3. La fonction de projection

**Signature :**

```sql
app_private.project_sale_fields(p_sale_id uuid, p_fields text[] default null, p_apply boolean default false) returns jsonb
```

- Volatile, `SECURITY DEFINER`, `search_path ''`.
- `revoke all … from public, anon, authenticated, service_role`, sans aucun `grant`.
- Appelée seulement par le noyau, par les RPC de décision (retrait, opposition) et par le report de fusion.
- `p_apply = false` donne une simulation sans écriture, utile pour la comparaison et les tests.

**Algorithme :**

1. **Verrouiller la ligne.** `select … from auction_sales where id = p_sale_id for no key update`.
2. **Réunir les candidats.** Ventes visées : `{p_sale_id}` ∪ `{old_sale_id from app_private.auction_sale_merges where canonical_sale_id = p_sale_id}`. Pour ces ventes, prendre la dernière décision par `claim_id` et ne garder que `accepted`. Joindre l'observation, puis `source_kind`, via une fonction déterministe qui s'appuie sur `evidence_kind`, `extractor_name` et `evidence_locator ? 'information_agent_fact_id'`. Exiger :
   - `can_hold` et `hold_enabled` ;
   - `lot_attachment` valide ;
   - aucune décision ultérieure `withdrawn`, `opposed` ou `contradicted`.
3. **Ordonner.** Par champ : `rank asc, received_at desc nulls last, decided_at desc, claim_id`.
4. **Remplacement contre contradiction.**
   - Même rang **et même origine** (même dossier ou même destinataire) : la plus récente remplace, c'est le cas du « message ultérieur de l'avocat ».
   - Même rang, **origines différentes** et valeurs hors tolérance : `state = 'conflicted'`. Si le champ était tenu, on garde la valeur affichée ; sinon, on ne tient rien. Dans les deux cas, ligne `conflicted` et relecture. Jamais de bascule automatique.
5. **Construire l'entrée.** Première prise : le bloc `listing` est l'instantané des colonnes **actuelles**, celles de l'annonce puisque le champ n'était pas tenu. Champ déjà tenu : on reprend son bloc `listing`.
6. **Champ qui n'a plus de pièce.** On retire l'entrée et on restaure les colonnes depuis `listing` (NULL si vide).
7. **Idempotence.** Si `held_fields` et les colonnes cibles sont égaux à l'existant, rien n'est écrit et `updated_at` ne bouge pas. Sinon : `set_config('app.sale_field_projection', id, true)`, un seul `UPDATE` (colonnes, `held_fields`, `updated_at`), remise à `''`, puis événements.
8. **Retour.** Pour chaque champ : `held`, `released`, `conflicted`, `unchanged` ou `pass_through`, avec la valeur et `claim_id`.

**Comportement du déclencheur de retenue sur un champ tenu.** Avec I la valeur entrante, H la valeur tenue et L la dernière valeur connue de l'annonce :

| Cas                              | Effet                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I nulle                          | On garde H (l'annonce ne dit rien).                                                                                                                              |
| I égale à H, à la tolérance près | On garde H : écho ou confirmation.                                                                                                                               |
| I égale à L, à la tolérance près | On garde H : l'annonce n'a pas changé. C'est indispensable : sans L, une annonce qui dit toujours 50 effacerait l'avocat (54) dès l'import suivant.              |
| Sinon (l'annonce a changé)       | On met à jour `listing` dans NEW et on journalise. Avec `keep_and_review`, on garde H. Avec `listing_wins_and_review`, on laisse passer I et on retire l'entrée. |

Pour chaque colonne tenue conservée : `new.col := old.col`.

**Écho.** C'est la ligne 2 du tableau. Le rétro-remplissage (`main.py:1320-1322`) ne comble que les valeurs manquantes, à partir de la base, donc avec H. Côté registre, il faut aussi le correctif Python de la section 1.

**Coût [S].** Quelques sondes d'index par appel (index `auction_fact_claims_sale_field_idx` et index du journal), moins d'une milliseconde. Appels rares : décisions humaines et fusions.

---

## 4. Plan de migrations (noms après `20261115100000`)

**Règles communes.**

- Chaque fichier commence par `set local lock_timeout = '5s'; set local statement_timeout = '60s'` et s'applique **hors import**.
- Avant d'appliquer : vérifier qu'aucune exécution n'est en cours (`auction_runs` et la réservation `claim_autonomous_pipeline_run`) et suspendre la collecte par le contrôle existant (`auction_pipeline_control`, [S] à confirmer par `devops-ci`).
- Vercel déploie `main` avant la migration : tout code qui appelle un nouvel objet doit tolérer son absence (`PGRST202` ou `42P01`, ou `to_regclass` comme `supabase_client.py:630-633`).

| Étape                                                  | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E0 (code seul)**                                     | Correctif d'écho dans `main.py` et `fact_claims.py`, et invariants qui ne dépendent d'aucun objet nouveau.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **M1 `20261116100000_fact_registry_tables`**           | Tables a) à d), droits, déclencheurs d'ajout seul et de TRUNCATE, données de préséance. Verrou : `SHARE ROW EXCLUSIVE` sur `auction_fact_claims` (FK de `claim_id`), ce qui bloque un instant les insertions d'observations de l'import. Aucun verrou sur `auction_sales`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **M2 `20261116100100_fact_claims_kinds_truncate`**     | Contrainte `evidence_kind` élargie en `not valid` (ACCESS EXCLUSIVE bref) et déclencheur TRUNCATE. **M2b** `…100200` : `validate constraint` (SHARE UPDATE EXCLUSIVE, environ 17 000 lignes, moins d'une seconde [S]).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **M3 `20261116100300_auction_sales_held_fields`**      | `add column held_fields jsonb` et contrainte de forme `not valid`. Verrou ACCESS EXCLUSIVE instantané, mais en file d'attente il bloque **aussi les lectures du site**, jusqu'à 5 s si un import tient la table. **M3b** : `validate`, qui parcourt la table sous SHARE UPDATE EXCLUSIVE sans bloquer les écritures.                                                                                                                                                                                                                                                                                                                                                                                       |
| **M4 `20261116100400_field_projection_and_hold`**      | `project_sale_fields`, fonction de retenue et `create trigger aaab_…` (SHARE ROW EXCLUSIVE sur `auction_sales`). **Inerte** : `held_fields` est nul partout, donc WHEN est faux.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Preuve (section 5)**                                 | Puis au moins une semaine d'imports observés.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **M5 `…_information_agent_core_projection` (bascule)** | Le noyau écrit l'observation (`professional_email` ou `professional_form`), la décision, puis appelle la projection. Le reste ne change pas : journal des publications, travaux d'enrichissement, `raw_payload` gardé pour compatibilité. `drop trigger information_agent_fact_claim_bridge` (déclencheur de contrainte **différé**, `20260928200000:223-227` [V]) : sinon, au commit, il refuserait une acceptation que la projection a mise en « conflicted ». `get_public_sale_lawyer_fact_sources` lit `held_fields`, avec repli sur `raw_payload` pour l'ancien. `review_auction_fact_claim` reste **inchangé** : les pièces d'annonce ne tiennent pas en V1, relâcher l'égalité ne servirait à rien. |
| **M6 `…_fact_withdraw_oppose`**                        | RPC administrateur de retrait et opposition de l'avocat : elles ajoutent une décision puis projettent. Écran admin tolérant l'absence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **M7 `…_carry_registry_on_merge`**                     | Dans `carry_sale_user_data_to_merged_sale` (BEFORE DELETE, `20261028110000:52`) : report des dossiers et faits candidats (aujourd'hui en cascade [V], unicité par vente et contact à gérer) et `project_sale_fields(v_target, null, true)`. Après M5 seulement.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Rattrapages éventuels**                              | Dans `supabase/repairs/` seulement, après lecture de la comparaison.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Retour arrière.**

- M4 : `drop trigger`, puis `drop function`.
- **M5 : d'abord rétablir le noyau et le pont dans leurs définitions de `20261114100000`, puis supprimer le déclencheur M4.** Avec le déclencheur en place, l'ancien noyau, qui n'écrit pas `held_fields`, verrait son écriture annulée sur une vente tenue. Les entrées `held_fields` restent, inertes une fois le déclencheur supprimé, et se vident ensuite par un rattrapage.
- M1, M2 et M3 : se retirent sans perte tant que M5 n'a rien écrit. Après M5, on garde les journaux (audit).

**À ne JAMAIS faire pendant un import :**

- tout DDL sur `auction_sales` ou `auction_fact_claims` ;
- ajouter une FK vers `auction_sales` ;
- un UPDATE en masse de `auction_sales` (environ 16 déclencheurs par ligne, plus des verrous de ligne contre le `for no key update` du pipeline) ;
- le premier remplissage de `held_fields`.

---

## 5. Preuve avant bascule

Avant M5, `held_fields` est nul partout. La seule chose à prouver : l'ensemble des champs que la projection tiendrait et sa concordance avec les colonnes. Requête de lecture seule, exécutable par `qualite-donnees` sans aucun objet nouveau :

```sql
with accepted as (
  select distinct on (f.sale_id, f.fact_key) f.sale_id, f.fact_key,
         nullif(btrim(f.proposed_value->>'value'), '') as v, c.recipient_kind
  from public.information_agent_fact_candidates f
  join public.information_agent_cases c on c.id = f.case_id
  where f.status = 'accepted'
    and f.fact_key in ('surface_m2','land_surface_m2','rooms_count','occupancy_status')
  order by f.sale_id, f.fact_key, f.reviewed_at desc nulls last, f.id desc
)
select a.fact_key, a.recipient_kind, count(*) as faits,
  count(*) filter (where case a.fact_key
    when 'surface_m2' then a.v ~ '^[0-9]+([.][0-9]+)?$' and s.app_surface_m2 = a.v::numeric
    when 'land_surface_m2' then a.v ~ '^[0-9]+([.][0-9]+)?$' and s.land_surface_m2 = a.v::numeric
    when 'rooms_count' then a.v ~ '^[0-9]{1,3}$' and s.rooms_count = a.v::integer
    when 'occupancy_status' then s.occupancy_status = a.v end) as encore_affiches
from accepted a join public.auction_sales s on s.id = a.sale_id
group by 1, 2 order by 1, 2;
```

Ajouter la même lecture sur `auction_fact_claims` (`claim_status = 'accepted'`, groupée par `evidence_kind`, `extractor_name`, `field_key`).

- **Coût [S].** Quelques millisecondes : une jointure sur les clés primaires, `raw_payload` jamais lu.
- **Résultat attendu.** 0 ligne, d'après le rapport du 10/11. Écarts légitimes :
  - (a) une valeur acceptée puis effacée par la collecte (le défaut 2 bis), à lister pour le propriétaire et **non** reprise d'office ;
  - (b) des observations d'annonce acceptées par `review_auction_fact_claim`, sans effet en V1 ;
  - (c) des faits de greffe ou de notaire (`recipient_kind <> 'source_lawyer'`) : ils tiennent le champ, mais ne valent pas mention publique.
- **Après M4, deuxième preuve (inertie).** Après plusieurs imports : `select count(*) from auction_sales where held_fields is not null` vaut 0, `auction_sale_field_hold_events` est vide, et `pg_stat_user_functions` (si `track_functions` le permet) montre 0 appel de la fonction de retenue.
- **Test pgTAP de concordance.** Sur jeu d'essai, la simulation `project_sale_fields(…, false)` et la requête ci-dessus doivent donner le même ensemble.

---

## 6. Tests pgTAP indispensables (nouveau fichier par thème, numéros 881 et suivants)

1. **Droits.** RLS active, aucune politique ; `has_table_privilege` faux pour anon et authenticated, vrai seulement en lecture pour service_role ; `has_function_privilege(execute)` faux pour tous les rôles de l'API sur `project_sale_fields` et sur la fonction de retenue ; `held_fields` absent des droits par colonne d'`authenticated`.
2. **Ajout seul.** UPDATE, DELETE et TRUNCATE refusés (55000) sur le journal des décisions et sur les événements ; TRUNCATE refusé sur `auction_fact_claims`.
3. **Chemin rapide.** Avec `held_fields` nul, `insert … on conflict (source_url) do update` change la surface comme aujourd'hui.
4. **Retenue.** Sur une vente tenue, ré-import avec, tour à tour :
   - (a) la même valeur d'annonce L ;
   - (b) l'écho H ;
   - (c) une valeur nulle ;
   - (d) une nouvelle valeur.

   Attendu : (a), (b) et (c) gardent H, sans événement. (d) produit un événement et garde H, ou libère le champ selon `on_listing_change`. Le groupe de surface reste cohérent (5 colonnes).

5. **`content_changed_at` inchangé** quand la retenue annule une réécriture (test d'ordre des déclencheurs).
6. **Idempotence.** Deux appels de la projection : le second ne modifie ni `xmin` ni `updated_at`.
7. **Seconde publication** sur la même clé par le même dossier : la plus récente remplace, sans annulation par le déclencheur.
8. **Contradiction** de deux origines au même rang : `conflicted`, affichage inchangé.
9. **Retrait et opposition** : restauration depuis `listing`.
10. **Lot `unknown` ou `unmatched`** : aucune retenue.
11. **Écriture forgée** de `held_fields` sans le réglage de transaction : exception 42501.
12. **Noyau de bout en bout**, avec `review_information_agent_fact_candidate` : observation, décision, retenue et journal des publications. Un appel `'auto'` échoue toujours (`auto_locked`).
13. **`get_public_sale_lawyer_fact_sources`** rend toujours la mention après un import qui retire `information_agent_verified_facts` de `raw_payload` (régression du défaut actuel).
14. **Fusion (M7)** : la secondaire tenue est supprimée, la canonique est reprojetée, les décisions survivent.

**Test manuel de concurrence à deux sessions** (base jetable, `psql` ×2) :

- **Cas 1, acceptation d'abord.** S1 `begin; select app_private.project_sale_fields(:id, null, true);` sans commit. S2 lance l'upsert du pipeline sur la même `source_url` : il attend. S1 `commit`. S2 se termine : sa ligne conserve H et `held_fields`.
- **Cas 2, import d'abord.** S2 `begin;` upsert sans commit. S1 accepte : il attend. S2 `commit`. S1 reprend sur la version de S2 : le bloc `listing` vaut la valeur de S2.
- **Cas 3, interblocage.** Rejouer avec le `for no key update order by id` de `publication_identity.py:449-451` sur deux ventes : aucun interblocage.

---

## 7. Invariants à ajouter à `scripts/check-security-invariants.mjs`

Réutiliser `readSourceTree` et `migrationSources`.

- **`fact-registry-tables-closed`.** Les trois nouvelles tables et la préséance doivent avoir : RLS, `revoke all … from public, anon, authenticated, service_role`, seulement `grant select … to service_role`, aucune politique. C'est le même schéma que les lignes 2222-2267.
- **`fact-registry-append-only`.** Les déclencheurs d'ajout seul et de TRUNCATE existent sur le journal, les événements et `auction_fact_claims`, et aucune migration ne les supprime.
- **`held-fields-projection-only`.**
  - Aucun fichier de `src/` (hors `types.ts`) ni de `services/data-pipeline/src/` ne nomme `held_fields`.
  - Dans les migrations, `held_fields` n'est affecté que dans `project_sale_fields` et dans la fonction de retenue.
  - `held_fields` est ajoutée à `internalAuctionSalesColumns`.
- **`hold-trigger-present-early`.** La dernière définition du déclencheur garde `before update of`, la clause WHEN, et un nom qui précède tous les autres déclencheurs BEFORE de `auction_sales`. Aucun `drop trigger` sans recréation dans la même migration.
- **`field-projection-not-callable-by-api`.** `revoke … from public, anon, authenticated, service_role` présent, aucun `grant execute`. Aucun code applicatif ni du pipeline ne nomme `project_sale_fields`.
- **Extension de `information-agent-no-automatic-publication-path`.**
  - Ajouter `auction_fact_claim_decisions_auto_locked` à la liste `locks` (lignes 2182-2193).
  - La contrainte `auction_fact_source_precedence_listing_never_holds` existe.
  - Aucune insertion dans le journal des décisions avec `publication_mode` différent de `'manual'`.
- **`fact-claims-never-repointed`.** Aucune migration ne contient `update public.auction_fact_claims set auction_sale_id =` vers une valeur non nulle, et `guard_auction_fact_claim_mutation` n'est jamais redéfinie sans la clause « detach only ».
- **`registry-no-fk-to-auction-sales`.** Aucune FK des nouvelles tables vers `auction_sales` (verrou sur la table chaude, cascade qui perd l'audit).

---

## 8. Dangers, irréversibilités, refus

**Dangereux :**

- Un ACCESS EXCLUSIVE sur `auction_sales` en attente derrière un import fige aussi les lectures du site (borné à 5 s par `lock_timeout`).
- Un déclencheur nommé `zzzz_` laisserait `content_changed_at` et la garde de relecture IA juger des valeurs que la retenue annule ensuite.
- Le retour arrière de M5 dans le mauvais ordre fait annuler par la retenue les écritures de l'ancien noyau.
- [V] `information_agent_fact_publications.sale_id` est en `on delete cascade` (`20261114100000:62`), comme `information_agent_auto_publication_decisions` (`20261115100000:118`) : une fusion efface aujourd'hui ce journal d'audit. À corriger dans M7 (FK supprimée, ou report avant suppression).
- Ce journal des publications n'a pas de déclencheur d'ajout seul (le commentaire de la ligne 55-56 le dit). Seuls les droits le protègent.

**Irréversible :** toute ligne du journal des décisions ou des événements (voulu), et les observations immuables. Une erreur ne se corrige que par une nouvelle décision. D'où : aucune insertion de masse dans ces tables par migration.

**Je refuserais :**

1. Un déclencheur qui **écrit** une valeur tirée des pièces (et non qui retient) ou qui appelle la projection.
2. Laisser l'annonce ou le PDF tenir un champ en V1 : il faudrait réécrire en SQL la logique de surface du pipeline.
3. Relâcher la garde d'immuabilité de `auction_fact_claims` pour re-pointer des observations lors d'une fusion.
4. Remplir `held_fields` ou le journal depuis `raw_payload.information_agent_verified_facts` dans une migration : c'est une réparation, à faire seulement après lecture de la comparaison et décision du propriétaire.
5. Retirer ou contourner une contrainte `auto_locked`, ou ajouter un `publication_mode = 'auto'`.
6. Toute FK `on delete cascade` des nouvelles tables vers `auction_sales`.
7. Relâcher l'égalité de `review_auction_fact_claim` sans usage défini.

**Pour `juridique-rgpd` :** conservation du journal des décisions après purge de la vente (`actor_id` sans FK) ; extrait de message d'avocat écrit dans `surface_evidence` ; occupation (données sur l'occupant) tenue sur la fiche.

---

## Mesures à confier à `qualite-donnees` (lecture seule)

1. La requête de la section 5, et sa variante sur `auction_fact_claims` (statut accepté par `evidence_kind`, `extractor_name`, `field_key`).
2. Volumes : `select claim_status, evidence_kind, count(*) from auction_fact_claims group by 1,2;` et `select count(*) from auction_fact_claims where evidence_locator ? 'information_agent_fact_id';`
3. Déclencheurs et leur ordre : `select tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.auction_sales'::regclass and not tgisinternal order by tgname;`
4. Effacement de la provenance par la collecte : `select count(*) as publications, count(*) filter (where s.raw_payload->'information_agent_verified_facts' ? p.fact_key) as encore_dans_raw_payload from information_agent_fact_publications p join auction_sales s on s.id = p.sale_id;`
5. Exposition de `surface_evidence` : `select grantee, privilege_type from information_schema.column_privileges where table_name = 'auction_sales' and column_name = 'surface_evidence';`
6. Nom réel de la contrainte : `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.auction_fact_claims'::regclass;`
7. Coût de l'upsert d'import, avant M4 et une semaine après : `select calls, mean_exec_time, max_exec_time from pg_stat_statements where query ilike 'insert into "public"."auction_sales"%' order by calls desc limit 5;`. Écart attendu : sous le bruit (moins de 1 %).
8. `show track_functions;`, puis après M4 : `select calls from pg_stat_user_functions where funcname = 'hold_projected_sale_fields';` (attendu : 0 avant M5).
9. Fréquence des fusions : `select date_trunc('week', merged_at), count(*) from app_private.auction_sale_merges group by 1 order by 1 desc limit 8;`

---

## Tableau des étapes

| Étape       | Contenu                                                                         | Verrous                                                             | Risque                              | Effort | Retour arrière                                                 |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------- | ------ | -------------------------------------------------------------- |
| E0          | Correctif d'écho (Python), premiers invariants                                  | Aucun                                                               | Faible                              | S      | Revert du code                                                 |
| M1          | Tables du registre, préséance, ajout seul, droits                               | SHARE ROW EXCL. bref sur `auction_fact_claims`                      | Faible                              | M      | `drop table` (avant M5)                                        |
| M2/M2b      | `evidence_kind` élargi, TRUNCATE interdit                                       | ACCESS EXCL. bref puis SHARE UPDATE EXCL. sur `auction_fact_claims` | Faible                              | S      | Remettre l'ancienne contrainte, `drop trigger`                 |
| M3/M3b      | `auction_sales.held_fields` et contrainte de forme                              | ACCESS EXCL. instantané, puis SHARE UPDATE EXCL.                    | Moyen (file d'attente des lectures) | S      | `drop column` (vide)                                           |
| M4          | Projection, fonction et déclencheur de retenue `aaab_` (inertes)                | SHARE ROW EXCL. sur `auction_sales`                                 | Moyen                               | L      | `drop trigger`, `drop function`                                |
| Preuve      | Comparaison, une semaine d'imports observés                                     | Aucun                                                               | Nul                                 | S      | Sans objet                                                     |
| M5          | Noyau qui projette, pont retiré, RPC publique sur `held_fields`                 | Remplacement de fonctions, `drop trigger` sur les faits candidats   | Élevé (bascule)                     | M      | Ancien noyau et ancien pont **puis** retrait du déclencheur M4 |
| M6          | RPC de retrait et d'opposition, écran admin                                     | Fonctions seulement                                                 | Moyen                               | M      | `drop function`                                                |
| M7          | Report à la fusion (dossiers, faits, reprojection), FK cascade du journal revue | Remplacement de la fonction BEFORE DELETE, FK modifiée              | Moyen                               | M      | Ancienne `carry_sale_user_data_to_merged_sale`                 |
| Réparations | Rattrapages décidés par le propriétaire, dans `supabase/repairs/`               | Lignes ciblées, par lots, hors import                               | Moyen                               | S      | Nouvelle décision de retrait (ajout seul)                      |
