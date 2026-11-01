-- 20261110120400 (n° 12) : contrôle de santé « groupes de doublons inter-sources restants ».
--   * un groupe = des ventes visibles de même jour (Paris), même mise à prix, même ville normalisée, d'au moins deux
--     sources différentes ; deux lignes d'une même source, une vente non visible et un prix différent ne comptent pas ;
--   * l'alerte catalogue.duplicates.cross_source s'ouvre en avertissement au seuil, passe en critique au seuil critique,
--     et se ferme d'elle-même deux heures après le retour sous le seuil ;
--   * evaluate_operational_health garde ses appels précédents.
begin;

select plan(14);

-- Les fonctions ----------------------------------------------------------------------------------------------

select ok(
  (
    select bool_and(
      procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    )
    from pg_proc procedure_row
    where procedure_row.oid in (
      'app_private.cross_source_duplicate_groups()'::regprocedure,
      'app_private.evaluate_catalogue_duplicates_health(timestamptz)'::regprocedure
    )
  ),
  'the group listing and the evaluation are security definer, with an empty search_path, and reserved to service_role'
);

select is(
  app_private.cross_source_duplicate_thresholds(),
  '{"warning_groups": 100, "critical_groups": 200}'::jsonb,
  'the default thresholds are 100 groups (warning) and 200 groups (critical)'
);

