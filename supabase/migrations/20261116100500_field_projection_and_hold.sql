begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R1, étape M4 (annexe 03, sections 1 et 3). INERTE : public.auction_sales.held_fields
-- est nulle partout, la clause WHEN des déclencheurs est donc fausse pour toute ligne (aucun appel PL/pgSQL), et
-- aucun code de l'application ni du pipeline n'appelle la projection (lot R2).
--
-- Deux rôles séparés :
--   * app_private.project_sale_fields(vente, champs, appliquer) : LA SEULE écriture qui pose ou retire une pièce
--     sur une fiche. Elle lit les décisions du journal (dernière décision par observation, dans l'ordre de seq),
--     ne garde que les acceptations d'une pièce rattachée au bon lot (single_lot, matched) dont l'origine peut
--     tenir le champ (préséance, hold_enabled), ordonne par rang puis par date (réception, à défaut décision),
--     distingue un remplacement (même rang, même origine : la plus récente l'emporte) d'une contradiction (même
--     rang, origines différentes, valeurs hors tolérance : rien ne bascule, évènement « conflicted » ; la valeur
--     affichée reste tant que la pièce qui la porte est encore acceptée, sinon la valeur de l'annonce revient),
--     et écrit en un seul UPDATE les colonnes, held_fields et updated_at. Sans changement, elle n'écrit rien.
--     Quand plus aucune pièce ne tient un champ (retrait, opposition, rejet), elle restaure la valeur de
--     l'annonce gardée dans le bloc « listing ». Elle n'échoue jamais sur la contrainte « pièces >= chambres » :
--     une pièce incompatible avec les chambres de la fiche n'est pas posée (état « blocked », évènement
--     projection_blocked, les autres champs sont projetés), et une valeur d'annonce à restaurer qui serait
--     incompatible est remplacée par NULL. Une pièce que l'annonce a délogée (évènement
--     listing_changed_released, réglage listing_wins_and_review) ne reprend pas le champ : il faut une nouvelle
--     décision humaine, postérieure à l'évènement. p_apply = false : simulation, sans verrou ni écriture.
--     Exécutable par AUCUN rôle de l'API (ni anon, ni authenticated, ni service_role) : seules des fonctions
--     SECURITY DEFINER du lot R2 l'appelleront.
--   * déclencheur aaab_auction_sales_hold_projected_fields : passif. Il ne calcule aucun gagnant et ne lit ni les
--     observations, ni les décisions, ni la préséance, ni raw_payload (jamais to_jsonb(new) ni to_jsonb(old)) :
--     il remet l'ancienne valeur des champs déjà tenus quand une écriture directe (collecte, repli REST, fusion,
--     rattrapage…) les réécrit. Avec I la valeur entrante, H la valeur tenue et L la dernière valeur connue de
--     l'annonce : I qui ne dit rien (nulle, nombre nul ou négatif, occupation inconnue), I égale à H ou I égale à
--     L (à la tolérance près) gardent H sans évènement ; sinon l'annonce a changé : un évènement part en
--     relecture (une seule fois par valeur entrante et par décision : une annonce qui oscille n'ajoute rien),
--     puis, selon le réglage du champ copié dans l'entrée, H reste et le bloc « listing » prend la nouvelle
--     valeur (keep_and_review, défaut) ou I passe et le champ est libéré (listing_wins_and_review). Une écriture
--     de held_fields hors projection est refusée (42501).
--     Nommé « aaab_ », juste après « aaaa_auction_sales_retention_tombstone_guard_update » et avant tous les autres
--     déclencheurs BEFORE qui jugent la ligne : la garde de relecture IA, les projections « zzzz_ », la visibilité
--     « zzzzz_ » et la clause WHEN de « zzzzzz_auction_sales_content_changed_at » voient la valeur finale (une
--     réécriture annulée ne date pas content_changed_at).
--   * déclencheur aaab_auction_sales_held_fields_insert_guard : une ligne neuve ne tient rien ; une insertion qui
--     fournit held_fields est refusée (42501), pour tout rôle. Clause WHEN (une seule comparaison à NULL).
--   * déclencheur aaab_auction_sales_held_fields_role_guard : le réglage de transaction que pose la projection
--     n'est pas un contrôle d'accès (tout rôle peut le poser). Ce déclencheur, SECURITY INVOKER, refuse (42501)
--     tout changement de held_fields par un rôle de l'API, réglage posé ou non. Son nom le fait passer AVANT la
--     retenue (« held » < « hold ») : il juge ce que l'instruction écrit, pas ce que la retenue ajuste ensuite.
--
-- Les trois déclencheurs sont posés par « create or replace trigger » (une seconde application ne supprime rien
-- et ne prend que le verrou SHARE ROW EXCLUSIVE) puis passés en « enable always » : ils restent actifs en
-- session_replication_role = replica.
--
-- Nombre de pièces et chambres (contrainte auction_sales_rooms_bedrooms_check). Quand une écriture apporte un
-- nombre de chambres supérieur au nombre de pièces tenu : en keep_and_review, la pièce reste et le nombre de
-- chambres entrant n'est pas pris (l'ancien reste), avec un évènement listing_changed_kept qui porte les deux
-- nombres ; en listing_wins_and_review, le champ est libéré. Dans les deux réglages l'écrivain n'échoue jamais,
-- même s'il n'écrit que bedrooms_count : après libération, le nombre de pièces est celui de l'écriture ou du bloc
-- « listing » s'il est compatible, sinon NULL. bedrooms_count est donc dans la liste des colonnes du déclencheur.
--
-- Écarts assumés avec l'annexe 03 :
--   * une garde à l'insertion et une garde par rôle, que l'annexe ne prévoyait pas ;
--   * une pièce de document acceptée tient le champ (plan du 11/11/2026, section 3) : la préséance est en
--     données (20261116100000), la projection ne nomme aucune origine ;
--   * un sixième évènement, projection_blocked ;
--   * les fusions : app_private.auction_sale_merges est tenue à plat par
--     app_private.carry_sale_user_data_to_merged_sale (une fiche absorbée pointe toujours la fiche conservée
--     finale, et la clé étrangère de canonical_sale_id interdit une chaîne) : une lecture à un niveau suffit.
-- Valeurs écrites dans le groupe de surface par une pièce : surface_m2 et app_surface_m2 prennent la valeur,
-- app_surface_kind et surface_source prennent « fact_registry_<origine> » (le noyau actuel écrit
-- « information_agent_verified »), surface_confidence prend la confiance de l'observation, au moins 0,85 (même
-- plancher que le noyau). surface_evidence reste hors du groupe. À confirmer au lot R2, avant la bascule.
--
-- Ordre des verrous (à respecter par tout appelant) : vente (FOR NO KEY UPDATE, qui ne bloque pas les clés
-- étrangères des observations et des travaux d'enrichissement), puis observations, puis décisions.
--
-- VERROU : CREATE TRIGGER et ENABLE ALWAYS TRIGGER prennent un SHARE ROW EXCLUSIVE sur public.auction_sales
-- (lectures possibles, écritures en attente quelques millisecondes). À APPLIQUER HORS IMPORT ; lock_timeout (5 s)
-- fait échouer la migration sans effet si le verrou n'est pas obtenu.
--
-- Retour arrière (avant le lot R2 : sans aucun effet sur les fiches) :
--   begin; set local lock_timeout = '5s';
--   drop trigger if exists aaab_auction_sales_hold_projected_fields on public.auction_sales;
--   drop trigger if exists aaab_auction_sales_held_fields_insert_guard on public.auction_sales;
--   drop trigger if exists aaab_auction_sales_held_fields_role_guard on public.auction_sales;
--   drop function if exists app_private.project_sale_fields(uuid, text[], boolean);
--   drop function if exists app_private.hold_projected_sale_fields();
--   drop function if exists app_private.refuse_inserted_held_fields();
--   drop function if exists app_private.refuse_api_role_held_fields_write();
--   drop function if exists app_private.sale_field_values_match(text, jsonb, jsonb, numeric, numeric);
--   drop function if exists app_private.sale_field_comparable(text, jsonb);
--   drop function if exists app_private.fact_claim_source_kind(text, text, jsonb);
--   commit;
-- Après le lot R2 : rétablir D'ABORD le noyau et le pont de 20261114100000, PUIS retirer les déclencheurs (sinon
-- la retenue annulerait les écritures de l'ancien noyau sur une vente tenue).

-- Origine d'une observation, d'après sa nature et son extracteur (déterministe). Nulle si l'origine n'est pas
-- classée : une telle pièce ne tient jamais un champ.
--   admin_entry → admin ; professional_form → lawyer_form ; professional_email → lawyer_email ;
--   observation du pont de l'agent d'information (extracteur information_agent et information_agent_fact_id dans
--   le localisateur), étiquetée avant le lot R2 : manual_review (corps du message), email_attachment ou
--   portal_upload (pièce transmise par le professionnel) → lawyer_email ;
--   source_document → document ; source_listing → listing ; tout le reste (source_record, agent_research, other,
--   et les pièces jointes ou dépôts hors agent) → non classé.
create or replace function app_private.fact_claim_source_kind(
  p_evidence_kind text,
  p_extractor_name text,
  p_evidence_locator jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_evidence_kind = 'admin_entry' then 'admin'
    when p_evidence_kind = 'professional_form' then 'lawyer_form'
    when p_evidence_kind = 'professional_email' then 'lawyer_email'
    when p_extractor_name = 'information_agent'
      and coalesce(p_evidence_locator ? 'information_agent_fact_id', false)
      and p_evidence_kind in ('manual_review', 'email_attachment', 'portal_upload')
      then 'lawyer_email'
    when p_evidence_kind = 'source_document' then 'document'
    when p_evidence_kind = 'source_listing' then 'listing'
    else null
  end;
$$;

-- Forme comparable d'une valeur de colonne (annonce entrante, valeur tenue, dernière valeur de l'annonce). Nulle
-- quand la valeur ne dit rien : NULL, chaîne vide, tableau vide, nombre nul ou négatif, occupation « unknown ».
-- L'occupation est ramenée aux trois valeurs que le registre affiche (plan, section 6, choix 5 : jamais qui
-- occupe ni pourquoi) : owner_occupied et squatted se comparent comme « occupied ». C'est cette forme, et elle
-- seule, que la file d'évènements (non effaçable) garde pour l'occupation. Les visites deviennent un tableau
-- trié et sans doublon de dates normalisées (les 10 premiers caractères d'une date ISO, sinon le texte en
-- minuscules).
create or replace function app_private.sale_field_comparable(p_field_key text, p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then null
    when p_field_key in ('property.surface_m2', 'property.land_surface_m2', 'property.rooms_count') then
      case
        when jsonb_typeof(p_value) = 'number' and (p_value #>> '{}')::numeric > 0 then p_value
        when jsonb_typeof(p_value) = 'string' and btrim(p_value #>> '{}') ~ '^[0-9]+([.][0-9]+)?$'
          and btrim(p_value #>> '{}')::numeric > 0
          then to_jsonb(btrim(p_value #>> '{}')::numeric)
        else null
      end
    when p_field_key = 'property.occupancy_status' then
      case
        when jsonb_typeof(p_value) <> 'string' then null
        when lower(btrim(p_value #>> '{}')) in ('', 'unknown') then null
        when lower(btrim(p_value #>> '{}')) in ('owner_occupied', 'squatted') then to_jsonb('occupied'::text)
        else to_jsonb(lower(btrim(p_value #>> '{}')))
      end
    when p_field_key = 'sale.visit_dates' then (
      select case when count(*) = 0 then null else jsonb_agg(normalized.item order by normalized.item) end
      from (
        select distinct
          case when raw.item ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then left(raw.item, 10) else lower(raw.item) end
            as item
        from (
          select btrim(element) as item
          from jsonb_array_elements_text(
            case when jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end
          ) element
        ) raw
        where raw.item <> ''
      ) normalized
    )
    else null
  end;
$$;

-- Deux valeurs d'un champ concordent-elles, à la tolérance près ? Faux si l'une ne dit rien. Nombres : écart au
-- plus égal à la plus grande des deux tolérances (absolue, ou relative à la plus grande valeur) ; sans tolérance,
-- égalité exacte. Autres types : égalité de la forme comparable.
create or replace function app_private.sale_field_values_match(
  p_field_key text,
  p_a jsonb,
  p_b jsonb,
  p_abs_tolerance numeric,
  p_rel_tolerance numeric
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_a jsonb := app_private.sale_field_comparable(p_field_key, p_a);
  v_b jsonb := app_private.sale_field_comparable(p_field_key, p_b);
  v_a_number numeric;
  v_b_number numeric;
begin
  if v_a is null or v_b is null then
    return false;
  end if;
  if p_field_key in ('property.surface_m2', 'property.land_surface_m2', 'property.rooms_count') then
    v_a_number := (v_a #>> '{}')::numeric;
    v_b_number := (v_b #>> '{}')::numeric;
    return abs(v_a_number - v_b_number) <= greatest(
      coalesce(p_abs_tolerance, 0),
      coalesce(p_rel_tolerance, 0) * greatest(abs(v_a_number), abs(v_b_number))
    );
  end if;
  return v_a = v_b;
end;
$$;

-- Déclencheur de retenue ----------------------------------------------------------------------------------------
-- Champ à plusieurs colonnes (surface) : l'annonce a changé dès qu'UNE des deux colonnes de valeur
-- (app_surface_m2, surface_m2) dit quelque chose qui n'est ni la valeur tenue, ni la dernière valeur connue de
-- l'annonce pour CETTE colonne. Une écriture partielle (un PATCH de surface_m2 seule) et un changement de la
-- seule surface_m2 dans une écriture complète sont donc vus. Le bloc « listing » ne reprend que les colonnes que
-- l'écriture a changées : une colonne inchangée porte encore la valeur tenue, pas celle de l'annonce. À la
-- libération, à l'inverse, les colonnes du groupe que l'écriture n'a pas touchées reprennent leur valeur du bloc
-- « listing » : aucune ne garde la valeur ni l'étiquette de la pièce.
create or replace function app_private.hold_projected_sale_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_held jsonb;
  v_key text;
  v_entry jsonb;
  v_listing jsonb;
  v_changed boolean;
  v_incoming jsonb;
  v_incoming_logged jsonb;
  v_held_value jsonb;
  v_listing_value jsonb;
  v_abs numeric;
  v_rel numeric;
  v_listing_wins boolean;
  v_keep boolean;
  v_event text;
  v_decision_id uuid;
  v_rooms integer;
begin
  -- La projection pose ce réglage de transaction (local) autour de son UPDATE : elle fait foi. Ce n'est pas un
  -- contrôle d'accès : aaab_auction_sales_held_fields_role_guard refuse les rôles de l'API, réglage posé ou non.
  if coalesce(pg_catalog.current_setting('app.sale_field_projection', true), '') = new.id::text then
    return new;
  end if;
  if new.held_fields is distinct from old.held_fields then
    raise exception using errcode = '42501',
      message = 'auction_sales.held_fields is written only by app_private.project_sale_fields.';
  end if;
  if old.held_fields is null then
    return new;
  end if;

  v_held := old.held_fields;
  for v_key in select held.key from pg_catalog.jsonb_object_keys(old.held_fields) held(key) order by held.key
  loop
    v_entry := old.held_fields -> v_key;
    v_listing := coalesce(v_entry -> 'listing', '{}'::jsonb);
    v_held_value := v_entry -> 'value';
    v_abs := (v_entry #>> '{tolerance,abs}')::numeric;
    v_rel := (v_entry #>> '{tolerance,rel}')::numeric;
    v_listing_wins := coalesce(v_entry ->> 'on_listing_change' = 'listing_wins_and_review', false);
    v_decision_id := (v_entry ->> 'decision_id')::uuid;
    v_changed := false;
    v_incoming := null;
    v_listing_value := null;

    -- Colonnes du champ, nommées une à une (jamais la ligne entière).
    if v_key = 'property.surface_m2' then
      if app_private.sale_field_comparable(v_key, to_jsonb(new.app_surface_m2)) is not null
        and not app_private.sale_field_values_match(
          v_key, to_jsonb(new.app_surface_m2), v_held_value, v_abs, v_rel)
        and not app_private.sale_field_values_match(
          v_key, to_jsonb(new.app_surface_m2), v_listing -> 'app_surface_m2', v_abs, v_rel)
      then
        v_changed := true;
        v_incoming := to_jsonb(new.app_surface_m2);
        v_listing_value := v_listing -> 'app_surface_m2';
      elsif app_private.sale_field_comparable(v_key, to_jsonb(new.surface_m2)) is not null
        and not app_private.sale_field_values_match(
          v_key, to_jsonb(new.surface_m2), v_held_value, v_abs, v_rel)
        and not app_private.sale_field_values_match(
          v_key, to_jsonb(new.surface_m2), v_listing -> 'surface_m2', v_abs, v_rel)
      then
        v_changed := true;
        v_incoming := to_jsonb(new.surface_m2);
        v_listing_value := v_listing -> 'surface_m2';
      end if;
    else
      if v_key = 'property.land_surface_m2' then
        v_incoming := to_jsonb(new.land_surface_m2);
        v_listing_value := v_listing -> 'land_surface_m2';
      elsif v_key = 'property.rooms_count' then
        v_incoming := to_jsonb(new.rooms_count);
        v_listing_value := v_listing -> 'rooms_count';
      elsif v_key = 'property.occupancy_status' then
        -- La file ne garde que la forme affichable de l'occupation (libre, occupé, loué).
        v_incoming := app_private.sale_field_comparable(v_key, to_jsonb(new.occupancy_status));
        v_listing_value := app_private.sale_field_comparable(v_key, v_listing -> 'occupancy_status');
      elsif v_key = 'sale.visit_dates' then
        v_incoming := new.visit_dates;
        v_listing_value := v_listing -> 'visit_dates';
      else
        raise exception using errcode = '22023',
          message = format('auction_sales.held_fields holds an unknown field %s.', v_key);
      end if;
      v_changed := app_private.sale_field_comparable(v_key, v_incoming) is not null
        and not app_private.sale_field_values_match(v_key, v_incoming, v_held_value, v_abs, v_rel)
        and not app_private.sale_field_values_match(v_key, v_incoming, v_listing_value, v_abs, v_rel);
    end if;
    v_incoming_logged := v_incoming;

    v_keep := true;
    v_event := null;
    if v_changed then
      if v_listing_wins then
        v_keep := false;
        v_event := 'listing_changed_released';
      else
        v_event := 'listing_changed_kept';
      end if;
    end if;

    -- Chambres entrantes plus nombreuses que les pièces tenues : la contrainte de la table refuserait la ligne.
    if v_keep
      and v_key = 'property.rooms_count'
      and new.bedrooms_count is not null
      and old.rooms_count is not null
      and old.rooms_count < new.bedrooms_count
    then
      v_incoming_logged := jsonb_build_object(
        'rooms_count', new.rooms_count, 'bedrooms_count', new.bedrooms_count
      );
      if v_listing_wins then
        v_keep := false;
        v_event := 'listing_changed_released';
      else
        -- La pièce reste ; le nombre de chambres entrant n'est pas pris (l'ancien reste s'il est compatible).
        v_event := 'listing_changed_kept';
        new.bedrooms_count := case
          when old.bedrooms_count is not null and old.bedrooms_count <= old.rooms_count
            then old.bedrooms_count
        end;
      end if;
    end if;

    if v_keep then
      if v_changed then
        -- Dernière valeur connue de l'annonce : les colonnes que cette écriture a changées.
        if v_key = 'property.surface_m2' then
          if new.surface_m2 is distinct from old.surface_m2 then
            v_listing := v_listing || jsonb_build_object('surface_m2', new.surface_m2);
          end if;
          if new.app_surface_m2 is distinct from old.app_surface_m2 then
            v_listing := v_listing || jsonb_build_object('app_surface_m2', new.app_surface_m2);
          end if;
          if new.app_surface_kind is distinct from old.app_surface_kind then
            v_listing := v_listing || jsonb_build_object('app_surface_kind', new.app_surface_kind);
          end if;
          if new.surface_source is distinct from old.surface_source then
            v_listing := v_listing || jsonb_build_object('surface_source', new.surface_source);
          end if;
          if new.surface_confidence is distinct from old.surface_confidence then
            v_listing := v_listing || jsonb_build_object('surface_confidence', new.surface_confidence);
          end if;
        elsif v_key = 'property.land_surface_m2' then
          v_listing := jsonb_build_object('land_surface_m2', new.land_surface_m2);
        elsif v_key = 'property.rooms_count' then
          v_listing := jsonb_build_object('rooms_count', new.rooms_count);
        elsif v_key = 'property.occupancy_status' then
          v_listing := jsonb_build_object('occupancy_status', new.occupancy_status);
        else
          v_listing := jsonb_build_object('visit_dates', new.visit_dates);
        end if;
        v_held := jsonb_set(v_held, array[v_key, 'listing'], jsonb_strip_nulls(v_listing));
      end if;
      if v_key = 'property.surface_m2' then
        new.surface_m2 := old.surface_m2;
        new.app_surface_m2 := old.app_surface_m2;
        new.app_surface_kind := old.app_surface_kind;
        new.surface_source := old.surface_source;
        new.surface_confidence := old.surface_confidence;
      elsif v_key = 'property.land_surface_m2' then
        new.land_surface_m2 := old.land_surface_m2;
      elsif v_key = 'property.rooms_count' then
        new.rooms_count := old.rooms_count;
      elsif v_key = 'property.occupancy_status' then
        new.occupancy_status := old.occupancy_status;
      else
        new.visit_dates := old.visit_dates;
      end if;
    else
      -- Libération : ce que l'écriture apporte passe ; une colonne qu'elle n'a pas touchée porte encore la valeur
      -- de la pièce et reprend donc la dernière valeur connue de l'annonce.
      if v_key = 'property.surface_m2' then
        if new.surface_m2 is not distinct from old.surface_m2 then
          new.surface_m2 := (v_listing ->> 'surface_m2')::numeric;
        end if;
        if new.app_surface_m2 is not distinct from old.app_surface_m2 then
          new.app_surface_m2 := (v_listing ->> 'app_surface_m2')::numeric;
        end if;
        if new.app_surface_kind is not distinct from old.app_surface_kind then
          new.app_surface_kind := v_listing ->> 'app_surface_kind';
        end if;
        if new.surface_source is not distinct from old.surface_source then
          new.surface_source := v_listing ->> 'surface_source';
        end if;
        if new.surface_confidence is not distinct from old.surface_confidence then
          new.surface_confidence := (v_listing ->> 'surface_confidence')::numeric;
        end if;
      elsif v_key = 'property.land_surface_m2' then
        if new.land_surface_m2 is not distinct from old.land_surface_m2 then
          new.land_surface_m2 := (v_listing ->> 'land_surface_m2')::numeric;
        end if;
      elsif v_key = 'property.rooms_count' then
        v_rooms := case
          when new.rooms_count is distinct from old.rooms_count then new.rooms_count
          else (v_listing ->> 'rooms_count')::integer
        end;
        -- Jamais d'échec de l'écrivain sur « pièces >= chambres » : à défaut de valeur compatible, NULL.
        if v_rooms is not null and new.bedrooms_count is not null and v_rooms < new.bedrooms_count then
          v_rooms := null;
        end if;
        new.rooms_count := v_rooms;
      elsif v_key = 'property.occupancy_status' then
        if new.occupancy_status is not distinct from old.occupancy_status then
          new.occupancy_status := v_listing ->> 'occupancy_status';
        end if;
      else
        if new.visit_dates is not distinct from old.visit_dates then
          new.visit_dates := v_listing -> 'visit_dates';
        end if;
      end if;
      v_held := v_held - v_key;
    end if;

    -- Un évènement par valeur entrante et par décision : une annonce qui oscille entre deux valeurs, ou la même
    -- écriture répétée, n'ajoute rien à la file.
    if v_event is not null and not (
      v_event = 'listing_changed_kept' and exists (
        select 1 from public.auction_sale_field_hold_events earlier
        where earlier.sale_id = new.id
          and earlier.field_key = v_key
          and earlier.event = 'listing_changed_kept'
          and earlier.decision_id is not distinct from v_decision_id
          and earlier.incoming_value is not distinct from v_incoming_logged
      )
    ) then
      insert into public.auction_sale_field_hold_events (
        sale_id, field_key, event, held_value, listing_value, incoming_value, decision_id
      ) values (
        new.id, v_key, v_event, v_held_value, v_listing_value, v_incoming_logged, v_decision_id
      );
    end if;
  end loop;

  if v_held is distinct from old.held_fields then
    new.held_fields := case when v_held = '{}'::jsonb then null else v_held end;
  end if;
  return new;
end;
$$;

comment on function app_private.hold_projected_sale_fields() is
  'Registre des pièces : déclencheur BEFORE UPDATE de auction_sales, passif. Remet la valeur tenue d''un champ que réécrit une écriture directe (collecte, repli REST, fusion, rattrapage) ; journalise un changement de l''annonce ; refuse (42501) toute écriture de held_fields hors app_private.project_sale_fields. Ne lit ni les observations, ni les décisions, ni la préséance, ni raw_payload.';

revoke all on function app_private.hold_projected_sale_fields()
  from public, anon, authenticated, service_role;

create or replace function app_private.refuse_inserted_held_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '42501',
    message = 'A new auction sale holds no field: auction_sales.held_fields is written only by app_private.project_sale_fields.';
end;
$$;

revoke all on function app_private.refuse_inserted_held_fields()
  from public, anon, authenticated, service_role;

-- Garde par rôle : SECURITY INVOKER, pour lire le rôle qui écrit (dans la projection, SECURITY DEFINER,
-- current_user est son propriétaire).
create or replace function app_private.refuse_api_role_held_fields_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then
    raise exception using errcode = '42501',
      message = 'auction_sales.held_fields cannot be written by an API role.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.refuse_api_role_held_fields_write()
  from public, anon, authenticated, service_role;

-- Projection --------------------------------------------------------------------------------------------------
create or replace function app_private.project_sale_fields(
  p_sale_id uuid,
  p_fields text[] default null,
  p_apply boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sale record;
  v_sales uuid[];
  v_field public.auction_fact_fields%rowtype;
  v_candidate record;
  -- Le gagnant du champ en cours, en scalaires remis à zéro à chaque champ (jamais un enregistrement, qui ne se
  -- lit pas avant sa première affectation et garderait le gagnant du champ précédent).
  v_has_winner boolean;
  v_winner_claim_id uuid;
  v_winner_decision_id uuid;
  v_winner_source_kind text;
  v_winner_rank smallint;
  v_winner_received_at timestamptz;
  v_winner_publication_mode text;
  v_winner_recipient_kind text;
  v_winner_confidence numeric;
  v_winner_value jsonb;
  v_origins text[];
  v_value jsonb;
  v_conflicting jsonb;
  v_invalid jsonb;
  v_conflict boolean;
  v_blocked jsonb;
  v_current jsonb;
  v_current_still_accepted boolean;
  v_entry jsonb;
  v_listing jsonb;
  v_listing_value jsonb;
  v_incompatible boolean;
  v_state text;
  v_old_held jsonb;
  v_new_held jsonb;
  v_result jsonb := '{}'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_event jsonb;
  v_changed boolean;
  t_surface_m2 numeric;
  t_app_surface_m2 numeric;
  t_app_surface_kind text;
  t_surface_source text;
  t_surface_confidence numeric;
  t_land_surface_m2 numeric;
  t_rooms_count integer;
  t_occupancy_status text;
  t_visit_dates jsonb;
begin
  if p_sale_id is null or p_apply is null then
    raise exception using errcode = '22023', message = 'A sale and an apply flag are required.';
  end if;
  if p_fields is not null and (
    cardinality(p_fields) = 0
    or array_position(p_fields, null) is not null
    or exists (
      select 1 from unnest(p_fields) requested(field_key)
      where not exists (
        select 1 from public.auction_fact_fields field where field.field_key = requested.field_key
      )
    )
  ) then
    raise exception using errcode = '22023', message = 'Unknown fact registry field.';
  end if;

  -- 1. La vente, verrouillée en écriture seulement (FOR NO KEY UPDATE : les clés étrangères qui la visent
  --    restent possibles). Jamais raw_payload.
  if p_apply then
    select sale.id, sale.held_fields, sale.surface_m2, sale.app_surface_m2, sale.app_surface_kind,
      sale.surface_source, sale.surface_confidence, sale.land_surface_m2, sale.rooms_count,
      sale.bedrooms_count, sale.occupancy_status, sale.visit_dates
    into v_sale
    from public.auction_sales sale
    where sale.id = p_sale_id
    for no key update;
  else
    select sale.id, sale.held_fields, sale.surface_m2, sale.app_surface_m2, sale.app_surface_kind,
      sale.surface_source, sale.surface_confidence, sale.land_surface_m2, sale.rooms_count,
      sale.bedrooms_count, sale.occupancy_status, sale.visit_dates
    into v_sale
    from public.auction_sales sale
    where sale.id = p_sale_id;
  end if;
  if not found then
    raise exception using errcode = 'P0002', message = 'Auction sale not found.';
  end if;

  t_surface_m2 := v_sale.surface_m2;
  t_app_surface_m2 := v_sale.app_surface_m2;
  t_app_surface_kind := v_sale.app_surface_kind;
  t_surface_source := v_sale.surface_source;
  t_surface_confidence := v_sale.surface_confidence;
  t_land_surface_m2 := v_sale.land_surface_m2;
  t_rooms_count := v_sale.rooms_count;
  t_occupancy_status := v_sale.occupancy_status;
  t_visit_dates := v_sale.visit_dates;
  v_old_held := v_sale.held_fields;
  v_new_held := coalesce(v_sale.held_fields, '{}'::jsonb);

  -- 2. Ventes visées : la vente et celles qu'elle a absorbées par fusion. La table des fusions est tenue à plat
  --    (une fiche absorbée pointe toujours la fiche conservée finale) : un niveau suffit.
  select array_agg(visited.sale_id) into v_sales
  from (
    select p_sale_id as sale_id
    union
    select merge.old_sale_id
    from app_private.auction_sale_merges merge
    where merge.canonical_sale_id = p_sale_id
  ) visited;

  for v_field in
    select * from public.auction_fact_fields field
    where p_fields is null or field.field_key = any(p_fields)
    order by field.field_key
  loop
    v_has_winner := false;
    v_winner_claim_id := null;
    v_winner_decision_id := null;
    v_winner_source_kind := null;
    v_winner_rank := null;
    v_winner_received_at := null;
    v_winner_publication_mode := null;
    v_winner_recipient_kind := null;
    v_winner_confidence := null;
    v_winner_value := null;
    v_origins := array[]::text[];
    v_conflicting := '[]'::jsonb;
    v_invalid := '[]'::jsonb;
    v_blocked := null;
    v_listing_value := null;
    v_incompatible := false;
    v_current := v_new_held -> v_field.field_key;
    v_current_still_accepted := false;

    -- 3. Candidats : dernière décision (seq) de chaque observation décidée pour ces ventes ; seulement une
    --    acceptation, d'un lot identifié, d'une origine qui peut tenir ce champ, si le champ est tenable, et que
    --    l'annonce n'a pas délogée depuis (évènement listing_changed_released qui nomme la décision ou qui la
    --    suit : il faut alors une nouvelle décision humaine).
    for v_candidate in
      with decided as (
        select distinct decision.claim_id
        from public.auction_fact_claim_decisions decision
        where decision.sale_id = any(v_sales) and decision.field_key = v_field.field_key
      ),
      latest as (
        select distinct on (decision.claim_id) decision.*
        from public.auction_fact_claim_decisions decision
        join decided on decided.claim_id = decision.claim_id
        order by decision.claim_id, decision.seq desc
      )
      select
        latest.id as decision_id,
        latest.claim_id,
        latest.received_at,
        latest.publication_mode,
        latest.recipient_kind,
        claim.value_jsonb,
        claim.confidence_score,
        origin.source_kind,
        precedence.rank,
        case
          when origin.source_kind = 'admin' then 'admin'
          when jsonb_typeof(claim.evidence_locator -> 'case_id') = 'string'
            then 'case:' || (claim.evidence_locator ->> 'case_id')
          when claim.raw_artifact_id is not null then 'artifact:' || claim.raw_artifact_id::text
          when claim.source_url is not null then 'url:' || claim.source_url
          else 'claim:' || claim.id::text
        end as origin_key
      from latest
      join public.auction_fact_claims claim
        on claim.id = latest.claim_id and claim.field_key = latest.field_key
      cross join lateral (
        select app_private.fact_claim_source_kind(
          claim.evidence_kind, claim.extractor_name, claim.evidence_locator
        ) as source_kind
      ) origin
      join public.auction_fact_source_precedence precedence
        on precedence.field_key = latest.field_key and precedence.source_kind = origin.source_kind
      where v_field.hold_enabled
        and latest.decision = 'accepted'
        and latest.lot_attachment in ('single_lot', 'matched')
        and precedence.can_hold
        and not exists (
          select 1 from public.auction_sale_field_hold_events released
          where released.sale_id = any(v_sales)
            and released.field_key = v_field.field_key
            and released.event = 'listing_changed_released'
            and (released.decision_id = latest.id or released.created_at >= latest.decided_at)
        )
      order by precedence.rank, coalesce(latest.received_at, latest.decided_at) desc, latest.seq desc
    loop
      v_value := app_private.sale_field_claim_value(v_field.field_key, v_candidate.value_jsonb);
      if v_value is null then
        -- Refusé à l'acceptation par le déclencheur de validation ; signalé si une ligne plus ancienne y échappe.
        v_invalid := v_invalid || jsonb_build_array(v_candidate.claim_id);
        continue;
      end if;
      if v_current ->> 'claim_id' = v_candidate.claim_id::text then
        v_current_still_accepted := true;
      end if;
      if not v_has_winner then
        v_has_winner := true;
        v_winner_claim_id := v_candidate.claim_id;
        v_winner_decision_id := v_candidate.decision_id;
        v_winner_source_kind := v_candidate.source_kind;
        v_winner_rank := v_candidate.rank;
        v_winner_received_at := v_candidate.received_at;
        v_winner_publication_mode := v_candidate.publication_mode;
        v_winner_recipient_kind := v_candidate.recipient_kind;
        v_winner_confidence := v_candidate.confidence_score;
        v_winner_value := v_value;
        v_origins := array[v_candidate.origin_key];
        continue;
      end if;
      -- 4. Un rang plus faible ne compte pas ; au même rang, une origine déjà vue est remplacée par sa pièce
      --    la plus récente ; une autre origine qui dit autre chose est une contradiction.
      continue when v_candidate.rank > v_winner_rank;
      continue when v_candidate.origin_key = any(v_origins);
      v_origins := v_origins || v_candidate.origin_key;
      if not app_private.sale_field_values_match(
        v_field.field_key, v_value, v_winner_value, v_field.abs_tolerance, v_field.rel_tolerance
      ) then
        v_conflicting := v_conflicting || jsonb_build_array(jsonb_build_object(
          'claim_id', v_candidate.claim_id, 'decision_id', v_candidate.decision_id, 'value', v_value
        ));
      end if;
    end loop;

    v_conflict := jsonb_array_length(v_conflicting) > 0;
    if v_conflict then
      v_conflicting := jsonb_build_array(jsonb_build_object(
        'claim_id', v_winner_claim_id, 'decision_id', v_winner_decision_id, 'value', v_winner_value
      )) || v_conflicting;
    elsif v_has_winner
      and v_field.field_key = 'property.rooms_count'
      and v_sale.bedrooms_count is not null
      and (v_winner_value #>> '{}')::integer < v_sale.bedrooms_count
    then
      -- La fiche compte plus de chambres que la pièce ne compte de pièces : la table refuserait la ligne.
      v_blocked := jsonb_build_object(
        'claim_id', v_winner_claim_id, 'decision_id', v_winner_decision_id, 'value', v_winner_value,
        'bedrooms_count', v_sale.bedrooms_count
      );
    end if;

    if (v_conflict or v_blocked is not null) and v_current is not null and v_current_still_accepted then
      -- Contradiction, ou pièce que la fiche refuse, sur un champ tenu par une pièce toujours acceptée : rien ne
      -- bascule, la valeur affichée reste, relecture.
      if v_conflict then
        v_state := 'conflicted';
        v_new_held := jsonb_set(v_new_held, array[v_field.field_key, 'state'], to_jsonb('conflicted'::text));
      else
        v_state := 'blocked';
      end if;
    elsif not v_conflict and v_blocked is null and v_has_winner then
      -- 5. Pièce posée. Première prise : le bloc « listing » est l'instantané des colonnes actuelles (celles de
      --    l'annonce, puisque le champ n'était pas tenu) ; champ déjà tenu : son bloc est repris.
      v_listing := v_current -> 'listing';
      if v_listing is null then
        v_listing := jsonb_strip_nulls(case v_field.field_key
          when 'property.surface_m2' then jsonb_build_object(
            'surface_m2', v_sale.surface_m2,
            'app_surface_m2', v_sale.app_surface_m2,
            'app_surface_kind', v_sale.app_surface_kind,
            'surface_source', v_sale.surface_source,
            'surface_confidence', v_sale.surface_confidence
          )
          when 'property.land_surface_m2' then jsonb_build_object('land_surface_m2', v_sale.land_surface_m2)
          when 'property.rooms_count' then jsonb_build_object('rooms_count', v_sale.rooms_count)
          when 'property.occupancy_status' then
            jsonb_build_object('occupancy_status', v_sale.occupancy_status)
          else jsonb_build_object('visit_dates', v_sale.visit_dates)
        end);
      end if;
      v_entry := jsonb_strip_nulls(jsonb_build_object(
        'v', 1,
        'value', v_winner_value,
        'state', 'held',
        'listing', v_listing,
        'claim_id', v_winner_claim_id,
        'decision_id', v_winner_decision_id,
        'source_kind', v_winner_source_kind,
        'rank', v_winner_rank,
        'received_on', (v_winner_received_at at time zone 'Europe/Paris')::date,
        'publication_mode', v_winner_publication_mode,
        'recipient_kind', v_winner_recipient_kind,
        'tolerance', jsonb_build_object('abs', v_field.abs_tolerance, 'rel', v_field.rel_tolerance),
        'on_listing_change', v_field.on_listing_change
      ));
      -- Même pièce, même décision : seuls les réglages du champ (recopiés dans l'entrée) ont pu changer. L'entrée
      -- est mise à jour sans évènement.
      v_state := case
        when v_current is not null
          and (v_current - 'tolerance' - 'on_listing_change') = (v_entry - 'tolerance' - 'on_listing_change')
          then 'unchanged'
        else 'held'
      end;
      v_new_held := v_new_held || jsonb_build_object(v_field.field_key, v_entry);
      if v_field.field_key = 'property.surface_m2' then
        t_surface_m2 := (v_winner_value #>> '{}')::numeric;
        t_app_surface_m2 := (v_winner_value #>> '{}')::numeric;
        t_app_surface_kind := 'fact_registry_' || v_winner_source_kind;
        t_surface_source := 'fact_registry_' || v_winner_source_kind;
        -- Même plancher que le noyau de publication pour une valeur acceptée par une personne.
        t_surface_confidence := greatest(v_winner_confidence, 0.85);
      elsif v_field.field_key = 'property.land_surface_m2' then
        t_land_surface_m2 := (v_winner_value #>> '{}')::numeric;
      elsif v_field.field_key = 'property.rooms_count' then
        t_rooms_count := (v_winner_value #>> '{}')::integer;
      elsif v_field.field_key = 'property.occupancy_status' then
        t_occupancy_status := v_winner_value #>> '{}';
      else
        t_visit_dates := v_winner_value;
      end if;
      if v_state = 'held' then
        v_listing_value := case v_field.field_key
          when 'property.surface_m2' then coalesce(v_listing -> 'app_surface_m2', v_listing -> 'surface_m2')
          when 'property.land_surface_m2' then v_listing -> 'land_surface_m2'
          when 'property.rooms_count' then v_listing -> 'rooms_count'
          when 'property.occupancy_status' then
            app_private.sale_field_comparable(v_field.field_key, v_listing -> 'occupancy_status')
          else v_listing -> 'visit_dates'
        end;
        v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'field_key', v_field.field_key, 'event', 'projection_held', 'held_value', v_winner_value,
          'listing_value', v_listing_value, 'decision_id', v_winner_decision_id
        )));
      end if;
    elsif v_current is not null then
      -- 6. La pièce qui tenait le champ n'est plus acceptée et aucune autre ne la remplace (plus de pièce, des
      --    pièces qui se contredisent, ou une pièce que la fiche refuse) : la valeur de l'annonce revient (NULL
      --    si l'annonce ne disait rien).
      v_state := case when v_conflict then 'conflicted' when v_blocked is not null then 'blocked' else 'released' end;
      v_listing := coalesce(v_current -> 'listing', '{}'::jsonb);
      if v_field.field_key = 'property.surface_m2' then
        t_surface_m2 := (v_listing ->> 'surface_m2')::numeric;
        t_app_surface_m2 := (v_listing ->> 'app_surface_m2')::numeric;
        t_app_surface_kind := v_listing ->> 'app_surface_kind';
        t_surface_source := v_listing ->> 'surface_source';
        t_surface_confidence := (v_listing ->> 'surface_confidence')::numeric;
        v_listing_value := coalesce(v_listing -> 'app_surface_m2', v_listing -> 'surface_m2');
      elsif v_field.field_key = 'property.land_surface_m2' then
        t_land_surface_m2 := (v_listing ->> 'land_surface_m2')::numeric;
        v_listing_value := v_listing -> 'land_surface_m2';
      elsif v_field.field_key = 'property.rooms_count' then
        t_rooms_count := (v_listing ->> 'rooms_count')::integer;
        v_listing_value := v_listing -> 'rooms_count';
        -- Un retrait ne peut pas échouer : une valeur d'annonce devenue incompatible avec les chambres de la
        -- fiche n'est pas restaurée.
        if t_rooms_count is not null and v_sale.bedrooms_count is not null
          and t_rooms_count < v_sale.bedrooms_count
        then
          t_rooms_count := null;
          v_incompatible := true;
        end if;
      elsif v_field.field_key = 'property.occupancy_status' then
        t_occupancy_status := v_listing ->> 'occupancy_status';
        v_listing_value := app_private.sale_field_comparable(
          v_field.field_key, v_listing -> 'occupancy_status');
      else
        t_visit_dates := v_listing -> 'visit_dates';
        v_listing_value := v_listing -> 'visit_dates';
      end if;
      v_new_held := v_new_held - v_field.field_key;
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'projection_released', 'held_value', v_current -> 'value',
        'listing_value', v_listing_value,
        -- Valeur d'annonce non restaurée : le nombre de chambres de la fiche qui l'en empêche.
        'incoming_value', case when v_incompatible then
          jsonb_build_object('bedrooms_count', v_sale.bedrooms_count) end,
        'decision_id', v_current -> 'decision_id'
      )));
    elsif v_conflict then
      -- Contradiction sur un champ libre : il le reste.
      v_state := 'conflicted';
    elsif v_blocked is not null then
      v_state := 'blocked';
    else
      v_state := 'pass_through';
    end if;

    if v_conflict then
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'conflicted',
        'held_value', v_new_held #> array[v_field.field_key, 'value'],
        'incoming_value', v_conflicting, 'decision_id', v_winner_decision_id
      )));
    elsif v_blocked is not null then
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'projection_blocked',
        'held_value', v_new_held #> array[v_field.field_key, 'value'],
        'incoming_value', v_blocked - 'claim_id' - 'decision_id', 'decision_id', v_winner_decision_id
      )));
    end if;

    v_result := v_result || jsonb_build_object(v_field.field_key, jsonb_strip_nulls(jsonb_build_object(
      'state', v_state,
      -- Valeur tenue après la projection (absente si le champ n'est pas tenu).
      'value', v_new_held #> array[v_field.field_key, 'value'],
      'claim_id', v_new_held #> array[v_field.field_key, 'claim_id'],
      'decision_id', v_new_held #> array[v_field.field_key, 'decision_id'],
      -- Valeur de l'annonce rendue aux colonnes quand le champ est libéré (absente si elle était incompatible
      -- avec les chambres de la fiche : NULL a été restauré).
      'released', case when v_current is not null and not v_new_held ? v_field.field_key then true end,
      'listing_value', case
        when v_current is not null and not v_new_held ? v_field.field_key and not v_incompatible
          then v_listing_value
      end,
      'listing_value_incompatible', case when v_incompatible then true end,
      'conflicting', case when v_conflict then v_conflicting end,
      'blocked', v_blocked,
      'invalid_claims', case when jsonb_array_length(v_invalid) > 0 then v_invalid end
    )));
  end loop;

  if v_new_held = '{}'::jsonb then
    v_new_held := null;
  end if;
  v_changed := v_new_held is distinct from v_old_held
    or t_surface_m2 is distinct from v_sale.surface_m2
    or t_app_surface_m2 is distinct from v_sale.app_surface_m2
    or t_app_surface_kind is distinct from v_sale.app_surface_kind
    or t_surface_source is distinct from v_sale.surface_source
    or t_surface_confidence is distinct from v_sale.surface_confidence
    or t_land_surface_m2 is distinct from v_sale.land_surface_m2
    or t_rooms_count is distinct from v_sale.rooms_count
    or t_occupancy_status is distinct from v_sale.occupancy_status
    or t_visit_dates is distinct from v_sale.visit_dates;

  if p_apply and v_changed then
    -- 7. Un seul UPDATE, identifié auprès du déclencheur de retenue par un réglage local à la transaction,
    --    remis à vide aussitôt après.
    perform pg_catalog.set_config('app.sale_field_projection', p_sale_id::text, true);
    update public.auction_sales sale set
      surface_m2 = t_surface_m2,
      app_surface_m2 = t_app_surface_m2,
      app_surface_kind = t_app_surface_kind,
      surface_source = t_surface_source,
      surface_confidence = t_surface_confidence,
      land_surface_m2 = t_land_surface_m2,
      rooms_count = t_rooms_count,
      occupancy_status = t_occupancy_status,
      visit_dates = t_visit_dates,
      held_fields = v_new_held,
      updated_at = pg_catalog.statement_timestamp()
    where sale.id = p_sale_id;
    perform pg_catalog.set_config('app.sale_field_projection', '', true);
  end if;

  if p_apply then
    for v_event in select value from jsonb_array_elements(v_events) loop
      -- Une contradiction ou un refus déjà signalé à l'identique (dernier évènement du champ, dans l'ordre de
      -- seq) n'est pas rejournalisé.
      if v_event ->> 'event' in ('conflicted', 'projection_blocked') and exists (
        select 1
        from (
          select latest.event, latest.incoming_value
          from public.auction_sale_field_hold_events latest
          where latest.sale_id = p_sale_id and latest.field_key = v_event ->> 'field_key'
          order by latest.seq desc
          limit 1
        ) last_event
        where last_event.event = v_event ->> 'event'
          and last_event.incoming_value = v_event -> 'incoming_value'
      ) then
        continue;
      end if;
      insert into public.auction_sale_field_hold_events (
        sale_id, field_key, event, held_value, listing_value, incoming_value, decision_id
      ) values (
        p_sale_id,
        v_event ->> 'field_key',
        v_event ->> 'event',
        v_event -> 'held_value',
        v_event -> 'listing_value',
        v_event -> 'incoming_value',
        (v_event ->> 'decision_id')::uuid
      );
    end loop;
  end if;

  return jsonb_build_object(
    'sale_id', p_sale_id,
    'applied', p_apply,
    'changed', v_changed,
    'fields', v_result
  );
end;
$$;

comment on function app_private.project_sale_fields(uuid, text[], boolean) is
  'Registre des pièces : seule écriture qui pose ou retire une pièce sur une fiche (colonnes tenues, held_fields, updated_at), à partir des acceptations du journal des décisions. p_apply = false : simulation sans verrou ni écriture. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.project_sale_fields(uuid, text[], boolean)
  from public, anon, authenticated, service_role;
revoke all on function app_private.fact_claim_source_kind(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.sale_field_comparable(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.sale_field_values_match(text, jsonb, jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;

-- Déclencheurs (la clause WHEN est fausse tant que held_fields est nulle : aucun appel PL/pgSQL) ---------------
create or replace trigger aaab_auction_sales_hold_projected_fields
  before update of
    surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, land_surface_m2,
    rooms_count, bedrooms_count, occupancy_status, visit_dates, held_fields
  on public.auction_sales
  for each row
  when (old.held_fields is not null or new.held_fields is distinct from old.held_fields)
  execute function app_private.hold_projected_sale_fields();
alter table public.auction_sales enable always trigger aaab_auction_sales_hold_projected_fields;

create or replace trigger aaab_auction_sales_held_fields_insert_guard
  before insert on public.auction_sales
  for each row
  when (new.held_fields is not null)
  execute function app_private.refuse_inserted_held_fields();
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_insert_guard;

create or replace trigger aaab_auction_sales_held_fields_role_guard
  before update of held_fields on public.auction_sales
  for each row
  when (new.held_fields is distinct from old.held_fields)
  execute function app_private.refuse_api_role_held_fields_write();
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_role_guard;

commit;
