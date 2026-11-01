-- 20261110130000 : le compteur de vues d'un rapport partagé s'incrémente en une instruction et seul le rôle de
-- service peut l'appeler.
begin;

select plan(5);

select ok(
  has_function_privilege('service_role', 'public.increment_property_report_share_view(uuid)', 'execute'),
  'the service role can increment the share view counter'
);

select ok(
  not has_function_privilege('anon', 'public.increment_property_report_share_view(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.increment_property_report_share_view(uuid)', 'execute'),
  'neither anon nor authenticated can call the counter'
);

select ok(
  not (select prosecdef from pg_proc where oid = 'public.increment_property_report_share_view(uuid)'::regprocedure),
  'the counter runs as its caller (SECURITY INVOKER)'
);

select is(
  (select proconfig from pg_proc where oid = 'public.increment_property_report_share_view(uuid)'::regprocedure),
  array['search_path=""']::text[],
  'the counter pins an empty search_path'
);

select is(
  public.increment_property_report_share_view('00000000-0000-4000-8000-000000000000'::uuid),
  null::integer,
  'an unknown report is not counted'
);

select * from finish();
rollback;
