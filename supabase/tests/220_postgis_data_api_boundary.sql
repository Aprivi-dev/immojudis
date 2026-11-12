begin;
-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte
-- connecté : ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;

select plan(27);

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
  'Data API access denied for an extension object',
  'anonymous callers cannot reach spatial_ref_sys through the Data API'
);

reset role;
set local request.path = 'rpc/st_estimatedextent';
set local role authenticated;

select throws_ok(
  'select public.enforce_data_api_object_boundary()',
  '42501',
  'Data API access denied for an extension object',
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

-- Lot R2c du registre des pièces (20261119100050) : la garde refuse tout chemin encodé et tout appel rpc/ d'une
-- fonction du schéma public qui appartient à une extension. PostGIS y est installé, ses fonctions sont exécutables
-- par anon et authenticated (droits de la plateforme), et plusieurs exécutent du SQL reçu en argument.
select ok(
  (select count(*) > 100
     from pg_proc routine
     join pg_depend dependency
       on dependency.classid = 'pg_proc'::regclass and dependency.objid = routine.oid and dependency.deptype = 'e'
     where routine.pronamespace = 'public'::regnamespace
       and has_function_privilege('authenticated', routine.oid, 'EXECUTE'))
  and to_regprocedure('public.st_findextent(text, text)') is not null,
  'the public schema holds extension functions that authenticated can execute, st_findextent among them: the guard is what keeps them out of the Data API'
);

-- Fonctions d'extension, quel que soit leur nom d'argument, la casse du chemin ou son préfixe.
set local request.path = '/rpc/st_findextent';
set local role authenticated;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an extension object',
  'authenticated callers cannot invoke st_findextent, which runs the text it receives'
);
reset role;
set local role anon;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an extension object',
  'nor anonymous callers'
);
reset role;
set local request.path = 'rpc/_postgis_stats';
set local role authenticated;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an extension object',
  'an internal PostGIS function is refused too'
);
reset role;
set local request.path = 'rpc/populate_geometry_columns';
set local role authenticated;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an extension object',
  'and populate_geometry_columns'
);
reset role;
set local request.path = '/rest/v1/rpc/ST_FindExtent/';
set local role authenticated;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an extension object',
  'the name is compared in lower case, with or without the rest/v1 prefix'
);
reset role;
set local request.path = '/RPC//st_findextent';
set local role authenticated;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an extension object',
  'and the rpc segment too'
);
reset role;
set local request.path = 'SPATIAL_REF_SYS';
set local role anon;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an extension object',
  'spatial_ref_sys is refused whatever its case'
);
reset role;

-- Chemin encodé : jamais comparé tel quel à un nom.
set local request.path = '/rpc/st%5Festimatedextent';
set local role authenticated;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an encoded request path',
  'an encoded path does not pass the guard: rpc/st%5Festimatedextent is refused'
);
reset role;
set local request.path = 'spatial%5Fref%5Fsys';
set local role anon;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an encoded request path',
  'nor spatial%5Fref%5Fsys'
);
reset role;
set local request.path = '/rpc/accept%5Fauction_fact_claim';
set local role authenticated;
select throws_ok(
  'select public.enforce_data_api_object_boundary()', '42501',
  'Data API access denied for an encoded request path',
  'any encoded path is refused, even to a function of the repository: the application never sends one'
);
reset role;

-- Les fonctions du dépôt passent, et les tables : la garde ne lit que le chemin, pas la chaîne de requête.
set local request.path = '/rpc/accept_auction_fact_claim';
set local role authenticated;
select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'a decision function of the fact registry is not an extension function: the guard lets it through'
);
reset role;
set local request.path = '/rpc/search_auction_sales_preview_v3';
set local role anon;
select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'a function the application already calls stays available to anonymous callers'
);
reset role;
set local request.path = '/rpc/get_withdrawn_catalogue_sources';
set local role authenticated;
select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'and to authenticated callers'
);
reset role;
set local request.path = '/rpc/no_such_function';
set local role authenticated;
select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'an unknown function name is left to PostgREST, which answers not found'
);
reset role;
set local request.path = '/user_profiles';
set local role authenticated;
select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'tables stay available'
);
reset role;
set local request.path = '/';
set local role anon;
select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'and the root of the API'
);
reset role;
set local request.path = '/rpc/st_findextent';
set local role service_role;
select lives_ok(
  'select public.enforce_data_api_object_boundary()',
  'the server role is not concerned by the guard'
);
reset role;

select * from finish();

rollback;
