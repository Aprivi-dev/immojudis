begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères » (chantier W3, points 14, 16, 19, 18 et 22 du compte-rendu du 23/10/2026) : des chiffres
-- seulement quand l'effectif les porte, comparés à des biens de même nature, sur des lots sans valeur aberrante.
--
-- 1. Effectif minimal et niveau de fiabilité (point 14). Jusqu'ici, la fonction ne renvoyait « rien » que si
--    aucun lot comparable n'existait : 3 lots donnaient des pourcentages à deux chiffres significatifs.
--    * Moins de 30 ventes nationales comparables (même tranche de mise à prix, même nature de bien, trois
--      dernières années) : aucun chiffre. La fonction renvoie {status: 'insufficient'} avec les deux effectifs,
--      que l'application affiche (« données insuffisantes, N ventes comparables »).
--    * Moins de 10 ventes du tribunal : repli national, annoncé comme tel (basis = 'national') ; les parts sont
--      alors celles des ventes nationales seules, sans mélange. À partir de 10 ventes du tribunal, la part est
--      lissée : (ventes du tribunal + 15 x taux national) / (ventes du tribunal + 15), comme avant
--      (basis = 'court'). La fourchette de prix utilise les lots du tribunal à partir de 20 (price_scope).
--    * Niveau de fiabilité (reliability), qui ne dépend que du nombre de ventes comparables du tribunal :
--        'good'   : 30 ventes du tribunal ou plus ;
--        'medium' : de 10 à 29 ventes du tribunal ;
--        'low'    : moins de 10 ventes du tribunal (repli national).
--      Ces seuils sont repris côté application (src/lib/auction-scenarios.ts, RELIABILITY_*), qui ne les
--      recalcule pas : elle affiche le niveau renvoyé.
-- 2. Nature du bien (point 16). Le calcul comparait un appartement à des parkings et à des terrains. Un
--    nouveau paramètre p_property_group (null = toutes natures) restreint les lots comparés :
--    * 'housing' (appartement, studio, maison, villa) : les lots de logement et ceux de nature inconnue ou
--      mixte (immeuble, ensemble) ; les parkings, terrains et locaux d'activité sont écartés ;
--    * 'parking', 'land', 'commercial' : seulement la même nature.
--    app_private.scenario_property_group(text) range une nature du pipeline dans l'un de ces groupes (null
--    pour immeuble, mixte, autre). Aucun scénario sous 1 000 € de mise à prix (la fonction renvoie null).
--    Les tranches de mise à prix (starting_price_band) ne sont PAS resserrées : les effectifs mesurés le
--    22/10 (3 783 lots, 74 tribunaux, 72,7 % de combinaisons tribunal x tranche sous le seuil) ne le permettent
--    pas ; des tranches plus fines feraient passer plus de ventes sous les seuils ci-dessus.
-- 3. Lots aberrants (point 22), écartés de la vue app_private.auction_scenario_observations, donc du cliché :
--    * ratio prix d'adjudication / mise à prix inférieur à 0,5 (erreurs de lecture : une adjudication à moins de
--      la moitié de la mise à prix ne se produit pas) ;
--    * lot dont le département n'appartient pas au ressort du tribunal auquel il est rattaché (Versailles hors
--      Yvelines). Le ressort est l'ensemble des départements des communes que les adjudications DVF rattachent à
--      ce tribunal (public.dvf_court_adjudications, référentiel Justice) ; un tribunal sans adjudication DVF, ou un
--      lot sans département, n'est pas écarté. Si ce contrôle écartait tout, la garde de réduction du cliché
--      (20261101120000) refuserait la recopie.
--    Les colonnes de la vue ne changent pas (le type de ligne sert aux fonctions et aux tests).
-- 4. Date du cliché (point 19) : get_court_auction_scenarios renvoie data_as_of (refreshed_at du cliché).
-- 5. get_court_auction_summaries renvoie aussi les médianes de mise à prix et de prix d'adjudication (point 18) ;
--    les moyennes restent dans la réponse (contrat de l'API publique).
--
-- Signatures : les fonctions gagnent un paramètre avec valeur par défaut ; les anciennes signatures sont
-- retirées (sinon un appel sans le nouveau paramètre serait ambigu). Les droits restent réservés à service_role.

drop function if exists public.get_court_auction_scenarios(text, numeric);
drop function if exists app_private.court_auction_scenarios(text, numeric);
drop function if exists app_private.court_auction_scenarios(
  text, numeric, app_private.auction_scenario_observations[]
);

create or replace function app_private.scenario_property_group(p_property_type text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_property_type in ('apartment', 'studio', 'house', 'villa') then 'housing'
    when p_property_type = 'parking' then 'parking'
    when p_property_type = 'land' then 'land'
    when p_property_type = 'commercial' then 'commercial'
  end;
$function$;

revoke all on function app_private.scenario_property_group(text) from public, anon, authenticated;
grant execute on function app_private.scenario_property_group(text) to service_role;

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
left join (
  select adjudication.court_code, array_agg(distinct adjudication.department) as departments
  from public.dvf_court_adjudications adjudication
  where adjudication.court_code is not null
  group by adjudication.court_code
) ressort on ressort.court_code = mapping.court_code
where coalesce(candidate.payload->>'sale_venue_type', 'tribunal') = 'tribunal'
  and pg_catalog.pg_input_is_valid(candidate.payload->>'sale_date', 'date')
  and pg_catalog.pg_input_is_valid(candidate.payload->>'starting_price_eur', 'numeric')
  and pg_catalog.pg_input_is_valid(candidate.payload->>'adjudication_price_eur', 'numeric')
  and (candidate.payload->>'starting_price_eur')::numeric > 1000
  and (candidate.payload->>'adjudication_price_eur')::numeric > 0
  -- Lot aberrant : une adjudication à moins de la moitié de la mise à prix est une erreur de lecture.
  and (candidate.payload->>'adjudication_price_eur')::numeric
    >= 0.5 * (candidate.payload->>'starting_price_eur')::numeric
  -- Lot dont le département n'est pas dans le ressort du tribunal rattaché.
  and (
    ressort.departments is null
    or nullif(pg_catalog.upper(btrim(candidate.payload->>'department')), '') is null
    or pg_catalog.upper(btrim(candidate.payload->>'department')) = any (ressort.departments)
  )
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
  p_observations app_private.auction_scenario_observations[],
  p_property_group text default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with window_obs as (
    select
      observation.court_code,
      observation.hammer_price_eur / observation.starting_price_eur as ratio,
      app_private.starting_price_band(observation.starting_price_eur) as band,
      app_private.scenario_property_group(observation.property_type) as property_group
    from unnest(p_observations) observation
    where observation.sale_date >= (current_date - interval '3 years')::date
      and observation.sale_date <= current_date
  ),
  national as (
    select * from window_obs
    where band = app_private.starting_price_band(p_starting_price)
      and case
        when p_property_group is null then true
        when p_property_group = 'housing'
          then coalesce(window_obs.property_group, 'housing') = 'housing'
        else window_obs.property_group = p_property_group
      end
  ),
  court as (
    select * from national where court_code = p_court_code
  ),
  sizes as (
    select
      (select count(*) from court) as n_court,
      (select count(*) from national) as n_national
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
    when p_starting_price is null or p_starting_price < 1000 then null
    when sizes.n_national < 30 then jsonb_build_object(
      'status', 'insufficient',
      'band', app_private.starting_price_band(p_starting_price),
      'court_sample', sizes.n_court,
      'national_sample', sizes.n_national,
      'minimum_national_sample', 30
    )
    else jsonb_build_object(
      'status', 'ok',
      'band', app_private.starting_price_band(p_starting_price),
      'court_sample', sizes.n_court,
      'national_sample', sizes.n_national,
      'basis', case when sizes.n_court >= 10 then 'court' else 'national' end,
      'reliability', case
        when sizes.n_court >= 30 then 'good'
        when sizes.n_court >= 10 then 'medium'
        else 'low'
      end,
      'price_scope', (select scope from price_scope),
      'scenarios', (
        select jsonb_agg(
          jsonb_build_object(
            'key', bucket_counts.key,
            'low_ratio', bucket_counts.low,
            'high_ratio', bucket_counts.high,
            'probability', round(
              case
                when sizes.n_court >= 10
                  then (bucket_counts.court_count + 15 * bucket_counts.national_count::numeric / sizes.n_national)
                    / (sizes.n_court + 15)
                else bucket_counts.national_count::numeric / sizes.n_national
              end,
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

revoke all on function app_private.court_auction_scenarios(
  text, numeric, app_private.auction_scenario_observations[], text
) from public, anon, authenticated;
grant execute on function app_private.court_auction_scenarios(
  text, numeric, app_private.auction_scenario_observations[], text
) to service_role;

create or replace function app_private.court_auction_scenarios(
  p_court_code text,
  p_starting_price numeric,
  p_property_group text default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select app_private.court_auction_scenarios(
    p_court_code,
    p_starting_price,
    array(select observation from app_private.auction_scenario_observations observation),
    p_property_group
  );
$function$;

revoke all on function app_private.court_auction_scenarios(text, numeric, text)
  from public, anon, authenticated;
grant execute on function app_private.court_auction_scenarios(text, numeric, text) to service_role;

create or replace function public.get_court_auction_scenarios(
  p_court_code text,
  p_starting_price numeric,
  p_property_group text default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with recent as (
    select array(
      select (
        observation.court_code,
        observation.property_type,
        observation.starting_price_eur,
        observation.hammer_price_eur,
        observation.sale_date
      )::app_private.auction_scenario_observations
      from app_private.auction_scenario_observation_snapshot observation
      where observation.sale_date >= (current_date - interval '3 years')::date
        and observation.sale_date <= current_date
    ) as observations
  )
  select jsonb_build_object(
    'scenarios', app_private.court_auction_scenarios(
      p_court_code, p_starting_price, recent.observations, p_property_group
    ),
    'history', app_private.court_auction_history(p_court_code, recent.observations),
    'data_as_of', (select state.refreshed_at from app_private.auction_scenario_snapshot_state state)
  )
  from recent;
$function$;

revoke all on function public.get_court_auction_scenarios(text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.get_court_auction_scenarios(text, numeric, text) to service_role;

-- Every court with enough history, for the tribunal comparison table (medians added, means kept).
create or replace function public.get_court_auction_summaries()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with lots as (
    select observation.*
    from app_private.auction_scenario_observation_snapshot observation
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
      round(percentile_cont(0.5) within group (order by starting_price_eur::double precision)::numeric) as median_starting_price,
      round(percentile_cont(0.5) within group (order by hammer_price_eur::double precision)::numeric) as median_hammer_price,
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
        'median_starting_price', licitor.median_starting_price,
        'median_hammer_price', licitor.median_hammer_price,
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

notify pgrst, 'reload schema';

commit;
