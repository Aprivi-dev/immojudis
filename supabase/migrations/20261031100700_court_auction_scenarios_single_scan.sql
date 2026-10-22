begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères » : get_court_auction_scenarios dépassait le délai de 8 s des appels de
-- l'application (« canceling statement due to statement timeout »), une fois le droit sur
-- starting_price_band accordé (20261031100600).
--
-- 1. app_private.auction_scenario_observations rattachait chaque lot à son tribunal par une jointure
--    latérale sur licitor_ingestion.diagnostic_court_mappings, une vue coûteuse (normalisation des
--    libellés, comparaison avec tous les noms officiels) : elle était recalculée pour chacun des
--    quelque 8 500 lots. Mesuré en production : 9,3 s pour une lecture de la vue. Le rattachement est
--    désormais calculé une fois puis joint sur le libellé, avec la même règle (un seul tribunal parmi
--    les correspondances retenues) : 2,0 s, et le même résultat (3 783 lots, 74 tribunaux).
-- 2. get_court_auction_scenarios lisait la vue deux fois (scénarios, puis historique du tribunal). Elle
--    la lit une fois, sur la fenêtre de trois ans, et passe les lots aux deux fonctions privées. Les
--    signatures d'origine restent, et lisent la vue elles-mêmes.
-- Les calculs et la forme du JSON ne changent pas ; les droits restent réservés à service_role.

create or replace view app_private.auction_scenario_observations as
select
  mapping.court_code,
  coalesce(nullif(btrim(candidate.payload->>'property_type'), ''), 'other') as property_type,
  (candidate.payload->>'starting_price_eur')::numeric as starting_price_eur,
  (candidate.payload->>'adjudication_price_eur')::numeric as hammer_price_eur,
  (candidate.payload->>'sale_date')::date as sale_date
from licitor_ingestion.statistics_eligible_candidates candidate
left join (
  select court_mapping.raw_tribunal_label, min(court_mapping.court_code) as court_code
  from licitor_ingestion.diagnostic_court_mappings court_mapping
  where court_mapping.mapping_status in (
      'unique_official_name_contained', 'unique_verified_historical_alias'
    )
  group by court_mapping.raw_tribunal_label
  having count(distinct court_mapping.court_code) = 1
) mapping on mapping.raw_tribunal_label = nullif(btrim(candidate.payload->>'tribunal'), '')
where coalesce(candidate.payload->>'sale_venue_type', 'tribunal') = 'tribunal'
  and pg_catalog.pg_input_is_valid(candidate.payload->>'sale_date', 'date')
  and pg_catalog.pg_input_is_valid(candidate.payload->>'starting_price_eur', 'numeric')
  and pg_catalog.pg_input_is_valid(candidate.payload->>'adjudication_price_eur', 'numeric')
  and (candidate.payload->>'starting_price_eur')::numeric > 1000
  and (candidate.payload->>'adjudication_price_eur')::numeric > 0
  and not (coalesce(candidate.payload->'quality_flags', '[]'::jsonb) ?| array[
    'index_detail_date_conflict',
    'conflicting_announcement_alias_capture',
    'cached_reparse_failed',
    'source_result_changed_pending_review',
    'lot_missing_in_latest_capture'
  ]);

