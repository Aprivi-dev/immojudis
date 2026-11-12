begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2c, étape C2 (contre-vérification 3 du lot R2b, constats N6 et N8 ; décisions du
-- propriétaire du 12/11/2026). Aucune fiche n'est écrite, la relance planifiée reste FERMÉE.
--
--   1. ERREURS SYSTÉMIQUES (N6). Le contrôle par vente et la relance planifiée simulent la projection vente par
--      vente et retiennent l'erreur d'une vente (donnée abîmée) sans s'arrêter. Une erreur de droit, de fonction
--      absente, de ressource ou une erreur interne n'est pas une donnée abîmée : elle vaut pour toutes les ventes,
--      et le rapport disait alors « tout le registre en dérive ». Les classes SQLSTATE 42 (syntaxe, droit, objet
--      absent), 53 (ressources), 58 (système) et XX (erreur interne) sont désormais RELEVÉES telles quelles : la
--      fonction s'arrête, la tâche échoue avec ce code. Une seule définition de ces classes :
--      app_private.fact_registry_error_is_systemic(sqlstate). Toute autre erreur reste une erreur de la vente.
--   2. FENÊTRE DES DÉCISIONS DÉFINITIVES (N8) : 48 heures au lieu de 24, soit deux passages de la tâche. Une
--      journée de tâche en échec ne fait plus perdre le signalement des décisions définitives de la veille.
--      « final_decisions » compte les décisions définitives des 48 dernières heures ;
--      « final_decisions_over_limit » compte les auteurs qui, dans cette fenêtre, ont dépassé le plafond sur une
--      période de 24 heures. Les plafonds ne sont plus appliqués pour l'instant (20261119100100) : ces deux
--      contrôles informent, ils ne bloquent pas.
--   3. ÉTAT DES TROIS RÉGLAGES AU RAPPORT : « decisions_second_factor_required » (déjà rendu),
--      « decision_rate_limits_enabled » et « scheduled_reprojection_enabled ».
--
-- Verrous : remplacement et création de fonctions. Aucun verrou sur auction_sales, sur auction_fact_claims ni sur
-- les journaux. Possible pendant un import.
--
-- Retour arrière, par une nouvelle migration : rétablir app_private.fact_registry_page_checks(uuid[]),
-- app_private.fact_registry_global_checks(uuid[]) et public.reproject_fact_registry_drift() de 20261118100300,
-- puis supprimer app_private.fact_registry_error_is_systemic(text).

-- 1. Classes d'erreurs systémiques : une seule définition -------------------------------------------------------------
create or replace function app_private.fact_registry_error_is_systemic(p_sqlstate text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.left(p_sqlstate, 2) in ('42', '53', '58', 'XX'), false);
$$;

comment on function app_private.fact_registry_error_is_systemic(text) is
  'Registre des pièces : ce code SQLSTATE est-il une erreur systémique (classes 42, 53, 58, XX), qui vaut pour toutes les ventes et doit être relevée, et non retenue comme l''erreur d''une vente ?';

revoke all on function app_private.fact_registry_error_is_systemic(text)
  from public, anon, authenticated, service_role;

