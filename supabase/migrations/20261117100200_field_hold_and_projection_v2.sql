begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a, étape A3 (plan du 11/11/2026, section 10 ; annexe 08, points 3, 4, 6 pour les
-- indices, 7 pour la comparaison et 8). INERTE : public.auction_sales.held_fields est nulle partout, la clause
-- WHEN des déclencheurs est donc fausse pour toute ligne, et rien n'appelle la projection.
--
-- Ce fichier remplace la retenue et la projection de 20261116100500 (version 2 de l'entrée de held_fields).
--
-- 1. MÉMOIRE D'ÉCHO (point 3, filet de la garde d'écho de la collecte). La collecte recopie de la base vers la
--    base : un import commencé avant une décision peut réécrire une valeur que la décision vient de retirer ou de
--    remplacer. Au lot R1 la base ne reconnaissait pas ce retour (scénarios A, B et C de l'annexe 09, section
--    2.1). L'entrée d'un champ garde désormais les anciennes valeurs tenues :
--      {"v":2,"state":"held","value":56,"echo":[{"value":54,"until":"2026-11-18T09:00:00+00:00"}],"listing":{…},…}
--      {"v":2,"state":"released","echo":[{"value":56,"until":"…"},{"value":54}],"released_by":"withdrawn",
--       "decision_id":"…","tolerance":{"abs":1,"rel":0.02}}
--    * « echo » : au plus cinq valeurs, la plus récente d'abord. Chaque valeur porte sa propre échéance « until »
--      (app_private.sale_field_echo_memory() : 7 jours, arbitrage du plan) ; sans « until », elle vit autant que la
--      vente : c'est le cas d'une valeur dont la pièce a reçu une opposition, ou un retrait pour autorisation
--      retirée (authorization_withdrawn). Une valeur opposée n'est jamais chassée de la liste par une valeur à
--      échéance.
--    * À la libération (retrait, opposition, rejet, contradiction, ou annonce qui l'emporte), l'entrée n'est plus
--      supprimée : elle passe à l'état « released » et ne garde que la mémoire d'écho. Tout lecteur de « ce que
--      la vente tient » filtre donc state in ('held', 'conflicted').
--    * Une valeur échue est retirée à l'écriture suivante de la vente (retenue) ou par la projection suivante qui
--      écrit ; une entrée « released » sans mémoire disparaît, et held_fields redevient nulle quand il ne reste
--      rien. Aucune tâche planifiée n'écrit. L'échéance seule n'est pas un changement pour la simulation.
--    Règles de la retenue, avec I la valeur entrante, H la valeur tenue, L la valeur d'annonce mémorisée et E la
--    mémoire d'écho :
--      champ tenu : I qui ne dit rien, I égale à H, I égale à L : H reste, sans évènement (lot R1) ;
--                   I égale à une valeur de E : H reste, L inchangée, évènement « echo_suppressed » (un par valeur
--                   et par décision) ; autre valeur : l'annonce a changé, comme au lot R1 ;
--      champ libéré : I égale à une valeur de E et différente de la colonne actuelle : la colonne actuelle reste
--                   (le groupe entier pour la surface), évènement « echo_suppressed » ; autre valeur : elle passe,
--                   comme pour un champ libre.
--    COLONNES VOISINES, jamais tenues mais surveillées (l'application affiche app_surface_m2, à défaut
--    habitable_surface_m2, à défaut carrez_surface_m2, et la collecte recalcule ces colonnes les unes à partir
--    des autres) : pour la surface, habitable_surface_m2 et carrez_surface_m2 ; pour le terrain, surface_m2 et
--    app_surface_m2 (avec app_surface_kind) quand la surface n'est pas elle-même tenue. Une valeur entrante sur
--    ces colonnes, égale à H ou à une valeur de E, est remplacée par la colonne actuelle : la valeur d'une pièce
--    n'entre jamais dans une colonne que le registre ne tient pas, elle ne peut donc pas y rester après un
--    retrait. Sans évènement tant que le champ est tenu (la collecte recalcule à chaque passage à partir de la
--    valeur affichée) ; avec « echo_suppressed » une fois le champ libéré. Le déclencheur se déclenche donc sur
--    deux colonnes de plus.
--    L'évènement « echo_suppressed » est l'indicateur d'un chemin que la garde d'écho de la collecte a oublié :
--    il doit rester à zéro. Limite assumée : une annonce qui publie réellement une valeur de la mémoire est
--    retenue jusqu'à l'échéance (pour toujours après une opposition), et visible en relecture par cet évènement.
--
-- 2. VALEUR D'ANNONCE QUAND L'ANNONCE SE TAIT (point 8, corrigé par le plan). La règle du lot R1 est gardée : une
--    valeur entrante vide ne vide PAS la valeur d'annonce mémorisée (la collecte juge une vente sur la valeur
--    affichée : un vide peut venir d'un garde-fou appliqué à la valeur tenue, pas d'un silence de l'annonce).
--    L'entrée note seulement le fait : « listing_silent_since » (date de la première écriture explicitement vide
--    d'une colonne dont l'annonce disait quelque chose), retiré dès que l'annonce redit sa valeur ou en change.
--    Le contrôle quotidien (20261117100500) en fait l'alerte fact_registry.stale_listing.
--
-- 3. VALEUR NEUTRE (point 4). Une pièce de surface écrit surface_source = 'fact_registry' et app_surface_kind =
--    'built' (« surface bâtie de nature non précisée », valeur déjà employée par la collecte). Le lot R1 écrivait
--    « fact_registry_<origine> » dans ces deux colonnes, que les vues publiques lisent : l'origine d'une pièce
--    (avocat, greffe, notaire, document, équipe) ne doit pas devenir publique. Elle reste dans held_fields.
--
-- 4. ORDRE PAR LA SÉQUENCE COMMUNE (point 7, 20261117100000). Une pièce que l'annonce a délogée ne reprend pas le
--    champ : la projection compare désormais le numéro de l'évènement à celui de la décision (released.seq >
--    latest.seq), plus une date. LIBÉRATION DURABLE ET VENTE ABSORBÉE (point 6) : un évènement
--    listing_changed_released de la vente projetée écarte toute décision plus ancienne de l'ensemble (cette vente
--    et celles qu'elle a absorbées) ; un évènement d'une vente absorbée n'écarte que les décisions de cette
--    vente, comme au lot R1.
--
-- 5. INDICES DE FUSION (point 6). app_private.project_sale_fields reçoit un quatrième paramètre,
--    p_listing_hints : les entrées held_fields de la vente absorbée (seules les clés « value », « state »,
--    « echo » et « listing » sont lues). Une fusion écrit la vente conservée avant de supprimer l'absorbée : ses
--    colonnes peuvent déjà porter la valeur tenue par l'absorbée. À la première prise d'un champ, si une colonne
--    de valeur égale la valeur ou une valeur d'écho de l'indice, le bloc « listing » est celui de l'indice (la
--    vraie valeur d'annonce) et non l'instantané des colonnes. La mémoire d'écho de l'indice est reprise. Aucun
--    appelant à ce lot (la fonction de report des fusions le passera au lot R2b). L'ancienne signature à trois
--    paramètres est supprimée.
--
-- 6. updated_at monotone : la projection écrit greatest(statement_timestamp(), updated_at + 1 microseconde), pour
--    qu'une écriture optimiste de la collecte, gardée par updated_at, abandonne toujours après une projection.
--
-- Arbitrages du plan appliqués contre l'annexe 08 : la base n'exige de la collecte aucun remplacement des colonnes
-- tenues par la valeur d'annonce (exigence P1 limitée à la fusion) ; une valeur entrante vide ne vide pas la
-- valeur d'annonce (point 8) ; la mémoire d'écho dure 7 jours et non 30, par valeur et non par entrée.
-- Non traité ici (lot R2c) : le refus d'un bloc d'annonce marqué information_agent_verified (point 13).
--
-- Ordre des verrous (inchangé) : vente (FOR NO KEY UPDATE), puis observations, puis décisions.
--
-- VERROU : CREATE OR REPLACE TRIGGER et ENABLE ALWAYS TRIGGER prennent un SHARE ROW EXCLUSIVE sur
-- public.auction_sales (lectures possibles, écritures en attente quelques millisecondes), à la première comme à
-- la seconde application ; jamais ACCESS EXCLUSIVE. À APPLIQUER HORS IMPORT ; lock_timeout (5 s) fait échouer la
-- migration sans effet si le verrou n'est pas obtenu.
--
-- Retour arrière (tant que held_fields est nulle partout : sans aucun effet sur les fiches) : réappliquer les
-- définitions de 20261116100500 (retenue, projection à trois paramètres, déclencheur et sa liste de colonnes),
-- puis
--   begin; set local lock_timeout = '5s';
--   drop function if exists app_private.project_sale_fields(uuid, text[], boolean, jsonb);
--   drop function if exists app_private.sale_field_incoming_class(text, jsonb, jsonb, jsonb, jsonb, numeric, numeric);
--   drop function if exists app_private.sale_field_echo_add(jsonb, text, jsonb, timestamptz, numeric, numeric);
--   drop function if exists app_private.sale_field_echo_matches(text, jsonb, jsonb, numeric, numeric);
--   drop function if exists app_private.sale_field_echo_prune(jsonb, timestamptz);
--   drop function if exists app_private.sale_field_echo_memory();
--   commit;
-- Dès qu'un champ est tenu ou libéré (held_fields non nulle), ne plus revenir en arrière : la retenue du lot R1
-- ne connaît pas l'état « released ».

