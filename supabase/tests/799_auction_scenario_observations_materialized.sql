-- « Scénarios d'enchères » (migration 20261108204000) : la vue des lots calcule la correspondance des libellés de
-- tribunaux et le ressort de chaque tribunal une seule fois (CTE matérialisés). Elle doit rendre exactement les
-- mêmes lignes que la définition de 20261101120100, et le cliché doit se recopier. La définition RÉELLE de la
-- migration est rejouée sur des tables de test (comme le test 673) et comparée, ligne pour ligne (doublons
-- compris), à l'ancienne définition recopiée ci-dessous sur les mêmes tables.
begin;
select plan(11);

create table public.pgtap_799_candidates (payload jsonb not null);
create table public.pgtap_799_mappings (
  raw_tribunal_label text not null,
  court_code text not null,
  mapping_status text not null
);

-- Ancienne définition (20261101120100), sources remplacées par les tables de test.
create view public.pgtap_799_old_observations as
select
  mapping.court_code,
  coalesce(nullif(btrim(candidate.payload->>'property_type'), ''), 'other') as property_type,
  (candidate.payload->>'starting_price_eur')::numeric as starting_price_eur,
  (candidate.payload->>'adjudication_price_eur')::numeric as hammer_price_eur,
  (candidate.payload->>'sale_date')::date as sale_date
