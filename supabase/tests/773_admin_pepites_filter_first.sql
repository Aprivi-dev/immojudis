-- Administration des pépites (migration 20261108110300) :
--   * `admin_list_sale_pepites` filtre le statut de la vente avant la fonction de visibilité, sans changer le
--     résultat : une évaluation de vente terminée n'est ni comptée ni listée (comme avant, la vente n'était pas
--     publiquement visible) ; les droits et le caractère `security definer` sont conservés ;
--   * `admin_pepite_independence_sales` rend en un appel les deux effectifs et les champs de rapprochement des seules
--     ventes dont l'avocat poursuivant est nommé ; service_role seul.
begin;

select plan(12);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type, lawyer_name, tribunal
) values
  ('c7730000-1000-4000-8000-000000000001', 'adm-test', 'https://example.test/adm/1', 'Adm 1', 'upcoming',
   '2099-01-01 12:00:00Z', 100000, 'tribunal', 'Maître Jean Dupont', 'Tribunal judiciaire de Bordeaux'),
  ('c7730000-1000-4000-8000-000000000002', 'adm-test', 'https://example.test/adm/2', 'Adm 2', 'upcoming',
   '2099-01-02 12:00:00Z', 100000, 'tribunal', null, 'Tribunal judiciaire de Bordeaux'),
  ('c7730000-1000-4000-8000-000000000003', 'adm-test', 'https://example.test/adm/3', 'Adm 3', 'past',
   '2099-01-03 12:00:00Z', 100000, 'tribunal', 'Maître Paul Martin', 'Tribunal judiciaire de Bordeaux'),
  ('c7730000-1000-4000-8000-000000000004', 'adm-test', 'https://example.test/adm/4', 'Adm 4', 'upcoming',
   '2099-01-04 12:00:00Z', 100000, 'tribunal', 'Maître Luc Durand', 'Tribunal judiciaire de Lyon');

create temporary table pgtap_773_admin (label text primary key, body jsonb) on commit drop;
grant all on pgtap_773_admin to public;
insert into pgtap_773_admin values ('before', public.admin_list_sale_pepites(now(), 300));

insert into public.auction_sale_pepites (
  sale_id, rule_version, engine_version, status, is_pepite, reason_codes, details
) values
  ('c7730000-1000-4000-8000-000000000001', 'pepite-v1', 'pgtap', 'pepite', true,
   array['pass:test_c_cost'], '{"venueType": "tribunal", "costRatio": 0.5}'),
  ('c7730000-1000-4000-8000-000000000002', 'pepite-v1', 'pgtap', 'pepite', false,
   array['pass:test_c_cost', 'stab:streak_1'], '{"venueType": "tribunal", "costRatio": 0.6}'),
  ('c7730000-1000-4000-8000-000000000003', 'pepite-v1', 'pgtap', 'pepite', true,
   array['pass:test_c_cost'], '{"venueType": "tribunal", "costRatio": 0.4}'),
  ('c7730000-1000-4000-8000-000000000004', 'pepite-v1', 'pgtap', 'not_pepite', false,
   array['fail:test_c_cost', 'fail:test_b_chance'], '{"venueType": "tribunal"}');