-- 2. Contrôles par vente (définition de 20261118100300, hormis les erreurs systémiques) ------------------------------
create or replace function app_private.fact_registry_page_checks(p_sale_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_sale_ids uuid[] := coalesce(p_sale_ids, array[]::uuid[]);
  v_sale_id uuid;
  v_drift_first uuid[] := array[]::uuid[];
  v_drift uuid[] := array[]::uuid[];
  -- Ventes dont la simulation lève : comptées en dérive, rendues avec leur code, écartées des lectures par entrée.
  v_failed uuid[] := array[]::uuid[];
  v_failures jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_mismatch uuid[];
  v_echo uuid[];
  v_stale uuid[];
  v_blocked uuid[];
  v_held_sales integer;
  v_held_fields integer;
begin
  -- 1. La simulation de projection ne doit rien changer. La simulation lit sans verrou, en plusieurs
  --    instructions : une décision validée pendant la passe peut la faire rendre « changed » à tort. Les ventes
  --    en dérive sont donc rejouées une fois, et seules celles qui le sont encore sont rendues.
  --    Une vente dont la simulation lève (donnée abîmée) n'arrête pas le contrôle : elle est en dérive.
  --    Une erreur systémique (droit, fonction absente, ressource, erreur interne) n'est pas une donnée abîmée :
  --    elle vaudrait pour toutes les ventes, elle est donc relevée telle quelle et le contrôle s'arrête.
  foreach v_sale_id in array v_sale_ids loop
    begin
      if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
        v_drift_first := v_drift_first || v_sale_id;
      end if;
    exception when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate;
      if app_private.fact_registry_error_is_systemic(v_sqlstate) then
        raise;
      end if;
      v_failed := v_failed || v_sale_id;
      if pg_catalog.cardinality(v_failed) <= 20 then
        v_failures := v_failures
          || pg_catalog.jsonb_build_array(app_private.fact_registry_failure(v_sale_id, v_sqlstate, null));
      end if;
    end;
  end loop;
  --    Dérive de masse : seules les vingt premières sont rejouées, les suivantes sont comptées telles quelles.
  foreach v_sale_id in array v_drift_first[1:20] loop
    begin
      if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
        v_drift := v_drift || v_sale_id;
      end if;
    exception when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate;
      if app_private.fact_registry_error_is_systemic(v_sqlstate) then
        raise;
      end if;
      v_drift := v_drift || v_sale_id;
    end;
  end loop;
  select coalesce(pg_catalog.array_agg(drifting.id order by drifting.id), array[]::uuid[]) into v_drift
  from pg_catalog.unnest(v_drift || v_drift_first[21:] || v_failed) drifting(id);

  -- 2. Une lecture par entrée de held_fields, tenue ou libérée, sans ce qui est échu.
  --    * colonnes tenues (entrée tenue seulement) ;
  --    * valeur d'une pièce hors de ses colonnes : colonnes voisines et copies (entrée tenue ou libérée), et
  --      colonnes du champ lui-même pour une entrée libérée. Références exactes : pour une entrée tenue, la
  --      valeur d'annonce mémorisée ; pour une entrée libérée, les valeurs rendues aux colonnes à la libération
  --      (« restored ») et, pour une colonne voisine ou une copie, les colonnes actuelles du champ ; pour une
  --      colonne voisine, en plus, la valeur qu'elle portait à la première prise (« neighbors ») ;
  --    * annonce qui se tait, surface tenue sur un terrain ;
  --    * note de blocage d'une entrée libérée.
  select
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.mismatch), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.leak), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.stale), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.blocked), array[]::uuid[]),
    (count(distinct checked.id) filter (where checked.holds))::integer,
    (count(*) filter (where checked.holds))::integer
  into v_mismatch, v_echo, v_stale, v_blocked, v_held_sales, v_held_fields
  from (
    select
      sale.id,
      piece.holds,
      piece.holds and case entry.key
        when 'property.surface_m2' then
          sale.surface_m2 is distinct from (piece.held #>> '{}')::numeric
          or sale.app_surface_m2 is distinct from (piece.held #>> '{}')::numeric
          or sale.surface_source is distinct from 'fact_registry'
          or sale.app_surface_kind is distinct from 'built'
        when 'property.land_surface_m2' then
          sale.land_surface_m2 is distinct from (piece.held #>> '{}')::numeric
        when 'property.rooms_count' then
          sale.rooms_count is distinct from (piece.held #>> '{}')::integer
        when 'property.occupancy_status' then
          sale.occupancy_status is distinct from (piece.held #>> '{}')
        else sale.visit_dates is distinct from piece.held
      end as mismatch,
      exists (
        select 1
        from (
          values
            -- (champ, valeur lue, colonne du champ lui-même, référence propre à la colonne, s'applique)
            ('property.surface_m2', pg_catalog.to_jsonb(sale.app_surface_m2), true, null::jsonb, not piece.holds),
            ('property.surface_m2', pg_catalog.to_jsonb(sale.surface_m2), true, null, not piece.holds),
            ('property.surface_m2', pg_catalog.to_jsonb(sale.habitable_surface_m2), false,
              piece.neighbors -> 'habitable_surface_m2', true),
            ('property.surface_m2', pg_catalog.to_jsonb(sale.carrez_surface_m2), false,
              piece.neighbors -> 'carrez_surface_m2', true),
            ('property.surface_m2', pg_catalog.to_jsonb(property.surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(property.app_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(property.habitable_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(property.carrez_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(surface.surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(surface.app_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(surface.habitable_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(surface.carrez_surface_m2), false, null, true),
            ('property.land_surface_m2', pg_catalog.to_jsonb(sale.land_surface_m2), true, null, not piece.holds),
            ('property.land_surface_m2', pg_catalog.to_jsonb(property.land_surface_m2), false, null, true),
            ('property.land_surface_m2', pg_catalog.to_jsonb(surface.land_surface_m2), false, null, true),
            -- Terrain recopié en surface principale : seulement quand la surface n'est pas elle-même tenue.
            ('property.land_surface_m2', pg_catalog.to_jsonb(sale.app_surface_m2), false,
              piece.neighbors -> 'app_surface_m2', not piece.surface_held),
            ('property.land_surface_m2', pg_catalog.to_jsonb(sale.surface_m2), false,
              piece.neighbors -> 'surface_m2', not piece.surface_held),
            ('property.rooms_count', pg_catalog.to_jsonb(sale.rooms_count), true, null, not piece.holds),
            ('property.rooms_count', pg_catalog.to_jsonb(property.rooms_count), false, null, true),
            ('property.rooms_count', pg_catalog.to_jsonb(surface.rooms_count), false, null, true),
            ('property.occupancy_status', pg_catalog.to_jsonb(sale.occupancy_status), true, null, not piece.holds),
            ('property.occupancy_status', pg_catalog.to_jsonb(property.occupancy_status), false, null, true),
            ('sale.visit_dates', sale.visit_dates, true, null, not piece.holds),
            ('sale.visit_dates', judicial.visit_dates, false, null, true)
        ) watched (field_key, value, own_column, own_reference, applies)
        where watched.field_key = entry.key
          and watched.applies
          and app_private.sale_field_value_leaks(
            entry.key,
            watched.value,
            piece.held,
            case
              when watched.own_column then piece.restored_references
              else piece.other_references || pg_catalog.jsonb_build_array(watched.own_reference)
            end,
            piece.echo,
            piece.abs_tolerance,
            piece.rel_tolerance
          )
      ) as leak,
      piece.holds and (
        entry.value ? 'listing_silent_since'
        or (
          entry.key = 'property.surface_m2'
          and app_private.sale_is_land_sale(
            sale.property_type, sale.surface_scope, sale.app_surface_kind, sale.held_fields)
        )
      ) as stale,
      not piece.holds and entry.value ? 'echo_blocked_since' as blocked
    from public.auction_sales sale
    cross join lateral pg_catalog.jsonb_each(app_private.sale_field_echo_prune(sale.held_fields, v_now)) entry
    cross join lateral (
      select
        coalesce(entry.value ->> 'state' in ('held', 'conflicted'), false) as holds,
        coalesce(entry.value -> 'listing', '{}'::jsonb) as listing,
        coalesce(entry.value -> 'restored', '{}'::jsonb) as restored,
        case entry.key
          when 'property.surface_m2' then
            pg_catalog.jsonb_build_array(sale.app_surface_m2, sale.surface_m2)
          when 'property.land_surface_m2' then pg_catalog.jsonb_build_array(sale.land_surface_m2)
          when 'property.rooms_count' then pg_catalog.jsonb_build_array(sale.rooms_count)
          when 'property.occupancy_status' then pg_catalog.jsonb_build_array(sale.occupancy_status)
          else pg_catalog.jsonb_build_array(sale.visit_dates)
        end as current_columns
    ) shape
    cross join lateral (
      select
        shape.holds,
        case when shape.holds then entry.value -> 'value' end as held,
        coalesce(entry.value -> 'neighbors', '{}'::jsonb) as neighbors,
        coalesce(entry.value -> 'echo', '[]'::jsonb) as echo,
        (entry.value #>> '{tolerance,abs}')::numeric as abs_tolerance,
        (entry.value #>> '{tolerance,rel}')::numeric as rel_tolerance,
        coalesce(
          sale.held_fields #>> '{property.surface_m2,state}' in ('held', 'conflicted'), false
        ) as surface_held,
        -- Références d'une colonne du champ libéré : les valeurs rendues à la libération.
        (
          select coalesce(pg_catalog.jsonb_agg(restored.value), '[]'::jsonb)
          from pg_catalog.jsonb_each(shape.restored) restored
        ) as restored_references,
        -- Références d'une colonne voisine ou d'une copie.
        case
          when shape.holds then (
            select coalesce(pg_catalog.jsonb_agg(listed.value), '[]'::jsonb)
            from pg_catalog.jsonb_each(shape.listing) listed
            where listed.key not in ('app_surface_kind', 'surface_source', 'surface_confidence')
          )
          else shape.current_columns || (
            select coalesce(pg_catalog.jsonb_agg(restored.value), '[]'::jsonb)
            from pg_catalog.jsonb_each(shape.restored) restored
          )
        end as other_references
    ) piece
    left join public.properties property on property.source_url = sale.source_url
    left join public.auction_surfaces surface on surface.source_url = sale.source_url
    left join public.judicial_sales judicial on judicial.source_url = sale.source_url
    where sale.held_fields is not null
      and sale.id = any(v_sale_ids)
      and sale.id <> all(v_failed)
  ) checked;

  return pg_catalog.jsonb_build_object(
    'sales_checked', pg_catalog.cardinality(v_sale_ids),
    'simulation_failures', v_failures,
    'held_sale_count', v_held_sales,
    'held_field_count', v_held_fields,
    'checks', pg_catalog.jsonb_build_object(
      'projection_drift', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_drift) > 0,
        'count', pg_catalog.cardinality(v_drift),
        'sale_ids', pg_catalog.to_jsonb(v_drift[1:20])
      ),
      'column_mismatch', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_mismatch) > 0,
        'count', pg_catalog.cardinality(v_mismatch),
        'sale_ids', pg_catalog.to_jsonb(v_mismatch[1:20])
      ),
      'echo_suspected', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_echo) > 0,
        'count', pg_catalog.cardinality(v_echo),
        'sale_ids', pg_catalog.to_jsonb(v_echo[1:20])
      ),
      'echo_blocked', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_blocked) > 0,
        'count', pg_catalog.cardinality(v_blocked),
        'sale_ids', pg_catalog.to_jsonb(v_blocked[1:20])
      ),
      'stale_listing', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_stale) > 0,
        'count', pg_catalog.cardinality(v_stale),
        'sale_ids', pg_catalog.to_jsonb(v_stale[1:20])
      )
    )
  );
end;
$$;

comment on function app_private.fact_registry_page_checks(uuid[]) is
  'Registre des pièces : contrôles par vente du contrôle quotidien, pour une page de ventes (dérive de la projection, appelée en simulation seulement ; colonnes tenues ; valeur d''une pièce hors de ses colonnes ; note de blocage ; annonce qui se tait). Lecture seule.';

revoke all on function app_private.fact_registry_page_checks(uuid[])
  from public, anon, authenticated, service_role;

-- 3. Contrôles généraux (définition de 20261118100300, hormis la fenêtre des décisions définitives et l'état
--    des trois réglages) --------------------------------------------------------------------------------------------
create or replace function app_private.fact_registry_global_checks(p_sale_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_payload_ids uuid[] := (coalesce(p_sale_ids, array[]::uuid[]))[1:500];
  v_triggers text[] := app_private.fact_registry_triggers_not_always();
  v_copied uuid[];
  v_label uuid[];
  v_events_day integer;
  v_echo_events integer;
  v_echo_events_total integer;
  v_echo_event_sales uuid[];
  v_carried integer;
  v_reprojection_enabled boolean := app_private.fact_registry_scheduled_reprojection_enabled();
  v_final_limit integer := app_private.fact_registry_daily_final_decision_limit();
  v_final integer;
  v_final_over integer;
begin
  -- La colonne interne recopiée dans raw_payload (500 ventes au plus).
  select coalesce(pg_catalog.array_agg(sale.id order by sale.id), array[]::uuid[]) into v_copied
  from public.auction_sales sale
  where sale.held_fields is not null and sale.id = any(v_payload_ids) and sale.raw_payload ? 'held_fields';

  -- Le libellé réservé du registre sur une surface que rien ne tient. Toutes les ventes sont lues (une
  --     lecture par jour d'une colonne courte) : une insertion directe échappe à la retenue, qui ne voit que les
  --     mises à jour.
  select coalesce(pg_catalog.array_agg(sale.id order by sale.id), array[]::uuid[]) into v_label
  from public.auction_sales sale
  where sale.surface_source = 'fact_registry'
    and not coalesce(sale.held_fields #>> '{property.surface_m2,state}' in ('held', 'conflicted'), false);

  -- La file de relecture. La rafale ne compte que ce qui vient d'une écriture directe (annonce qui
  -- change, écho écarté) : une séance d'acceptations (projection_held) n'est pas une rafale.
  select
    count(*) filter (
      where event.event in ('listing_changed_kept', 'listing_changed_released', 'echo_suppressed')
        and event.created_at >= v_now - interval '24 hours')::integer,
    count(*) filter (
      where event.event = 'echo_suppressed' and event.created_at >= v_now - interval '48 hours')::integer,
    count(*) filter (where event.event = 'echo_suppressed')::integer,
    coalesce(
      pg_catalog.array_agg(distinct event.sale_id) filter (
        where event.event = 'echo_suppressed' and event.created_at >= v_now - interval '48 hours'),
      array[]::uuid[]
    )
  into v_events_day, v_echo_events, v_echo_events_total, v_echo_event_sales
  from public.auction_sale_field_hold_events event;

  -- Pièces reportées par une fusion sur 24 heures (information, pas une alerte).
  select count(*)::integer into v_carried
  from public.auction_sale_field_hold_events event
  where event.event = 'merge_carried' and event.created_at >= v_now - interval '24 hours';

  -- Décisions définitives sur 48 heures, soit deux passages de la tâche : un passage en échec ne fait pas perdre
  -- celles de la veille. Leur nombre, et le nombre d'auteurs qui, dans cette fenêtre, ont dépassé le plafond sur
  -- une période de 24 heures (les 24 heures qui précèdent chacune de leurs décisions).
  with finals as materialized (
    select decision.actor_id, decision.decided_at
    from public.auction_fact_claim_decisions decision
    where app_private.fact_decision_is_final(decision.decision, decision.reason_code)
      and decision.decided_at > v_now - interval '72 hours'
  )
  select
    (select count(*) from finals recent where recent.decided_at > v_now - interval '48 hours')::integer,
    (select count(distinct coalesce(recent.actor_id::text, ''))
       from finals recent
      where recent.decided_at > v_now - interval '48 hours'
        and (
          select count(*) from finals earlier
          where earlier.actor_id is not distinct from recent.actor_id
            and earlier.decided_at > recent.decided_at - interval '24 hours'
            and earlier.decided_at <= recent.decided_at
        ) > v_final_limit)::integer
  into v_final, v_final_over;

  return pg_catalog.jsonb_build_object(
    'merge_carried', pg_catalog.jsonb_build_object('count', v_carried, 'window_hours', 24),
    -- État des trois réglages du registre : une levée doit se voir.
    'decisions_second_factor_required', app_private.fact_registry_decisions_second_factor_required(),
    'decision_rate_limits_enabled', app_private.fact_registry_decision_rate_limits_enabled(),
    'scheduled_reprojection_enabled', v_reprojection_enabled,
    'checks', pg_catalog.jsonb_build_object(
      'triggers_not_always', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_triggers) > 0,
        'count', pg_catalog.cardinality(v_triggers),
        'triggers', pg_catalog.to_jsonb(v_triggers)
      ),
      'registry_label', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_label) > 0,
        'count', pg_catalog.cardinality(v_label),
        'sale_ids', pg_catalog.to_jsonb(v_label[1:20])
      ),
      'internal_column_copied', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_copied) > 0,
        'count', pg_catalog.cardinality(v_copied),
        'sales_read', pg_catalog.cardinality(v_payload_ids),
        'sale_ids', pg_catalog.to_jsonb(v_copied[1:20])
      ),
      'events_burst', pg_catalog.jsonb_build_object(
        'active', v_events_day > 50,
        'count', v_events_day,
        'threshold', 50,
        'window_hours', 24
      ),
      'echo_suppressed', pg_catalog.jsonb_build_object(
        'active', v_echo_events > 0,
        'count', v_echo_events,
        'window_hours', 48,
        'total', v_echo_events_total,
        'sale_ids', pg_catalog.to_jsonb(v_echo_event_sales[1:20])
      ),
      'reprojection_enabled', pg_catalog.jsonb_build_object(
        'active', v_reprojection_enabled,
        'count', case when v_reprojection_enabled then 1 else 0 end
      ),
      'final_decisions', pg_catalog.jsonb_build_object(
        'active', v_final > 0,
        'count', v_final,
        'window_hours', 48
      ),
      'final_decisions_over_limit', pg_catalog.jsonb_build_object(
        'active', v_final_over > 0,
        'count', v_final_over,
        'limit', v_final_limit,
        'limit_period_hours', 24,
        'window_hours', 48
      )
    )
  );
end;
$$;

comment on function app_private.fact_registry_global_checks(uuid[]) is
  'Registre des pièces : contrôles du contrôle quotidien qui ne dépendent pas d''une page de ventes (déclencheurs, libellé réservé, colonne interne recopiée, file d''évènements, relance planifiée ouverte, décisions définitives sur 48 heures), compte des pièces reportées par une fusion sur 24 heures et état des trois réglages du registre. Lecture seule.';

revoke all on function app_private.fact_registry_global_checks(uuid[])
  from public, anon, authenticated, service_role;

-- 4. Relance planifiée (définition de 20261118100300, hormis les erreurs systémiques) --------------------------------
create or replace function public.reproject_fact_registry_drift()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '120s'
as $$
declare
  v_enabled boolean := app_private.fact_registry_scheduled_reprojection_enabled();
  -- Ventes écrites ou occupées par passage ; ventes occupées qui arrêtent la passe ; ventes en échec détaillées.
  v_max constant integer := 30;
  v_busy_max constant integer := 3;
  v_failures_listed constant integer := 20;
  v_sale_id uuid;
  v_drifting uuid[] := array[]::uuid[];
  v_before jsonb;
  v_after jsonb;
  v_applied integer := 0;
  v_busy integer := 0;
  v_failed integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_bounded boolean := false;
  v_events integer;
  v_sqlstate text;
  v_constraint text;
begin
  -- Fermée, journal des décisions vide, ou retenue hors service : rien n'est simulé ni écrit.
  if v_enabled
    and exists (select 1 from public.auction_fact_claim_decisions)
    and pg_catalog.cardinality(app_private.fact_registry_triggers_not_always()) = 0
  then
    -- 1. Simuler toutes les ventes du registre, SANS AUCUN VERROU. Une vente dont la simulation lève (donnée
    --    abîmée) est comptée en échec avec son code et n'arrête pas la passe.
    for v_sale_id in
      select candidate.id from app_private.fact_registry_candidate_sales() candidate(id) order by candidate.id
    loop
      begin
        if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
          v_drifting := v_drifting || v_sale_id;
        end if;
      exception when others then
        get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
        -- Erreur systémique : elle vaudrait pour toutes les ventes, la passe s'arrête et rien n'est écrit.
        if app_private.fact_registry_error_is_systemic(v_sqlstate) then
          raise;
        end if;
        v_failed := v_failed + 1;
        if v_failed <= v_failures_listed then
          v_failures := v_failures || pg_catalog.jsonb_build_array(
            app_private.fact_registry_failure(v_sale_id, v_sqlstate, v_constraint));
        end if;
        raise log 'fact registry scheduled reprojection failed for one sale: sqlstate %', v_sqlstate;
      end;
    end loop;

    -- 2. Appliquer aux ventes en dérive. Les verrous de ligne ne sont pris qu'ici : une vente écrite n'est tenue
    --    que le temps des écritures suivantes, jamais pendant la simulation du registre.
    foreach v_sale_id in array v_drifting loop
      -- Borne atteinte : la passe s'arrête là ; le passage suivant reprend.
      if v_applied + v_busy >= v_max or v_busy >= v_busy_max then
        v_bounded := true;
        exit;
      end if;
      -- Une vente par bloc : un verrou non obtenu ou une erreur n'annule que cette vente, et la passe continue. Le
      -- contrôle qui suit signale en dérive ce qui n'a pas été appliqué.
      begin
        continue when not app_private.lock_sale_for_registry(v_sale_id);
        select sale.held_fields into v_before from public.auction_sales sale where sale.id = v_sale_id;
        if (app_private.project_sale_fields(v_sale_id, null, true) ->> 'changed')::boolean then
          select sale.held_fields into v_after from public.auction_sales sale where sale.id = v_sale_id;
          -- Un évènement par champ dont l'entrée a changé ; à défaut (colonnes remises seules), par champ tenu.
          insert into public.auction_sale_field_hold_events (sale_id, field_key, event, held_value, decision_id)
          select v_sale_id, field.field_key, 'drift_reprojected',
            case when after_entry.value ->> 'state' in ('held', 'conflicted') then after_entry.value -> 'value' end,
            coalesce(after_entry.value ->> 'decision_id', before_entry.value ->> 'decision_id')::uuid
          from public.auction_fact_fields field
          left join lateral (select v_before -> field.field_key as value) before_entry on true
          left join lateral (select v_after -> field.field_key as value) after_entry on true
          where before_entry.value is distinct from after_entry.value;
          get diagnostics v_events = row_count;
          if v_events = 0 then
            insert into public.auction_sale_field_hold_events (sale_id, field_key, event, held_value, decision_id)
            select v_sale_id, entry.key, 'drift_reprojected', entry.value -> 'value',
              (entry.value ->> 'decision_id')::uuid
            from pg_catalog.jsonb_each(coalesce(v_after, '{}'::jsonb)) entry
            where entry.value ->> 'state' in ('held', 'conflicted');
          end if;
          v_applied := v_applied + 1;
        end if;
      exception
        when lock_not_available then
          v_busy := v_busy + 1;
        when others then
          -- Une vente en échec ne compte pas dans la borne : elle ne prive pas les suivantes de leur tour. Son
          -- code et le nom de la contrainte sont rendus et journalisés, jamais son message ni son détail.
          get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
          if app_private.fact_registry_error_is_systemic(v_sqlstate) then
            raise;
          end if;
          v_failed := v_failed + 1;
          if v_failed <= v_failures_listed then
            v_failures := v_failures || pg_catalog.jsonb_build_array(
              app_private.fact_registry_failure(v_sale_id, v_sqlstate, v_constraint));
          end if;
          raise log 'fact registry scheduled reprojection failed for one sale: sqlstate %', v_sqlstate;
      end;
    end loop;
  end if;

  return pg_catalog.jsonb_build_object(
    'enabled', v_enabled,
    'max', v_max,
    'drifted', pg_catalog.cardinality(v_drifting),
    'applied', v_applied,
    'busy', v_busy,
    'failed', v_failed,
    'failures', v_failures,
    'bounded', v_bounded
  );
end;
$$;

comment on function public.reproject_fact_registry_drift() is
  'Registre des pièces : réapplique la projection aux ventes du registre dont la simulation rend « changed » (reclassement en terrain, nombre de chambres corrigé par la collecte), 30 ventes au plus par passage. Écriture de fiche lancée par la tâche planifiée fact-registry-check, dans sa propre transaction, avant le contrôle ; fermée par défaut (réglage scheduled_reprojection) ; n''écrit aucune décision. Sans paramètre. Serveur seul (service_role).';

revoke all on function public.reproject_fact_registry_drift() from public, anon, authenticated;
grant execute on function public.reproject_fact_registry_drift() to service_role;

notify pgrst, 'reload schema';

commit;