from public.pgtap_799_candidates candidate
left join (
  select court_mapping.raw_tribunal_label, min(court_mapping.court_code) as court_code
  from public.pgtap_799_mappings court_mapping
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
  and (candidate.payload->>'adjudication_price_eur')::numeric
    >= 0.5 * (candidate.payload->>'starting_price_eur')::numeric
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

-- La vue réelle, rejouée sur les tables de test.
do $$
declare
  v_definition text := pg_catalog.pg_get_viewdef('app_private.auction_scenario_observations'::regclass);
begin
  create temporary table pgtap_799_definition on commit drop as select v_definition as definition;
  v_definition := replace(
    v_definition, 'licitor_ingestion.statistics_eligible_candidates', 'public.pgtap_799_candidates'
  );
  v_definition := replace(
    v_definition, 'licitor_ingestion.diagnostic_court_mappings', 'public.pgtap_799_mappings'
  );
  execute 'create or replace view app_private.auction_scenario_observations as ' || v_definition;
end;
$$;

select is(
  (select (length(definition) - length(replace(upper(definition), 'AS MATERIALIZED', ''))) / length('AS MATERIALIZED')
   from pgtap_799_definition),
  2,
  'the view computes the court mapping and the court''s ressort once each (two materialized CTEs)'
);

insert into public.pgtap_799_mappings (raw_tribunal_label, court_code, mapping_status) values
  ('Tribunal A (test)', 'tj_799_a', 'unique_official_name_contained'),
  ('Tribunal A (test)', 'tj_799_a', 'unique_official_name_contained'),
  ('Tribunal B (test)', 'tj_799_b', 'unique_verified_historical_alias'),
  -- Libellé rattaché à deux tribunaux : ambigu, écarté de la correspondance.
  ('Tribunal C (test)', 'tj_799_a', 'unique_official_name_contained'),
  ('Tribunal C (test)', 'tj_799_b', 'unique_official_name_contained'),
  -- Statut non retenu.
  ('Tribunal D (test)', 'tj_799_a', 'ambiguous');

-- Ressort de tj_799_a : Gironde et Dordogne (avec une répétition). tj_799_b n'a aucune adjudication DVF.
insert into public.dvf_court_adjudications (
  mutation_id, mutation_date, insee_code, department, court_code, property_type, price_eur, source_year
) values
  ('pgtap-799-1', current_date - 100, '33063', '33', 'tj_799_a', 'apartment', 100000, 2026),
  ('pgtap-799-2', current_date - 101, '33064', '33', 'tj_799_a', 'apartment', 100000, 2026),
  ('pgtap-799-3', current_date - 102, '24037', '24', 'tj_799_a', 'house', 100000, 2026);

insert into public.pgtap_799_candidates (payload)
select jsonb_build_object(
  'property_type', 'apartment',
  'sale_date', coalesce(row_data.sale_date, (current_date - 30)::text),
  'starting_price_eur', row_data.starting::text,
  'adjudication_price_eur', row_data.hammer::text
)
  || case when row_data.label is null then '{}'::jsonb else jsonb_build_object('tribunal', row_data.label) end
  || case when row_data.department is null then '{}'::jsonb else jsonb_build_object('department', row_data.department) end
  || case when row_data.flag is null then '{}'::jsonb else jsonb_build_object('quality_flags', jsonb_build_array(row_data.flag)) end
  || case when row_data.venue is null then '{}'::jsonb else jsonb_build_object('sale_venue_type', row_data.venue) end
from (values
  ('Tribunal A (test)', 50000, 100000, '33', null, null, null),            -- conservé
  ('Tribunal A (test)', 50000, 100000, '33', null, null, null),            -- doublon exact : conservé deux fois
  ('Tribunal A (test)', 60000, 90000, '24', null, null, null),             -- conservé
  ('Tribunal A (test)', 50000, 90000, '75', null, null, null),             -- hors ressort : écarté
  ('Tribunal A (test)', 50000, 80000, null, null, null, null),             -- sans département : conservé
  ('Tribunal A (test)', 50000, 70000, ' 24 ', null, null, null),           -- département à nettoyer : conservé
  ('Tribunal A (test)', 50000, 20000, '33', null, null, null),             -- ratio 0,4 : écarté
  ('Tribunal A (test)', 50000, 25000, '33', null, null, null),             -- ratio 0,5 : conservé
  ('Tribunal B (test)', 50000, 70000, '99', null, null, null),             -- tribunal sans ressort connu : conservé
  ('Tribunal C (test)', 50000, 70000, '75', null, null, null),             -- libellé ambigu : conservé sans tribunal
  ('Tribunal D (test)', 40000, 50000, '33', null, null, null),             -- statut non retenu : sans tribunal
  ('Tribunal E (test)', 40000, 55000, '33', null, null, null),             -- libellé inconnu : sans tribunal
  ('Tribunal A (test)', 1000, 5000, '33', null, null, null),               -- mise à prix non supérieure à 1 000 : écarté
  ('Tribunal A (test)', 50000, 70000, '33', 'cached_reparse_failed', null, null),  -- drapeau de qualité : écarté
  ('Tribunal A (test)', 50000, 70000, '33', null, 'amiable', null),        -- hors tribunal : écarté
  ('Tribunal A (test)', 50000, 70000, '33', null, null, 'pas-une-date'),   -- date illisible : écarté
  (null, 50000, 70000, '33', null, null, null)                             -- sans libellé : conservé sans tribunal
) as row_data (label, starting, hammer, department, flag, venue, sale_date);

select is(
  (select array_agg(attribute.attname::text order by attribute.attnum)
   from pg_attribute attribute
   where attribute.attrelid = 'app_private.auction_scenario_observations'::regclass
     and attribute.attnum > 0 and not attribute.attisdropped),
  array['court_code', 'property_type', 'starting_price_eur', 'hammer_price_eur', 'sale_date'],
  'the columns of the view (the row type of the scenario functions) do not change'
);

select bag_eq(
  'select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date from app_private.auction_scenario_observations',
  'select court_code, property_type, starting_price_eur, hammer_price_eur, sale_date from public.pgtap_799_old_observations',
  'the rewritten view returns exactly the rows of the previous definition (duplicates included)'
);

select is(
  (select count(*)::int from app_private.auction_scenario_observations),
  11,
  'eleven of the seventeen lots are kept'
);

select is(
  (select count(*)::int from app_private.auction_scenario_observations where court_code is null),
  4,
  'an ambiguous label, an unretained status, an unknown label and a lot without label keep no court'
);

select is(
  app_private.refresh_auction_scenario_observations(true, true),
  11,
  'the snapshot is refreshed from the rewritten view'
);

select is(
  (select count(*)::int from app_private.auction_scenario_observation_snapshot),
  11,
  'the snapshot holds the eleven lots'
);

select is(
  (select observation_count from app_private.auction_scenario_snapshot_state),
  11,
  'the snapshot state records the count'
);

select ok(
  (select 'enable_nestloop=off' = any (proc.proconfig)
   from pg_proc proc
   where proc.oid = 'app_private.refresh_auction_scenario_observations(boolean, boolean)'::regprocedure),
  'the refresh function disables nested loops for its own duration only (function attribute)'
);

select ok(
  has_table_privilege('service_role', 'app_private.auction_scenario_observations', 'select'),
  'service_role still reads the view'
);

select ok(
  not has_table_privilege('authenticated', 'app_private.auction_scenario_observations', 'select'),
  'authenticated still cannot read the view'
);

select * from finish();
rollback;
