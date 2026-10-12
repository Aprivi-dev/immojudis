begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères » (offre Analyse) : ce que les trois dernières années
-- d'adjudications d'un tribunal disent d'une vente à venir.
--
-- Deux sources, lues séparément :
--   * Licitor (accord de réutilisation confirmé par le propriétaire le 12/10/2026) :
--     mise à prix ET prix d'adjudication de chaque lot, donc les rapports
--     prix final / mise à prix et les scénarios ;
--   * DVF (DGFiP, licence ouverte) : mutations « Adjudication » rattachées au
--     tribunal compétent pour la commune, donc les volumes et les prix finaux
--     officiels, sans mise à prix.
-- Tout est réservé au service role : l'application vérifie l'offre avant de lire.

create schema if not exists app_private;

-- DVF ---------------------------------------------------------------------

create table if not exists public.dvf_court_adjudications (
  mutation_id text primary key,
  mutation_date date not null,
  insee_code text not null,
  department text not null,
  court_code text,
  property_type text not null check (
    property_type in ('apartment', 'house', 'land', 'commercial', 'parking', 'mixed', 'other')
  ),
  built_surface_m2 numeric check (built_surface_m2 is null or built_surface_m2 > 0),
  land_surface_m2 numeric check (land_surface_m2 is null or land_surface_m2 > 0),
  local_count integer not null default 0 check (local_count >= 0),
  price_eur numeric not null check (price_eur > 0),
  source_year smallint not null,
  imported_at timestamptz not null default statement_timestamp()
);

create index if not exists dvf_court_adjudications_court_date_idx
  on public.dvf_court_adjudications (court_code, mutation_date desc);

alter table public.dvf_court_adjudications enable row level security;
revoke all on table public.dvf_court_adjudications from public, anon, authenticated;
grant select, insert, update, delete on table public.dvf_court_adjudications to service_role;

comment on table public.dvf_court_adjudications is
  'Mutations DVF « Adjudication » (une ligne par mutation), rattachées au tribunal judiciaire compétent pour la commune (référentiel Justice). Rempli par services/data-pipeline/src/dvf_court_adjudications.py.';

-- Licitor -----------------------------------------------------------------

-- One row per reported tribunal adjudication, attached to its canonical court
-- when the label maps to exactly one court. Prices were validated by the
-- statistics gate; the same exclusions as the barometer are re-applied.
create or replace view app_private.auction_scenario_observations as
select
  mapping.court_code,
  coalesce(nullif(btrim(candidate.payload->>'property_type'), ''), 'other') as property_type,
  (candidate.payload->>'starting_price_eur')::numeric as starting_price_eur,
  (candidate.payload->>'adjudication_price_eur')::numeric as hammer_price_eur,
  (candidate.payload->>'sale_date')::date as sale_date
from licitor_ingestion.statistics_eligible_candidates candidate
left join lateral (
  select min(court_mapping.court_code) as court_code
  from licitor_ingestion.diagnostic_court_mappings court_mapping
  where court_mapping.raw_tribunal_label = nullif(btrim(candidate.payload->>'tribunal'), '')
    and court_mapping.mapping_status in (
      'unique_official_name_contained', 'unique_verified_historical_alias'
    )
  having count(distinct court_mapping.court_code) = 1
) mapping on true
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

revoke all on app_private.auction_scenario_observations from public, anon, authenticated;
grant select on app_private.auction_scenario_observations to service_role;

-- The starting price drives the outcome more than anything else: a 15 000 €
-- lot is typically sold at 3.7×, a 300 000 € one at 1.2×. Scenarios compare a
-- sale with lots of the same band.
create or replace function app_private.starting_price_band(p_starting_price numeric)
returns smallint
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_starting_price is null or p_starting_price <= 0 then null
    when p_starting_price < 20000 then 1
    when p_starting_price < 50000 then 2
    when p_starting_price < 100000 then 3
    when p_starting_price < 200000 then 4
    else 5
  end::smallint;
$function$;

