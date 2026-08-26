begin;

select plan(9);

select ok(
  to_regprocedure('public.enforce_data_api_object_boundary()') is not null,
  'the Data API boundary hook exists'
);

select ok(
  not (
    select function_row.prosecdef
    from pg_proc function_row
    where function_row.oid =
      'public.enforce_data_api_object_boundary()'::regprocedure
  ),
  'the boundary hook runs with invoker privileges'
);

select ok(
  (
    select function_row.proconfig @> array['search_path=""']::text[]
    from pg_proc function_row
    where function_row.oid =
      'public.enforce_data_api_object_boundary()'::regprocedure
  ),
  'the boundary hook has an empty search path'
);

select ok(
  (
    select role_row.rolconfig @> array[
      'pgrst.db_pre_request=public.enforce_data_api_object_boundary'
    ]::text[]
    from pg_roles role_row
    where role_row.rolname = 'authenticator'
  ),
  'PostgREST invokes the boundary hook before every Data API request'
);

select ok(
  has_function_privilege(
    'anon',
    'public.enforce_data_api_object_boundary()',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.enforce_data_api_object_boundary()',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.enforce_data_api_object_boundary()',
    'EXECUTE'
  ),
  'every Data API request role can execute the pre-request hook'
);

set local request.path = 'auction_sales';
set local role anon;

select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'anonymous application endpoints remain available'
);

reset role;
set local request.path = 'spatial_ref_sys';
set local role anon;

select throws_ok(
  'select public.enforce_data_api_object_boundary()',
  '42501',
  'Data API access denied for Supabase-managed PostGIS object',
  'anonymous callers cannot reach spatial_ref_sys through the Data API'
);

reset role;
set local request.path = 'rpc/st_estimatedextent';
set local role authenticated;

select throws_ok(
  'select public.enforce_data_api_object_boundary()',
  '42501',
  'Data API access denied for Supabase-managed PostGIS object',
  'authenticated callers cannot invoke st_estimatedextent through the Data API'
);

reset role;
set local request.path = 'rpc/st_estimatedextent';
set local role service_role;

select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'trusted server-side PostGIS operations remain available'
);

reset role;

select * from finish();

rollback;