-- Durée de la mémoire d'écho hors opposition (arbitrage du plan : 7 jours). Une seule fonction à changer.
create or replace function app_private.sale_field_echo_memory()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '7 days';
$$;

-- held_fields sans les valeurs d'écho échues à p_now. Une entrée « released » qui n'a plus de mémoire disparaît ;
-- nul s'il ne reste aucune entrée. Les entrées tenues ne changent pas autrement.
create or replace function app_private.sale_field_echo_prune(p_held jsonb, p_now timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when p_held is null or pg_catalog.jsonb_typeof(p_held) <> 'object' then p_held
    else (
      select case when count(*) = 0 then null else pg_catalog.jsonb_object_agg(kept.key, kept.entry) end
      from (
        select
          field.key,
          case
            when pg_catalog.jsonb_typeof(field.value) <> 'object' then field.value
            when live.echo is null then field.value - 'echo'
            else pg_catalog.jsonb_set(field.value, '{echo}', live.echo)
          end as entry,
          live.echo
        from pg_catalog.jsonb_each(p_held) field
        cross join lateral (
          select pg_catalog.jsonb_agg(item.value order by item.position) as echo
          from pg_catalog.jsonb_array_elements(
            case
              when pg_catalog.jsonb_typeof(field.value -> 'echo') = 'array' then field.value -> 'echo'
              else '[]'::jsonb
            end
          ) with ordinality item(value, position)
          where item.value ->> 'until' is null or (item.value ->> 'until')::timestamptz > p_now
        ) live
      ) kept
      where kept.echo is not null or kept.entry ->> 'state' is distinct from 'released'
    )
  end;
$$;

-- Une valeur concorde-t-elle avec une valeur de la mémoire d'écho (à la tolérance du champ) ?
create or replace function app_private.sale_field_echo_matches(
  p_field_key text,
  p_value jsonb,
  p_echo jsonb,
  p_abs_tolerance numeric,
  p_rel_tolerance numeric
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(p_echo) = 'array' then p_echo else '[]'::jsonb end
    ) item
    where app_private.sale_field_values_match(
      p_field_key, p_value, item.value -> 'value', p_abs_tolerance, p_rel_tolerance
    )
  );
$$;

