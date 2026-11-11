begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R1, étape M4 (annexe 03, sections 1 et 3). INERTE : public.auction_sales.held_fields
-- est nulle partout, la clause WHEN du déclencheur est donc fausse pour toute ligne (aucun appel PL/pgSQL), et
-- aucun code de l'application ni du pipeline n'appelle la projection (lot R2).
--
-- Deux rôles séparés :
--   * app_private.project_sale_fields(vente, champs, appliquer) : LA SEULE écriture qui pose ou retire une pièce
--     sur une fiche. Elle lit les décisions du journal (dernière décision par observation), ne garde que les
--     acceptations humaines d'une pièce rattachée au bon lot (single_lot, matched) dont l'origine peut tenir le
--     champ (préséance, hold_enabled), ordonne par rang puis réception puis décision, distingue un remplacement
--     (même rang, même origine : la plus récente l'emporte) d'une contradiction (même rang, origines
--     différentes, valeurs hors tolérance : rien ne bascule, évènement « conflicted »), et écrit en un seul
--     UPDATE les colonnes, held_fields et updated_at. Sans changement, elle n'écrit rien (updated_at et xmin ne
--     bougent pas). p_apply = false : simulation, sans verrou ni écriture. Exécutable par AUCUN rôle de l'API
--     (ni anon, ni authenticated, ni service_role) : seules des fonctions SECURITY DEFINER du lot R2 l'appelleront.
--   * déclencheur aaab_auction_sales_hold_projected_fields : passif. Il ne calcule aucun gagnant et ne lit ni les
--     observations, ni la préséance, ni raw_payload (jamais to_jsonb(new) ni to_jsonb(old)) : il remet l'ancienne
--     valeur des champs déjà tenus quand une écriture directe (collecte, repli REST, fusion, rattrapage…) les
--     réécrit. Avec I la valeur entrante, H la valeur tenue et L la dernière valeur connue de l'annonce : I nulle,
--     I égale à H ou I égale à L (à la tolérance près) gardent H sans évènement ; sinon l'annonce a changé : le
--     bloc « listing » prend la nouvelle valeur et un évènement part en relecture, puis, selon le réglage du
--     champ copié dans l'entrée, H reste (keep_and_review, défaut) ou I passe et le champ est libéré
--     (listing_wins_and_review). Une écriture de held_fields hors projection est refusée (42501).
--     Nommé « aaab_ », juste après « aaaa_auction_sales_retention_tombstone_guard_update » et avant tous les autres
--     déclencheurs BEFORE : la garde de relecture IA, les projections « zzzz_ », la visibilité « zzzzz_ » et la
--     clause WHEN de « zzzzzz_auction_sales_content_changed_at » voient la valeur finale (une réécriture annulée
--     ne date pas content_changed_at).
--   * déclencheur aaab_auction_sales_held_fields_insert_guard : une ligne neuve ne tient rien ; une insertion qui
--     fournit held_fields est refusée (42501). Clause WHEN (une seule comparaison à NULL) : jamais d'appel pour
--     la collecte.
--
-- Écart assumé avec l'annexe 03 : le nombre de pièces tenu n'est jamais gardé sous le nombre de chambres entrant
-- (contrainte auction_sales_rooms_bedrooms_check) : le champ est alors libéré avec un évènement
-- listing_changed_released, au lieu de faire échouer l'écriture de la collecte. bedrooms_count est donc dans la
-- liste des colonnes du déclencheur.
--
-- Ordre des verrous (à respecter par tout appelant) : vente (FOR NO KEY UPDATE, qui ne bloque pas les clés
-- étrangères des observations et des travaux d'enrichissement), puis observations, puis décisions.
--
-- VERROU : CREATE TRIGGER prend un SHARE ROW EXCLUSIVE sur public.auction_sales (lectures possibles, écritures en
-- attente quelques millisecondes). À APPLIQUER HORS IMPORT ; lock_timeout (5 s) fait échouer la migration sans
-- effet si le verrou n'est pas obtenu.
--
-- Retour arrière (avant le lot R2 : sans aucun effet sur les fiches) :
--   begin; set local lock_timeout = '5s';
--   drop trigger if exists aaab_auction_sales_hold_projected_fields on public.auction_sales;
--   drop trigger if exists aaab_auction_sales_held_fields_insert_guard on public.auction_sales;
--   drop function if exists app_private.project_sale_fields(uuid, text[], boolean);
--   drop function if exists app_private.hold_projected_sale_fields();
--   drop function if exists app_private.refuse_inserted_held_fields();
--   drop function if exists app_private.sale_field_values_match(text, jsonb, jsonb, numeric, numeric);
--   drop function if exists app_private.sale_field_comparable(text, jsonb);
--   drop function if exists app_private.sale_field_claim_value(text, jsonb);
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

-- Valeur d'une observation acceptée, contrôlée strictement (type JSON, bornes du noyau de publication). Nulle si
-- la valeur n'est pas recevable : la projection l'écarte et la signale (invalid_claims), sans la tenir.
--   surface : nombre dans ]0 ; 1 000 000] ; terrain : nombre dans ]0 ; 100 000 000] ; pièces : entier de 1 à 100 ;
--   occupation : vacant, occupied, rented, owner_occupied ou squatted (« unknown » n'est pas une pièce) ;
--   visites : tableau non vide de dates AAAA-MM-JJ, rendu trié et sans doublon.
create or replace function app_private.sale_field_claim_value(p_field_key text, p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then null
    when p_field_key = 'property.surface_m2' then
      case when jsonb_typeof(p_value) = 'number'
        and (p_value #>> '{}')::numeric > 0 and (p_value #>> '{}')::numeric <= 1000000
        then p_value end
    when p_field_key = 'property.land_surface_m2' then
      case when jsonb_typeof(p_value) = 'number'
        and (p_value #>> '{}')::numeric > 0 and (p_value #>> '{}')::numeric <= 100000000
        then p_value end
    when p_field_key = 'property.rooms_count' then
      case when jsonb_typeof(p_value) = 'number'
        and (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
        and (p_value #>> '{}')::numeric between 1 and 100
        then to_jsonb((p_value #>> '{}')::numeric::integer) end
    when p_field_key = 'property.occupancy_status' then
      case when jsonb_typeof(p_value) = 'string'
        and (p_value #>> '{}') in ('vacant', 'occupied', 'rented', 'owner_occupied', 'squatted')
        then p_value end
    when p_field_key = 'sale.visit_dates' then
      case when jsonb_typeof(p_value) = 'array'
        and jsonb_array_length(p_value) between 1 and 50
        and not exists (
          select 1 from jsonb_array_elements(p_value) element
          where jsonb_typeof(element) <> 'string'
            or (element #>> '{}') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
        )
        then (
          select jsonb_agg(day order by day)
          from (select distinct element as day from jsonb_array_elements_text(p_value) element) days
        ) end
    else null
  end;
$$;

-- Forme comparable d'une valeur de colonne (annonce entrante, valeur tenue, dernière valeur de l'annonce). Nulle
-- quand la valeur ne dit rien : NULL, chaîne vide, tableau vide, occupation « unknown ». Les visites deviennent
-- un tableau trié et sans doublon de dates normalisées (les 10 premiers caractères d'une date ISO, sinon le texte
-- en minuscules).
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
        when jsonb_typeof(p_value) = 'number' then p_value
        when jsonb_typeof(p_value) = 'string' and btrim(p_value #>> '{}') ~ '^[0-9]+([.][0-9]+)?$'
          then to_jsonb(btrim(p_value #>> '{}')::numeric)
        else null
      end
    when p_field_key = 'property.occupancy_status' then
      case
        when jsonb_typeof(p_value) = 'string'
          and nullif(lower(btrim(p_value #>> '{}')), '') is not null
          and lower(btrim(p_value #>> '{}')) <> 'unknown'
          then to_jsonb(lower(btrim(p_value #>> '{}')))
        else null
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
-- Valeur entrante d'un champ à plusieurs colonnes (surface) : la colonne de valeur que l'écriture a changée
-- (app_surface_m2 d'abord, sinon surface_m2), pour qu'une écriture partielle (un PATCH de surface_m2 seule) soit
-- vue comme un changement de l'annonce ; à défaut, la valeur affichée entrante. Le bloc « listing » ne reprend que
-- les colonnes que l'écriture a changées : une colonne inchangée porte encore la valeur tenue, pas celle de
-- l'annonce.
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
  v_incoming jsonb;
  v_incoming_logged jsonb;
  v_held_value jsonb;
  v_listing_value jsonb;
  v_abs numeric;
  v_rel numeric;
  v_keep boolean;
  v_event text;
begin
  -- La projection pose ce réglage de transaction (local) autour de son UPDATE : elle fait foi.
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
    -- Colonnes du champ, nommées une à une (jamais la ligne entière).
    if v_key = 'property.surface_m2' then
      v_incoming := to_jsonb(case
        when new.app_surface_m2 is not null and new.app_surface_m2 is distinct from old.app_surface_m2
          then new.app_surface_m2
        when new.surface_m2 is not null and new.surface_m2 is distinct from old.surface_m2
          then new.surface_m2
        else coalesce(new.app_surface_m2, new.surface_m2)
      end);
      v_listing_value := coalesce(v_listing -> 'app_surface_m2', v_listing -> 'surface_m2');
    elsif v_key = 'property.land_surface_m2' then
      v_incoming := to_jsonb(new.land_surface_m2);
      v_listing_value := v_listing -> 'land_surface_m2';
    elsif v_key = 'property.rooms_count' then
      v_incoming := to_jsonb(new.rooms_count);
      v_listing_value := v_listing -> 'rooms_count';
    elsif v_key = 'property.occupancy_status' then
      v_incoming := to_jsonb(new.occupancy_status);
      v_listing_value := v_listing -> 'occupancy_status';
    elsif v_key = 'sale.visit_dates' then
      v_incoming := new.visit_dates;
      v_listing_value := v_listing -> 'visit_dates';
    else
      raise exception using errcode = '22023',
        message = format('auction_sales.held_fields holds an unknown field %s.', v_key);
    end if;
    v_held_value := v_entry -> 'value';
    v_abs := (v_entry #>> '{tolerance,abs}')::numeric;
    v_rel := (v_entry #>> '{tolerance,rel}')::numeric;
    v_incoming_logged := v_incoming;

    if app_private.sale_field_comparable(v_key, v_incoming) is null then
      -- L'annonce ne dit rien.
      v_keep := true;
      v_event := null;
    elsif app_private.sale_field_values_match(v_key, v_incoming, v_held_value, v_abs, v_rel) then
      -- Écho ou confirmation de la valeur tenue.
      v_keep := true;
      v_event := null;
    elsif app_private.sale_field_values_match(v_key, v_incoming, v_listing_value, v_abs, v_rel) then
      -- L'annonce n'a pas changé.
      v_keep := true;
      v_event := null;
    elsif v_entry ->> 'on_listing_change' = 'listing_wins_and_review' then
      v_keep := false;
      v_event := 'listing_changed_released';
    else
      v_keep := true;
      v_event := 'listing_changed_kept';
    end if;

    -- Le nombre de pièces tenu ne descend jamais sous le nombre de chambres entrant (contrainte
    -- auction_sales_rooms_bedrooms_check) : le champ est libéré et le cas part en relecture, avec les deux
    -- nombres, au lieu de faire échouer l'écriture de la collecte.
    if v_keep
      and v_key = 'property.rooms_count'
      and new.bedrooms_count is not null
      and old.rooms_count is not null
      and old.rooms_count < new.bedrooms_count
    then
      v_keep := false;
      v_event := 'listing_changed_released';
      v_incoming_logged := jsonb_build_object(
        'rooms_count', new.rooms_count, 'bedrooms_count', new.bedrooms_count
      );
    end if;

    if v_keep then
      if v_event = 'listing_changed_kept' then
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
      v_held := v_held - v_key;
    end if;

    if v_event is not null then
      insert into public.auction_sale_field_hold_events (
        sale_id, field_key, event, held_value, listing_value, incoming_value, decision_id
      ) values (
        new.id, v_key, v_event, v_held_value, v_listing_value, v_incoming_logged,
        (v_entry ->> 'decision_id')::uuid
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
  'Registre des pièces : déclencheur BEFORE UPDATE de auction_sales, passif. Remet la valeur tenue d''un champ que réécrit une écriture directe (collecte, repli REST, fusion, rattrapage) ; journalise un changement de l''annonce ; refuse (42501) toute écriture de held_fields hors app_private.project_sale_fields. Ne lit ni les observations, ni la préséance, ni raw_payload.';

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
  v_current jsonb;
  v_current_still_accepted boolean;
  v_entry jsonb;
  v_listing jsonb;
  v_listing_value jsonb;
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
      sale.occupancy_status, sale.visit_dates
    into v_sale
    from public.auction_sales sale
    where sale.id = p_sale_id
    for no key update;
  else
    select sale.id, sale.held_fields, sale.surface_m2, sale.app_surface_m2, sale.app_surface_kind,
      sale.surface_source, sale.surface_confidence, sale.land_surface_m2, sale.rooms_count,
      sale.occupancy_status, sale.visit_dates
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

  -- 2. Ventes visées : la vente et celles qu'elle a absorbées par fusion (en chaîne).
  with recursive absorbed(sale_id) as (
    select p_sale_id
    union
    select merge.old_sale_id
    from app_private.auction_sale_merges merge
    join absorbed on merge.canonical_sale_id = absorbed.sale_id
  )
  select array_agg(absorbed.sale_id) into v_sales from absorbed;

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
    v_listing_value := null;
    v_current := v_new_held -> v_field.field_key;
    v_current_still_accepted := false;

    -- 3. Candidats : dernière décision de chaque observation décidée pour ces ventes ; seulement une
    --    acceptation, d'un lot identifié, d'une origine qui peut tenir ce champ, si le champ est tenable.
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
        order by decision.claim_id, decision.decided_at desc, decision.id desc
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
          when claim.evidence_locator ? 'case_id' then 'case:' || (claim.evidence_locator ->> 'case_id')
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
      order by precedence.rank, latest.received_at desc nulls last, latest.decided_at desc,
        latest.claim_id
    loop
      v_value := app_private.sale_field_claim_value(v_field.field_key, v_candidate.value_jsonb);
      if v_value is null then
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

    if jsonb_array_length(v_conflicting) > 0 then
      v_conflicting := jsonb_build_array(jsonb_build_object(
        'claim_id', v_winner_claim_id, 'decision_id', v_winner_decision_id, 'value', v_winner_value
      )) || v_conflicting;
    end if;

    if jsonb_array_length(v_conflicting) > 0 and v_current is not null and v_current_still_accepted then
      -- Contradiction sur un champ tenu par une pièce toujours acceptée : rien ne bascule, la valeur affichée
      -- reste (état « conflicted »), relecture.
      v_state := 'conflicted';
      v_new_held := jsonb_set(v_new_held, array[v_field.field_key, 'state'], to_jsonb('conflicted'::text));
    elsif jsonb_array_length(v_conflicting) = 0 and v_has_winner then
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
      v_state := case when v_current is not null and v_current = v_entry then 'unchanged' else 'held' end;
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
          when 'property.occupancy_status' then v_listing -> 'occupancy_status'
          else v_listing -> 'visit_dates'
        end;
        v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'field_key', v_field.field_key, 'event', 'projection_held', 'held_value', v_winner_value,
          'listing_value', v_listing_value, 'decision_id', v_winner_decision_id
        )));
      end if;
    elsif v_current is not null then
      -- 6. La pièce qui tenait le champ n'est plus acceptée et aucune autre ne la remplace (plus de pièce, ou
      --    des pièces qui se contredisent) : la valeur de l'annonce revient (NULL si l'annonce ne disait rien).
      v_state := case when jsonb_array_length(v_conflicting) > 0 then 'conflicted' else 'released' end;
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
      elsif v_field.field_key = 'property.occupancy_status' then
        t_occupancy_status := v_listing ->> 'occupancy_status';
        v_listing_value := v_listing -> 'occupancy_status';
      else
        t_visit_dates := v_listing -> 'visit_dates';
        v_listing_value := v_listing -> 'visit_dates';
      end if;
      v_new_held := v_new_held - v_field.field_key;
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'projection_released', 'held_value', v_current -> 'value',
        'listing_value', v_listing_value, 'decision_id', v_current -> 'decision_id'
      )));
    elsif jsonb_array_length(v_conflicting) > 0 then
      -- Contradiction sur un champ libre : il le reste.
      v_state := 'conflicted';
    else
      v_state := 'pass_through';
    end if;

    if jsonb_array_length(v_conflicting) > 0 then
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'conflicted',
        'held_value', v_new_held #> array[v_field.field_key, 'value'],
        'incoming_value', v_conflicting, 'decision_id', v_winner_decision_id
      )));
    end if;

    v_result := v_result || jsonb_build_object(v_field.field_key, jsonb_strip_nulls(jsonb_build_object(
      'state', v_state,
      -- Valeur tenue après la projection (absente si le champ n'est pas tenu).
      'value', v_new_held #> array[v_field.field_key, 'value'],
      'claim_id', v_new_held #> array[v_field.field_key, 'claim_id'],
      'decision_id', v_new_held #> array[v_field.field_key, 'decision_id'],
      -- Valeur de l'annonce rendue aux colonnes quand le champ est libéré.
      'released', case when v_current is not null and not v_new_held ? v_field.field_key then true end,
      'listing_value', case
        when v_current is not null and not v_new_held ? v_field.field_key then v_listing_value
      end,
      'conflicting', case when jsonb_array_length(v_conflicting) > 0 then v_conflicting end,
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
      -- Une contradiction déjà signalée à l'identique n'est pas rejournalisée.
      if v_event ->> 'event' = 'conflicted' and exists (
        select 1
        from (
          select latest.event, latest.incoming_value
          from public.auction_sale_field_hold_events latest
          where latest.sale_id = p_sale_id and latest.field_key = v_event ->> 'field_key'
          order by latest.created_at desc, latest.id desc
          limit 1
        ) last_event
        where last_event.event = 'conflicted' and last_event.incoming_value = v_event -> 'incoming_value'
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
  'Registre des pièces : seule écriture qui pose ou retire une pièce sur une fiche (colonnes tenues, held_fields, updated_at), à partir des décisions d''acceptation humaine du journal. p_apply = false : simulation sans verrou ni écriture. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.project_sale_fields(uuid, text[], boolean)
  from public, anon, authenticated, service_role;
revoke all on function app_private.fact_claim_source_kind(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.sale_field_claim_value(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.sale_field_comparable(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.sale_field_values_match(text, jsonb, jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;

-- Déclencheurs (la clause WHEN est fausse tant que held_fields est nulle : aucun appel PL/pgSQL) ---------------
drop trigger if exists aaab_auction_sales_hold_projected_fields on public.auction_sales;
create trigger aaab_auction_sales_hold_projected_fields
  before update of
    surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, land_surface_m2,
    rooms_count, bedrooms_count, occupancy_status, visit_dates, held_fields
  on public.auction_sales
  for each row
  when (old.held_fields is not null or new.held_fields is distinct from old.held_fields)
  execute function app_private.hold_projected_sale_fields();

drop trigger if exists aaab_auction_sales_held_fields_insert_guard on public.auction_sales;
create trigger aaab_auction_sales_held_fields_insert_guard
  before insert on public.auction_sales
  for each row
  when (new.held_fields is not null)
  execute function app_private.refuse_inserted_held_fields();

commit;
