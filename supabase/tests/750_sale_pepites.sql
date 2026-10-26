-- Pépites (migration 20261104100000) : résultat de la règle pepite-v1 stocké dans une table privée, mode
-- « off / shadow / on » (valeur initiale « shadow »), lecture publique par deux fonctions qui ne rendent
-- jamais un montant, liste d'administration, signal « pepite » des retours « Utile / Pas pertinent ».
--   * la table n'est lisible ni par anon ni par authenticated, écrite par service_role ;
--   * mode « shadow » ou « off » : les fonctions publiques ne rendent rien ;
--   * mode « on » : une pépite n'est rendue que si, au moment de l'appel, la vente est publique, à venir et
--     datée dans le futur, la mise à prix et l'estimation (prête ou en cours de rafraîchissement) sont celles
--     de l'évaluation, et l'évaluation date de moins de 36 heures ;
--   * les trois rôles (service_role, authenticated, anon) appellent les fonctions publiques ; sans ligne de mode,
--     rien n'est public ; l'arrêt d'urgence accepte un identifiant d'administrateur inconnu.
begin;

select plan(73);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7500000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pepite-feedback@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- Ventes de la lecture publique (01 à 13), toutes à 100 000 € ; ventes de l'administration (21 à 29) ; ventes
-- des retours (31 à 33).
--   01 conforme ; 02 prix modifié depuis l'évaluation ; 03 estimation recalculée ; 04 estimation pas prête ;
--   05 évaluation de 37 h ; 06 évaluation de 35 h (conforme) ; 07 vente passée ; 08 vente reportée ;
--   09 en quarantaine ; 10 évaluation « pas pépite » ; 11 date passée, statut resté « à venir » ;
--   12 estimation en cours de rafraîchissement (pending), même computed_at (conforme) ; 13 estimation en échec.
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type
)
select
  ('c7500000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'pepites-test', 'https://example.test/pepites/' || g, 'Pepite sale ' || g,
  case g when 7 then 'past' when 8 then 'postponed' when 9 then 'quarantined' else 'upcoming' end,
  case g when 7 then '2000-01-01 12:00:00Z'::timestamptz when 11 then '2000-01-01 12:00:00Z'::timestamptz
    else '2099-01-01 12:00:00Z'::timestamptz + g * interval '1 hour' end,
  100000, 'tribunal'
from generate_series(1, 13) as g
union all
select
  ('c7500000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'pepites-test', 'https://example.test/pepites/' || g, 'Pepite sale ' || g,
  case g when 29 then 'quarantined' else 'upcoming' end,
  '2099-02-01 12:00:00Z'::timestamptz + g * interval '1 hour', 100000,
  -- Le type de vente des compteurs vient de cette colonne : 27 et 28 ne sont ni de tribunal ni notariales.
  case when g in (25, 26) then 'notary' when g in (27, 28) then 'state' else 'tribunal' end
from generate_series(21, 29) as g
union all
select
  ('c7500000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'pepites-test', 'https://example.test/pepites/' || g, 'Pepite sale ' || g, 'upcoming',
  '2099-03-01 12:00:00Z'::timestamptz + g * interval '1 hour', 100000, 'tribunal'
from generate_series(31, 33) as g;

-- Estimations prêtes, calculées le 01/11/2026 à 08:00 (la 04 reste en attente).
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
       model_version = 'pgtap-750-v1',
       computed_at = '2026-11-01 08:00:00Z'
 where auction_sale_id in (
   select ('c7500000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
     from generate_series(1, 11) as g
    where g <> 4
 );
-- 12 : un rafraîchissement est en cours, l'ancienne estimation reste celle de l'évaluation ; 13 : en échec.
update public.auction_sale_market_estimates
   set status = case auction_sale_id
         when 'c7500000-1000-4000-8000-000000000012'::uuid then 'pending' else 'failed' end,
       computed_at = '2026-11-01 08:00:00Z'
 where auction_sale_id in (
   'c7500000-1000-4000-8000-000000000012'::uuid, 'c7500000-1000-4000-8000-000000000013'::uuid
 );

-- Évaluations : toutes publiables, à 100 000 € et à l'estimation du 01/11 08:00, sauf les écarts voulus.
insert into public.auction_sale_pepites (
  sale_id, rule_version, engine_version, regime_version, status, is_pepite, favorable_streak,
  reason_codes, details, input_starting_price_eur, input_estimate_computed_at, evaluated_at
)
select
  ('c7500000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'pepite-v1', 'pgtap', 'pgtap', case g when 10 then 'not_pepite' else 'pepite' end,
  g <> 10, 2, array['pass:test_c_cost'],
  '{"venueType": "tribunal", "costRatio": 0.5}'::jsonb,
  100000,
  case g when 3 then '2026-11-01 07:00:00Z'::timestamptz else '2026-11-01 08:00:00Z'::timestamptz end,
  case g when 5 then now() - interval '37 hours' when 6 then now() - interval '35 hours' else now() end
from generate_series(1, 13) as g;

-- La vente 02 a changé de prix depuis son évaluation.
update public.auction_sales
   set starting_price_eur = 95000
 where id = 'c7500000-1000-4000-8000-000000000002';

-- Structure et droits ----------------------------------------------------------------------------
select has_table('public', 'auction_sale_pepites', 'the pepite results are stored');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_sale_pepites'::regclass),
  'row level security is enabled on the pepite table'
);
select ok(
  not has_table_privilege('anon', 'public.auction_sale_pepites', 'SELECT')
  and not has_table_privilege('anon', 'public.auction_sale_pepites', 'INSERT')
  and not has_table_privilege('anon', 'public.auction_sale_pepites', 'UPDATE')
  and not has_table_privilege('anon', 'public.auction_sale_pepites', 'DELETE')
  and not has_table_privilege('authenticated', 'public.auction_sale_pepites', 'SELECT')
  and not has_table_privilege('authenticated', 'public.auction_sale_pepites', 'INSERT')
  and not has_table_privilege('authenticated', 'public.auction_sale_pepites', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.auction_sale_pepites', 'DELETE'),
  'neither a visitor nor an account holds any right on the pepite table'
);
select ok(
  has_table_privilege('service_role', 'public.auction_sale_pepites', 'SELECT')
  and has_table_privilege('service_role', 'public.auction_sale_pepites', 'INSERT')
  and has_table_privilege('service_role', 'public.auction_sale_pepites', 'UPDATE'),
  'service_role reads and writes the pepite table'
);
select is(
  (
    select array_agg(policy.roles::text order by policy.policyname)
    from pg_policies policy
    where policy.schemaname = 'public' and policy.tablename = 'auction_sale_pepites'
  ),
  array['{service_role}']::text[],
  'the only policy of the pepite table is the service_role one'
);
select is(
  (select array_agg(column_name::text order by ordinal_position)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'auction_sale_pepites'),
  array[
    'sale_id', 'rule_version', 'engine_version', 'regime_version', 'status', 'is_pepite',
    'favorable_streak', 'frozen_at', 'last_favorable_at', 'data_missing_since', 'reason_codes',
    'details', 'input_starting_price_eur',
    'input_estimate_computed_at', 'evaluated_at', 'first_pepite_at'
  ],
  'the table holds the versions, the status, the published result, the series dates, the reasons, the private details and the inputs'
);
select is(
  (select count(*) from pg_indexes
    where schemaname = 'public' and tablename = 'auction_sale_pepites'
      and indexname = 'auction_sale_pepites_status_idx'),
  0::bigint,
  'no index on the status alone: no query filters on it'
);
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.auction_sale_pepites'::regclass and contype = 'f'),
  'c',
  'a result disappears with its sale (on delete cascade)'
);
select throws_ok(
  $$update public.auction_sale_pepites set status = 'not_applicable'
     where sale_id = 'c7500000-1000-4000-8000-000000000001'$$,
  '23514', null, 'a sale outside the rule is never published'
);
select throws_ok(
  $$update public.auction_sale_pepites set status = 'maybe'
     where sale_id = 'c7500000-1000-4000-8000-000000000001'$$,
  '23514', null, 'the status comes from a closed list'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.sale_pepite_settings'::regclass)
  and not has_table_privilege('anon', 'app_private.sale_pepite_settings', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.sale_pepite_settings', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.sale_pepite_settings', 'UPDATE'),
  'the mode table is closed to the browser roles'
);
select is(
  (select mode from app_private.sale_pepite_settings where singleton),
  'shadow',
  'the initial mode is « shadow »: nothing is public'
);
select is(app_private.sale_pepite_mode(), 'shadow', 'the mode function reads the singleton');
select is(public.get_sale_pepite_mode(), 'shadow', 'the application reads the mode through the public function');
select throws_ok(
  $$update app_private.sale_pepite_settings set mode = 'maybe' where singleton$$,
  '23514', null, 'the mode comes from the list off, shadow, on'
);
select throws_ok(
  $$insert into app_private.sale_pepite_settings (singleton, mode) values (false, 'on')$$,
  '23514', null, 'there is a single mode row'
);
select ok(
  (select bool_and(procedure_row.prosecdef and procedure_row.proconfig @> array['search_path=""']::text[])
     from pg_proc procedure_row
    where procedure_row.oid in (
      'app_private.sale_pepite_mode()'::regprocedure,
      'app_private.get_public_sale_pepite(uuid)'::regprocedure,
      'app_private.list_public_pepite_sale_ids()'::regprocedure,
      'public.admin_list_sale_pepites(timestamptz, integer)'::regprocedure
    )),
  'the logic is security definer with an empty search_path'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.get_public_sale_pepite(uuid)'::regprocedure)
  and not (select prosecdef from pg_proc where oid = 'public.list_public_pepite_sale_ids()'::regprocedure),
  'the public functions are thin invoker wrappers (a definer function of public is refused to anon by 441)'
);
select ok(
  has_function_privilege('anon', 'public.get_public_sale_pepite(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_public_sale_pepite(uuid)', 'EXECUTE')
  and has_function_privilege('anon', 'public.list_public_pepite_sale_ids()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.list_public_pepite_sale_ids()', 'EXECUTE'),
  'visitors and accounts can ask whether a sale is a pepite'
);
select ok(
  not has_function_privilege('anon', 'public.get_sale_pepite_mode()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_sale_pepite_mode()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_sale_pepite_mode()', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.sale_pepite_mode()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.sale_pepite_mode()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_list_sale_pepites(timestamptz, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_list_sale_pepites(timestamptz, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_list_sale_pepites(timestamptz, integer)', 'EXECUTE'),
  'the mode and the administration list are reserved to the server'
);

-- Lecture publique : mode « shadow » -> rien ------------------------------------------------------------
select is(
  (select count(*) from public.list_public_pepite_sale_ids() as id
    where id::text like 'c7500000-1000-4000-8000-0000000000%'),
  0::bigint,
  'in shadow mode the list of pepites is empty'
);
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000001'),
  false,
  'in shadow mode a stored pepite is not public'
);
update app_private.sale_pepite_settings set mode = 'off' where singleton;
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000001'),
  false,
  'in off mode nothing is public either'
);

-- Mode « on » : les gardes à la lecture ------------------------------------------------------------------
update app_private.sale_pepite_settings set mode = 'on' where singleton;
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000001'),
  true,
  'in on mode a conforming pepite is public'
);
select is(
  (select array_agg(public.get_public_sale_pepite(('c7500000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid) order by g)
     from generate_series(1, 13) as g),
  array[true, false, false, false, false, true, false, false, false, false, false, true, false],
  'only the conforming sales are public: the price changed (02), the estimate recomputed (03) or never computed (04), an evaluation older than 36 h (05), a past (07), postponed (08) or quarantined (09) sale, a result that is not a pepite (10), a date in the past (11) and a failed estimate (13) are not ; an estimate being refreshed with the evaluated computed_at (12) is'
);
select is(
  (select array_agg(id order by id) from public.list_public_pepite_sale_ids() as id
    where id::text like 'c7500000-1000-4000-8000-0000000000%'),
  array[
    'c7500000-1000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000006',
    'c7500000-1000-4000-8000-000000000012'
  ]::uuid[],
  'the list holds the same conforming pepites'
);
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-0000000000ff'),
  false,
  'an unknown sale is not a pepite (false, never null)'
);
select is(
  (select jsonb_typeof(to_jsonb(public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000001')))),
  'boolean',
  'the answer is a boolean: never an amount'
);
update public.auction_sales
   set starting_price_eur = 100000
 where id = 'c7500000-1000-4000-8000-000000000002';
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000002'),
  true,
  'the price back at the evaluated one, the pepite is public again (the guard reads the live price)'
);

-- Sans ligne de mode, rien n'est public (le mode vaut « off »), et l'arrêt d'urgence ne crée pas de ligne.
delete from app_private.sale_pepite_settings where singleton;
select is(app_private.sale_pepite_mode(), 'off', 'without a mode row the mode is « off »');
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000001'),
  false,
  'without a mode row a stored pepite is not public'
);
select is(
  (select count(*) from public.list_public_pepite_sale_ids() as id
    where id::text like 'c7500000-1000-4000-8000-0000000000%'),
  0::bigint,
  'without a mode row the list of pepites is empty'
);
select is(public.suspend_sale_pepites(), 'off', 'without a mode row the emergency stop reports « off »');
select is(
  (select count(*) from app_private.sale_pepite_settings),
  0::bigint,
  'and creates no row'
);
insert into app_private.sale_pepite_settings (singleton, mode) values (true, 'on');

-- Les trois rôles appellent les fonctions publiques (mode « on »).
set local role service_role;
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000001'),
  true,
  'the server role reads the boolean'
);
select is(
  (select count(*) from public.list_public_pepite_sale_ids() as id
    where id = 'c7500000-1000-4000-8000-000000000001'),
  1::bigint,
  'the server role reads the list'
);
reset role;
set local role authenticated;
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000001'),
  true,
  'an account reads the boolean'
);
select is(
  (select count(*) from public.list_public_pepite_sale_ids() as id
    where id = 'c7500000-1000-4000-8000-000000000001'),
  1::bigint,
  'an account reads the list'
);
reset role;
set local role anon;
select is(
  (select count(*) from public.list_public_pepite_sale_ids() as id
    where id = 'c7500000-1000-4000-8000-000000000001'),
  1::bigint,
  'a visitor reads the list'
);
select is(
  public.get_public_sale_pepite('c7500000-1000-4000-8000-000000000001'),
  true,
  'a visitor reads the boolean'
);
select throws_ok(
  $$select count(*) from public.auction_sale_pepites$$,
  '42501', null, 'a visitor cannot read the table'
);
reset role;

-- Administration -----------------------------------------------------------------------------------------
-- La lecture publique est finie : les évaluations ci-dessus laissent la place à celles de la liste.
delete from public.auction_sale_pepites
 where sale_id::text like 'c7500000-1000-4000-8000-0000000000%'
   and sale_id::text not like 'c7500000-1000-4000-8000-00000000002%';

create temporary table pgtap_750_admin (label text primary key, body jsonb) on commit drop;
grant all on pgtap_750_admin to public;
insert into pgtap_750_admin values ('before', public.admin_list_sale_pepites());

-- 21 pépite du tribunal (0,50) ; 22 à confirmer (0,60) ; 23 presque pépite (un seul critère, l'écart) ;
-- 24 deux critères manqués ; 25 pépite notariale (0,40) ; 26 données insuffisantes notariale ; 27 non applicable
-- sans type ; 28 presque pépite d'un autre type ; 29 pépite d'une vente en quarantaine (ni comptée ni listée).
insert into public.auction_sale_pepites (
  sale_id, rule_version, engine_version, status, is_pepite, reason_codes, details
) values
  ('c7500000-1000-4000-8000-000000000021', 'pepite-v1', 'pgtap', 'pepite', true,
   array['pass:test_c_cost'], '{"venueType": "tribunal", "costRatio": 0.5, "probablePriceEur": 120000}'),
  ('c7500000-1000-4000-8000-000000000022', 'pepite-v1', 'pgtap', 'pepite', false,
   array['pass:test_c_cost', 'stab:streak_1'], '{"venueType": "tribunal", "costRatio": 0.6}'),
  ('c7500000-1000-4000-8000-000000000023', 'pepite-v1', 'pgtap', 'not_pepite', false,
   array['pass:test_c_cost', 'fail:gap_significant'], '{"venueType": "tribunal"}'),
  ('c7500000-1000-4000-8000-000000000024', 'pepite-v1', 'pgtap', 'not_pepite', false,
   array['fail:gap_significant', 'fail:test_b_chance'], '{"venueType": "tribunal"}'),
  ('c7500000-1000-4000-8000-000000000025', 'pepite-v1', 'pgtap', 'pepite', true,
   array['pass:test_c_cost'], '{"venueType": "notary", "costRatio": 0.4}'),
  ('c7500000-1000-4000-8000-000000000026', 'pepite-v1', 'pgtap', 'insufficient', false,
   array['fail:estimate_actionable'], '{"venueType": "notary"}'),
  ('c7500000-1000-4000-8000-000000000027', 'pepite-v1', 'pgtap', 'not_applicable', false,
   array['fail:regime_open'], '{}'),
  ('c7500000-1000-4000-8000-000000000028', 'pepite-v1', 'pgtap', 'not_pepite', false,
   array['fail:test_c_cost'], '{"venueType": "state"}'),
  ('c7500000-1000-4000-8000-000000000029', 'pepite-v1', 'pgtap', 'pepite', true,
   array['pass:test_c_cost'], '{"venueType": "tribunal", "costRatio": 0.1}');
insert into pgtap_750_admin values ('after', public.admin_list_sale_pepites());

select is(
  (select array_agg(key order by key) from pgtap_750_admin t, jsonb_object_keys(t.body) as key
    where t.label = 'after'),
  array['counters', 'generated_at', 'mode', 'rows'],
  'the answer holds the mode, the counters and the rows'
);
select is(
  (select body ->> 'mode' from pgtap_750_admin where label = 'after'),
  'on',
  'the answer carries the current mode'
);
select is(
  (select array_agg(c ->> 'venue' order by ordinality)
     from pgtap_750_admin t, jsonb_array_elements(t.body -> 'counters') with ordinality as x(c, ordinality)
    where t.label = 'after'),
  array['tribunal', 'notary', 'other'],
  'the counters are by kind of sale: court, notary, other'
);
select is(
  (
    select jsonb_object_agg(
      a ->> 'venue',
      jsonb_build_array(
        (a ->> 'evaluated')::int - (b ->> 'evaluated')::int,
        (a ->> 'pepites')::int - (b ->> 'pepites')::int,
        (a ->> 'pending')::int - (b ->> 'pending')::int,
        (a ->> 'not_pepite')::int - (b ->> 'not_pepite')::int,
        (a ->> 'not_applicable')::int - (b ->> 'not_applicable')::int,
        (a ->> 'insufficient')::int - (b ->> 'insufficient')::int,
        (a ->> 'evaluable')::int - (b ->> 'evaluable')::int,
        (a ->> 'only_gap_guard')::int - (b ->> 'only_gap_guard')::int
      )
    )
    from pgtap_750_admin t1,
         pgtap_750_admin t2,
         jsonb_array_elements(t1.body -> 'counters') a,
         jsonb_array_elements(t2.body -> 'counters') b
    where t1.label = 'after' and t2.label = 'before' and a ->> 'venue' = b ->> 'venue'
  ),
  '{
    "tribunal": [4, 1, 1, 2, 0, 0, 4, 1],
    "notary": [2, 1, 0, 0, 0, 1, 1, 0],
    "other": [2, 0, 0, 1, 1, 0, 1, 0]
  }'::jsonb,
  'the counters: evaluated, pepites, to confirm, not pepite, not applicable, insufficient, evaluable, stopped only by the gap guard (the quarantined sale is not counted)'
);
select is(
  (select array_agg(r ->> 'sale_id' order by ordinality)
     from pgtap_750_admin t, jsonb_array_elements(t.body -> 'rows') with ordinality as x(r, ordinality)
    where t.label = 'after' and r ->> 'sale_id' like 'c7500000-1000-4000-8000-0000000000%'),
  array[
    'c7500000-1000-4000-8000-000000000025', 'c7500000-1000-4000-8000-000000000021',
    'c7500000-1000-4000-8000-000000000022', 'c7500000-1000-4000-8000-000000000023',
    'c7500000-1000-4000-8000-000000000028'
  ],
  'the list: published pepites first (lowest cost ratio first), then those to confirm, then the near misses; no sale with two misses, no insufficient data, no quarantined sale'
);
select is(
  (select r -> 'details' ->> 'probablePriceEur'
     from pgtap_750_admin t, jsonb_array_elements(t.body -> 'rows') r
    where t.label = 'after' and r ->> 'sale_id' = 'c7500000-1000-4000-8000-000000000021'),
  '120000',
  'the private details come with the row (the administration reads them)'
);
select is(
  (select jsonb_array_length(public.admin_list_sale_pepites(now(), 2) -> 'rows')),
  2,
  'the list is bounded by the limit'
);

-- Arrêt d'urgence ---------------------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.suspend_sale_pepites(text, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.suspend_sale_pepites(text, uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.suspend_sale_pepites(text, uuid)', 'EXECUTE')
  and (select prosecdef and proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'public.suspend_sale_pepites(text, uuid)'::regprocedure),
  'the emergency stop is security definer and reserved to the server (the admin route checks the role)'
);
select throws_ok(
  $$select public.suspend_sale_pepites('on')$$,
  '22023', null, 'it never opens: « on » is not a target'
);
select throws_ok(
  $$select public.suspend_sale_pepites(null)$$,
  '22023', null, 'a missing target is refused'
);
select throws_ok(
  $$select public.suspend_sale_pepites('maybe')$$,
  '22023', null, 'an unknown target is refused'
);
select is(public.suspend_sale_pepites(), 'shadow', 'from « on » it goes back to « shadow » by default');
select is(app_private.sale_pepite_mode(), 'shadow', 'and the mode is stored');
select is(
  public.suspend_sale_pepites('off'),
  'shadow',
  'from « shadow » it does nothing: the mode is returned as it is'
);
select is(app_private.sale_pepite_mode(), 'shadow', 'and stays « shadow »');
update app_private.sale_pepite_settings set mode = 'on' where singleton;
select is(
  public.suspend_sale_pepites('off', 'c7500000-0000-4000-8000-000000000001'),
  'off',
  'from « on » it can also go to « off »'
);
select is(
  (select updated_by from app_private.sale_pepite_settings where singleton),
  'c7500000-0000-4000-8000-000000000001'::uuid,
  'the administrator who stopped it is recorded'
);
select is(
  public.suspend_sale_pepites('shadow'),
  'off',
  'from « off » it never goes up to « shadow »'
);
select is(app_private.sale_pepite_mode(), 'off', 'and stays « off »');
-- Un identifiant d'administrateur inconnu n'empêche pas l'arrêt d'urgence : la colonne reste nulle.
update app_private.sale_pepite_settings set mode = 'on' where singleton;
select is(
  public.suspend_sale_pepites('shadow', 'c7500000-0000-4000-8000-0000000000ee'),
  'shadow',
  'an unknown administrator identifier does not stop the emergency stop'
);
select is(
  (select updated_by from app_private.sale_pepite_settings where singleton),
  null::uuid,
  'and no administrator is recorded (no foreign key error)'
);

-- Retours « Utile / Pas pertinent » sur le signal « pepite » --------------------------------------------------
create temporary table pgtap_750_feedback (label text primary key, body jsonb) on commit drop;
insert into pgtap_750_feedback values ('before', public.admin_sale_signal_feedback_summary());

select is(
  public.record_sale_signal_feedback(
    'c7500000-0000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000031', 'pepite', 'useful'),
  true,
  'a useful feedback on the pepite signal is recorded'
);
select is(
  public.record_sale_signal_feedback(
    'c7500000-0000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000032', 'pepite',
    'not_relevant', 'amount_too_high'),
  true,
  '« Montant trop haut » is a reason of the pepite signal'
);
select is(
  public.record_sale_signal_feedback(
    'c7500000-0000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000033', 'pepite',
    'not_relevant', 'criterion_wrong'),
  true,
  '« Un critère est faux » is a reason of the pepite signal'
);
select is(
  public.record_sale_signal_feedback(
    'c7500000-0000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000033', 'pepite',
    'not_relevant', 'not_interesting'),
  true,
  '« Peu intéressant » is a reason of the pepite signal (it corrects the day''s feedback)'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c7500000-0000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000031', 'pepite', 'not_relevant', 'estimate_too_high')$$,
  '23514', null, 'a reason of the market gap signal is refused for the pepite signal'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c7500000-0000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000031', 'market_gap_band', 'not_relevant', 'amount_too_high')$$,
  '23514', null, 'a reason of the pepite signal is refused for the market gap signal'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c7500000-0000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000031', 'pepite', 'useful', 'amount_too_high')$$,
  '23514', null, 'a reason is only for « not_relevant »'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c7500000-0000-4000-8000-000000000001', 'c7500000-1000-4000-8000-000000000031', 'pepite', 'not_relevant', 'because I said so')$$,
  '23514', null, 'a free-text reason is refused'
);
insert into pgtap_750_feedback values ('after', public.admin_sale_signal_feedback_summary());
select is(
  (
    select jsonb_build_array(
      (a ->> 'total')::int - (b ->> 'total')::int,
      (a ->> 'useful')::int - (b ->> 'useful')::int,
      (a ->> 'not_relevant')::int - (b ->> 'not_relevant')::int,
      (a -> 'reasons' ->> 'amount_too_high')::int - (b -> 'reasons' ->> 'amount_too_high')::int,
      (a -> 'reasons' ->> 'criterion_wrong')::int - (b -> 'reasons' ->> 'criterion_wrong')::int,
      (a -> 'reasons' ->> 'not_interesting')::int - (b -> 'reasons' ->> 'not_interesting')::int
    )
    from pgtap_750_feedback t1,
         pgtap_750_feedback t2,
         jsonb_array_elements(t1.body -> 'signals') a,
         jsonb_array_elements(t2.body -> 'signals') b
    where t1.label = 'after' and t2.label = 'before'
      and a ->> 'signal' = 'pepite' and b ->> 'signal' = 'pepite'
  ),
  '[3, 1, 2, 1, 0, 1]'::jsonb,
  'the administration summary counts the pepite signal and its three reasons'
);

-- Disparition avec la vente --------------------------------------------------------------------------------
-- Pont Outcome Graph exigé avant toute suppression d'une vente (garde de 20260730163756), comme les autres tests.
select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales where id = 'c7500000-1000-4000-8000-000000000021'$$,
  'a sale with a stored pepite can be purged'
);
select is(
  (select count(*) from public.auction_sale_pepites where sale_id = 'c7500000-1000-4000-8000-000000000021'),
  0::bigint,
  'its result goes with it'
);

select * from finish();

rollback;
