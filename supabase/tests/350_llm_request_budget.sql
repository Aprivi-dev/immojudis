begin;

select plan(11);

select ok(
  has_table_privilege('service_role', 'public.llm_usage_events', 'SELECT')
    and has_table_privilege('service_role', 'public.llm_usage_events', 'INSERT')
    and has_table_privilege('service_role', 'public.llm_usage_events', 'UPDATE'),
  'service role can write request reservations and finalize telemetry'
);

select ok(
  not has_table_privilege('anon', 'public.llm_usage_events', 'SELECT')
    and not has_table_privilege('authenticated', 'public.llm_usage_events', 'SELECT'),
  'request telemetry is not exposed to client roles'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.reserve_llm_request(text,text,text,integer,integer,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  'service role can reserve a request'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.reserve_llm_request(text,text,text,integer,integer,text,text,text,text,text,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.reserve_llm_request(text,text,text,integer,integer,text,text,text,text,text,text)',
      'EXECUTE'
    ),
  'client roles cannot reserve requests'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.finalize_llm_request(uuid,text,text,boolean,integer,integer,integer,integer,integer,text)',
    'EXECUTE'
  ),
  'service role can finalize a request'
);

set local role service_role;

select lives_ok(
  $$
  select public.reserve_llm_request(
    'replicate',
    'test/model:v1',
    'fact_extraction',
    1,
    10,
    'budget-test-key',
    'sale-test',
    'job-test',
    'https://example.test/sale',
    'facts',
    'cache_miss'
  )
  $$,
  'first request key can be atomically reserved'
);

select is(
  (
    select count(*)
    from public.llm_usage_events
    where request_key = 'budget-test-key'
      and request_status = 'reserved'
  ),
  1::bigint,
  'the reservation is counted before provider completion'
);

select throws_ok(
  $$
  select public.reserve_llm_request(
    'replicate', 'test/model:v1', 'fact_extraction', 2, 10,
    'budget-test-key', 'sale-test', 'job-test', null, 'facts', 'retry'
  )
  $$,
  'P0001',
  'Unresolved LLM request key requires provider reconciliation before retry',
  'an unresolved request key blocks a possible duplicate POST'
);

select lives_ok(
  $$
  select public.finalize_llm_request(
    (
      select id
      from public.llm_usage_events
      where request_key = 'budget-test-key'
      order by created_at desc
      limit 1
    ),
    'succeeded', 'prediction-test', true, 100, 20, 80, 30, 20, null
  )
  $$,
  'a reservation can be finalized with bounded telemetry'
);

select is(
  (
    select request_status
    from public.llm_usage_events
    where request_key = 'budget-test-key'
    order by created_at desc
    limit 1
  ),
  'succeeded',
  'finalization records the provider outcome'
);

select throws_ok(
  $$
  select public.reserve_llm_request(
    'replicate', 'test/model:v1', 'fact_extraction', 1, 1,
    'different-budget-key', null, null, null, 'facts', 'budget'
  )
  $$,
  'P0001',
  'Hourly LLM request budget exhausted',
  'the rolling hourly budget is enforced atomically'
);

select * from finish();

rollback;
