-- « Scénarios d'enchères » (migration 20261101120100, point 22) : la vue des lots écarte les lots aberrants :
-- ratio prix d'adjudication / mise à prix inférieur à 0,5, et lot dont le département n'est pas dans le ressort
-- du tribunal rattaché. La vue réelle est rejouée sur des tables de test (la porte statistique Licitor et le
-- rattachement des tribunaux sont remplacés par deux tables) : c'est bien la définition de la migration qui est
-- exercée, pas une copie.
begin;
select plan(8);

create table public.pgtap_673_candidates (payload jsonb not null);
create table public.pgtap_673_mappings (
  raw_tribunal_label text not null,
  court_code text not null,
  mapping_status text not null
);

do $$
declare
  v_definition text := pg_catalog.pg_get_viewdef('app_private.auction_scenario_observations'::regclass);
begin
  v_definition := replace(
    v_definition, 'licitor_ingestion.statistics_eligible_candidates', 'public.pgtap_673_candidates'
  );
  v_definition := replace(
    v_definition, 'licitor_ingestion.diagnostic_court_mappings', 'public.pgtap_673_mappings'
  );
  execute 'create or replace view app_private.auction_scenario_observations as ' || v_definition;
end;
$$;

select ok(
  position('pgtap_673_candidates' in pg_catalog.pg_get_viewdef('app_private.auction_scenario_observations'::regclass)) > 0
  and position('pgtap_673_mappings' in pg_catalog.pg_get_viewdef('app_private.auction_scenario_observations'::regclass)) > 0,
  'the migration''s view definition now reads the test tables'
);

insert into public.pgtap_673_mappings (raw_tribunal_label, court_code, mapping_status) values
  ('Tribunal de Versailles (test)', 'tj_673', 'unique_official_name_contained'),
  ('Tribunal sans ressort connu (test)', 'tj_673_free', 'unique_verified_historical_alias');

-- Le ressort de tj_673 : une commune des Yvelines. tj_673_free n'a aucune adjudication DVF.
insert into public.dvf_court_adjudications (
  mutation_id, mutation_date, insee_code, department, court_code, property_type, price_eur, source_year
) values ('pgtap-673-1', current_date - 100, '78646', '78', 'tj_673', 'apartment', 100000, 2026);

insert into public.pgtap_673_candidates (payload)
select jsonb_build_object(
  'tribunal', row_data.label,
  'property_type', 'apartment',
  'sale_date', (current_date - 30)::text,
  'starting_price_eur', row_data.starting::text,
  'adjudication_price_eur', row_data.hammer::text
) || case when row_data.department is null then '{}'::jsonb
          else jsonb_build_object('department', row_data.department) end
from (values
  -- Adjugé 2 fois la mise à prix, département du ressort : conservé.
  ('Tribunal de Versailles (test)', 50000, 100000, '78'),
  -- Ratio 0,4 : erreur de lecture, écarté.
  ('Tribunal de Versailles (test)', 50000, 20000, '78'),
  -- Ratio exactement 0,5 : conservé.
  ('Tribunal de Versailles (test)', 50000, 25000, '78'),
  -- Département des Hauts-de-Seine pour un tribunal des Yvelines : écarté.
  ('Tribunal de Versailles (test)', 50000, 99999, '92'),
  -- Aucun département : conservé.
  ('Tribunal de Versailles (test)', 50000, 100001, null),
  -- Tribunal sans adjudication DVF : rien à comparer, conservé.
  ('Tribunal sans ressort connu (test)', 50000, 100002, '99')
) as row_data (label, starting, hammer, department);

select is(
  (select count(*)::int from app_private.auction_scenario_observations where court_code = 'tj_673'),
  3,
  'three of the five lots of the Versailles court are kept'
);
select ok(
  not exists (select 1 from app_private.auction_scenario_observations where hammer_price_eur = 20000),
  'a lot sold at 0.4 times the starting price is left out'
);
select ok(
  exists (select 1 from app_private.auction_scenario_observations where hammer_price_eur = 25000),
  'a lot sold at exactly half the starting price is kept'
);
select ok(
  not exists (select 1 from app_private.auction_scenario_observations where hammer_price_eur = 99999),
  'a lot outside the court''s département is left out'
);
select ok(
  exists (select 1 from app_private.auction_scenario_observations where hammer_price_eur = 100001),
  'a lot without a département is kept'
);
select ok(
  exists (
    select 1 from app_private.auction_scenario_observations
    where hammer_price_eur = 100002 and court_code = 'tj_673_free'
  ),
  'a court without any DVF adjudication has no ressort to check against'
);
select is(
  (select array_agg(attribute.attname::text order by attribute.attnum)
   from pg_attribute attribute
   where attribute.attrelid = 'app_private.auction_scenario_observations'::regclass
     and attribute.attnum > 0 and not attribute.attisdropped),
  array['court_code', 'property_type', 'starting_price_eur', 'hammer_price_eur', 'sale_date'],
  'the columns of the view (the row type of the scenario functions) do not change'
);

select * from finish();
rollback;
