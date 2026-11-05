-- 20261111100000 (audit qualité du 03/11/2026) : sentinelle de qualité du catalogue.
--   * les mesures ne portent que sur les ventes en ligne (v_auction_sales_discovery) ;
--   * chambres >= pièces (plus d'une pièce), terrain avec pièces, lot Licitor discordant avec sa carte : invariants,
--     une vente suffit ; la carte « 27 742,81 € » est lue en euros, une carte illisible n'est jamais comptée ;
--   * prix au m² au-dessus de 30 000 € hors ventes reconnues ; part sans code postal au-dessus de 8 % à partir de
--     100 ventes en ligne ; ventes avec une pièce « incomplete » connue depuis plus de 3 jours au-dessus de 80 ;
--   * les alertes catalogue.quality.* s'ouvrent en avertissement (catégorie import) avec le nombre et des
--     identifiants en exemple, et se ferment deux heures après le retour sous le seuil ;
--   * un cliché par jour UTC dans auction_pipeline_observations (catalogue-quality) ;
--   * evaluate_operational_health garde ses appels précédents.
begin;

select plan(25);

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
      'app_private.catalogue_quality_metrics(timestamptz)'::regprocedure,
      'app_private.evaluate_catalogue_quality_health(timestamptz)'::regprocedure
    )
  ),
  'the metrics and the evaluation are security definer, with an empty search_path, and reserved to service_role'
);

select ok(
  has_function_privilege('service_role', 'app_private.catalogue_quality_thresholds()', 'execute')
  and not has_function_privilege('anon', 'app_private.catalogue_quality_thresholds()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.catalogue_quality_thresholds()', 'execute'),
  'the thresholds are reserved to service_role'
);

select is(
  app_private.catalogue_quality_thresholds(),
  '{
    "price_per_m2_max_eur": 30000,
    "price_per_m2_acknowledged_sale_ids": ["b13dcf59-fa8a-42d5-8c5b-a0de982994cf"],
    "missing_postal_code_ratio_max": 0.08,
    "ratio_minimum_live_sales": 100,
    "documents_incomplete_minimum_age_days": 3,
    "documents_incomplete_max_sales": 80,
    "example_limit": 5
  }'::jsonb,
  'the default thresholds: 30 000 €/m² (Cap-Ferrat acknowledged), 8 % from 100 live sales, 80 sales after 3 days'
);

