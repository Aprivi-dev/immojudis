-- Règle de pépite pepite-v1.2 (migration 20261109120100) : le marché local de la commune est lu dans
-- app_private.commune_market_trends, recalculée depuis public.dvf_transactions par
-- app_private.refresh_commune_market_trends(), et lue par public.get_commune_market_trends(text[]).
-- Les communes d'essai portent des codes 99901 à 99903, qui n'existent pas.
begin;
select plan(32);

delete from public.dvf_transactions;

-- 99901, Appartement : 12 ventes en 2026 à 3 000 EUR/m² (dont la plus récente, le 15/06/2026), 10 ventes en
-- septembre 2025 à 3 200, une vente le 16/06/2025 (dans les 12 derniers mois) et une le 15/06/2025 (juste hors
-- fenêtre), 11 ventes en 2023 à 4 000.
insert into public.dvf_transactions (
  source_mutation_id, sale_date, mutation_nature, total_price_eur, built_surface_m2, property_type, insee_code
)
select 'cmt-2026-' || n, date '2026-01-09' + n, 'Vente', 150000, 50, 'Appartement', '99901'
from generate_series(1, 11) n;
insert into public.dvf_transactions (
  source_mutation_id, sale_date, mutation_nature, total_price_eur, built_surface_m2, property_type, insee_code
) values ('cmt-latest', '2026-06-15', 'Vente', 150000, 50, 'Appartement', '99901');
insert into public.dvf_transactions (
  source_mutation_id, sale_date, mutation_nature, total_price_eur, built_surface_m2, property_type, insee_code
)
select 'cmt-2025-' || n, date '2025-08-31' + n, 'Vente', 160000, 50, 'Appartement', '99901'
from generate_series(1, 10) n;
insert into public.dvf_transactions (
  source_mutation_id, sale_date, mutation_nature, total_price_eur, built_surface_m2, property_type, insee_code
) values
  ('cmt-edge-in', '2025-06-16', 'Vente', 160000, 50, 'Appartement', '99901'),
  ('cmt-edge-out', '2025-06-15', 'Vente', 160000, 50, 'Appartement', '99901');
insert into public.dvf_transactions (
  source_mutation_id, sale_date, mutation_nature, total_price_eur, built_surface_m2, property_type, insee_code
)
select 'cmt-2023-' || n, date '2023-04-30' + n, 'Vente', 200000, 50, 'Appartement', '99901'
from generate_series(1, 11) n;

-- Ventes écartées : prix au m² hors de 300 à 25 000, autre nature de mutation, autre type, surface inconnue,
-- code commune invalide.
insert into public.dvf_transactions (
  source_mutation_id, sale_date, mutation_nature, total_price_eur, built_surface_m2, property_type, insee_code
) values
  ('cmt-cheap', '2026-02-01', 'Vente', 10000, 50, 'Appartement', '99901'),
  ('cmt-dear', '2026-02-01', 'Vente', 1500000, 50, 'Appartement', '99901'),
  ('cmt-vefa', '2026-02-01', 'Vente en l''état futur d''achèvement', 150000, 50, 'Appartement', '99901'),
  ('cmt-adjudication', '2026-02-01', 'Adjudication', 150000, 50, 'Appartement', '99901'),
  ('cmt-outbuilding', '2026-02-01', 'Vente', 150000, 50, 'Dépendance', '99901'),
  ('cmt-no-surface', '2026-02-01', 'Vente', 150000, null, 'Appartement', '99901'),
  ('cmt-bad-code', '2026-02-01', 'Vente', 150000, 50, 'Appartement', '9990');