select ok(
  position('perform app_private.evaluate_catalogue_duplicates_health(p_now);'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0
  and position('perform app_private.evaluate_flood_pepite_reference_health(p_now);'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0
  and position('auction_scenarios.snapshot.stale'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0,
  'evaluate_operational_health calls the duplicates evaluation and keeps the earlier ones'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
-- Toutes les ventes sont à venir (2099), visibles, avec des villes propres à ce test (suffixe 833).
--   g1 : Nîmes 833 / NIMES 833, même jour, même prix, deux sources         -> un groupe (ville normalisée)
--   g2 : Albi 833, deux sources, prix à 1 euro près (200000.40 et 200000.00) -> un groupe
--   g3 : Brest 833, deux lignes de la MÊME source                           -> aucun groupe
--   g4 : Dijon 833, deux sources mais la seconde vente est adjugée (invisible) -> aucun groupe
--   g5 : Lille 833, deux sources, prix différents                           -> aucun groupe
--   g6 : Metz 833, deux sources, jours différents                           -> aucun groupe
--   g7 : Tours 833, une seule vente                                         -> aucun groupe
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload
) values
  ('c8330000-1000-4000-8000-000000000001', 'pgtap-833-a', 'https://example.test/833/1a', 'Doublon 1a', 'Adresse 1a', 'Nîmes 833', '30', 'apartment', 100000, '2099-03-10 10:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 43.8367, 4.3601, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000002', 'pgtap-833-b', 'https://example.test/833/1b', 'Doublon 1b', 'Adresse 1b', 'NIMES 833', '30', 'apartment', 100000, '2099-03-10 14:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 43.8367, 4.3601, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000003', 'pgtap-833-a', 'https://example.test/833/2a', 'Doublon 2a', 'Adresse 2a', 'Albi 833', '81', 'house', 200000.40, '2099-03-11 10:00:00Z', 90, 'habitable', 4, 2, 1, 'upcoming', 43.9298, 2.1480, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000004', 'pgtap-833-b', 'https://example.test/833/2b', 'Doublon 2b', 'Adresse 2b', 'Albi 833', '81', 'house', 200000.00, '2099-03-11 11:00:00Z', 90, 'habitable', 4, 2, 1, 'upcoming', 43.9298, 2.1480, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000005', 'pgtap-833-a', 'https://example.test/833/3a', 'Même source 3a', 'Adresse 3a', 'Brest 833', '29', 'apartment', 150000, '2099-03-12 10:00:00Z', 40, 'habitable', 2, 1, 1, 'upcoming', 48.3904, -4.4861, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000006', 'pgtap-833-a', 'https://example.test/833/3b', 'Même source 3b', 'Adresse 3b', 'Brest 833', '29', 'apartment', 150000, '2099-03-12 10:00:00Z', 40, 'habitable', 2, 1, 1, 'upcoming', 48.3904, -4.4861, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000007', 'pgtap-833-a', 'https://example.test/833/4a', 'Invisible 4a', 'Adresse 4a', 'Dijon 833', '21', 'apartment', 120000, '2099-03-13 10:00:00Z', 45, 'habitable', 2, 1, 1, 'upcoming', 47.3220, 5.0415, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000008', 'pgtap-833-b', 'https://example.test/833/4b', 'Invisible 4b', 'Adresse 4b', 'Dijon 833', '21', 'apartment', 120000, '2099-03-13 10:00:00Z', 45, 'habitable', 2, 1, 1, 'adjudicated', 47.3220, 5.0415, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000009', 'pgtap-833-a', 'https://example.test/833/5a', 'Prix 5a', 'Adresse 5a', 'Lille 833', '59', 'apartment', 80000, '2099-03-14 10:00:00Z', 35, 'habitable', 1, 1, 1, 'upcoming', 50.6292, 3.0573, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-00000000000a', 'pgtap-833-b', 'https://example.test/833/5b', 'Prix 5b', 'Adresse 5b', 'Lille 833', '59', 'apartment', 85000, '2099-03-14 10:00:00Z', 35, 'habitable', 1, 1, 1, 'upcoming', 50.6292, 3.0573, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-00000000000b', 'pgtap-833-a', 'https://example.test/833/6a', 'Jour 6a', 'Adresse 6a', 'Metz 833', '57', 'apartment', 90000, '2099-03-15 10:00:00Z', 38, 'habitable', 2, 1, 1, 'upcoming', 49.1193, 6.1757, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-00000000000c', 'pgtap-833-b', 'https://example.test/833/6b', 'Jour 6b', 'Adresse 6b', 'Metz 833', '57', 'apartment', 90000, '2099-04-15 10:00:00Z', 38, 'habitable', 2, 1, 1, 'upcoming', 49.1193, 6.1757, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-00000000000d', 'pgtap-833-a', 'https://example.test/833/7a', 'Seule 7a', 'Adresse 7a', 'Tours 833', '37', 'apartment', 70000, '2099-03-16 10:00:00Z', 30, 'habitable', 1, 1, 1, 'upcoming', 47.3941, 0.6848, 'tribunal', 'pending', '{}'::jsonb);

-- Les groupes ----------------------------------------------------------------------------------------------------

select is(
  (select count(*)::integer from app_private.cross_source_duplicate_groups() where city_key like '% 833'),
  2,
  'two groups of visible sales from two sources share a day, a price and a city'
);

select is(
  (select city_key from app_private.cross_source_duplicate_groups() where city_key like 'nimes%'),
  'nimes 833',
  'the city is normalized: accents and case are ignored'
);

select is(
  (select line_count || '/' || source_count from app_private.cross_source_duplicate_groups() where city_key = 'nimes 833'),
  '2/2',
  'a group counts its lines and its distinct sources'
);

select is(
  (select line_count || '/' || source_count from app_private.cross_source_duplicate_groups() where city_key = 'albi 833'),
  '2/2',
  'a price within one euro is the same price'
);

select is(
  (select count(*)::integer from app_private.cross_source_duplicate_groups()
    where city_key in ('brest 833', 'dijon 833', 'lille 833', 'metz 833', 'tours 833')),
  0,
  'the same source twice, a sale that is not visible, another price, another day or a lone sale are not groups'
);

-- L'alerte : seuils par défaut (aucun groupe parasite, deux groupes d'essai < 100) --------------------------------

delete from public.operational_alerts;

select public.evaluate_operational_health('2026-11-10T10:00:00Z'::timestamptz);

select is(
  (select count(*)::integer from public.operational_alerts where alert_key = 'catalogue.duplicates.cross_source'),
  0,
  'under the default threshold of 100 groups, no alert is opened'
);

-- Seuils abaissés pour l'essai : avertissement à 2 groupes, critique à 4 --------------------------------------------

create or replace function app_private.cross_source_duplicate_thresholds()
returns jsonb
language sql
immutable
set search_path = ''
as $$ select '{"warning_groups": 2, "critical_groups": 4}'::jsonb; $$;

select public.evaluate_operational_health('2026-11-10T10:30:00Z'::timestamptz);

select ok(
  (
    select status = 'open' and severity = 'warning' and category = 'import'
      and (details ->> 'groups')::integer = (select count(*) from app_private.cross_source_duplicate_groups())
      and (details ->> 'lines')::integer = (select coalesce(sum(line_count), 0) from app_private.cross_source_duplicate_groups())
      and (details ->> 'warning_groups')::integer = 2
    from public.operational_alerts
    where alert_key = 'catalogue.duplicates.cross_source'
  ),
  'at the warning threshold the alert opens as a warning with the group and line counts'
);

-- Deux groupes de plus : critique
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload
) values
  ('c8330000-1000-4000-8000-000000000011', 'pgtap-833-a', 'https://example.test/833/8a', 'Doublon 8a', 'Adresse 8a', 'Pau 833', '64', 'apartment', 110000, '2099-05-10 10:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 43.2951, -0.3708, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000012', 'pgtap-833-b', 'https://example.test/833/8b', 'Doublon 8b', 'Adresse 8b', 'Pau 833', '64', 'apartment', 110000, '2099-05-10 10:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 43.2951, -0.3708, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000013', 'pgtap-833-a', 'https://example.test/833/9a', 'Doublon 9a', 'Adresse 9a', 'Agen 833', '47', 'apartment', 115000, '2099-05-11 10:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 44.2000, 0.6200, 'tribunal', 'pending', '{}'::jsonb),
  ('c8330000-1000-4000-8000-000000000014', 'pgtap-833-b', 'https://example.test/833/9b', 'Doublon 9b', 'Adresse 9b', 'Agen 833', '47', 'apartment', 115000, '2099-05-11 10:00:00Z', 50, 'habitable', 2, 1, 1, 'upcoming', 44.2000, 0.6200, 'tribunal', 'pending', '{}'::jsonb);

select public.evaluate_operational_health('2026-11-10T11:00:00Z'::timestamptz);

select ok(
  (
    select status = 'open' and severity = 'critical'
    from public.operational_alerts
    where alert_key = 'catalogue.duplicates.cross_source'
  ),
  'at the critical threshold the alert becomes critical'
);

-- Fusion : retour sous le seuil -> inactive, puis fermée deux heures plus tard ------------------------------------
-- Le déclencheur require_outcome_bridge_before_auction_sale_delete exige le pont vers l'Outcome Graph avant toute
-- suppression d'une vente (même méthode que 753 et 754) : le jeu d'essai (17 ventes) tient dans un lot de 25.
do $bridge$ begin perform public.bridge_auction_sales_to_outcome_graph_batch('c832ffff-ffff-4fff-8fff-ffffffffffff'::uuid, 25); end $bridge$;

delete from public.auction_sales
where id in (
  'c8330000-1000-4000-8000-000000000002', 'c8330000-1000-4000-8000-000000000004',
  'c8330000-1000-4000-8000-000000000012', 'c8330000-1000-4000-8000-000000000014'
);

select is(
  (select count(*)::integer from app_private.cross_source_duplicate_groups() where city_key like '% 833'),
  0,
  'once the duplicate lines are merged away no group is left'
);

select public.evaluate_operational_health('2026-11-10T11:30:00Z'::timestamptz);

select ok(
  (
    select status = 'open' and inactive_since is not null
    from public.operational_alerts
    where alert_key = 'catalogue.duplicates.cross_source'
  ),
  'under the threshold the alert becomes inactive (it stays open during the two-hour hysteresis)'
);

select public.evaluate_operational_health('2026-11-10T13:45:00Z'::timestamptz);

select is(
  (select status from public.operational_alerts where alert_key = 'catalogue.duplicates.cross_source'),
  'resolved',
  'the alert closes by itself two hours after the return under the threshold'
);

select * from finish();
rollback;
