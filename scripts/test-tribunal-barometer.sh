#!/usr/bin/env bash
# Exercise the actual migration against isolated PostgreSQL fixtures. No remote DB.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_dir="$(mktemp -d "${TMPDIR:-/tmp}/immojudis-barometer-db.XXXXXX")"
port=55443
cleanup() {
  pg_ctl -D "$db_dir" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$db_dir"
}
trap cleanup EXIT
initdb -D "$db_dir" -A trust -U postgres >/dev/null
pg_ctl -D "$db_dir" -o "-k $db_dir -p $port -h '' -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap" -l "$db_dir/server.log" start >/dev/null
psql -h "$db_dir" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<SQL
create role anon;
create role authenticated;
create role licitor_collector;
create role service_role;
create schema licitor_ingestion;
create table licitor_ingestion.statistics_eligible_candidates (payload jsonb);
create table licitor_ingestion.diagnostic_court_mappings (
  raw_tribunal_label text, court_id uuid, court_code text, court_name text,
  judicial_region text, mapping_status text
);
insert into licitor_ingestion.diagnostic_court_mappings values
  ('Paris historique', '00000000-0000-4000-8000-000000000001', 'paris', 'TJ Paris', 'Paris', 'unique_verified_historical_alias'),
  ('Ambigu', '00000000-0000-4000-8000-000000000002', 'ambigu', 'Ambigu', 'Paris', 'ambiguous');
-- Twelve apartments at exact band boundaries, with known hand-calculated median.
insert into licitor_ingestion.statistics_eligible_candidates
select jsonb_build_object('tribunal', 'Paris historique', 'property_type', 'apartment',
  'starting_price_eur', 100000, 'adjudication_price_eur', price, 'sale_venue_type', 'tribunal')
from unnest(array[50000,100000,125000,150000,200000,300000]) price cross join generate_series(1,2);
-- Unpublishable subgroups still belong to the parent denominator.
insert into licitor_ingestion.statistics_eligible_candidates
select jsonb_build_object('tribunal', 'Paris historique', 'property_type', 'house',
  'starting_price_eur', 100000, 'adjudication_price_eur', 100000) from generate_series(1,9);
-- An ambiguous court contributes only to the national cohort.
insert into licitor_ingestion.statistics_eligible_candidates values
 ('{"tribunal":"Ambigu","property_type":"unknown","starting_price_eur":100000,"adjudication_price_eur":150000}');
-- None of the following may enter either cohort.
insert into licitor_ingestion.statistics_eligible_candidates values
 ('{"tribunal":"Paris historique","starting_price_eur":1000,"adjudication_price_eur":5000}'),
 ('{"tribunal":"Paris historique","starting_price_eur":100000,"adjudication_price_eur":0}'),
 ('{"tribunal":"Paris historique","starting_price_eur":"bad","adjudication_price_eur":100000}'),
 ('{"tribunal":"Paris historique","starting_price_eur":100000,"adjudication_price_eur":200000,"sale_venue_type":"notary"}'),
 ('{"tribunal":"Paris historique","starting_price_eur":100000,"adjudication_price_eur":200000,"quality_flags":["source_result_changed_pending_review"]}');
\i '$repo_root/supabase/migrations/20261003100950_tribunal_barometer_enrichment.sql'
do \$test\$
declare national jsonb; local_stats jsonb; apartment jsonb;
begin
  select extra_statistics into national from licitor_ingestion.diagnostic_price_enrichments where scope_type='national';
  select extra_statistics into local_stats from licitor_ingestion.diagnostic_price_enrichments where scope_type='tribunal';
  if (national#>>'{distribution,sampleSize}')::int <> 22 or (local_stats#>>'{distribution,sampleSize}')::int <> 21 then
    raise exception 'Cohort eligibility or exact court mapping is wrong';
  end if;
  if jsonb_array_length(local_stats->'propertyTypes') <> 1 then raise exception 'Subthreshold type was published'; end if;
  apartment := local_stats#>'{propertyTypes,0,distribution}';
  if (apartment#>>'{summary,medianHammerPriceEur}')::numeric <> 137500 or
     (apartment#>>'{summary,medianHammerToStartingRatio}')::numeric <> 1.375 or
     (apartment#>>'{summary,meanHammerToStartingRatio}')::numeric <> 1.5417 then
    raise exception 'Per-sale aggregation is incorrect';
  end if;
  if exists (select 1 from jsonb_array_elements(apartment->'detailedBidDistribution') b
    where (b->>'count')::int <> 2 or abs((b->>'share')::numeric - 2.0/12) > .000001) then
    raise exception 'Band boundary or denominator is incorrect';
  end if;
  if has_table_privilege('anon', 'licitor_ingestion.diagnostic_price_enrichments', 'SELECT') or
     has_table_privilege('authenticated', 'licitor_ingestion.diagnostic_price_enrichments', 'SELECT') or
     has_table_privilege('licitor_collector', 'licitor_ingestion.diagnostic_price_enrichments', 'SELECT') then
    raise exception 'Private statistics exposed';
  end if;
  if not has_table_privilege('service_role', 'licitor_ingestion.diagnostic_price_enrichments', 'SELECT') or
     not exists (select 1 from pg_class where oid='licitor_ingestion.diagnostic_price_enrichments'::regclass
       and reloptions @> array['security_invoker=true']) then raise exception 'Invoker view protection missing'; end if;
end
\$test\$;
SQL
printf 'Barometer SQL: cohort, thresholds, aliases, medians, six band boundaries and private access verified.\n'