-- 99902, Maison : 3 ventes en 2026 à 2 000 EUR/m². 99903, Appartement : ventes de 2022 seulement.
insert into public.dvf_transactions (
  source_mutation_id, sale_date, mutation_nature, total_price_eur, built_surface_m2, property_type, insee_code
)
select 'cmt-house-' || n, date '2026-02-28' + n, 'Vente', 200000, 100, 'Maison', '99902'
from generate_series(1, 3) n;
insert into public.dvf_transactions (
  source_mutation_id, sale_date, mutation_nature, total_price_eur, built_surface_m2, property_type, insee_code
)
select 'cmt-old-' || n, date '2022-04-30' + n, 'Vente', 100000, 50, 'Appartement', '99903'
from generate_series(1, 4) n;

-- Le recalcul ---------------------------------------------------------------------------------------------------
select is(
  app_private.refresh_commune_market_trends(),
  3,
  'the refresh writes one row per commune and housing type that has a sale'
);
select is(
  current_setting('statement_timeout'),
  '10min',
  'the refresh gives itself a ten-minute statement timeout (transaction-local)'
);
select is(
  (select count(*)::integer from app_private.commune_market_trends),
  3,
  'the invalid commune code and the non-housing type have no row'
);
select is(
  (select reference_year from app_private.commune_market_trends where insee_code = '99901'),
  2026,
  'the reference year is the year of the most recent sale'
);
select is(
  (select sales_12_months from app_private.commune_market_trends where insee_code = '99901' and property_type = 'Appartement'),
  23,
  'twelve months are counted from the most recent sale: 12 + 10 + the 16/06/2025 sale, not the 15/06/2025 one'
);
select is(
  (select sales_recent_year from app_private.commune_market_trends where insee_code = '99901' and property_type = 'Appartement'),
  12,
  'the recent year counts its own sales'
);
select is(
  (select sales_baseline_year from app_private.commune_market_trends where insee_code = '99901' and property_type = 'Appartement'),
  11,
  'the baseline year is three years before the reference year'
);
select is(
  (select median_recent_eur_m2 from app_private.commune_market_trends where insee_code = '99901' and property_type = 'Appartement'),
  3000.00::numeric,
  'the recent median ignores prices outside 300 to 25 000, other natures, other types and unknown surfaces'
);
select is(
  (select median_baseline_eur_m2 from app_private.commune_market_trends where insee_code = '99901' and property_type = 'Appartement'),
  4000.00::numeric,
  'the baseline median is the median of the year three years before'
);
select is(
  (select sales_12_months || '/' || sales_recent_year || '/' || sales_baseline_year || '/' || median_recent_eur_m2
   from app_private.commune_market_trends where insee_code = '99902' and property_type = 'Maison'),
  '3/3/0/2000.00',
  'a commune with few sales keeps its row with its small counts'
);
select is(
  (select median_baseline_eur_m2 from app_private.commune_market_trends where insee_code = '99902'),
  null::numeric,
  'a year without sale has no median (never a made-up value)'
);
select is(
  (select sales_12_months || '/' || sales_recent_year || '/' || sales_baseline_year
   from app_private.commune_market_trends where insee_code = '99903'),
  '0/0/0',
  'a commune with sales only outside the windows has a row with zero counts: its market is not liquid, not unknown'
);
select is(
  (select count(*)::integer from app_private.commune_market_trends where property_type not in ('Maison', 'Appartement')),
  0,
  'only houses and apartments are aggregated'
);

-- La lecture par l'application ---------------------------------------------------------------------------------
select is(
  jsonb_array_length(public.get_commune_market_trends(array['99901', '99902', '12345'])),
  2,
  'the read returns the rows of the requested communes only'
);
select is(
  public.get_commune_market_trends(array['99901'])->0->>'sales_12_months',
  '23',
  'the read carries the aggregate of the commune'
);
select is(
  public.get_commune_market_trends(array['00000']),
  '[]'::jsonb,
  'a commune without aggregate reads as an empty list'
);

-- Les gardes du recalcul -----------------------------------------------------------------------------------------
insert into app_private.commune_market_trends (
  insee_code, property_type, reference_year, sales_12_months, sales_recent_year, sales_baseline_year
)
select '98' || lpad(n::text, 3, '0'), 'Maison', 2026, 30, 20, 20
from generate_series(1, 117) n;

