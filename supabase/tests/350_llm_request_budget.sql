begin;

select plan(16);

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

insert into public.llm_usage_events (
  provider, model, request_kind, request_key, request_status, succeeded,
  error_message, created_at
) values
  (
    'replicate', 'test/model:v1', 'fact_extraction', 'invalid-json-key',
    'failed', false, 'Replicate returned invalid JSON after retry', now() - interval '1 hour'
  ),
  (
    'replicate', 'test/model:v1', 'fact_extraction', 'structured-validation-key',
    'failed', false, '2 validation errors for LLMExtraction', now() - interval '1 hour'
  ),
  (
    'replicate', 'test/model:v1', 'fact_extraction', 'provider-failure-key',
    'failed', false, 'Replicate provider rejected the request with an invalid JSON body', now() - interval '1 hour'
  ),
  (
    'replicate', 'test/model:v1', 'fact_extraction', 'expired-invalid-json-key',
    'failed', false, 'Replicate returned invalid JSON after retry', now() - interval '25 hours'
  );

select throws_ok(
  $$
  select public.reserve_llm_request(
    'replicate', 'test/model:v1', 'fact_extraction', 1, 100,
    'invalid-json-key', null, null, null, 'facts', 'retry'
  )
  $$,
  'P0001',
  'Unresolved deterministic LLM request key is blocked for 24 hours after invalid JSON or structured validation failure; change evidence, prompt, or model before retry',
  'an exact key with a recent invalid JSON failure is blocked'
);

select throws_ok(
  $$
  select public.reserve_llm_request(
    'replicate', 'test/model:v1', 'fact_extraction', 1, 100,
    'structured-validation-key', null, null, null, 'facts', 'retry'
  )
  $$,
  'P0001',
  'Unresolved deterministic LLM request key is blocked for 24 hours after invalid JSON or structured validation failure; change evidence, prompt, or model before retry',
  'an exact key with a recent structured validation failure is blocked'
);

select lives_ok(
  $$
  select public.reserve_llm_request(
    'replicate', 'test/model:v1', 'fact_extraction', 1, 100,
    'provider-failure-key', null, null, null, 'facts', 'retry'
  )
  $$,
  'provider failures remain retryable rather than entering the deterministic format guard'
);

select lives_ok(
  $$
  select public.reserve_llm_request(
    'replicate', 'test/model:v1', 'fact_extraction', 1, 100,
    'invalid-json-key-v2', null, null, null, 'facts', 'repaired_prompt'
  )
  $$,
  'a changed request key remains eligible after a format failure'
);

select lives_ok(
  $$
  select public.reserve_llm_request(
    'replicate', 'test/model:v1', 'fact_extraction', 1, 100,
    'expired-invalid-json-key', null, null, null, 'facts', 'retry'
  )
  $$,
  'a format failure older than the 24-hour window is retryable'
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
