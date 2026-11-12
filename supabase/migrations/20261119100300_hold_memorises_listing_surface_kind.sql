begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2c, étape C3 (condition 11 du runbook R2b, limite « reclassement en terrain par la
-- nature seule, surface tenue » de docs/architecture/registre-des-pieces.md). Sans effet tant qu'aucune vente ne
-- tient de surface.
--
-- Quand la surface est tenue, la colonne app_surface_kind porte « built » (écrit par la projection), et la nature
-- de l'annonce est mémorisée dans le bloc « listing » de l'entrée (held_fields). La retenue ne mettait ce bloc à
-- jour que si la VALEUR d'annonce changeait : une annonce qui passait en terrain par sa seule nature, sans changer
-- de valeur, n'était pas vue par app_private.sale_is_land_sale, donc ni par le contrôle quotidien, ni par la
-- projection suivante.
--
-- app_private.hold_projected_sale_fields() (définition de 20261117100200, reprise à l'identique) reçoit un seul
-- ajout, dans la branche « champ gardé » : pour la surface, quand l'écriture parle pour l'annonce (la colonne
-- app_surface_m2 porte la valeur d'annonce connue, ou une nouvelle valeur) et apporte une nature non vide, autre
-- que celle de la colonne et autre que celle qui est mémorisée, cette nature est mémorisée. La colonne garde
-- « built », comme avant.
--
-- EFFET : la vente est alors une vente de terrain pour la définition commune. Le contrôle quotidien la signale
-- (« stale_listing », et « projection_drift » : la projection libérerait la surface) ; la prochaine décision sur la
-- vente, ou la relance planifiée si le propriétaire l'ouvre, libère la surface (état « blocked », raison
-- « land_sale »). La retenue elle-même ne libère rien : elle reste passive.
--
-- LIMITES RESTANTES. Une écriture dont la colonne app_surface_m2 porte exactement la valeur tenue (la pièce dit la
-- même surface que l'annonce) ou un écho ne se distingue pas d'une relecture de la fiche : sa nature n'est pas
-- mémorisée. Une nature « built » apportée par l'annonce ne se distingue pas du libellé neutre que porte la
-- colonne : une annonce qui repasse de « terrain » à « built » sans changer de valeur garde « terrain » en mémoire
-- (sens prudent : la surface de la pièce est libérée à la projection suivante). Un reclassement par le type de bien
-- ou par la portée de la surface est vu dans tous les cas.
--
-- Verrous : remplacement d'une fonction. Le déclencheur aaab_auction_sales_hold_projected_fields n'est pas touché
-- (ni recréé, ni son mode) : aucun verrou sur auction_sales. Possible pendant un import ; une écriture en cours
-- garde l'ancienne définition jusqu'à sa fin.
--
-- Retour arrière, par une nouvelle migration : rétablir app_private.hold_projected_sale_fields() de
-- 20261117100200.

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
  -- v_neighbors : colonnes voisines relevées à la première prise ; v_suppressed : celles que cette écriture voulait
  -- remplir avec la valeur d'une pièce.
  v_neighbors jsonb;
  v_suppressed jsonb;
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
  v_label_blocked boolean := false;
  v_label_incoming jsonb;
begin
  -- La projection pose ce réglage de transaction (local) autour de son UPDATE : elle fait foi. Ce n'est pas un
  -- contrôle d'accès : aaab_auction_sales_held_fields_role_guard (held_fields) et
  -- aaab_auction_sales_held_fields_marker_guard (colonnes d'une vente du registre) n'acceptent que le rôle
  -- propriétaire de la projection, et passent avant ce déclencheur.
  if coalesce(pg_catalog.current_setting('app.sale_field_projection', true), '') = new.id::text then
    return new;
  end if;
  if new.held_fields is distinct from old.held_fields then
    raise exception using errcode = '42501',
      message = 'auction_sales.held_fields is written only by app_private.project_sale_fields.';
  end if;

  -- Ce qui est échu sort à cette écriture (valeurs d'écho, note de blocage ancienne).
  v_held := coalesce(app_private.sale_field_echo_prune(old.held_fields, v_now), '{}'::jsonb);
  v_surface_held := coalesce(v_held #>> '{property.surface_m2,state}' in ('held', 'conflicted'), false);

  -- LIBELLÉ RÉSERVÉ. surface_source = 'fact_registry' n'est écrit que par la projection, sur une surface tenue.
  -- Une écriture directe qui l'apporte sur une surface non tenue recopie une ligne lue quand une pièce tenait le
  -- champ : le groupe de la surface entier garde ses valeurs actuelles, quelle que soit la valeur apportée.
  if not v_surface_held
    and new.surface_source is not distinct from 'fact_registry'
    and old.surface_source is distinct from 'fact_registry'
  then
    v_label_blocked := true;
    v_label_incoming := jsonb_strip_nulls(jsonb_build_object(
      'surface_source', new.surface_source, 'app_surface_m2', new.app_surface_m2, 'surface_m2', new.surface_m2
    ));
    new.surface_m2 := old.surface_m2;
    new.app_surface_m2 := old.app_surface_m2;
    new.app_surface_kind := old.app_surface_kind;
    new.surface_source := old.surface_source;
    new.surface_confidence := old.surface_confidence;
  end if;

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
    v_neighbors := coalesce(v_entry -> 'neighbors', '{}'::jsonb);
    v_suppressed := '{}'::jsonb;
    v_held_value := v_entry -> 'value';
    v_abs := (v_entry #>> '{tolerance,abs}')::numeric;
    v_rel := (v_entry #>> '{tolerance,rel}')::numeric;
    v_listing_wins := coalesce(v_entry ->> 'on_listing_change' = 'listing_wins_and_review', false);
    v_decision_id := (v_entry ->> 'decision_id')::uuid;
    v_class := 'none';
    v_class_app := null;
    v_class_surface := null;
    v_incoming := null;
    v_incoming_logged := null;
    v_listing_value := null;
    v_event := null;
    v_silent := false;
    v_spoke := false;

    if v_state = 'released' then
      -- Champ libéré : seule la mémoire d'écho joue. Une valeur entrante DIFFÉRENTE de la colonne actuelle
      -- (inégalité exacte) et égale, à la tolérance du champ, à une valeur de la mémoire ne passe pas ; tout le
      -- reste passe comme pour un champ libre. La colonne actuelle n'est PAS une valeur d'annonce à laquelle
      -- comparer la valeur entrante : une pièce qui confirme l'annonce à la tolérance près (annonce 50, pièce
      -- 50,4) reviendrait sinon après son retrait ou son opposition.
      if v_key = 'property.surface_m2' then
        v_listing_value := coalesce(to_jsonb(old.app_surface_m2), to_jsonb(old.surface_m2));
        if v_label_blocked then
          -- Le groupe a déjà repris ses valeurs. L'évènement garde la valeur apportée si elle est dans la
          -- mémoire (le cas d'un import périmé), sinon ce que l'écriture apportait avec le libellé.
          v_class := 'echo';
          v_incoming := case
            when (v_label_incoming ->> 'app_surface_m2')::numeric is distinct from old.app_surface_m2
              and app_private.sale_field_incoming_class(
                v_key, v_label_incoming -> 'app_surface_m2', null, null, v_echo, v_abs, v_rel
              ) = 'echo'
              then v_label_incoming -> 'app_surface_m2'
            when (v_label_incoming ->> 'surface_m2')::numeric is distinct from old.surface_m2
              and app_private.sale_field_incoming_class(
                v_key, v_label_incoming -> 'surface_m2', null, null, v_echo, v_abs, v_rel
              ) = 'echo'
              then v_label_incoming -> 'surface_m2'
            else v_label_incoming
          end;
        elsif new.app_surface_m2 is distinct from old.app_surface_m2
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.app_surface_m2), null, null, v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := to_jsonb(new.app_surface_m2);
        elsif new.surface_m2 is distinct from old.surface_m2
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.surface_m2), null, null, v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := to_jsonb(new.surface_m2);
        end if;
        if v_class = 'echo' then
          new.surface_m2 := old.surface_m2;
          new.app_surface_m2 := old.app_surface_m2;
          new.app_surface_kind := old.app_surface_kind;
          new.surface_source := old.surface_source;
          new.surface_confidence := old.surface_confidence;
        end if;
        -- Colonnes voisines (sauf la valeur qu'elles portaient déjà à la première prise : celle de l'annonce).
        if new.habitable_surface_m2 is distinct from old.habitable_surface_m2
          and new.habitable_surface_m2 is distinct from (v_neighbors ->> 'habitable_surface_m2')::numeric
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.habitable_surface_m2), null, null, v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_suppressed := v_suppressed || jsonb_build_object('habitable_surface_m2', new.habitable_surface_m2);
          new.habitable_surface_m2 := old.habitable_surface_m2;
        end if;
        if new.carrez_surface_m2 is distinct from old.carrez_surface_m2
          and new.carrez_surface_m2 is distinct from (v_neighbors ->> 'carrez_surface_m2')::numeric
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.carrez_surface_m2), null, null, v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_suppressed := v_suppressed || jsonb_build_object('carrez_surface_m2', new.carrez_surface_m2);
          new.carrez_surface_m2 := old.carrez_surface_m2;
        end if;
      elsif v_key = 'property.land_surface_m2' then
        v_listing_value := to_jsonb(old.land_surface_m2);
        if new.land_surface_m2 is distinct from old.land_surface_m2
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.land_surface_m2), null, null, v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := to_jsonb(new.land_surface_m2);
          new.land_surface_m2 := old.land_surface_m2;
        end if;
        -- Colonnes voisines (terrain recopié en surface principale), quand la surface n'est pas tenue.
        if not v_surface_held then
          if new.app_surface_m2 is distinct from old.app_surface_m2
            and new.app_surface_m2 is distinct from (v_neighbors ->> 'app_surface_m2')::numeric
            and app_private.sale_field_incoming_class(
              v_key, to_jsonb(new.app_surface_m2), null, null, v_echo, v_abs, v_rel
            ) = 'echo'
          then
            v_class := 'echo';
            v_suppressed := v_suppressed || jsonb_build_object('app_surface_m2', new.app_surface_m2);
            new.app_surface_m2 := old.app_surface_m2;
            new.app_surface_kind := old.app_surface_kind;
          end if;
          if new.surface_m2 is distinct from old.surface_m2
            and new.surface_m2 is distinct from (v_neighbors ->> 'surface_m2')::numeric
            and app_private.sale_field_incoming_class(
              v_key, to_jsonb(new.surface_m2), null, null, v_echo, v_abs, v_rel
            ) = 'echo'
          then
            v_class := 'echo';
            v_suppressed := v_suppressed || jsonb_build_object('surface_m2', new.surface_m2);
            new.surface_m2 := old.surface_m2;
          end if;
        end if;
      elsif v_key = 'property.rooms_count' then
        v_listing_value := to_jsonb(old.rooms_count);
        if new.rooms_count is distinct from old.rooms_count
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.rooms_count), null, null, v_echo, v_abs, v_rel
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
            v_key, to_jsonb(new.occupancy_status), null, null, v_echo, v_abs, v_rel
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
            v_key, new.visit_dates, null, null, v_echo, v_abs, v_rel
          ) = 'echo'
        then
          v_class := 'echo';
          v_incoming := new.visit_dates;
          new.visit_dates := old.visit_dates;
        end if;
      end if;
      if v_class = 'echo' then
        v_event := 'echo_suppressed';
        -- Une colonne voisine seule : l'évènement nomme la colonne.
        v_incoming_logged := coalesce(v_incoming, v_suppressed);
        v_held_value := null;
        -- Note de blocage : la date de la première retenue et celle de la dernière. Si l'annonce dit vraiment
        -- cette valeur (elle a rejoint la pièce avant le retrait ou l'opposition), chaque passage de la collecte
        -- est retenu : la note reste, et le contrôle quotidien garde l'alerte fact_registry.echo_blocked ouverte.
        -- Après un écho isolé, elle sort d'elle-même (sale_field_echo_prune).
        if not v_entry ? 'echo_blocked_since' then
          v_held := jsonb_set(v_held, array[v_key, 'echo_blocked_since'], to_jsonb(v_now));
        end if;
        v_held := jsonb_set(v_held, array[v_key, 'echo_blocked_at'], to_jsonb(v_now));
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

      -- Colonnes voisines, que le champ reste tenu ou que l'annonce l'emporte : la valeur tenue, ou une valeur de
      -- la mémoire d'écho, n'y entre pas (sauf la valeur que la colonne portait déjà à la première prise : celle
      -- de l'annonce).
      if v_key = 'property.surface_m2' then
        if new.habitable_surface_m2 is distinct from old.habitable_surface_m2
          and new.habitable_surface_m2 is distinct from (v_neighbors ->> 'habitable_surface_m2')::numeric
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.habitable_surface_m2), v_held_value, null, v_echo, v_abs, v_rel
          ) in ('held', 'echo')
        then
          v_suppressed := v_suppressed || jsonb_build_object('habitable_surface_m2', new.habitable_surface_m2);
          new.habitable_surface_m2 := old.habitable_surface_m2;
        end if;
        if new.carrez_surface_m2 is distinct from old.carrez_surface_m2
          and new.carrez_surface_m2 is distinct from (v_neighbors ->> 'carrez_surface_m2')::numeric
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.carrez_surface_m2), v_held_value, null, v_echo, v_abs, v_rel
          ) in ('held', 'echo')
        then
          v_suppressed := v_suppressed || jsonb_build_object('carrez_surface_m2', new.carrez_surface_m2);
          new.carrez_surface_m2 := old.carrez_surface_m2;
        end if;
      elsif v_key = 'property.land_surface_m2' and not v_surface_held then
        -- Terrain recopié en surface principale, quand la surface n'est pas tenue.
        if new.app_surface_m2 is distinct from old.app_surface_m2
          and new.app_surface_m2 is distinct from (v_neighbors ->> 'app_surface_m2')::numeric
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.app_surface_m2), v_held_value, null, v_echo, v_abs, v_rel
          ) in ('held', 'echo')
        then
          v_suppressed := v_suppressed || jsonb_build_object('app_surface_m2', new.app_surface_m2);
          new.app_surface_m2 := old.app_surface_m2;
          new.app_surface_kind := old.app_surface_kind;
        end if;
        if new.surface_m2 is distinct from old.surface_m2
          and new.surface_m2 is distinct from (v_neighbors ->> 'surface_m2')::numeric
          and app_private.sale_field_incoming_class(
            v_key, to_jsonb(new.surface_m2), v_held_value, null, v_echo, v_abs, v_rel
          ) in ('held', 'echo')
        then
          v_suppressed := v_suppressed || jsonb_build_object('surface_m2', new.surface_m2);
          new.surface_m2 := old.surface_m2;
        end if;
      end if;
      -- Une colonne voisine écartée sans autre évènement pour ce champ est journalisée, en nommant la colonne (un
      -- évènement par valeur et par décision : si la collecte la recalcule à chaque passage, la file n'en garde
      -- qu'une trace).
      if v_event is null and v_suppressed <> '{}'::jsonb then
        v_event := 'echo_suppressed';
        v_incoming_logged := v_suppressed;
      end if;

      if v_keep then
        if v_class = 'changed' then
          -- Dernière valeur connue de l'annonce. Une colonne n'y entre que si SA PROPRE classe est « changed » :
          -- dans une écriture mixte, l'autre colonne de la surface peut porter la valeur tenue ou un écho, qui
          -- reviendrait au retrait comme valeur d'annonce. Les libellés suivent leur colonne ; le libellé réservé
          -- du registre n'est jamais une valeur d'annonce.
          if v_key = 'property.surface_m2' then
            if v_class_surface = 'changed' then
              v_listing := v_listing || jsonb_build_object('surface_m2', new.surface_m2);
            end if;
            if v_class_app = 'changed' then
              v_listing := v_listing || jsonb_build_object('app_surface_m2', new.app_surface_m2);
              if new.app_surface_kind is distinct from old.app_surface_kind then
                v_listing := v_listing || jsonb_build_object('app_surface_kind', new.app_surface_kind);
              end if;
            end if;
            if new.surface_source is distinct from old.surface_source
              and new.surface_source is distinct from 'fact_registry'
            then
              v_listing := v_listing || jsonb_build_object('surface_source', new.surface_source);
              if new.surface_confidence is distinct from old.surface_confidence then
                v_listing := v_listing || jsonb_build_object('surface_confidence', new.surface_confidence);
              end if;
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
        -- Nature de l'annonce (lot R2c) : mémorisée à chaque écriture où l'annonce parle de la surface principale
        -- (sa valeur d'annonce connue, ou une nouvelle valeur), même quand cette valeur ne bouge pas. Une annonce
        -- qui passe en terrain par sa seule nature est ainsi vue par app_private.sale_is_land_sale. Une écriture
        -- qui porte la valeur tenue ou un écho relit la fiche, et la nature que porte déjà la colonne (« built »,
        -- écrit par la projection) est le libellé neutre du registre : ni l'une ni l'autre ne dit rien de l'annonce.
        if v_key = 'property.surface_m2'
          and v_class_app in ('listing', 'changed')
          and new.app_surface_kind is not null
          and new.app_surface_kind is distinct from old.app_surface_kind
          and new.app_surface_kind is distinct from (v_listing ->> 'app_surface_kind')
        then
          v_listing := v_listing || jsonb_build_object('app_surface_kind', new.app_surface_kind);
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
        -- Libération par l'annonce : ce que l'annonce apporte passe (colonne de classe « changed », ou vidée).
        -- Une colonne que l'écriture n'a pas touchée, ou qui porte la valeur tenue ou un écho, reprend la
        -- dernière valeur connue de l'annonce.
        if v_key = 'property.surface_m2' then
          if v_class_surface in ('held', 'echo') then
            new.surface_m2 := (v_listing ->> 'surface_m2')::numeric;
          end if;
          if v_class_app in ('held', 'echo') then
            new.app_surface_m2 := (v_listing ->> 'app_surface_m2')::numeric;
          end if;
          if v_class_app in ('held', 'echo') or new.app_surface_kind is not distinct from old.app_surface_kind
          then
            new.app_surface_kind := v_listing ->> 'app_surface_kind';
          end if;
          if new.surface_source is not distinct from old.surface_source
            or new.surface_source is not distinct from 'fact_registry'
          then
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
        -- L'entrée ne disparaît pas : elle garde en mémoire d'écho la valeur que la pièce tenait, les colonnes
        -- voisines de la première prise et les valeurs rendues aux colonnes (« restored » : celles de l'annonce).
        v_held := jsonb_set(v_held, array[v_key], jsonb_strip_nulls(jsonb_build_object(
          'v', 2,
          'state', 'released',
          'released_by', 'listing',
          'decision_id', v_entry -> 'decision_id',
          'tolerance', coalesce(v_entry -> 'tolerance', '{}'::jsonb),
          'neighbors', v_entry -> 'neighbors',
          'restored', case v_key
            when 'property.surface_m2' then
              jsonb_build_object('surface_m2', new.surface_m2, 'app_surface_m2', new.app_surface_m2)
            when 'property.land_surface_m2' then jsonb_build_object('land_surface_m2', new.land_surface_m2)
            when 'property.rooms_count' then jsonb_build_object('rooms_count', new.rooms_count)
            when 'property.occupancy_status' then
              jsonb_build_object('occupancy_status', new.occupancy_status)
            else jsonb_build_object('visit_dates', new.visit_dates)
          end,
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

  -- Libellé réservé écarté sur une vente dont la surface n'a aucune entrée : même évènement, sans décision, UN SEUL
  -- par vente quelle que soit la valeur apportée (la file n'a pas de purge : une collecte qui recopierait le libellé
  -- à chaque passage avec une valeur différente n'y ajoute rien).
  if v_label_blocked and not v_held ? 'property.surface_m2' and not exists (
    select 1 from public.auction_sale_field_hold_events earlier
    where earlier.sale_id = new.id
      and earlier.field_key = 'property.surface_m2'
      and earlier.event = 'echo_suppressed'
      and earlier.decision_id is null
      and earlier.incoming_value ? 'surface_source'
  ) then
    insert into public.auction_sale_field_hold_events (
      sale_id, field_key, event, held_value, listing_value, incoming_value, decision_id
    ) values (
      new.id, 'property.surface_m2', 'echo_suppressed', null,
      coalesce(to_jsonb(old.app_surface_m2), to_jsonb(old.surface_m2)), v_label_incoming, null
    );
  end if;

  if v_held = '{}'::jsonb then
    v_held := null;
  end if;
  if v_held is distinct from old.held_fields then
    new.held_fields := v_held;
  end if;
  return new;
end;
$$;

comment on function app_private.hold_projected_sale_fields() is
  'Registre des pièces : déclencheur BEFORE UPDATE de auction_sales, passif. Remet la valeur tenue d''un champ que réécrit une écriture directe (collecte, repli REST, fusion, rattrapage) ; écarte le retour d''une ancienne valeur tenue (mémoire d''écho), y compris par une colonne voisine ; journalise un changement de l''annonce ; refuse (42501) toute écriture de held_fields hors app_private.project_sale_fields. Ne lit ni les observations, ni les décisions, ni la préséance, ni raw_payload.';

revoke all on function app_private.hold_projected_sale_fields()
  from public, anon, authenticated, service_role;

commit;
