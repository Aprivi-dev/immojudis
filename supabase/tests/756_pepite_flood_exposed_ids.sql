-- Pépites « exposées » (migration 20261106100400) : parmi les pépites publiables, celles dont le bien est dans le
-- périmètre d'un plan de prévention des risques d'inondation (details.flood.verdict = 'exposed'). Un fait public,
-- sans montant : des identifiants, rien d'autre.
--   * mode « shadow » ou « off » : liste vide ; mode « on » : seules les pépites publiables et exposées ;
--   * mêmes gardes à la lecture que get_public_sale_pepite (prix inchangé, évaluation de moins de 36 h…) ;
--   * jamais plus que la liste des pépites publiables ;
--   * fonction de logique SECURITY DEFINER à chemin de recherche vide, enveloppe publique SECURITY INVOKER ;
--   * visiteurs, comptes et serveur peuvent l'appeler.
begin;

select plan(13);

-- Ventes : 01 exposée et conforme ; 02 contrôlée sans exposition ; 03 sans contrôle (règle v1) ; 04 exposée mais
-- évaluation de 37 h ; 05 exposée mais pas une pépite ; 06 exposée, prix modifié depuis l'évaluation.
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type
)
select
  ('c7560000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'pepites-flood-test', 'https://example.test/pepites-flood/' || g, 'Flood pepite sale ' || g,
  'upcoming', '2099-01-01 12:00:00Z'::timestamptz + g * interval '1 hour', 100000, 'tribunal'
from generate_series(1, 6) as g;

update public.auction_sale_market_estimates
   set status = 'ready',
       estimate = '{}'::jsonb,
       value_p10_eur = 150000,
       value_p50_eur = 200000,
       value_p90_eur = 260000,
       actionable = true,
       comparable_count = 12,
       confidence_score = 70,
       engine_kind = 'comparable_ensemble',
       model_version = 'pgtap-756-v1',
       computed_at = '2026-11-01 08:00:00Z'
 where auction_sale_id in (
   select ('c7560000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 6) as g
 );

insert into public.auction_sale_pepites (
  sale_id, rule_version, engine_version, regime_version, status, is_pepite, favorable_streak,
  reason_codes, details, input_starting_price_eur, input_estimate_computed_at, evaluated_at
)
select
  ('c7560000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'pepite-v2', 'pgtap', 'pgtap', 'pepite', g <> 5, 2, array['pass:test_c_cost'],
  case g
    when 2 then '{"flood": {"verdict": "none_found"}}'::jsonb
    when 3 then '{"venueType": "tribunal"}'::jsonb
    else '{"flood": {"verdict": "exposed", "observedAt": "2026-11-01T08:00:00Z"}}'::jsonb
  end,
  100000, '2026-11-01 08:00:00Z'::timestamptz,
  case g when 4 then now() - interval '37 hours' else now() end
from generate_series(1, 6) as g;

update public.auction_sales
   set starting_price_eur = 95000
 where id = 'c7560000-1000-4000-8000-000000000006';

-- Structure et droits ----------------------------------------------------------------------------
select ok(
  (select bool_and(procedure_row.prosecdef and procedure_row.proconfig @> array['search_path=""']::text[])
     from pg_proc procedure_row
    where procedure_row.oid = 'app_private.list_public_pepite_flood_exposed_ids()'::regprocedure),
  'the logic is security definer with an empty search_path'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.list_public_pepite_flood_exposed_ids()'::regprocedure),
  'the public function is a thin invoker wrapper (a definer function of public is refused to anon by 441)'
);
select ok(
  has_function_privilege('anon', 'public.list_public_pepite_flood_exposed_ids()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.list_public_pepite_flood_exposed_ids()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.list_public_pepite_flood_exposed_ids()', 'EXECUTE'),
  'visitors, accounts and the server can read the list'
);
select is(
  (select pg_get_function_result('public.list_public_pepite_flood_exposed_ids()'::regprocedure)),
  'SETOF uuid',
  'the function returns identifiers, never an amount or a detail'
);

-- Mode « shadow » ou « off » : rien -----------------------------------------------------------------------
update app_private.sale_pepite_settings set mode = 'shadow' where singleton;
select is(
  (select count(*) from public.list_public_pepite_flood_exposed_ids() as id
    where id::text like 'c7560000-1000-4000-8000-0000000000%'),
  0::bigint,
  'in shadow mode the list of exposed pepites is empty'
);
update app_private.sale_pepite_settings set mode = 'off' where singleton;
select is(
  (select count(*) from public.list_public_pepite_flood_exposed_ids() as id
    where id::text like 'c7560000-1000-4000-8000-0000000000%'),
  0::bigint,
  'in off mode the list is empty too'
);

-- Mode « on » ----------------------------------------------------------------------------------------------
update app_private.sale_pepite_settings set mode = 'on' where singleton;
select is(
  (select array_agg(id order by id) from public.list_public_pepite_flood_exposed_ids() as id
    where id::text like 'c7560000-1000-4000-8000-0000000000%'),
  array['c7560000-1000-4000-8000-000000000001']::uuid[],
  'only the conforming exposed pepite is listed: not a checked one (02), one without check (03), a stale evaluation (04), a sale that is not a pepite (05) and a changed price (06)'
);
select ok(
  (select bool_and(id in (select p from public.list_public_pepite_sale_ids() as p))
     from public.list_public_pepite_flood_exposed_ids() as id),
  'the exposed pepites are always part of the list of publishable pepites'
);

-- Les gardes sont lues en direct -------------------------------------------------------------------------------
update public.auction_sales
   set starting_price_eur = 100000
 where id = 'c7560000-1000-4000-8000-000000000006';
select is(
  (select count(*) from public.list_public_pepite_flood_exposed_ids() as id
    where id = 'c7560000-1000-4000-8000-000000000006'),
  1::bigint,
  'the price back at the evaluated one, the sale is listed again (the guard reads the live price)'
);
update public.auction_sale_pepites
   set details = '{"flood": {"verdict": "high"}}'::jsonb
 where sale_id = 'c7560000-1000-4000-8000-000000000006';
select is(
  (select count(*) from public.list_public_pepite_flood_exposed_ids() as id
    where id = 'c7560000-1000-4000-8000-000000000006'),
  0::bigint,
  'a verdict that is not « exposed » is never listed'
);

-- Sans ligne de mode, rien n'est public ---------------------------------------------------------------------------
delete from app_private.sale_pepite_settings where singleton;
select is(
  (select count(*) from public.list_public_pepite_flood_exposed_ids() as id
    where id::text like 'c7560000-1000-4000-8000-0000000000%'),
  0::bigint,
  'without a mode row the list is empty'
);
insert into app_private.sale_pepite_settings (singleton, mode) values (true, 'on');

-- Les trois rôles ----------------------------------------------------------------------------------------------
set local role anon;
select is(
  (select count(*) from public.list_public_pepite_flood_exposed_ids() as id
    where id = 'c7560000-1000-4000-8000-000000000001'),
  1::bigint,
  'a visitor reads the list'
);
reset role;
set local role authenticated;
select is(
  (select count(*) from public.list_public_pepite_flood_exposed_ids() as id
    where id = 'c7560000-1000-4000-8000-000000000001'),
  1::bigint,
  'an account reads the list'
);
reset role;

select * from finish();

rollback;