select throws_ok(
  $$select app_private.refresh_commune_market_trends()$$,
  '55000',
  null,
  'a refresh that would keep less than half of the previous rows is refused'
);
select is(
  (select count(*)::integer from app_private.commune_market_trends),
  120,
  'a refused refresh leaves the previous rows untouched'
);
select is(
  app_private.refresh_commune_market_trends(true),
  3,
  'the shrink guard can be lifted explicitly'
);
select is(
  (select count(*)::integer from app_private.commune_market_trends),
  3,
  'the forced refresh replaces the rows'
);

delete from public.dvf_transactions;
select throws_ok(
  $$select app_private.refresh_commune_market_trends(true)$$,
  '55000',
  null,
  'a refresh with no DVF sale at all is refused, even forced: it would erase the aggregate'
);
select is(
  (select count(*)::integer from app_private.commune_market_trends),
  3,
  'the aggregate is kept when the refresh is refused for an empty DVF table'
);

-- Les droits -------------------------------------------------------------------------------------------------------
select ok(
  (select class_row.relrowsecurity from pg_class class_row where class_row.oid = 'app_private.commune_market_trends'::regclass),
  'row level security is enabled on the aggregate'
);
select ok(
  has_table_privilege('service_role', 'app_private.commune_market_trends', 'SELECT')
  and has_table_privilege('service_role', 'app_private.commune_market_trends', 'INSERT')
  and has_table_privilege('service_role', 'app_private.commune_market_trends', 'UPDATE')
  and has_table_privilege('service_role', 'app_private.commune_market_trends', 'DELETE'),
  'the service role reads and writes the aggregate'
);
select ok(
  not has_table_privilege('anon', 'app_private.commune_market_trends', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.commune_market_trends', 'SELECT')
  and not has_table_privilege('anon', 'app_private.commune_market_trends', 'INSERT')
  and not has_table_privilege('authenticated', 'app_private.commune_market_trends', 'INSERT'),
  'anon and authenticated have no right on the aggregate'
);
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'app_private' and tablename = 'commune_market_trends'
      and roles = array['service_role']::name[]
  )
  and not exists (
    select 1 from pg_policies
    where schemaname = 'app_private' and tablename = 'commune_market_trends'
      and not (roles = array['service_role']::name[])
  ),
  'the only policy of the aggregate is for the service role'
);
select ok(
  has_function_privilege('service_role', 'app_private.refresh_commune_market_trends(boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.refresh_commune_market_trends(boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.refresh_commune_market_trends(boolean)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_commune_market_trends(text[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_commune_market_trends(text[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_commune_market_trends(text[])', 'EXECUTE'),
  'only the server refreshes and reads the aggregate'
);
select ok(
  (select procedure_row.prosecdef and procedure_row.proconfig @> array['search_path=""']::text[]
   from pg_proc procedure_row
   where procedure_row.oid = 'app_private.refresh_commune_market_trends(boolean)'::regprocedure),
  'the refresh is SECURITY DEFINER with an empty search_path'
);
select ok(
  (select not procedure_row.prosecdef and procedure_row.proconfig @> array['search_path=""']::text[]
   from pg_proc procedure_row
   where procedure_row.oid = 'public.get_commune_market_trends(text[])'::regprocedure),
  'the public read is SECURITY INVOKER with an empty search_path'
);

-- Cas d'échec : un compte connecté ne lit rien et ne recalcule rien.
set local role authenticated;
select throws_ok(
  $$select count(*) from app_private.commune_market_trends$$,
  '42501',
  null,
  'a signed-in account cannot read the aggregate'
);
select throws_ok(
  $$select app_private.refresh_commune_market_trends()$$,
  '42501',
  null,
  'a signed-in account cannot refresh the aggregate'
);
select throws_ok(
  $$select public.get_commune_market_trends(array['99901'])$$,
  '42501',
  null,
  'a signed-in account cannot call the public read'
);
reset role;

select * from finish();
rollback;
