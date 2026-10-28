-- Médiane des loyers ANIL par département (migration 20261108120300) : repli départemental calculé.
begin;

select plan(6);

insert into public.anil_rents (
  commune_code, segment, commune_name, department_code, rent_per_m2, prediction_type, vintage, source_updated_on, source_url
) values
  ('23001', 'apt_all', 'A', '23', 7, 'commune', 2025, '2025-12-11', 'https://example.test/anil'),
  ('23002', 'apt_all', 'B', '23', 9, 'commune', 2025, '2025-12-11', 'https://example.test/anil'),
  ('23003', 'apt_all', 'C', '23', 8, 'maille', 2025, '2025-12-11', 'https://example.test/anil'),
  ('23004', 'apt_all', 'D', '23', 20, 'epci', 2025, '2025-12-11', 'https://example.test/anil'),
  ('23001', 'house', 'A', '23', 6, 'commune', 2025, '2025-12-11', 'https://example.test/anil'),
  ('2A004', 'apt_all', 'Ajaccio', '2A', 15, 'commune', 2025, '2025-12-11', 'https://example.test/anil');

select results_eq(
  $$ select segment, rent_per_m2, communes, vintage from public.anil_department_medians(array['23']) order by segment $$,
  $$ values ('apt_all'::text, 8.5::numeric, 4, 2025::smallint), ('house'::text, 6::numeric, 1, 2025::smallint) $$,
  'the median is computed per department and segment, with the vintage of the map'
);
select is(
  (select source_updated_on from public.anil_department_medians(array['23']) where segment = 'apt_all'),
  '2025-12-11'::date,
  'the publication date of the map is returned'
);
select is(
  (select rent_per_m2 from public.anil_department_medians(array['2A'])),
  15::numeric,
  'Corsica, absent from the hard-coded table, has a median'
);
select is(
  (select count(*) from public.anil_department_medians(array['976', '99'])),
  0::bigint,
  'a department without ANIL line (Mayotte is excluded from the map) has no median'
);
select is(
  (select count(*) from public.anil_department_medians(array(select '23' from generate_series(1, 111)))),
  0::bigint,
  'more than 110 departments at once are refused (empty answer)'
);
select ok(
  has_function_privilege('service_role', 'public.anil_department_medians(text[])', 'execute')
  and not has_function_privilege('anon', 'public.anil_department_medians(text[])', 'execute')
  and not has_function_privilege('authenticated', 'public.anil_department_medians(text[])', 'execute'),
  'only the service role can run anil_department_medians'
);

select * from finish();

rollback;
