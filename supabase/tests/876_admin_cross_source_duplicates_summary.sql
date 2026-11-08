-- 20261112100100 (D12, affichage) : résumé des doublons inter-sources pour le panneau « Contrôles qualité ».
--   * service_role seul, security definer, search_path vide ;
--   * même définition que app_private.cross_source_duplicate_groups (groupes, lignes) et mêmes seuils (100 / 200) ;
--   * les groupes à trois sources ou plus sont comptés et listés ; la fonction n'écrit rien.
begin;

select plan(7);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.admin_cross_source_duplicates_summary(integer)'::regprocedure
  ),
  'the summary is security definer, with an empty search_path, and reserved to service_role'
);

-- Jeu d'essai : villes propres à ce test (suffixe 874), toutes à venir et visibles.
--   Rodez 874 : trois sources, même jour, même prix -> un groupe à trois sources (3 lignes)
--   Sète 874  : deux sources                          -> un groupe à deux sources (2 lignes)
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload
) values
  ('c8740000-1000-4000-8000-000000000001', 'pgtap-874-a', 'https://example.test/874/1a', 'Rodez a', 'Adresse 1a', 'Rodez 874', '12', 'apartment', 95000, '2099-05-10 10:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 44.3506, 2.5750, 'tribunal', 'pending', '{}'::jsonb),
  ('c8740000-1000-4000-8000-000000000002', 'pgtap-874-b', 'https://example.test/874/1b', 'Rodez b', 'Adresse 1b', 'RODEZ 874', '12', 'apartment', 95000, '2099-05-10 11:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 44.3506, 2.5750, 'tribunal', 'pending', '{}'::jsonb),
  ('c8740000-1000-4000-8000-000000000003', 'pgtap-874-c', 'https://example.test/874/1c', 'Rodez c', 'Adresse 1c', 'Rodez 874', '12', 'apartment', 95000, '2099-05-10 12:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 44.3506, 2.5750, 'tribunal', 'pending', '{}'::jsonb),
  ('c8740000-1000-4000-8000-000000000004', 'pgtap-874-a', 'https://example.test/874/2a', 'Sète a', 'Adresse 2a', 'Sète 874', '34', 'house', 180000, '2099-05-11 10:00:00Z', 90, 'habitable', 4, 2, 1, 'upcoming', 43.4028, 3.6928, 'tribunal', 'pending', '{}'::jsonb),
  ('c8740000-1000-4000-8000-000000000005', 'pgtap-874-b', 'https://example.test/874/2b', 'Sète b', 'Adresse 2b', 'Sete 874', '34', 'house', 180000, '2099-05-11 15:00:00Z', 90, 'habitable', 4, 2, 1, 'upcoming', 43.4028, 3.6928, 'tribunal', 'pending', '{}'::jsonb);

select is(
  (public.admin_cross_source_duplicates_summary() ->> 'groups')::integer,
  (select count(*)::integer from app_private.cross_source_duplicate_groups()),
  'the number of groups is the one of the alert definition'
);

select is(
  (public.admin_cross_source_duplicates_summary() ->> 'lines')::integer,
  (select coalesce(sum(line_count), 0)::integer from app_private.cross_source_duplicate_groups()),
  'the number of lines is the one of the alert definition'
);

select is(
  public.admin_cross_source_duplicates_summary() -> 'thresholds',
  '{"warning_groups": 100, "critical_groups": 200}'::jsonb,
  'the thresholds of the alert are unchanged (100 and 200 groups)'
);

select ok(
  (public.admin_cross_source_duplicates_summary() ->> 'three_source_groups')::integer >= 1,
  'a group with three sources is counted'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(public.admin_cross_source_duplicates_summary(100) -> 'three_source_examples') example
    where example ->> 'city_key' = 'rodez 874'
      and (example ->> 'source_count')::integer = 3
      and (example ->> 'line_count')::integer = 3
  )
  and not exists (
    select 1
    from jsonb_array_elements(public.admin_cross_source_duplicates_summary(100) -> 'three_source_examples') example
    where example ->> 'city_key' = 'sete 874'
  ),
  'the three-source groups are listed, two-source groups are not'
);

select is(
  jsonb_array_length(public.admin_cross_source_duplicates_summary(1) -> 'three_source_examples') <= 1,
  true,
  'the listing follows the requested limit'
);

select * from finish();
rollback;
