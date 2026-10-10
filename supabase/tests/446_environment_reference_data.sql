begin;

select plan(12);

select ok(
  (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass),
  format('%s has row level security', t)
)
from unnest(array[
  'reference_communes',
  'commune_risk_profiles',
  'climate_stations',
  'climate_station_months'
]) as t;

select ok(
  not has_table_privilege(role, format('public.%I', t), 'select'),
  format('%s is not readable by %s', t, role)
)
from unnest(array[
  'reference_communes',
  'commune_risk_profiles',
  'climate_stations',
  'climate_station_months'
]) as t
cross join unnest(array['anon', 'authenticated']) as role;

select * from finish();

rollback;