-- Droits et forme ----------------------------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig @> array['search_path=""']::text[]
     from pg_proc where oid = 'public.admin_list_sale_pepites(timestamptz, integer)'::regprocedure),
  'the administration list is still security definer with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'public.admin_list_sale_pepites(timestamptz, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_list_sale_pepites(timestamptz, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_list_sale_pepites(timestamptz, integer)', 'EXECUTE'),
  'the administration list is still reserved to the server'
);
select ok(
  not has_function_privilege('anon', 'public.admin_pepite_independence_sales()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pepite_independence_sales()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pepite_independence_sales()', 'EXECUTE'),
  'the independence function is reserved to the server'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.admin_pepite_independence_sales()'::regprocedure),
  'the independence function is security invoker'
);

-- Liste : une évaluation de vente terminée n'est ni comptée ni listée -----------------------------------------
insert into pgtap_773_admin values ('after', public.admin_list_sale_pepites(now(), 300));

select is(
  (select array_agg(r ->> 'sale_id' order by ordinality)
     from pgtap_773_admin t, jsonb_array_elements(t.body -> 'rows') with ordinality as x(r, ordinality)
    where t.label = 'after' and r ->> 'sale_id' like 'c7730000-1000-4000-8000-0000000000%'),
  array['c7730000-1000-4000-8000-000000000001', 'c7730000-1000-4000-8000-000000000002']::text[],
  'the published pepite and the one to confirm are listed; the past sale and the two-miss sale are not'
);
select is(
  (
    select jsonb_build_array(
      (a ->> 'evaluated')::int - (b ->> 'evaluated')::int,
      (a ->> 'pepites')::int - (b ->> 'pepites')::int,
      (a ->> 'pending')::int - (b ->> 'pending')::int,
      (a ->> 'not_pepite')::int - (b ->> 'not_pepite')::int
    )
    from pgtap_773_admin t1,
         pgtap_773_admin t2,
         jsonb_array_elements(t1.body -> 'counters') a,
         jsonb_array_elements(t2.body -> 'counters') b
    where t1.label = 'after' and t2.label = 'before' and a ->> 'venue' = 'tribunal' and b ->> 'venue' = 'tribunal'
  ),
  '[3, 1, 1, 1]'::jsonb,
  'the court counters grow by the three visible evaluations (evaluated, pepite, to confirm, not pepite); the past sale is not counted'
);

-- Indépendance -------------------------------------------------------------------------------------------------
create temporary table pgtap_773_independence (body jsonb) on commit drop;
grant all on pgtap_773_independence to public;
set local role service_role;
insert into pgtap_773_independence values (public.admin_pepite_independence_sales());
reset role;

select is(
  (select array_agg(key order by key) from pgtap_773_independence t, jsonb_object_keys(t.body) as key),
  array['evaluable', 'pepites', 'sales']::text[],
  'the answer holds the two counts and the sales'
);
select ok(
  (select (body ->> 'evaluable')::int >= 4 and (body ->> 'pepites')::int >= 3 from pgtap_773_independence),
  'the counts include the pepites (published or to confirm) and every evaluable sale of the fixture'
);
select is(
  (select array_agg(s ->> 'id' order by s ->> 'id')
     from pgtap_773_independence t, jsonb_array_elements(t.body -> 'sales') s
    where s ->> 'id' like 'c7730000-1000-4000-8000-0000000000%'),
  array[
    'c7730000-1000-4000-8000-000000000001',
    'c7730000-1000-4000-8000-000000000003',
    'c7730000-1000-4000-8000-000000000004'
  ]::text[],
  'only the sales with a named prosecuting lawyer come back, past sales included (the control never filtered on visibility)'
);
select is(
  (select jsonb_build_object(
            'lawyer', s ->> 'lawyer_name', 'tribunal', s ->> 'tribunal',
            'is_pepite', s -> 'is_pepite', 'pending', s -> 'pending')
     from pgtap_773_independence t, jsonb_array_elements(t.body -> 'sales') s
    where s ->> 'id' = 'c7730000-1000-4000-8000-000000000001'),
  '{"lawyer": "Maître Jean Dupont", "tribunal": "Tribunal judiciaire de Bordeaux", "is_pepite": true, "pending": false}'::jsonb,
  'a row carries the matching fields and the pepite flags'
);
select is(
  (select (s -> 'pending')::boolean
     from pgtap_773_independence t, jsonb_array_elements(t.body -> 'sales') s
    where s ->> 'id' = 'c7730000-1000-4000-8000-000000000004'),
  false,
  'a sale that missed two criteria is evaluable but neither a pepite nor to confirm'
);
select ok(
  not exists (
    select 1 from pgtap_773_independence t, jsonb_array_elements(t.body -> 'sales') s
     where s ->> 'id' = 'c7730000-1000-4000-8000-000000000002'
  ),
  'a sale without a named lawyer cannot match a referenced lawyer: it is left out of the rows but counted in the totals'
);

select * from finish();

rollback;