create or replace function app_private.court_auction_scenarios(
  p_court_code text,
  p_starting_price numeric,
  p_observations app_private.auction_scenario_observations[]
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with window_obs as (
    select
      observation.court_code,
      observation.starting_price_eur,
      observation.hammer_price_eur,
      observation.hammer_price_eur / observation.starting_price_eur as ratio,
      app_private.starting_price_band(observation.starting_price_eur) as band
    from unnest(p_observations) observation
    where observation.sale_date >= (current_date - interval '3 years')::date
      and observation.sale_date <= current_date
  ),
  national as (
    select * from window_obs
    where band = app_private.starting_price_band(p_starting_price)
  ),
  court as (
    select * from national where court_code = p_court_code
  ),
  sizes as (
    select (select count(*) from court) as n_court, (select count(*) from national) as n_national
  ),
  buckets(key, position, low, high) as (
    values
      ('near_start', 1, 0::numeric, 1.1::numeric),
      ('up_to_1_5', 2, 1.1, 1.5),
      ('up_to_2', 3, 1.5, 2),
      ('up_to_3', 4, 2, 3),
      ('above_3', 5, 3, null)
  ),
  bucket_counts as (
    select
      bucket.key,
      bucket.position,
      bucket.low,
      bucket.high,
      (select count(*) from court
        where court.ratio >= bucket.low and (bucket.high is null or court.ratio < bucket.high)) as court_count,
      (select count(*) from national
        where national.ratio >= bucket.low and (bucket.high is null or national.ratio < bucket.high)) as national_count
    from buckets bucket
  ),
  price_scope as (
    select case when sizes.n_court >= 20 then 'court' else 'national' end as scope from sizes
  ),
  ranged as (
    select ratio from court where (select scope from price_scope) = 'court'
    union all
    select ratio from national where (select scope from price_scope) = 'national'
  ),
  quantiles as (
    select
      percentile_cont(0.25) within group (order by ratio::double precision) as q25,
      percentile_cont(0.5) within group (order by ratio::double precision) as q50,
      percentile_cont(0.75) within group (order by ratio::double precision) as q75
    from ranged
  )
  select case
    when p_starting_price is null or p_starting_price <= 0 or sizes.n_national = 0 then null
    else jsonb_build_object(
      'band', app_private.starting_price_band(p_starting_price),
      'court_sample', sizes.n_court,
      'national_sample', sizes.n_national,
      'price_scope', (select scope from price_scope),
      'scenarios', (
        select jsonb_agg(
          jsonb_build_object(
            'key', bucket_counts.key,
            'low_ratio', bucket_counts.low,
            'high_ratio', bucket_counts.high,
            'probability', round(
              (bucket_counts.court_count + 15 * bucket_counts.national_count::numeric / sizes.n_national)
                / (sizes.n_court + 15),
              4
            )
          )
          order by bucket_counts.position
        )
        from bucket_counts
      ),
      'ratio_quartiles', jsonb_build_object(
        'q25', round(quantiles.q25::numeric, 3),
        'q50', round(quantiles.q50::numeric, 3),
        'q75', round(quantiles.q75::numeric, 3)
      )
    )
  end
  from sizes, quantiles;
$function$;

revoke all on function app_private.court_auction_scenarios(text, numeric, app_private.auction_scenario_observations[])
  from public, anon, authenticated;
grant execute on function app_private.court_auction_scenarios(text, numeric, app_private.auction_scenario_observations[])
  to service_role;

create or replace function app_private.court_auction_history(
  p_court_code text,
  p_observations app_private.auction_scenario_observations[]
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with lots as (
    select observation.*, observation.hammer_price_eur / observation.starting_price_eur as ratio
    from unnest(p_observations) observation
    where observation.court_code = p_court_code
      and observation.sale_date >= (current_date - interval '3 years')::date
      and observation.sale_date <= current_date
  ),
  dvf_window as (
    select max(adjudication.mutation_date) as last_date from public.dvf_court_adjudications adjudication
  ),
  dvf as (
    select adjudication.*
    from public.dvf_court_adjudications adjudication, dvf_window
    where adjudication.court_code = p_court_code
      and adjudication.mutation_date > (dvf_window.last_date - interval '3 years')::date
  )
  select jsonb_build_object(
    'licitor', (
      select case when count(*) = 0 then null else jsonb_build_object(
        'sample', count(*),
        'first_sale', min(sale_date),
        'last_sale', max(sale_date),
        'mean_starting_price', round(avg(starting_price_eur)),
        'mean_hammer_price', round(avg(hammer_price_eur)),
        'median_starting_price', round(percentile_cont(0.5) within group (order by starting_price_eur::double precision)::numeric),
        'median_hammer_price', round(percentile_cont(0.5) within group (order by hammer_price_eur::double precision)::numeric),
        'median_ratio', round(percentile_cont(0.5) within group (order by ratio::double precision)::numeric, 3),
        'above_starting_rate', round(avg((hammer_price_eur > starting_price_eur)::int), 4),
        'at_least_double_rate', round(avg((hammer_price_eur >= 2 * starting_price_eur)::int), 4),
        'by_year', (
          select jsonb_agg(jsonb_build_object('year', year, 'sales', sales) order by year)
          from (
            select extract(year from sale_date)::int as year, count(*) as sales from lots group by 1
          ) per_year
        )
      ) end
      from lots
    ),
    'dvf', (
      select case when count(*) = 0 then null else jsonb_build_object(
        'sample', count(*),
        'first_date', min(mutation_date),
        'last_date', max(mutation_date),
        'mean_price', round(avg(price_eur)),
        'median_price', round(percentile_cont(0.5) within group (order by price_eur::double precision)::numeric),
        'by_type', (
          select jsonb_agg(
            jsonb_build_object(
              'property_type', property_type,
              'sample', sales,
              'median_price', median_price,
              'median_price_per_m2', median_price_per_m2,
              'surface_sample', surface_sales
            )
            order by sales desc
          )
          from (
            select
              property_type,
              count(*) as sales,
              round(percentile_cont(0.5) within group (order by price_eur::double precision)::numeric) as median_price,
              count(*) filter (where built_surface_m2 >= 9 and local_count = 1) as surface_sales,
              round(
                (percentile_cont(0.5) within group (order by (price_eur / built_surface_m2)::double precision)
                  filter (where built_surface_m2 >= 9 and local_count = 1))::numeric
              ) as median_price_per_m2
            from dvf
            group by property_type
          ) per_type
        )
      ) end
      from dvf
    )
  );
$function$;

revoke all on function app_private.court_auction_history(text, app_private.auction_scenario_observations[])
  from public, anon, authenticated;
grant execute on function app_private.court_auction_history(text, app_private.auction_scenario_observations[])
  to service_role;

create or replace function app_private.court_auction_scenarios(
  p_court_code text,
  p_starting_price numeric
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select app_private.court_auction_scenarios(
    p_court_code,
    p_starting_price,
    array(select observation from app_private.auction_scenario_observations observation)
  );
$function$;

create or replace function app_private.court_auction_history(p_court_code text)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select app_private.court_auction_history(
    p_court_code,
    array(select observation from app_private.auction_scenario_observations observation)
  );
$function$;

create or replace function public.get_court_auction_scenarios(
  p_court_code text,
  p_starting_price numeric
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with recent as (
    select array(
      select observation
      from app_private.auction_scenario_observations observation
      where observation.sale_date >= (current_date - interval '3 years')::date
        and observation.sale_date <= current_date
    ) as observations
  )
  select jsonb_build_object(
    'scenarios', app_private.court_auction_scenarios(p_court_code, p_starting_price, recent.observations),
    'history', app_private.court_auction_history(p_court_code, recent.observations)
  )
  from recent;
$function$;

notify pgrst, 'reload schema';

commit;
