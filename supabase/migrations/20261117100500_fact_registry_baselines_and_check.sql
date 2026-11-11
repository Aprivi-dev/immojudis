begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a, étape A7 (plan du 11/11/2026, section 10 ; annexe 08, points 3 c et 12).
-- INERTE : aucun champ n'est tenu, les trois fonctions rendent zéro ligne ou un rapport vide.
--
--   1. public.get_sale_field_baselines(p_sale_ids) : pour chaque champ TENU (state held ou conflicted) des ventes
--      demandées (toutes si l'argument est nul), les colonnes du champ et la dernière valeur connue de l'annonce
--      (bloc « listing » ; une clé absente = colonne nulle). Elle ne rend jamais la valeur tenue, la pièce, la
--      décision ni l'origine. SEUL usage (arbitrage du plan) : la fusion de doublons de la collecte, qui doit
--      fusionner deux fiches sur leurs valeurs d'annonce et non sur la valeur d'une pièce. La collecte continue
--      de juger une vente sur la valeur affichée : la base n'exige rien d'autre d'elle. Serveur seul.
--   2. public.check_fact_registry_consistency(p_limit) : le contrôle quotidien. Fonction STABLE : PostgreSQL
--      refuse toute écriture depuis une fonction non volatile, elle ne peut donc rien écrire (elle simule la
--      projection, p_apply = false). Elle rend un rapport JSON de comptes et d'identifiants de vente (20 au
--      plus par contrôle), jamais une valeur :
--        projection_drift        la simulation de projection rendrait « changed » pour une vente qui tient ou
--                                mémorise un champ, ou dont une pièce a pour dernière décision une acceptation
--                                d'un lot identifié ;
--        triggers_not_always     un déclencheur du registre manque ou n'est plus en mode « always » ;
--        column_mismatch         une colonne tenue diffère de la valeur de son entrée, ou les libellés d'une
--                                surface tenue ne sont plus les valeurs neutres (fact_registry, built) ;
--        echo_suspected          une colonne voisine de la vente, ou une copie (properties, auction_surfaces,
--                                judicial_sales), porte la valeur tenue ou une valeur de la mémoire d'écho, et
--                                pas la valeur d'annonce ;
--        internal_column_copied  raw_payload d'une vente du registre contient une clé held_fields ;
--        events_burst            plus de 50 évènements en 24 heures dans la file de relecture ;
--        echo_suppressed         au moins un évènement echo_suppressed en 48 heures (deux passages du contrôle :
--                                le plan Hobby décale un passage jusqu'à 59 minutes) : un chemin de la collecte a
--                                échappé à sa garde d'écho ; l'indicateur doit rester à zéro ;
--        stale_listing           l'annonce s'est tue sur un champ tenu (listing_silent_since : la valeur d'annonce
--                                mémorisée est peut-être périmée, arbitrage du plan sur le point 8), ou une
--                                surface est tenue sur une vente devenue un terrain.
--      Le nombre de ventes examinées est borné par p_limit ; au-delà, « truncated » vaut true (la tâche échoue
--      alors au lieu de rendre un rapport partiel pour complet).
--   3. public.sync_fact_registry_alerts(p_limit) : appelée par la tâche /api/cron/fact-registry-check. Elle lance
--      le contrôle puis ouvre ou referme une alerte opérationnelle par contrôle (clé fact_registry.<contrôle>),
--      par le mécanisme existant (app_private.sync_operational_alert : notification à l'ouverture, rappel au plus
--      une fois par 24 heures, fermeture deux heures après le retour au calme). La clé, la catégorie et la gravité
--      sont fixées ici : l'appelant ne fournit ni rapport ni détail. Critique : projection_drift,
--      triggers_not_always, column_mismatch. Avertissement : les cinq autres. Catégorie « import », celle des
--      autres contrôles du catalogue (operational_alerts_category_check n'est pas touchée).
--
-- Verrous : création de fonctions seulement. Possible pendant un import.
--
-- Retour arrière :
--   begin;
--   drop function if exists public.sync_fact_registry_alerts(integer);
--   drop function if exists public.check_fact_registry_consistency(integer);
--   drop function if exists public.get_sale_field_baselines(uuid[]);
--   drop function if exists app_private.sale_field_value_leaks(text, jsonb, jsonb, jsonb, jsonb, jsonb, numeric, numeric);
--   commit;
-- (les alertes fact_registry.* déjà ouvertes restent dans operational_alerts : ne pas les supprimer.)

create or replace function public.get_sale_field_baselines(p_sale_ids uuid[] default null)
returns table (sale_id uuid, field_key text, columns text[], listing jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select sale.id, entry.key, field.held_columns, coalesce(entry.value -> 'listing', '{}'::jsonb)
  from public.auction_sales sale
  cross join lateral pg_catalog.jsonb_each(sale.held_fields) entry
  join public.auction_fact_fields field on field.field_key = entry.key
  where sale.held_fields is not null
    and (p_sale_ids is null or sale.id = any(p_sale_ids))
    and entry.value ->> 'state' in ('held', 'conflicted')
  order by sale.id, entry.key;
$$;

comment on function public.get_sale_field_baselines(uuid[]) is
  'Registre des pièces : pour chaque champ tenu des ventes demandées, ses colonnes et la dernière valeur connue de l''annonce. Jamais la valeur tenue, la pièce, la décision ni l''origine. Réservée à la fusion de doublons de la collecte (service_role).';

revoke all on function public.get_sale_field_baselines(uuid[]) from public, anon, authenticated;
grant execute on function public.get_sale_field_baselines(uuid[]) to service_role;

-- Une colonne non tenue porte-t-elle la valeur d'une pièce (valeur tenue ou mémoire d'écho) sans que ce soit la
-- valeur d'annonce mémorisée ?
create or replace function app_private.sale_field_value_leaks(
  p_field_key text,
  p_value jsonb,
  p_held jsonb,
  p_listing_a jsonb,
  p_listing_b jsonb,
  p_echo jsonb,
  p_abs_tolerance numeric,
  p_rel_tolerance numeric
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select app_private.sale_field_incoming_class(
      p_field_key, p_value, p_held, null, p_echo, p_abs_tolerance, p_rel_tolerance
    ) in ('held', 'echo')
    and not app_private.sale_field_values_match(
      p_field_key, p_value, p_listing_a, p_abs_tolerance, p_rel_tolerance)
    and not app_private.sale_field_values_match(
      p_field_key, p_value, p_listing_b, p_abs_tolerance, p_rel_tolerance);
$$;

revoke all on function
  app_private.sale_field_value_leaks(text, jsonb, jsonb, jsonb, jsonb, jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;

create or replace function public.check_fact_registry_consistency(p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_candidates integer;
  v_sale_ids uuid[];
  v_sale_id uuid;
  v_drift uuid[] := array[]::uuid[];
  v_mismatch uuid[];
  v_echo uuid[];
  v_stale uuid[];
  v_copied uuid[];
  v_triggers text[];
  v_events_day integer;
  v_echo_events integer;
  v_echo_events_total integer;
  v_echo_event_sales uuid[];
  v_held_sales integer;
  v_held_fields integer;
begin
  -- Ventes examinées : celles qui tiennent ou mémorisent un champ, et celles dont une pièce a pour dernière
  -- décision une acceptation d'un lot identifié (rapportée à la vente conservée après une fusion).
  with accepted as (
    select distinct coalesce(merge.canonical_sale_id, latest.sale_id) as id
    from (
      select distinct on (decision.claim_id) decision.sale_id, decision.decision, decision.lot_attachment
      from public.auction_fact_claim_decisions decision
      order by decision.claim_id, decision.seq desc
    ) latest
    left join app_private.auction_sale_merges merge on merge.old_sale_id = latest.sale_id
    where latest.decision = 'accepted' and latest.lot_attachment in ('single_lot', 'matched')
  ),
  candidates as (
    select sale.id from public.auction_sales sale where sale.held_fields is not null
    union
    select sale.id from accepted join public.auction_sales sale on sale.id = accepted.id
  )
  select
    (select count(*)::integer from candidates),
    (select coalesce(pg_catalog.array_agg(bounded.id order by bounded.id), array[]::uuid[])
       from (select candidates.id from candidates order by candidates.id limit v_limit) bounded)
  into v_candidates, v_sale_ids;

  -- 1. La simulation de projection ne doit rien changer.
  foreach v_sale_id in array v_sale_ids loop
    if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
      v_drift := v_drift || v_sale_id;
    end if;
  end loop;

  -- 2. Mode des déclencheurs.
  v_triggers := app_private.fact_registry_triggers_not_always();

  -- 3, 4 et 8. Colonnes tenues, colonnes voisines et copies, annonce qui se tait : une lecture par champ tenu.
  select
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.mismatch), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.leak), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.stale), array[]::uuid[]),
    count(distinct checked.id)::integer,
    count(*)::integer
  into v_mismatch, v_echo, v_stale, v_held_sales, v_held_fields
  from (
    select
      sale.id,
      case entry.key
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
      case entry.key
        when 'property.surface_m2' then exists (
          select 1
          from (values
            (pg_catalog.to_jsonb(sale.habitable_surface_m2)), (pg_catalog.to_jsonb(sale.carrez_surface_m2)),
            (pg_catalog.to_jsonb(property.surface_m2)), (pg_catalog.to_jsonb(property.app_surface_m2)),
            (pg_catalog.to_jsonb(property.habitable_surface_m2)),
            (pg_catalog.to_jsonb(property.carrez_surface_m2)),
            (pg_catalog.to_jsonb(surface.surface_m2)), (pg_catalog.to_jsonb(surface.app_surface_m2)),
            (pg_catalog.to_jsonb(surface.habitable_surface_m2)),
            (pg_catalog.to_jsonb(surface.carrez_surface_m2))
          ) copied(value)
          where app_private.sale_field_value_leaks(
            entry.key, copied.value, piece.held, piece.listing -> 'app_surface_m2',
            piece.listing -> 'surface_m2', piece.echo, piece.abs_tolerance, piece.rel_tolerance)
        )
        when 'property.land_surface_m2' then exists (
          select 1
          from (values
            (pg_catalog.to_jsonb(property.land_surface_m2), true),
            (pg_catalog.to_jsonb(surface.land_surface_m2), true),
            -- Terrain recopié en surface principale : seulement quand la surface n'est pas elle-même tenue.
            (pg_catalog.to_jsonb(sale.app_surface_m2), not piece.surface_held),
            (pg_catalog.to_jsonb(sale.surface_m2), not piece.surface_held)
          ) copied(value, applies)
          where copied.applies and app_private.sale_field_value_leaks(
            entry.key, copied.value, piece.held, piece.listing -> 'land_surface_m2', null, piece.echo,
            piece.abs_tolerance, piece.rel_tolerance)
        )
        when 'property.rooms_count' then exists (
          select 1
          from (values
            (pg_catalog.to_jsonb(property.rooms_count)), (pg_catalog.to_jsonb(surface.rooms_count))
          ) copied(value)
          where app_private.sale_field_value_leaks(
            entry.key, copied.value, piece.held, piece.listing -> 'rooms_count', null, piece.echo,
            piece.abs_tolerance, piece.rel_tolerance)
        )
        when 'property.occupancy_status' then app_private.sale_field_value_leaks(
          entry.key, pg_catalog.to_jsonb(property.occupancy_status), piece.held,
          piece.listing -> 'occupancy_status', null, piece.echo, piece.abs_tolerance, piece.rel_tolerance)
        else app_private.sale_field_value_leaks(
          entry.key, judicial.visit_dates, piece.held, piece.listing -> 'visit_dates', null, piece.echo,
          piece.abs_tolerance, piece.rel_tolerance)
      end as leak,
      entry.value ? 'listing_silent_since'
        or (
          entry.key = 'property.surface_m2'
          and (sale.property_type = 'land' or sale.surface_scope = 'land')
        ) as stale
    from public.auction_sales sale
    cross join lateral pg_catalog.jsonb_each(sale.held_fields) entry
    cross join lateral (
      select
        entry.value -> 'value' as held,
        coalesce(entry.value -> 'listing', '{}'::jsonb) as listing,
        coalesce(entry.value -> 'echo', '[]'::jsonb) as echo,
        (entry.value #>> '{tolerance,abs}')::numeric as abs_tolerance,
        (entry.value #>> '{tolerance,rel}')::numeric as rel_tolerance,
        coalesce(
          sale.held_fields #>> '{property.surface_m2,state}' in ('held', 'conflicted'), false
        ) as surface_held
    ) piece
    left join public.properties property on property.source_url = sale.source_url
    left join public.auction_surfaces surface on surface.source_url = sale.source_url
    left join public.judicial_sales judicial on judicial.source_url = sale.source_url
    where sale.held_fields is not null
      and sale.id = any(v_sale_ids)
      and entry.value ->> 'state' in ('held', 'conflicted')
  ) checked;

  -- 5. La colonne interne recopiée dans raw_payload.
  select coalesce(pg_catalog.array_agg(sale.id), array[]::uuid[]) into v_copied
  from public.auction_sales sale
  where sale.held_fields is not null and sale.id = any(v_sale_ids) and sale.raw_payload ? 'held_fields';

  -- 6 et 7. La file de relecture.
  select
    count(*) filter (where event.created_at >= v_now - interval '24 hours')::integer,
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

  return pg_catalog.jsonb_build_object(
    'checked_at', v_now,
    'limit', v_limit,
    'candidate_sales', v_candidates,
    'sales_checked', pg_catalog.cardinality(v_sale_ids),
    'truncated', v_candidates > pg_catalog.cardinality(v_sale_ids),
    'held_sales', v_held_sales,
    'held_fields', v_held_fields,
    'checks', pg_catalog.jsonb_build_object(
      'projection_drift', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_drift) > 0,
        'count', pg_catalog.cardinality(v_drift),
        'sale_ids', pg_catalog.to_jsonb(v_drift[1:20])
      ),
      'triggers_not_always', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_triggers) > 0,
        'count', pg_catalog.cardinality(v_triggers),
        'triggers', pg_catalog.to_jsonb(v_triggers)
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
      'internal_column_copied', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_copied) > 0,
        'count', pg_catalog.cardinality(v_copied),
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
      'stale_listing', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_stale) > 0,
        'count', pg_catalog.cardinality(v_stale),
        'sale_ids', pg_catalog.to_jsonb(v_stale[1:20])
      )
    )
  );