select ok(
  position('perform app_private.evaluate_catalogue_quality_health(p_now);'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0
  and position('perform app_private.evaluate_catalogue_duplicates_health(p_now);'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0
  and position('perform app_private.evaluate_flood_pepite_reference_health(p_now);'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0
  and position('auction_scenarios.snapshot.stale'
    in pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0,
  'evaluate_operational_health calls the catalogue quality evaluation and keeps the earlier ones'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
-- Ventes en ligne (2099, à venir), par défaut un appartement propre : 69001, libre, 50 m² habitables, 100 000 €,
-- 3 pièces dont 2 chambres. Seul ce qui diffère est donné.
--   01 propre                                   10 Licitor 80 000 €, carte « 80 000 € »           (concorde)
--   02 3 pièces, 3 chambres        -> invariant 11 Licitor, carte « Voir l'annonce »              (illisible)
--   03 1 pièce, 1 chambre (studio) -> rien      12 Licitor sans carte
--   04 terrain avec 2 pièces       -> invariant 13 sans code postal
--   05 terrain sans pièces         -> rien      14 code postal vide
--   06 2 000 000 € / 50 m² = 40 000 €/m²        15 maison sans surface, occupation nulle
--   07 3 500 000 € / 100 m² = 35 000 €/m²       16 occupation inconnue, pièce incomplete de 5 jours
--   08 Licitor 90 000 €, carte « 80 000 € »     17 pièce incomplete d'un jour, pièce lue ancienne
--   09 Licitor 27 742,81 €, carte « 27 742,81 € » (concorde)
--   19 vente adjugée (hors ligne) : terrain avec pièces, chambres >= pièces -> jamais comptée
create temporary table quality_fixture (
  suffix text primary key,
  source_name text not null default 'pgtap-872',
  property_type text not null default 'apartment',
  starting_price_eur numeric not null default 100000,
  habitable_surface_m2 numeric default 50,
  surface_m2 numeric,
  rooms_count integer default 3,
  bedrooms_count integer default 2,
  postal_code text default '69001',
  occupancy_status text default 'vacant',
  status text not null default 'upcoming',
  raw_payload jsonb not null default '{}'::jsonb
) on commit drop;

insert into quality_fixture (suffix) values ('01');
insert into quality_fixture (suffix, rooms_count, bedrooms_count) values ('02', 3, 3), ('03', 1, 1);
insert into quality_fixture (suffix, property_type, starting_price_eur, habitable_surface_m2, surface_m2, rooms_count, bedrooms_count)
values ('04', 'land', 20000, null, 1000, 2, null), ('05', 'land', 20000, null, 1000, null, null);
insert into quality_fixture (suffix, starting_price_eur, habitable_surface_m2) values ('06', 2000000, 50), ('07', 3500000, 100);
insert into quality_fixture (suffix, source_name, starting_price_eur, raw_payload) values
  ('08', 'licitor', 90000, '{"source_lots": [{"starting_price_eur": "80 000 €"}]}'),
  ('09', 'licitor', 27742.81, '{"source_lots": [{"starting_price_eur": "27 742,81 €"}]}'),
  ('10', 'licitor', 80000, '{"source_lots": [{"starting_price_eur": "80 000 €"}, {"starting_price_eur": "7 000 €"}]}'),
  ('11', 'licitor', 50000, '{"source_lots": [{"starting_price_eur": "Voir l''annonce"}]}'),
  ('12', 'licitor', 50000, '{}');
insert into quality_fixture (suffix, postal_code) values ('13', null), ('14', ' ');
insert into quality_fixture (suffix, property_type, habitable_surface_m2, occupancy_status) values ('15', 'house', null, null);
insert into quality_fixture (suffix, occupancy_status) values ('16', 'unknown'), ('17', 'vacant');
insert into quality_fixture (suffix, property_type, rooms_count, bedrooms_count, status)
values ('19', 'land', 3, 3, 'adjudicated');

insert into public.auction_sales (
  id, source_name, source_url, title, address, city, postal_code, department, property_type,
  starting_price_eur, sale_date, habitable_surface_m2, surface_m2, rooms_count, bedrooms_count,
  occupancy_status, status, latitude, longitude, sale_venue_type, sale_verification_status, raw_payload
)
select
  ('c8720000-1000-4000-8000-0000000000' || fixture.suffix)::uuid,
  fixture.source_name,
  'https://example.test/872/' || fixture.suffix,
  'Qualité ' || fixture.suffix,
  'Adresse ' || fixture.suffix,
  'Lyon 872',
  fixture.postal_code,
  '69',
  fixture.property_type,
  fixture.starting_price_eur,
  '2099-03-10 10:00:00Z'::timestamptz,
  fixture.habitable_surface_m2,
  fixture.surface_m2,
  fixture.rooms_count,
  fixture.bedrooms_count,
  fixture.occupancy_status,
  fixture.status,
  45.7640,
  4.8357,
  'tribunal',
  'pending',
  fixture.raw_payload
from quality_fixture fixture;

insert into public.auction_documents (source_url, document_url, extraction_status, created_at) values
  ('https://example.test/872/16', 'https://example.test/872/16.pdf', 'incomplete', '2026-11-05T10:00:00Z'),
  ('https://example.test/872/17', 'https://example.test/872/17a.pdf', 'incomplete', '2026-11-09T10:00:00Z'),
  ('https://example.test/872/17', 'https://example.test/872/17b.pdf', 'extracted', '2026-10-01T10:00:00Z'),
  ('https://example.test/872/19', 'https://example.test/872/19.pdf', 'incomplete', '2026-10-01T10:00:00Z');

-- Les mesures (seuils par défaut) -------------------------------------------------------------------------------

create temporary table quality_metrics on commit drop as
select app_private.catalogue_quality_metrics('2026-11-10T10:00:00Z'::timestamptz) as value;

select is(
  (select (value ->> 'live_sales')::integer from quality_metrics),
  17,
  'only the live sales are measured (the adjudicated sale is left out)'
);

select is(
  (select value -> 'metrics' -> 'bedrooms_ge_rooms' from quality_metrics),
  '{"count": 1, "example_sale_ids": ["c8720000-1000-4000-8000-000000000002"]}'::jsonb,
  'bedrooms >= rooms counts a 3-room sale with 3 bedrooms, not a studio'
);

select is(
  (select value -> 'metrics' -> 'land_with_rooms' from quality_metrics),
  '{"count": 1, "example_sale_ids": ["c8720000-1000-4000-8000-000000000004"]}'::jsonb,
  'a land with a room count is counted, a land without rooms is not'
);

select is(
  (select value -> 'metrics' -> 'price_per_m2_implausible' from quality_metrics),
  '{"count": 2, "acknowledged": 0, "highest_eur_per_m2": 40000,
    "example_sale_ids": ["c8720000-1000-4000-8000-000000000006", "c8720000-1000-4000-8000-000000000007"]}'::jsonb,
  'the sales above 30 000 €/m² are counted, highest first'
);

select is(
  (select value -> 'metrics' -> 'licitor_lot_mismatch' from quality_metrics),
  '{"count": 1, "licitor_live": 5, "without_card": 1, "unreadable_card": 1,
    "example_sale_ids": ["c8720000-1000-4000-8000-000000000008"]}'::jsonb,
  'a Licitor price that differs from its own card is a mismatch; cents, a second card, no card or an unreadable card are not'
);

select is(
  (select (value -> 'metrics' -> 'missing_postal_code_ratio') - 'example_sale_ids' from quality_metrics),
  '{"count": 2, "population": 17, "ratio": 0.1176}'::jsonb,
  'a null or blank postal code is missing'
);

select is(
  (select value -> 'metrics' -> 'dwelling_without_surface_ratio' from quality_metrics),
  '{"count": 1, "population": 15, "ratio": 0.0667}'::jsonb,
  'the share of houses and apartments without a surface is measured among dwellings'
);

select is(
  (select value -> 'metrics' -> 'occupancy_unknown_ratio' from quality_metrics),
  '{"count": 2, "population": 17, "ratio": 0.1176}'::jsonb,
  'a null or unknown occupancy is unknown'
);

select is(
  (select value -> 'metrics' -> 'documents_incomplete' from quality_metrics),
  '{"count": 1, "example_sale_ids": ["c8720000-1000-4000-8000-000000000016"]}'::jsonb,
  'only a live sale with a document incomplete for more than 3 days is counted'
);

-- Les alertes, seuils par défaut --------------------------------------------------------------------------------

delete from public.operational_alerts;
delete from public.auction_pipeline_observations where source_name = 'catalogue-quality';

select public.evaluate_operational_health('2026-11-10T10:00:00Z'::timestamptz);

select is(
  (
    select array_agg(alert_key order by alert_key)
    from public.operational_alerts
    where alert_key like 'catalogue.quality.%' and status = 'open'
  ),
  array[
    'catalogue.quality.bedrooms_ge_rooms',
    'catalogue.quality.land_with_rooms',
    'catalogue.quality.licitor_lot_mismatch',
    'catalogue.quality.price_per_m2_implausible'
  ],
  'the invariants and the price per m² open; the ratio (under 100 live sales) and the documents (under 80) do not'
);

select ok(
  (
    select bool_and(severity = 'warning' and category = 'import' and notification_event = 'opened')
    from public.operational_alerts
    where alert_key like 'catalogue.quality.%'
  ),
  'every catalogue quality alert is an import warning, queued for notification'
);

select is(
  (
    select details
    from public.operational_alerts
    where alert_key = 'catalogue.quality.licitor_lot_mismatch'
  ),
  '{"count": 1, "licitor_live": 5, "without_card": 1, "unreadable_card": 1, "live_sales": 17, "maximum_count": 0,
    "example_sale_ids": ["c8720000-1000-4000-8000-000000000008"]}'::jsonb,
  'the details carry the count, the threshold and example sale ids'
);

select is(
  (
    select count(*)::integer
    from public.auction_pipeline_observations
    where source_name = 'catalogue-quality'
      and (metrics ->> 'live_sales')::integer = 17
      and metrics -> 'metrics' ? 'occupancy_unknown_ratio'
      and metrics ? 'thresholds'
  ),
  1,
  'a snapshot of every metric is recorded'
);

-- Seuils abaissés pour l'essai : part dès 10 ventes au-delà de 10 %, pièces au-delà de 0, vente 07 reconnue ------

create or replace function app_private.catalogue_quality_thresholds()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "price_per_m2_max_eur": 30000,
    "price_per_m2_acknowledged_sale_ids": ["c8720000-1000-4000-8000-000000000007"],
    "missing_postal_code_ratio_max": 0.1,
    "ratio_minimum_live_sales": 10,
    "documents_incomplete_minimum_age_days": 3,
    "documents_incomplete_max_sales": 0,
    "example_limit": 5
  }'::jsonb;
$$;

select public.evaluate_operational_health('2026-11-10T10:30:00Z'::timestamptz);

select ok(
  (
    select status = 'open' and (details ->> 'ratio')::numeric = 0.1176 and (details ->> 'maximum_ratio')::numeric = 0.1
    from public.operational_alerts
    where alert_key = 'catalogue.quality.missing_postal_code_ratio'
  )
  and (
    select status = 'open' and (details ->> 'count')::integer = 1
    from public.operational_alerts
    where alert_key = 'catalogue.quality.documents_incomplete'
  ),
  'above their thresholds the postal code ratio and the incomplete documents open'
);

select is(
  (
    select (details ->> 'count')::integer || '/' || (details ->> 'acknowledged')::integer
    from public.operational_alerts
    where alert_key = 'catalogue.quality.price_per_m2_implausible'
  ),
  '1/1',
  'an acknowledged sale is no longer counted, only reported as acknowledged'
);

select is(
  (
    select count(*)::integer
    from public.auction_pipeline_observations
    where source_name = 'catalogue-quality'
  ),
  1,
  'a second evaluation on the same UTC day adds no snapshot'
);

-- Réparation : retour sous tous les seuils -> inactives, puis fermées deux heures plus tard ---------------------

update public.auction_sales set bedrooms_count = 2 where id = 'c8720000-1000-4000-8000-000000000002';
update public.auction_sales set rooms_count = null where id = 'c8720000-1000-4000-8000-000000000004';
update public.auction_sales set starting_price_eur = 200000 where id = 'c8720000-1000-4000-8000-000000000006';
update public.auction_sales set starting_price_eur = 80000 where id = 'c8720000-1000-4000-8000-000000000008';
update public.auction_sales set postal_code = '69002'
where id in ('c8720000-1000-4000-8000-000000000013', 'c8720000-1000-4000-8000-000000000014');
update public.auction_documents set extraction_status = 'extracted'
where document_url = 'https://example.test/872/16.pdf';

select public.evaluate_operational_health('2026-11-10T11:00:00Z'::timestamptz);

select ok(
  (
    select bool_and(status = 'open' and inactive_since is not null) and count(*) = 6
    from public.operational_alerts
    where alert_key like 'catalogue.quality.%'
  ),
  'under the thresholds the alerts become inactive (they stay open during the two-hour hysteresis)'
);

select public.evaluate_operational_health('2026-11-10T13:15:00Z'::timestamptz);

select ok(
  (
    select bool_and(status = 'resolved' and notification_event = 'resolved') and count(*) = 6
    from public.operational_alerts
    where alert_key like 'catalogue.quality.%'
  ),
  'the alerts close by themselves two hours after the return under the thresholds'
);

select is(
  (
    select value
    from (select app_private.catalogue_quality_metrics('2026-11-10T13:15:00Z'::timestamptz) as value) repaired
  ) -> 'metrics' -> 'licitor_lot_mismatch' ->> 'count',
  '0',
  'the repaired Licitor sale matches its card'
);

-- Le lendemain, un nouveau cliché ----------------------------------------------------------------------------------

select public.evaluate_operational_health('2026-11-11T10:00:00Z'::timestamptz);

select is(
  (
    select count(*)::integer
    from public.auction_pipeline_observations
    where source_name = 'catalogue-quality'
  ),
  2,
  'the next UTC day records a new snapshot'
);

select is(
  (
    select (metrics -> 'metrics' -> 'bedrooms_ge_rooms' ->> 'count')::integer
    from public.auction_pipeline_observations
    where source_name = 'catalogue-quality'
    order by observed_at desc
    limit 1
  ),
  0,
  'the latest snapshot holds the repaired values'
);

select * from finish();
rollback;