-- Ajoute une valeur à la mémoire d'écho. p_until nul : la valeur vit autant que la vente. Une valeur déjà en
-- mémoire (à la tolérance près) garde sa place et sa forme ; seule son échéance change : retirée si l'une des deux
-- est sans échéance, sinon la plus tardive. Ajouter deux fois la même valeur ne change donc rien (la projection
-- reste idempotente). Une valeur nouvelle entre en tête. Cinq valeurs au plus : la plus ancienne valeur à échéance
-- sort d'abord, jamais une valeur sans échéance tant qu'il en reste une à échéance.
create or replace function app_private.sale_field_echo_add(
  p_echo jsonb,
  p_field_key text,
  p_value jsonb,
  p_until timestamptz,
  p_abs_tolerance numeric,
  p_rel_tolerance numeric
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_echo jsonb := case when pg_catalog.jsonb_typeof(p_echo) = 'array' then p_echo else '[]'::jsonb end;
  v_result jsonb := '[]'::jsonb;
  v_element jsonb;
  v_found boolean := false;
  v_drop integer;
begin
  if app_private.sale_field_comparable(p_field_key, p_value) is null then
    return v_echo;
  end if;
  for v_element in
    select item.value
    from pg_catalog.jsonb_array_elements(v_echo) with ordinality item(value, position)
    order by item.position
  loop
    if not v_found and app_private.sale_field_values_match(
      p_field_key, p_value, v_element -> 'value', p_abs_tolerance, p_rel_tolerance
    ) then
      v_found := true;
      if v_element ->> 'until' is not null then
        if p_until is null then
          v_element := v_element - 'until';
        elsif p_until > (v_element ->> 'until')::timestamptz then
          v_element := pg_catalog.jsonb_set(v_element, '{until}', pg_catalog.to_jsonb(p_until));
        end if;
      end if;
    end if;
    v_result := v_result || pg_catalog.jsonb_build_array(v_element);
  end loop;
  if v_found then
    return v_result;
  end if;
  v_result := pg_catalog.jsonb_build_array(
    case
      when p_until is null then pg_catalog.jsonb_build_object('value', p_value)
      else pg_catalog.jsonb_build_object('value', p_value, 'until', p_until)
    end
  ) || v_result;
  while pg_catalog.jsonb_array_length(v_result) > 5 loop
    select max(item.position)::integer - 1 into v_drop
    from pg_catalog.jsonb_array_elements(v_result) with ordinality item(value, position)
    where item.value ->> 'until' is not null;
    v_result := v_result - coalesce(v_drop, pg_catalog.jsonb_array_length(v_result) - 1);
  end loop;
  return v_result;
end;
$$;

-- Ce que dit une valeur entrante d'une colonne : 'empty' (elle ne dit rien), 'held' (la valeur tenue), 'listing'
-- (la valeur d'annonce mémorisée, ou la colonne actuelle pour un champ libéré), 'echo' (une valeur de la mémoire
-- d'écho), 'changed' (autre chose). Dans cet ordre : une valeur égale à la valeur tenue n'est jamais un écho.
create or replace function app_private.sale_field_incoming_class(
  p_field_key text,
  p_incoming jsonb,
  p_held jsonb,
  p_listing jsonb,
  p_echo jsonb,
  p_abs_tolerance numeric,
  p_rel_tolerance numeric
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when app_private.sale_field_comparable(p_field_key, p_incoming) is null then 'empty'
    when app_private.sale_field_values_match(
      p_field_key, p_incoming, p_held, p_abs_tolerance, p_rel_tolerance) then 'held'
    when app_private.sale_field_values_match(
      p_field_key, p_incoming, p_listing, p_abs_tolerance, p_rel_tolerance) then 'listing'
    when app_private.sale_field_echo_matches(
      p_field_key, p_incoming, p_echo, p_abs_tolerance, p_rel_tolerance) then 'echo'
    else 'changed'
  end;
$$;

revoke all on function app_private.sale_field_echo_memory()
  from public, anon, authenticated, service_role;
revoke all on function app_private.sale_field_echo_prune(jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function app_private.sale_field_echo_matches(text, jsonb, jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;
revoke all on function app_private.sale_field_echo_add(jsonb, text, jsonb, timestamptz, numeric, numeric)
  from public, anon, authenticated, service_role;
revoke all on function
  app_private.sale_field_incoming_class(text, jsonb, jsonb, jsonb, jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;

-- Déclencheur de retenue, version 2 --------------------------------------------------------------------------------
-- Passif comme au lot R1 : il ne calcule aucun gagnant et ne lit ni les observations, ni les décisions, ni la
-- préséance, ni raw_payload (jamais la ligne entière). Champ à plusieurs colonnes (surface) : l'annonce a changé
-- dès qu'UNE des deux colonnes de valeur (app_surface_m2 d'abord, puis surface_m2) dit quelque chose qui n'est ni
-- la valeur tenue, ni la valeur d'annonce mémorisée pour CETTE colonne, ni une valeur de la mémoire d'écho.
create or replace function app_private.hold_projected_sale_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_held jsonb;
  v_key text;
  v_entry jsonb;
  v_state text;
  v_listing jsonb;
  v_echo jsonb;
  v_class text;
  v_class_app text;
  v_class_surface text;
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
  v_silent boolean;
  v_spoke boolean;
  v_surface_held boolean;
begin
  -- La projection pose ce réglage de transaction (local) autour de son UPDATE : elle fait foi. Ce n'est pas un
  -- contrôle d'accès : aaab_auction_sales_held_fields_role_guard n'accepte que le rôle propriétaire de la
  -- projection, réglage posé ou non.
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

  -- Les valeurs d'écho échues sortent à cette écriture.
  v_held := app_private.sale_field_echo_prune(old.held_fields, v_now);
  if v_held is null then
    new.held_fields := null;
    return new;
  end if;
  v_surface_held := coalesce(v_held #>> '{property.surface_m2,state}' in ('held', 'conflicted'), false);

  for v_key in select held.key from pg_catalog.jsonb_object_keys(v_held) held(key) order by held.key
  loop
    if v_key not in (
      'property.surface_m2', 'property.land_surface_m2', 'property.rooms_count', 'property.occupancy_status',
      'sale.visit_dates'
    ) then
      raise exception using errcode = '22023',
        message = format('auction_sales.held_fields holds an unknown field %s.', v_key);
    end if;
    v_entry := v_held -> v_key;
    v_state := v_entry ->> 'state';
    if v_state is null or v_state not in ('held', 'conflicted', 'released') then
      raise exception using errcode = '22023',
        message = format('auction_sales.held_fields holds the field %s in an unknown state.', v_key);
    end if;
    v_listing := coalesce(v_entry -> 'listing', '{}'::jsonb);
    v_echo := coalesce(v_entry -> 'echo', '[]'::jsonb);
    v_held_value := v_entry -> 'value';
    v_abs := (v_entry #>> '{tolerance,abs}')::numeric;
    v_rel := (v_entry #>> '{tolerance,rel}')::numeric;
    v_listing_wins := coalesce(v_entry ->> 'on_listing_change' = 'listing_wins_and_review', false);
    v_decision_id := (v_entry ->> 'decision_id')::uuid;
    v_class := 'none';
    v_incoming := null;
    v_incoming_logged := null;
    v_listing_value := null;
    v_event := null;
    v_silent := false;
    v_spoke := false;

    if v_state = 'released' then
      -- Champ libéré : seule la mémoire d'écho joue. Une valeur entrante égale à une valeur de la mémoire, et
      -- différente de la colonne actuelle, ne passe pas ; tout le reste passe comme pour un champ libre.
      if v_key = 'property.surface_m2' then
        if new.app_surface_m2 is distinct from old.app_surface_m2
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.app_surface_m2), null, to_jsonb(old.app_surface_m2), v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := to_jsonb(new.app_surface_m2);
        elsif new.surface_m2 is distinct from old.surface_m2
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.surface_m2), null, to_jsonb(old.surface_m2), v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := to_jsonb(new.surface_m2);
        end if;
        v_listing_value := coalesce(to_jsonb(old.app_surface_m2), to_jsonb(old.surface_m2));
        if v_class = 'echo' then
          new.surface_m2 := old.surface_m2;
          new.app_surface_m2 := old.app_surface_m2;
          new.app_surface_kind := old.app_surface_kind;
          new.surface_source := old.surface_source;
          new.surface_confidence := old.surface_confidence;
        end if;
        -- Colonnes voisines.
        if new.habitable_surface_m2 is distinct from old.habitable_surface_m2
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.habitable_surface_m2), null, to_jsonb(old.habitable_surface_m2), v_echo,
            v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := coalesce(v_incoming, to_jsonb(new.habitable_surface_m2));
          new.habitable_surface_m2 := old.habitable_surface_m2;
        end if;
        if new.carrez_surface_m2 is distinct from old.carrez_surface_m2
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.carrez_surface_m2), null, to_jsonb(old.carrez_surface_m2), v_echo, v_abs,
            v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := coalesce(v_incoming, to_jsonb(new.carrez_surface_m2));
          new.carrez_surface_m2 := old.carrez_surface_m2;
        end if;
      elsif v_key = 'property.land_surface_m2' then
        v_listing_value := to_jsonb(old.land_surface_m2);
        if new.land_surface_m2 is distinct from old.land_surface_m2
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.land_surface_m2), null, to_jsonb(old.land_surface_m2), v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := to_jsonb(new.land_surface_m2);
          new.land_surface_m2 := old.land_surface_m2;
        end if;
        -- Colonnes voisines (terrain recopié en surface principale), quand la surface n'est pas tenue.
        if not v_surface_held then
          if new.app_surface_m2 is distinct from old.app_surface_m2
            and app_private.sale_field_incoming_class(
              v_key, to_jsonb(new.app_surface_m2), null, to_jsonb(old.app_surface_m2), v_echo, v_abs, v_rel
            ) = 'echo'
          then
            v_class := 'echo';
            v_incoming := coalesce(v_incoming, to_jsonb(new.app_surface_m2));
            new.app_surface_m2 := old.app_surface_m2;
            new.app_surface_kind := old.app_surface_kind;
          end if;
          if new.surface_m2 is distinct from old.surface_m2
            and app_private.sale_field_incoming_class(
              v_key, to_jsonb(new.surface_m2), null, to_jsonb(old.surface_m2), v_echo, v_abs, v_rel
            ) = 'echo'
          then
            v_class := 'echo';
            v_incoming := coalesce(v_incoming, to_jsonb(new.surface_m2));
            new.surface_m2 := old.surface_m2;
          end if;
        end if;
      elsif v_key = 'property.rooms_count' then
        v_listing_value := to_jsonb(old.rooms_count);
        if new.rooms_count is distinct from old.rooms_count
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.rooms_count), null, to_jsonb(old.rooms_count), v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := to_jsonb(new.rooms_count);
          new.rooms_count := old.rooms_count;
          -- Jamais d'échec de l'écrivain sur « pièces >= chambres » : le nombre de chambres venu avec l'écho
          -- n'est pas pris s'il dépasse le nombre de pièces gardé.
          if old.rooms_count is not null and new.bedrooms_count is not null
            and old.rooms_count < new.bedrooms_count
          then
            new.bedrooms_count := case
              when old.bedrooms_count is not null and old.bedrooms_count <= old.rooms_count
                then old.bedrooms_count
            end;
          end if;
        end if;
      elsif v_key = 'property.occupancy_status' then
        v_listing_value := app_private.sale_field_comparable(v_key, to_jsonb(old.occupancy_status));
        if new.occupancy_status is distinct from old.occupancy_status
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.occupancy_status), null, to_jsonb(old.occupancy_status), v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          -- La file ne garde que la forme affichable de l'occupation (libre, occupé, loué).
          v_incoming := app_private.sale_field_comparable(v_key, to_jsonb(new.occupancy_status));
          new.occupancy_status := old.occupancy_status;
        end if;
      else
        v_listing_value := old.visit_dates;
        if new.visit_dates is distinct from old.visit_dates
          and app_private.sale_field_incoming_class(
            v_key, new.visit_dates, null, old.visit_dates, v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := new.visit_dates;
          new.visit_dates := old.visit_dates;
        end if;
      end if;
      if v_class = 'echo' then
        v_event := 'echo_suppressed';
        v_incoming_logged := v_incoming;
        v_held_value := null;
      end if;
    else
      -- Champ tenu (« held » ou « conflicted »). Colonnes du champ, nommées une à une.
      if v_key = 'property.surface_m2' then
        v_class_app := app_private.sale_field_incoming_class(
          v_key, to_jsonb(new.app_surface_m2), v_held_value, v_listing -> 'app_surface_m2', v_echo, v_abs, v_rel
        );
        v_class_surface := app_private.sale_field_incoming_class(
          v_key, to_jsonb(new.surface_m2), v_held_value, v_listing -> 'surface_m2', v_echo, v_abs, v_rel
        );
        if v_class_app = 'changed' then
          v_class := 'changed';
          v_incoming := to_jsonb(new.app_surface_m2);
          v_listing_value := v_listing -> 'app_surface_m2';
        elsif v_class_surface = 'changed' then
          v_class := 'changed';
          v_incoming := to_jsonb(new.surface_m2);
          v_listing_value := v_listing -> 'surface_m2';
        elsif v_class_app = 'echo' then
          v_class := 'echo';
          v_incoming := to_jsonb(new.app_surface_m2);
          v_listing_value := v_listing -> 'app_surface_m2';
        elsif v_class_surface = 'echo' then
          v_class := 'echo';
          v_incoming := to_jsonb(new.surface_m2);
          v_listing_value := v_listing -> 'surface_m2';
        end if;
        v_spoke := v_class_app = 'listing' or v_class_surface = 'listing';
        v_silent := (
            v_class_app = 'empty' and new.app_surface_m2 is distinct from old.app_surface_m2
            and app_private.sale_field_comparable(v_key, v_listing -> 'app_surface_m2') is not null
          ) or (
            v_class_surface = 'empty' and new.surface_m2 is distinct from old.surface_m2
            and app_private.sale_field_comparable(v_key, v_listing -> 'surface_m2') is not null
          );
      else
        if v_key = 'property.land_surface_m2' then
          v_incoming := to_jsonb(new.land_surface_m2);
          v_listing_value := v_listing -> 'land_surface_m2';
          v_silent := new.land_surface_m2 is distinct from old.land_surface_m2;
        elsif v_key = 'property.rooms_count' then
          v_incoming := to_jsonb(new.rooms_count);
          v_listing_value := v_listing -> 'rooms_count';
          v_silent := new.rooms_count is distinct from old.rooms_count;
        elsif v_key = 'property.occupancy_status' then
          -- La file ne garde que la forme affichable de l'occupation (libre, occupé, loué).
          v_incoming := app_private.sale_field_comparable(v_key, to_jsonb(new.occupancy_status));
          v_listing_value := app_private.sale_field_comparable(v_key, v_listing -> 'occupancy_status');
          v_silent := new.occupancy_status is distinct from old.occupancy_status;
        else
          v_incoming := new.visit_dates;
          v_listing_value := v_listing -> 'visit_dates';
          v_silent := new.visit_dates is distinct from old.visit_dates;
        end if;
        v_class_app := app_private.sale_field_incoming_class(
          v_key, v_incoming, v_held_value, v_listing_value, v_echo, v_abs, v_rel
        );
        v_class := case when v_class_app in ('changed', 'echo') then v_class_app else 'none' end;
        v_spoke := v_class_app = 'listing';
        -- L'annonce se tait : écriture explicitement vide d'une colonne dont l'annonce disait quelque chose.
        v_silent := v_silent and v_class_app = 'empty'
          and app_private.sale_field_comparable(v_key, v_listing_value) is not null;
      end if;
      v_incoming_logged := v_incoming;

      v_keep := true;
      if v_class = 'changed' then
        if v_listing_wins then
          v_keep := false;
          v_event := 'listing_changed_released';
        else
          v_event := 'listing_changed_kept';
        end if;
      elsif v_class = 'echo' then
        v_event := 'echo_suppressed';
      end if;

      -- Chambres entrantes plus nombreuses que les pièces tenues : la contrainte de la table refuserait la ligne.
      if v_keep
        and v_key = 'property.rooms_count'
        and new.bedrooms_count is not null
        and old.rooms_count is not null
        and old.rooms_count < new.bedrooms_count
      then
        if v_class = 'echo' then
          -- Écriture périmée : le nombre de chambres venu avec l'écho n'est pas pris, le champ reste tenu.
          new.bedrooms_count := case
            when old.bedrooms_count is not null and old.bedrooms_count <= old.rooms_count
              then old.bedrooms_count
          end;
        else
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
      end if;

      if v_keep then
        if v_class = 'changed' then
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
          -- L'annonce a parlé : elle ne se tait plus.
          v_held := v_held #- array[v_key, 'listing_silent_since'];
        elsif v_class = 'none' then
          if v_spoke then
            v_held := v_held #- array[v_key, 'listing_silent_since'];
          elsif v_silent and not v_entry ? 'listing_silent_since' then
            v_held := jsonb_set(v_held, array[v_key, 'listing_silent_since'], to_jsonb(v_now));
          end if;
        end if;
        if v_key = 'property.surface_m2' then
          new.surface_m2 := old.surface_m2;
          new.app_surface_m2 := old.app_surface_m2;
          new.app_surface_kind := old.app_surface_kind;
          new.surface_source := old.surface_source;
          new.surface_confidence := old.surface_confidence;
          -- Colonnes voisines : la valeur tenue, ou une valeur de la mémoire d'écho, n'y entre pas.
          if new.habitable_surface_m2 is distinct from old.habitable_surface_m2
            and app_private.sale_field_incoming_class(
              v_key, to_jsonb(new.habitable_surface_m2), v_held_value, null, v_echo, v_abs, v_rel
            ) in ('held', 'echo')
          then
            new.habitable_surface_m2 := old.habitable_surface_m2;
          end if;
          if new.carrez_surface_m2 is distinct from old.carrez_surface_m2
            and app_private.sale_field_incoming_class(
              v_key, to_jsonb(new.carrez_surface_m2), v_held_value, null, v_echo, v_abs, v_rel
            ) in ('held', 'echo')
          then
            new.carrez_surface_m2 := old.carrez_surface_m2;
          end if;
        elsif v_key = 'property.land_surface_m2' then
          new.land_surface_m2 := old.land_surface_m2;
          -- Colonnes voisines (terrain recopié en surface principale), quand la surface n'est pas tenue.
          if not v_surface_held then
            if new.app_surface_m2 is distinct from old.app_surface_m2
              and app_private.sale_field_incoming_class(
                v_key, to_jsonb(new.app_surface_m2), v_held_value, null, v_echo, v_abs, v_rel
              ) in ('held', 'echo')
            then
              new.app_surface_m2 := old.app_surface_m2;
              new.app_surface_kind := old.app_surface_kind;
            end if;
            if new.surface_m2 is distinct from old.surface_m2
              and app_private.sale_field_incoming_class(
                v_key, to_jsonb(new.surface_m2), v_held_value, null, v_echo, v_abs, v_rel
              ) in ('held', 'echo')
            then
              new.surface_m2 := old.surface_m2;
            end if;
          end if;
        elsif v_key = 'property.rooms_count' then
          new.rooms_count := old.rooms_count;
        elsif v_key = 'property.occupancy_status' then
          new.occupancy_status := old.occupancy_status;
        else
          new.visit_dates := old.visit_dates;
        end if;
      else
        -- Libération par l'annonce : ce que l'écriture apporte passe ; une colonne qu'elle n'a pas touchée porte
        -- encore la valeur de la pièce et reprend donc la dernière valeur connue de l'annonce.
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
        -- L'entrée ne disparaît pas : elle garde en mémoire d'écho la valeur que la pièce tenait.
        v_held := jsonb_set(v_held, array[v_key], jsonb_strip_nulls(jsonb_build_object(
          'v', 2,
          'state', 'released',
          'released_by', 'listing',
          'decision_id', v_entry -> 'decision_id',
          'tolerance', coalesce(v_entry -> 'tolerance', '{}'::jsonb),
          'echo', app_private.sale_field_echo_add(
            v_echo, v_key, v_held_value, v_now + app_private.sale_field_echo_memory(), v_abs, v_rel
          )
        )));
      end if;
    end if;

    -- Un évènement par valeur entrante et par décision : une annonce qui oscille entre deux valeurs, un écho
    -- répété ou la même écriture rejouée n'ajoutent rien à la file.
    if v_event is not null and not (
      v_event in ('listing_changed_kept', 'echo_suppressed') and exists (
        select 1 from public.auction_sale_field_hold_events earlier
        where earlier.sale_id = new.id
          and earlier.field_key = v_key
          and earlier.event = v_event
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
  'Registre des pièces : déclencheur BEFORE UPDATE de auction_sales, passif. Remet la valeur tenue d''un champ que réécrit une écriture directe (collecte, repli REST, fusion, rattrapage) ; écarte le retour d''une ancienne valeur tenue (mémoire d''écho), y compris par une colonne voisine ; journalise un changement de l''annonce ; refuse (42501) toute écriture de held_fields hors app_private.project_sale_fields. Ne lit ni les observations, ni les décisions, ni la préséance, ni raw_payload.';

revoke all on function app_private.hold_projected_sale_fields()
  from public, anon, authenticated, service_role;

-- Projection, version 2 ---------------------------------------------------------------------------------------------
drop function if exists app_private.project_sale_fields(uuid, text[], boolean);

create or replace function app_private.project_sale_fields(
  p_sale_id uuid,
  p_fields text[] default null,
  p_apply boolean default false,
  p_listing_hints jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_memory interval := app_private.sale_field_echo_memory();
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
  -- v_stored : l'entrée du champ, quel que soit son état ; v_current : la même, seulement si elle tient le champ.
  v_stored jsonb;
  v_current jsonb;
  v_current_still_accepted boolean;
  v_entry jsonb;
  v_echo jsonb;
  v_hint jsonb;
  v_hint_echo jsonb;
  v_element jsonb;
  v_released_by text;
  v_listing jsonb;
  v_listing_value jsonb;
  v_incompatible boolean;
  v_state text;
  v_holds boolean;
  v_old_held jsonb;
  v_base_held jsonb;
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
  if p_listing_hints is not null and jsonb_typeof(p_listing_hints) <> 'object' then
    raise exception using errcode = '22023', message = 'Listing hints must be a JSON object.';
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
  -- Les valeurs d'écho échues ne comptent plus. Leur seul retrait n'est pas un changement : la projection ne
  -- réécrit pas une vente pour cela (la retenue les retire à l'écriture suivante).
  v_base_held := app_private.sale_field_echo_prune(v_old_held, v_now);
  v_new_held := coalesce(v_base_held, '{}'::jsonb);

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
    v_stored := v_new_held -> v_field.field_key;
    v_current := case when v_stored ->> 'state' in ('held', 'conflicted') then v_stored end;
    v_current_still_accepted := false;
    v_echo := case
      when jsonb_typeof(v_stored -> 'echo') = 'array' then v_stored -> 'echo' else '[]'::jsonb
    end;

    -- Indice de fusion : la mémoire d'écho de la vente absorbée est reprise (valeurs non échues).
    v_hint := case
      when jsonb_typeof(p_listing_hints -> v_field.field_key) = 'object'
        then p_listing_hints -> v_field.field_key
    end;
    v_hint_echo := '[]'::jsonb;
    if v_hint is not null then
      v_hint_echo := coalesce(
        app_private.sale_field_echo_prune(
          jsonb_build_object('hint', jsonb_build_object('state', 'held', 'echo', v_hint -> 'echo')), v_now
        ) #> '{hint,echo}',
        '[]'::jsonb
      );
      -- De la plus ancienne à la plus récente, pour garder l'ordre de la liste.
      for v_element in
        select item.value
        from jsonb_array_elements(v_hint_echo) with ordinality item(value, position)
        order by item.position desc
      loop
        v_echo := app_private.sale_field_echo_add(
          v_echo, v_field.field_key, v_element -> 'value', (v_element ->> 'until')::timestamptz,
          v_field.abs_tolerance, v_field.rel_tolerance
        );
      end loop;
    end if;

    -- 3. Candidats : dernière décision (seq) de chaque observation décidée pour ces ventes ; seulement une
    --    acceptation, d'un lot identifié, d'une origine qui peut tenir ce champ, si le champ est tenable, et que
    --    l'annonce n'a pas délogée depuis. L'ordre entre l'évènement et la décision est celui de la séquence
    --    commune aux deux journaux (jamais une date). Un évènement listing_changed_released de la vente de la
    --    décision l'écarte s'il la nomme ou la suit ; un évènement de la vente projetée (la vente conservée)
    --    écarte toute décision plus ancienne de l'ensemble, donc aussi celles d'une vente absorbée. La libération
    --    d'une vente absorbée ne déloge pas les pièces de la vente conservée. Il faut alors une nouvelle décision
    --    humaine.
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
        latest.decision,
        latest.reason_code,
        latest.lot_attachment,
        latest.received_at,
        latest.publication_mode,
        latest.recipient_kind,
        claim.value_jsonb,
        claim.confidence_score,
        origin.source_kind,
        precedence.rank,
        coalesce(precedence.can_hold, false) as can_hold,
        exists (
          select 1 from public.auction_sale_field_hold_events released
          where released.field_key = v_field.field_key
            and released.event = 'listing_changed_released'
            and (
              (released.sale_id = latest.sale_id
                and (released.decision_id = latest.id or released.seq > latest.seq))
              or (released.sale_id = p_sale_id and released.seq > latest.seq)
            )
        ) as dislodged,
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
      left join public.auction_fact_source_precedence precedence
        on precedence.field_key = latest.field_key and precedence.source_kind = origin.source_kind
      order by precedence.rank, coalesce(latest.received_at, latest.decided_at) desc, latest.seq desc
    loop
      v_value := app_private.sale_field_claim_value(v_field.field_key, v_candidate.value_jsonb);
      -- Opposition, ou autorisation d'affichage retirée : la valeur entre en mémoire d'écho sans échéance (elle
      -- n'est gardée que si le champ a une entrée, tenue ou libérée).
      if v_candidate.decision = 'opposed'
        or (v_candidate.decision = 'withdrawn' and v_candidate.reason_code = 'authorization_withdrawn')
      then
        if v_value is not null then
          v_echo := app_private.sale_field_echo_add(
            v_echo, v_field.field_key, v_value, null, v_field.abs_tolerance, v_field.rel_tolerance
          );
        end if;
        continue;
      end if;
      continue when not (
        v_field.hold_enabled
        and v_candidate.decision = 'accepted'
        and v_candidate.lot_attachment in ('single_lot', 'matched')
        and v_candidate.can_hold
        and not v_candidate.dislodged
      );
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
      --    l'annonce, puisque le champ n'était pas tenu), ou celui de l'indice de fusion quand une colonne porte
      --    déjà la valeur que tenait la vente absorbée ; champ déjà tenu : son bloc est repris.
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
        if v_hint is not null and jsonb_typeof(v_hint -> 'listing') = 'object' and exists (
          select 1
          from (
            select case v_field.field_key
              when 'property.surface_m2' then to_jsonb(v_sale.app_surface_m2)
              when 'property.land_surface_m2' then to_jsonb(v_sale.land_surface_m2)
              when 'property.rooms_count' then to_jsonb(v_sale.rooms_count)
              when 'property.occupancy_status' then to_jsonb(v_sale.occupancy_status)
              else v_sale.visit_dates
            end as value
            union all
            select to_jsonb(v_sale.surface_m2) where v_field.field_key = 'property.surface_m2'
          ) displayed
          where app_private.sale_field_incoming_class(
            v_field.field_key, displayed.value, v_hint -> 'value', null, v_hint_echo,
            v_field.abs_tolerance, v_field.rel_tolerance
          ) in ('held', 'echo')
        ) then
          -- Seules les colonnes du champ sont reprises de l'indice.
          select coalesce(jsonb_object_agg(hinted.key, hinted.value), '{}'::jsonb) into v_listing
          from jsonb_each(jsonb_strip_nulls(v_hint -> 'listing')) hinted
          where hinted.key = any(v_field.held_columns);
        end if;
      end if;
      -- Remplacement : la valeur que le champ tenait entre en mémoire d'écho. Fusion : de même pour la valeur
      -- que tenait la vente absorbée, si ce n'est pas celle qui tient désormais.
      if v_current is not null and not app_private.sale_field_values_match(
        v_field.field_key, v_current -> 'value', v_winner_value, v_field.abs_tolerance, v_field.rel_tolerance
      ) then
        v_echo := app_private.sale_field_echo_add(
          v_echo, v_field.field_key, v_current -> 'value', v_now + v_memory,
          v_field.abs_tolerance, v_field.rel_tolerance
        );
      end if;
      if v_hint ->> 'state' in ('held', 'conflicted') and not app_private.sale_field_values_match(
        v_field.field_key, v_hint -> 'value', v_winner_value, v_field.abs_tolerance, v_field.rel_tolerance
      ) then
        v_echo := app_private.sale_field_echo_add(
          v_echo, v_field.field_key, v_hint -> 'value', v_now + v_memory,
          v_field.abs_tolerance, v_field.rel_tolerance
        );
      end if;
      v_entry := jsonb_strip_nulls(jsonb_build_object(
        'v', 2,
        'value', v_winner_value,
        'state', 'held',
        'listing', v_listing,
        'listing_silent_since', v_current -> 'listing_silent_since',
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
      -- Même pièce, même décision : seuls les réglages du champ (recopiés dans l'entrée), sa version ou sa
      -- mémoire d'écho ont pu changer. L'entrée est mise à jour sans évènement.
      v_state := case
        when v_current is not null
          and (v_current - 'tolerance' - 'on_listing_change' - 'echo' - 'v')
            = (v_entry - 'tolerance' - 'on_listing_change' - 'echo' - 'v')
          then 'unchanged'
        else 'held'
      end;
      v_new_held := v_new_held || jsonb_build_object(v_field.field_key, v_entry);
      if v_field.field_key = 'property.surface_m2' then
        t_surface_m2 := (v_winner_value #>> '{}')::numeric;
        t_app_surface_m2 := (v_winner_value #>> '{}')::numeric;
        -- Valeurs neutres : ni l'origine de la pièce, ni une nature de surface que la pièce n'affirme pas.
        t_app_surface_kind := 'built';
        t_surface_source := 'fact_registry';
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
      -- L'entrée ne disparaît pas : elle garde en mémoire d'écho la valeur que la pièce tenait (7 jours, ou sans
      -- échéance si sa pièce a reçu une opposition : la boucle des décisions l'a déjà inscrite).
      v_echo := app_private.sale_field_echo_add(
        v_echo, v_field.field_key, v_current -> 'value', v_now + v_memory,
        v_field.abs_tolerance, v_field.rel_tolerance
      );
      select decision.decision into v_released_by
      from public.auction_fact_claim_decisions decision
      where decision.claim_id = (v_current ->> 'claim_id')::uuid
      order by decision.seq desc
      limit 1;
      v_new_held := v_new_held || jsonb_build_object(v_field.field_key, jsonb_strip_nulls(jsonb_build_object(
        'v', 2,
        'state', 'released',
        'released_by', case when v_released_by is null or v_released_by = 'accepted' then 'other' else v_released_by end,
        'decision_id', v_current -> 'decision_id',
        'tolerance', jsonb_build_object('abs', v_field.abs_tolerance, 'rel', v_field.rel_tolerance)
      )));
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

    -- Mémoire d'écho. Un champ sans entrée n'en reçoit une (libérée) que par un indice de fusion ; une entrée
    -- libérée sans mémoire disparaît.
    if not v_new_held ? v_field.field_key and jsonb_array_length(v_hint_echo) > 0 then
      v_new_held := v_new_held || jsonb_build_object(v_field.field_key, jsonb_strip_nulls(jsonb_build_object(
        'v', 2,
        'state', 'released',
        'released_by', 'merge',
        'tolerance', jsonb_build_object('abs', v_field.abs_tolerance, 'rel', v_field.rel_tolerance)
      )));
    end if;
    if v_new_held ? v_field.field_key then
      if jsonb_array_length(v_echo) > 0 then
        v_new_held := jsonb_set(v_new_held, array[v_field.field_key, 'echo'], v_echo);
      elsif v_new_held #>> array[v_field.field_key, 'state'] = 'released' then
        v_new_held := v_new_held - v_field.field_key;
      else
        v_new_held := v_new_held #- array[v_field.field_key, 'echo'];
      end if;
    end if;
    v_holds := coalesce(v_new_held #>> array[v_field.field_key, 'state'] in ('held', 'conflicted'), false);

    if v_conflict then
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'conflicted',
        'held_value', case when v_holds then v_new_held #> array[v_field.field_key, 'value'] end,
        'incoming_value', v_conflicting, 'decision_id', v_winner_decision_id
      )));
    elsif v_blocked is not null then
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'projection_blocked',
        'held_value', case when v_holds then v_new_held #> array[v_field.field_key, 'value'] end,
        'incoming_value', v_blocked - 'claim_id' - 'decision_id', 'decision_id', v_winner_decision_id
      )));
    end if;

    v_result := v_result || jsonb_build_object(v_field.field_key, jsonb_strip_nulls(jsonb_build_object(
      'state', v_state,
      -- Valeur tenue après la projection (absente si le champ n'est pas tenu).
      'value', case when v_holds then v_new_held #> array[v_field.field_key, 'value'] end,
      'claim_id', case when v_holds then v_new_held #> array[v_field.field_key, 'claim_id'] end,
      'decision_id', case when v_holds then v_new_held #> array[v_field.field_key, 'decision_id'] end,
      -- Valeur de l'annonce rendue aux colonnes quand le champ est libéré (absente si elle était incompatible
      -- avec les chambres de la fiche : NULL a été restauré).
      'released', case when v_current is not null and not v_holds then true end,
      'listing_value', case
        when v_current is not null and not v_holds and not v_incompatible then v_listing_value
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
  v_changed := v_new_held is distinct from v_base_held
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
    --    remis à vide aussitôt après. updated_at avance toujours, même si l'horloge de l'instruction recule.
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
      updated_at = greatest(pg_catalog.statement_timestamp(), sale.updated_at + interval '1 microsecond')
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

comment on function app_private.project_sale_fields(uuid, text[], boolean, jsonb) is
  'Registre des pièces : seule écriture qui pose ou retire une pièce sur une fiche (colonnes tenues, held_fields, updated_at), à partir des acceptations du journal des décisions. p_apply = false : simulation sans verrou ni écriture. p_listing_hints : entrées held_fields d''une vente absorbée par fusion. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.project_sale_fields(uuid, text[], boolean, jsonb)
  from public, anon, authenticated, service_role;

comment on column public.auction_sales.held_fields is
  'Registre des pièces : par champ, soit une entrée tenue (state held ou conflicted : valeur, provenance, dernière valeur connue de l''annonce, mémoire d''écho), soit une entrée libérée (state released : mémoire d''écho seule, anciennes valeurs tenues dont le retour est écarté). Nulle si rien n''est tenu ni mémorisé. Écrite par app_private.project_sale_fields et par le déclencheur de retenue aaab_auction_sales_hold_projected_fields ; toute autre écriture est refusée, et toute écriture directe d''un champ tenu est retenue par la base.';

-- Déclencheur de retenue : deux colonnes voisines de plus (la clause WHEN est fausse tant que held_fields est
-- nulle : aucun appel PL/pgSQL). Les deux autres déclencheurs de 20261116100500 ne changent pas.
create or replace trigger aaab_auction_sales_hold_projected_fields
  before update of
    surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, habitable_surface_m2,
    carrez_surface_m2, land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates, held_fields
  on public.auction_sales
  for each row
  when (old.held_fields is not null or new.held_fields is distinct from old.held_fields)
  execute function app_private.hold_projected_sale_fields();
alter table public.auction_sales enable always trigger aaab_auction_sales_hold_projected_fields;

commit;