-- Scenarios for one starting price at one court. Each probability blends the
-- court's own lots of the same band with the national lots of that band
-- (weight 15): a court with few comparable sales leans on the national rate,
-- one with many speaks for itself. The price range uses the court's lots when
-- there are at least 20, the national ones otherwise.
create or replace function app_private.court_auction_scenarios(
  p_court_code text,
  p_starting_price numeric
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
    from app_private.auction_scenario_observations observation
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

revoke all on function app_private.court_auction_scenarios(text, numeric) from public, anon, authenticated;
grant execute on function app_private.court_auction_scenarios(text, numeric) to service_role;

-- What the court's last three years look like, all bands together.
create or replace function app_private.court_auction_history(p_court_code text)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with lots as (
    select observation.*, observation.hammer_price_eur / observation.starting_price_eur as ratio
    from app_private.auction_scenario_observations observation
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

revoke all on function app_private.court_auction_history(text) from public, anon, authenticated;
grant execute on function app_private.court_auction_history(text) to service_role;

create or replace function public.get_court_auction_scenarios(
  p_court_code text,
  p_starting_price numeric
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'scenarios', app_private.court_auction_scenarios(p_court_code, p_starting_price),
    'history', app_private.court_auction_history(p_court_code)
  );
$function$;

revoke all on function public.get_court_auction_scenarios(text, numeric) from public, anon, authenticated;
grant execute on function public.get_court_auction_scenarios(text, numeric) to service_role;

-- Every court with enough history, for the tribunal comparison table.
create or replace function public.get_court_auction_summaries()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with lots as (
    select observation.*
    from app_private.auction_scenario_observations observation
    where observation.court_code is not null
      and observation.sale_date >= (current_date - interval '3 years')::date
      and observation.sale_date <= current_date
  ),
  licitor as (
    select
      court_code,
      count(*) as sample,
      round(avg(starting_price_eur)) as mean_starting_price,
      round(avg(hammer_price_eur)) as mean_hammer_price,
      round(percentile_cont(0.5) within group (order by (hammer_price_eur / starting_price_eur)::double precision)::numeric, 3) as median_ratio,
      round(avg((hammer_price_eur >= 2 * starting_price_eur)::int), 4) as at_least_double_rate
    from lots
    group by court_code
  ),
  dvf_window as (
    select max(mutation_date) as last_date from public.dvf_court_adjudications
  ),
  dvf as (
    select
      adjudication.court_code,
      count(*) as sample,
      round(percentile_cont(0.5) within group (order by adjudication.price_eur::double precision)::numeric) as median_price
    from public.dvf_court_adjudications adjudication, dvf_window
    where adjudication.court_code is not null
      and adjudication.mutation_date > (dvf_window.last_date - interval '3 years')::date
    group by adjudication.court_code
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'court_code', courts.court_code,
      'court_name', coalesce(tribunal.canonical_name, courts.court_code),
      'licitor', case when licitor.sample >= 10 then jsonb_build_object(
        'sample', licitor.sample,
        'mean_starting_price', licitor.mean_starting_price,
        'mean_hammer_price', licitor.mean_hammer_price,
        'median_ratio', licitor.median_ratio,
        'at_least_double_rate', licitor.at_least_double_rate
      ) end,
      'dvf', case when dvf.sample >= 10 then jsonb_build_object(
        'sample', dvf.sample,
        'median_price', dvf.median_price
      ) end
    )
    order by coalesce(licitor.sample, 0) + coalesce(dvf.sample, 0) desc
  ), '[]'::jsonb)
  from (
    select court_code from licitor where sample >= 10
    union
    select court_code from dvf where sample >= 10
  ) courts
  left join licitor on licitor.court_code = courts.court_code
  left join dvf on dvf.court_code = courts.court_code
  left join public.tribunals tribunal on tribunal.code = courts.court_code;
$function$;

revoke all on function public.get_court_auction_summaries() from public, anon, authenticated;
grant execute on function public.get_court_auction_summaries() to service_role;

notify pgrst, 'reload schema';

commit;
