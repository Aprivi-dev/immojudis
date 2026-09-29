begin;

select plan(12);

select has_function(
  'public',
  'claim_information_agent_inbound_jobs',
  array['integer', 'timestamp with time zone'],
  'lease-fenced inbound claim function exists'
);
select ok(
  position('fenced_messages' in pg_get_functiondef(
    'public.claim_information_agent_inbound_jobs(integer,timestamptz)'::regprocedure
  )) > 0
  and position('jsonb_build_object(''lease_id''' in pg_get_functiondef(
    'public.claim_information_agent_inbound_jobs(integer,timestamptz)'::regprocedure
  )) > 0,
  'claim replaces the message-side lease in the same database statement'
);
select ok(
  position('status = ''review''' in pg_get_functiondef(
    'public.claim_information_agent_inbound_jobs(integer,timestamptz)'::regprocedure
  )) > 0
  and position('lease_id}' in pg_get_functiondef(
    'public.claim_information_agent_inbound_jobs(integer,timestamptz)'::regprocedure
  )) > 0,
  'terminal stale leases clear the message-side fence'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_information_agent_inbound_jobs(integer,timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.claim_information_agent_inbound_jobs(integer,timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_information_agent_inbound_jobs(integer,timestamptz)',
    'execute'
  ),
  'only service role can invoke the lease-fenced claim'
);
select ok(
  not has_table_privilege('anon', 'public.information_agent_inbound_jobs', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_inbound_jobs', 'SELECT'),
  'browser roles cannot read inbound jobs'
);
select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.information_agent_inbound_jobs'::regclass
  ),
  'inbound jobs retain row level security'
);
select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.claim_information_agent_inbound_jobs(integer,timestamptz)'::regprocedure
  ),
  'claim function uses an empty search path'
);
select ok(
  position('for update skip locked' in pg_get_functiondef(
    'public.claim_information_agent_inbound_jobs(integer,timestamptz)'::regprocedure
  )) > 0,
  'claim keeps row locking and skip-locked concurrency semantics'
);
select has_function(
  'app_private',
  'enforce_information_agent_inbound_write_lease',
  array[]::text[],
  'evidence and fact inserts have a database lease fence'
);
select ok(
  not has_function_privilege(
    'anon',
    'app_private.enforce_information_agent_inbound_write_lease()',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.enforce_information_agent_inbound_write_lease()',
    'execute'
  ),
  'the trigger fence is not callable by API roles'
);
select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.information_agent_evidence_assets'::regclass
      and tgname = 'information_agent_evidence_assets_inbound_lease'
      and not tgisinternal
  )
  and exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.information_agent_fact_candidates'::regclass
      and tgname = 'information_agent_fact_candidates_inbound_lease'
      and not tgisinternal
  )
  and exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.information_agent_cases'::regclass
      and tgname = 'information_agent_cases_inbound_lease'
      and not tgisinternal
  )
  and exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.information_agent_missions'::regclass
      and tgname = 'information_agent_missions_inbound_lease'
      and not tgisinternal
  ),
  'case, mission, evidence, and fact writes enforce lease fencing'
);
select ok(
  position('for update' in pg_get_functiondef(
    'app_private.enforce_information_agent_inbound_write_lease()'::regprocedure
  )) > 0
  and position('tg_table_name' in pg_get_functiondef(
    'app_private.enforce_information_agent_inbound_write_lease()'::regprocedure
  )) > 0
  and position('row_message_id' in pg_get_functiondef(
    'app_private.enforce_information_agent_inbound_write_lease()'::regprocedure
  )) > 0
  and position('new.metadata := new.metadata - ''inbound_lease_id'' - ''inbound_message_id''' in pg_get_functiondef(
    'app_private.enforce_information_agent_inbound_write_lease()'::regprocedure
  )) > 0,
  'the fence serializes against claim, binds the target row, and strips its internal tokens'
);

select * from finish();
rollback;
