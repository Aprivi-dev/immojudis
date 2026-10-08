-- Additive barometer metrics on the existing authorized, reviewed source cohort.
-- Keep the canonical eligibility, historical court aliases, and n >= 10 threshold.
-- Old snapshots remain immutable. A NEW build through the existing staging,
-- attestation and review flow is required before publishing these additions.
-- Type medians and DVF discounts must never be inferred from aggregate quartiles.

create or replace view licitor_ingestion.diagnostic_price_enrichments
with (security_invoker=true) as
with parsed as (
  select
    coalesce(nullif(candidate.payload->>'property_type', ''), 'unknown') as property_type,
    nullif(pg_catalog.btrim(candidate.payload->>'tribunal'), '') as raw_tribunal_label,
    case when pg_catalog.pg_input_is_valid(candidate.payload->>'starting_price_eur', 'numeric')
      then (candidate.payload->>'starting_price_eur')::numeric end as starting_price_eur,
    case when pg_catalog.pg_input_is_valid(candidate.payload->>'adjudication_price_eur', 'numeric')
      then (candidate.payload->>'adjudication_price_eur')::numeric end as hammer_price_eur,
    coalesce(candidate.payload->>'sale_venue_type', 'tribunal') as sale_venue_type,
    coalesce(candidate.payload->'quality_flags', '[]'::jsonb) as quality_flags
  from licitor_ingestion.statistics_eligible_candidates candidate
), eligible as (
  select parsed.*
  from parsed
  where parsed.sale_venue_type = 'tribunal'
    and not (parsed.quality_flags ?| array[
      'index_detail_date_conflict',
      'conflicting_announcement_alias_capture',
      'cached_reparse_failed',
      'source_result_changed_pending_review',
      'lot_missing_in_latest_capture'
    ])
    and parsed.starting_price_eur > 1000
    and parsed.hammer_price_eur > 0
), scoped as (
  select
    'national'::text as scope_type,
    null::uuid as court_id,
    null::text as court_code,
    'France entière'::text as scope_label,
    null::text as judicial_region,
    eligible.property_type,
    eligible.starting_price_eur,
    eligible.hammer_price_eur
  from eligible
  union all
  select
    'tribunal'::text,
    mapping.court_id,
    mapping.court_code,
    mapping.court_name,
    mapping.judicial_region,
    eligible.property_type,
    eligible.starting_price_eur,
    eligible.hammer_price_eur
  from eligible
  join licitor_ingestion.diagnostic_court_mappings mapping
    on mapping.raw_tribunal_label = eligible.raw_tribunal_label
   and mapping.mapping_status in ('unique_official_name_contained', 'unique_verified_historical_alias')
), grouped as (
  select scope_type, court_id, property_type, grouping(property_type) as all_types,
    count(*) as n,
    jsonb_build_object(
      'sampleSize', count(*),
      'hammerPriceMiddle50Eur', jsonb_build_object(
        'p25', percentile_cont(0.25) within group(order by hammer_price_eur),
        'p75', percentile_cont(0.75) within group(order by hammer_price_eur)),
      'ratioMiddle50', jsonb_build_object(
        'p25', percentile_cont(0.25) within group(order by hammer_price_eur/starting_price_eur),
        'p75', percentile_cont(0.75) within group(order by hammer_price_eur/starting_price_eur)),
      'summary', jsonb_build_object(
        'medianHammerPriceEur', round((percentile_cont(0.5) within group(order by hammer_price_eur))::numeric),
        'medianStartingPriceEur', round((percentile_cont(0.5) within group(order by starting_price_eur))::numeric),
        'medianHammerToStartingRatio', round((percentile_cont(0.5) within group(order by hammer_price_eur/starting_price_eur))::numeric, 4),
        'meanHammerToStartingRatio', round(avg(hammer_price_eur/starting_price_eur), 4)
      ),
      'detailedBidDistribution', jsonb_build_array(
        jsonb_build_object('band', 'below_starting',
          'count', count(*) filter(where hammer_price_eur < starting_price_eur),
          'share', round((count(*) filter(where hammer_price_eur < starting_price_eur))::numeric / count(*), 6)),
        jsonb_build_object('band', 'at_starting',
          'count', count(*) filter(where hammer_price_eur = starting_price_eur),
          'share', round((count(*) filter(where hammer_price_eur = starting_price_eur))::numeric / count(*), 6)),
        jsonb_build_object('band', 'above_1_below_1_5',
          'count', count(*) filter(where hammer_price_eur > starting_price_eur and hammer_price_eur < starting_price_eur * 1.5),
          'share', round((count(*) filter(where hammer_price_eur > starting_price_eur and hammer_price_eur < starting_price_eur * 1.5))::numeric / count(*), 6)),
        jsonb_build_object('band', 'from_1_5_below_2',
          'count', count(*) filter(where hammer_price_eur >= starting_price_eur * 1.5 and hammer_price_eur < starting_price_eur * 2),
          'share', round((count(*) filter(where hammer_price_eur >= starting_price_eur * 1.5 and hammer_price_eur < starting_price_eur * 2))::numeric / count(*), 6)),
        jsonb_build_object('band', 'from_2_below_3',
          'count', count(*) filter(where hammer_price_eur >= starting_price_eur * 2 and hammer_price_eur < starting_price_eur * 3),
          'share', round((count(*) filter(where hammer_price_eur >= starting_price_eur * 2 and hammer_price_eur < starting_price_eur * 3))::numeric / count(*), 6)),
        jsonb_build_object('band', 'at_least_3',
          'count', count(*) filter(where hammer_price_eur >= starting_price_eur * 3),
          'share', round((count(*) filter(where hammer_price_eur >= starting_price_eur * 3))::numeric / count(*), 6))
      ),
      'bidDistribution', jsonb_build_array(jsonb_build_object('band','below_starting', 'count',count(*) filter(where hammer_price_eur < starting_price_eur), 'share',round((count(*) filter(where hammer_price_eur < starting_price_eur))::numeric / count(*),6)),
jsonb_build_object('band','at_starting', 'count',count(*) filter(where hammer_price_eur = starting_price_eur), 'share',round((count(*) filter(where hammer_price_eur = starting_price_eur))::numeric / count(*),6)),
jsonb_build_object('band','above_1_below_1_5', 'count',count(*) filter(where hammer_price_eur > starting_price_eur and hammer_price_eur < starting_price_eur * 1.5), 'share',round((count(*) filter(where hammer_price_eur > starting_price_eur and hammer_price_eur < starting_price_eur * 1.5))::numeric / count(*),6)),
jsonb_build_object('band','from_1_5_below_2', 'count',count(*) filter(where hammer_price_eur >= starting_price_eur * 1.5 and hammer_price_eur < starting_price_eur * 2), 'share',round((count(*) filter(where hammer_price_eur >= starting_price_eur * 1.5 and hammer_price_eur < starting_price_eur * 2))::numeric / count(*),6)),
jsonb_build_object('band','at_least_2', 'count',count(*) filter(where hammer_price_eur >= starting_price_eur * 2), 'share',round((count(*) filter(where hammer_price_eur >= starting_price_eur * 2))::numeric / count(*),6)))
    ) as distribution
  from scoped
  group by grouping sets ((scope_type,court_id),(scope_type,court_id,property_type))
  having count(*) >= 10
)
select parent.scope_type, parent.court_id,
  jsonb_build_object('distribution',parent.distribution,'propertyTypes',
    coalesce((select jsonb_agg(jsonb_build_object(
       'propertyType', child.property_type, 'distribution', child.distribution)
       order by child.property_type)
     from grouped child
     where child.all_types=0 and child.property_type in
       ('apartment','house','commercial','building','land','parking','mixed')
       and child.scope_type=parent.scope_type
       and child.court_id is not distinct from parent.court_id), '[]'::jsonb)
  ) as extra_statistics
from grouped parent where parent.all_types=1;

revoke all on licitor_ingestion.diagnostic_price_enrichments from public, anon, authenticated, licitor_collector;
grant select on licitor_ingestion.diagnostic_price_enrichments to service_role;
comment on view licitor_ingestion.diagnostic_price_enrichments is
  'Private barometer enrichments: per-sale medians and mean ratio, quartiles, six exclusive bid bands, property types at n>=10. Requires a new reviewed immutable build before publication.';
