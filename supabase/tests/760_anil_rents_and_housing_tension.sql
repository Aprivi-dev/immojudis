begin;

select plan(33);

-- Private reference tables: RLS on, no right for anon or authenticated, full rights for the service role.
select ok(
  (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass),
  format('%s has row level security', t)
)
from unnest(array['anil_rents', 'commune_housing_tension']) as t;

select ok(
  not has_table_privilege(role, format('public.%I', t), privilege),
  format('%s has no %s right on %s', role, privilege, t)
)
from unnest(array['anil_rents', 'commune_housing_tension']) as t
cross join unnest(array['anon', 'authenticated']) as role
cross join unnest(array['select', 'insert', 'update', 'delete']) as privilege;

select ok(
  has_table_privilege('service_role', format('public.%I', t), privilege),
  format('service_role has %s on %s', privilege, t)
)
from unnest(array['anil_rents', 'commune_housing_tension']) as t
cross join unnest(array['select', 'insert', 'update', 'delete']) as privilege;

-- The sources registry gained the frequency and the credit the licence imposes.
select has_column('public', 'data_sources', 'update_frequency', 'data_sources has update_frequency');
select has_column('public', 'data_sources', 'attribution_notice', 'data_sources has attribution_notice');

-- Both sources are registered, manual and inactive, pending legal review, with their licence and credit.
select results_eq(
  $$
    select name, license, ingestion_policy, legal_review_status, active
    from public.data_sources
    where name in ('anil_rent_map', 'tlv_zoning')
    order by name
  $$,
  $$
    values
      ('anil_rent_map'::text, 'Licence Ouverte / Open Licence 2.0'::text, 'allowed_manual'::text, 'pending'::text, false),
      ('tlv_zoning'::text, 'Licence Ouverte / Open Licence 2.0'::text, 'allowed_manual'::text, 'pending'::text, false)
  $$,
  'both sources are registered as manual, pending review and inactive'
);

select is(
  (select attribution_notice from public.data_sources where name = 'anil_rent_map'),
  'Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin',
  'the ANIL credit is registered'
);

select ok(
  (select update_frequency is not null from public.data_sources where name = 'tlv_zoning'),
  'the zoning update frequency is registered'
);

-- The constraints keep a broken line out.
select throws_ok(
  $$
    insert into public.anil_rents (
      commune_code, segment, commune_name, department_code, rent_per_m2, prediction_type, vintage, source_url
    ) values ('33063', 'studio', 'Bordeaux', '33', 15, 'commune', 2025, 'https://example.test/a.csv')
  $$,
  '23514',
  null,
  'anil_rents refuses an unknown segment'
);

select throws_ok(
  $$
    insert into public.commune_housing_tension (
      commune_code, commune_name, department_code, zoning_2013, zoning_2023, zoning_post_decree,
      decree_reference, source_url
    ) values ('33063', 'Bordeaux', '33', 'tlv', 'tendue', 'autre', 'Décret n° 2025-1267', 'https://example.test/z.csv')
  $$,
  '23514',
  null,
  'commune_housing_tension refuses an unknown zoning'
);

select * from finish();

rollback;
