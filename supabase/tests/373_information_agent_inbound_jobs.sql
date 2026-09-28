begin;
select plan(9);

select has_table('public', 'information_agent_inbound_jobs', 'durable inbound queue exists');
select has_column('public', 'information_agent_inbound_jobs', 'message_id', 'queue binds to a persisted message');
select has_column('public', 'information_agent_inbound_jobs', 'lease_id', 'queue supports a claim lease');
select ok(
  exists (
    select 1
    from pg_class index_row
    join pg_namespace namespace_row on namespace_row.oid = index_row.relnamespace
    where namespace_row.nspname = 'public'
      and index_row.relname = 'information_agent_inbound_jobs_queue_idx'
      and index_row.relkind = 'i'
  ),
  'queue has a bounded claim index'
);
select has_function(
  'public',
  'claim_information_agent_inbound_jobs',
  array['integer', 'timestamp with time zone'],
  'queue exposes an atomic claim function'
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
  'only service role can claim inbound jobs'
);
select ok(
  not has_table_privilege('anon', 'public.information_agent_inbound_jobs', 'SELECT'),
  'anonymous clients cannot read inbound jobs'
);
select ok(
  not has_table_privilege('authenticated', 'public.information_agent_inbound_jobs', 'SELECT'),
  'authenticated clients cannot read inbound jobs'
);
select ok(
  position('information-agent-inbound' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'operational health tracks a stale inbound worker'
);

select * from finish();
rollback;