end;
$$;

comment on function public.check_fact_registry_consistency(integer) is
  'Registre des pièces : contrôle quotidien en lecture seule (fonction stable). Rapport JSON de comptes et d''identifiants de vente, jamais une valeur : dérive de la projection, mode des déclencheurs, colonnes tenues, écho dans une colonne voisine ou une copie, colonne interne recopiée, rafale d''évènements, écho écarté, annonce qui se tait. Serveur seul (service_role).';

revoke all on function public.check_fact_registry_consistency(integer) from public, anon, authenticated;
grant execute on function public.check_fact_registry_consistency(integer) to service_role;

create or replace function public.sync_fact_registry_alerts(p_limit integer default 500)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_report jsonb := public.check_fact_registry_consistency(p_limit);
  v_check record;
begin
  for v_check in
    select planned.check_key, planned.severity
    from (
      values
        ('projection_drift', 'critical'),
        ('triggers_not_always', 'critical'),
        ('column_mismatch', 'critical'),
        ('echo_suspected', 'warning'),
        ('internal_column_copied', 'warning'),
        ('events_burst', 'warning'),
        ('echo_suppressed', 'warning'),
        ('stale_listing', 'warning')
    ) as planned (check_key, severity)
  loop
    if pg_catalog.jsonb_typeof(v_report #> array['checks', v_check.check_key, 'active']) is distinct from 'boolean'
    then
      raise exception using errcode = 'XX000',
        message = pg_catalog.format('fact registry check %s returned no state', v_check.check_key);
    end if;
    perform app_private.sync_operational_alert(
      'fact_registry.' || v_check.check_key,
      'import',
      v_check.severity,
      (v_report #> array['checks', v_check.check_key]) - 'active'
        || pg_catalog.jsonb_build_object(
          'checked_at', v_report -> 'checked_at',
          'sales_checked', v_report -> 'sales_checked',
          'truncated', v_report -> 'truncated'
        ),
      (v_report #>> array['checks', v_check.check_key, 'active'])::boolean
    );
  end loop;
  return v_report;
end;
$$;

comment on function public.sync_fact_registry_alerts(integer) is
  'Registre des pièces : lance le contrôle quotidien puis ouvre ou referme les alertes opérationnelles fact_registry.* (clé, catégorie et gravité fixées ici). Rend le rapport du contrôle. Serveur seul (service_role).';

revoke all on function public.sync_fact_registry_alerts(integer) from public, anon, authenticated;
grant execute on function public.sync_fact_registry_alerts(integer) to service_role;

notify pgrst, 'reload schema';

commit;
