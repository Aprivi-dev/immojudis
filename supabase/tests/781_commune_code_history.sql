-- Table de passage des codes commune (migration 20261108120200) :
--   * table privée (schéma app_private), RLS activée, aucun droit pour anon ni authenticated ;
--   * les contraintes écartent un code mal formé, un passage vers le même code et une modalité inconnue ;
--   * public.commune_code_aliases rend les codes d'arrivée puis de départ, suit une chaîne, ne boucle pas, et n'est
--     exécutable que par le rôle de service.
begin;

select plan(13);

select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.commune_code_history'::regclass),
  'commune_code_history has row level security'
);

select ok(
  not has_table_privilege('anon', 'app_private.commune_code_history', 'select')
  and not has_table_privilege('authenticated', 'app_private.commune_code_history', 'select')
  and not has_table_privilege('authenticated', 'app_private.commune_code_history', 'insert'),
  'the browser roles have no right on commune_code_history'
);

select ok(
  has_table_privilege('service_role', 'app_private.commune_code_history', 'select')
  and has_table_privilege('service_role', 'app_private.commune_code_history', 'insert')
  and has_table_privilege('service_role', 'app_private.commune_code_history', 'delete'),
  'the service role reads and writes commune_code_history'
);

select throws_ok(
  $$ insert into app_private.commune_code_history (old_code, new_code, effective_on, modality) values ('2', '02564', '2026-01-01', '35') $$,
  '23514',
  null,
  'a malformed code is refused'
);
select throws_ok(
  $$ insert into app_private.commune_code_history (old_code, new_code, effective_on, modality) values ('02564', '02564', '2026-01-01', '35') $$,
  '23514',
  null,
  'a passage to the same code is refused'
);
select throws_ok(
  $$ insert into app_private.commune_code_history (old_code, new_code, effective_on, modality) values ('02077', '02564', '2026-01-01', '99') $$,
  '23514',
  null,
  'an unknown modality is refused'
);

insert into app_private.commune_code_history (old_code, new_code, effective_on, modality) values
  ('02077', '02564', '2026-01-01', '35'),
  ('02564', '02999', '2027-01-01', '32'),
  ('11111', '22222', '2020-01-01', '32'),
  ('11112', '22222', '2020-01-01', '32'),
  ('22222', '11111', '2021-01-01', '41');

select results_eq(
  $$ select alias, direction, depth from public.commune_code_aliases(array['02077']) order by alias $$,
  $$ values ('02564'::text, 'new'::text, 1), ('02999'::text, 'new'::text, 2) $$,
  'the arrival codes are returned, chains included'
);
select results_eq(
  $$ select alias, direction from public.commune_code_aliases(array['02564']) order by direction, alias $$,
  $$ values ('02999'::text, 'new'::text), ('02077'::text, 'old'::text) $$,
  'a code that merged later also gets its departure codes'
);
select results_eq(
  $$ select alias from public.commune_code_aliases(array['22222']) where direction = 'old' order by alias $$,
  $$ values ('11111'::text), ('11112'::text) $$,
  'several departure codes are all returned'
);
select is(
  (select count(*) from public.commune_code_aliases(array['22222', '11111'])),
  (select count(*) from (select distinct code, alias, direction from public.commune_code_aliases(array['22222', '11111'])) d),
  'a loop of passages terminates and never repeats a row'
);
select is(
  (select count(*) from public.commune_code_aliases(array['00000', 'abc'])),
  0::bigint,
  'a code without passage gives nothing'
);
select is(
  (select count(*) from public.commune_code_aliases(array(select '02077' from generate_series(1, 501)))),
  0::bigint,
  'more than 500 codes at once are refused (empty answer)'
);
select ok(
  has_function_privilege('service_role', 'public.commune_code_aliases(text[])', 'execute')
  and not has_function_privilege('anon', 'public.commune_code_aliases(text[])', 'execute')
  and not has_function_privilege('authenticated', 'public.commune_code_aliases(text[])', 'execute'),
  'only the service role can run commune_code_aliases'
);

select * from finish();

rollback;
