begin;

select plan(5);

-- CI contract (P4-07): every SECURITY DEFINER function of the exposed `public` schema that anon
-- or authenticated can execute must be on this allowlist. Extension-owned objects (PostGIS's
-- st_estimatedextent) are excluded: they are blocked by enforce_data_api_object_boundary().
-- To add a function, justify it in the migration and extend the arrays below.
select is(
  (
    select coalesce(array_agg(function_row.oid::regprocedure::text order by function_row.oid::regprocedure::text), array[]::text[])
    from pg_proc function_row
    where function_row.pronamespace = 'public'::regnamespace
      and function_row.prosecdef
      and function_row.prokind in ('f', 'p')
      and not exists (
        select 1 from pg_depend dependency
        where dependency.objid = function_row.oid and dependency.deptype = 'e'
      )
      and has_function_privilege('anon', function_row.oid, 'execute')
  ),
  array[]::text[],
  'anon cannot execute any SECURITY DEFINER function of the public schema'
);

select is(
  (
    select coalesce(array_agg(function_row.oid::regprocedure::text order by function_row.oid::regprocedure::text), array[]::text[])
    from pg_proc function_row
    where function_row.pronamespace = 'public'::regnamespace
      and function_row.prosecdef
      and function_row.prokind in ('f', 'p')
      and not exists (
        select 1 from pg_depend dependency
        where dependency.objid = function_row.oid and dependency.deptype = 'e'
      )
      and has_function_privilege('authenticated', function_row.oid, 'execute')
  ),
  array[
    'catalogue_readiness_allows_premium(text,text,timestamp with time zone)',
    'clear_auction_sale_readiness_override(uuid)',
    'set_auction_sale_readiness_override(uuid,text,text,timestamp with time zone)',
    'set_catalogue_readiness_enforcement(boolean)'
  ]::text[],
  'authenticated executes only the allowlisted SECURITY DEFINER functions'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.decide_outcome_claim_eligibility(uuid,text,text,uuid[],text,uuid)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.review_judilibre_match_candidate(uuid,text,text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.review_outcome_evidence(uuid,text,text,jsonb,text)',
    'execute'
  ),
  'the outcome review RPCs are no longer callable from the browser'
);

-- A function created by the migration role must not be executable by PUBLIC any more.
create function app_private.p4_07_probe() returns integer language sql as 'select 1';
select ok(
  not has_function_privilege('authenticated', 'app_private.p4_07_probe()', 'execute')
  and not has_function_privilege('anon', 'app_private.p4_07_probe()', 'execute'),
  'a new function gets no implicit PUBLIC execute in any schema'
);

create function public.p4_07_probe() returns integer language sql as 'select 1';
select ok(
  has_function_privilege('service_role', 'public.p4_07_probe()', 'execute')
  and not has_function_privilege('anon', 'public.p4_07_probe()', 'execute')
  and not has_function_privilege('authenticated', 'public.p4_07_probe()', 'execute'),
  'a new public function is executable by service_role only'
);

select * from finish();
rollback;
