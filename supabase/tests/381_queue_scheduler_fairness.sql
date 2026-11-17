begin;

select plan(23);

select ok(
  to_regprocedure(
    'app_private.pipeline_queue_should_preempt_source(boolean,timestamptz,timestamptz)'
  ) is not null,
  'the queue/source arbitration helper exists'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    null,
    '2026-09-28 12:00:00+00'::timestamptz
  ),
  true,
  'a due queue is selected when no source is due'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    '2026-09-28 11:30:00+00'::timestamptz,
    '2026-09-28 12:00:00+00'::timestamptz
  ),
  true,
  'a due queue may preempt a source inside the one-hour lateness budget'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    '2026-09-28 09:59:59+00'::timestamptz,
    '2026-09-28 12:00:00+00'::timestamptz
  ),
  false,
  'a source overdue by more than one hour keeps its collection turn'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    false,
    '2026-09-28 11:30:00+00'::timestamptz,
    '2026-09-28 12:00:00+00'::timestamptz
  ),
  false,
  'a queue that is not due never preempts collection'
);

-- Since 20261203100000 the collections and the queue are two scheduling lanes: the dispatcher no longer arbitrates
-- between them (the helper stays in place for a rollback, its pure rule is still tested above).
select ok(
  position(
    'pipeline_queue_should_preempt_source' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) = 0,
  'the two-lane dispatcher no longer arbitrates between the queue and a source'
);

select ok(
  position(
    'next_attempt_at' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) > 0
  and position(
    'lease_until' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) > 0,
  'the fairness migration preserves dispatch retry and lease metadata'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.pipeline_queue_should_preempt_source(boolean,timestamptz,timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.pipeline_queue_should_preempt_source(boolean,timestamptz,timestamptz)',
    'execute'
  ),
  'the arbitration helper is not exposed to client roles'
);

select ok(
  position(
    'auction_observations' in pg_get_functiondef(
      'public.auction_all_source_freshness(timestamptz)'::regprocedure
    )
  ) > 0
  and to_regclass('public.auction_pipeline_observations_complete_source_time_idx') is not null,
  'the health observer uses normalized observations and its partial index'
);

select ok(
  position(
    'timeout_milliseconds => 30000' in pg_get_functiondef(
      'app_private.invoke_operational_health_endpoint()'::regprocedure
    )
  ) > 0,
  'the Vault-backed health callback keeps the existing 30-second timeout'
);

select ok(
  position(
    'interval ''1 hour''' in pg_get_functiondef(
      'app_private.pipeline_queue_should_preempt_source(boolean,timestamptz,timestamptz)'::regprocedure
    )
  ) > 0,
  'the source lateness budget remains explicitly bounded to one hour'
);

-- Exercise the dispatcher with a small, isolated fixture.  The helper tests
-- above prove the pure arbitration rule; these calls prove that the two-lane
-- claim RPC (20261203100000) collects a due source at once and still claims
-- the due queue in the same tick, on its own lane.
set local role service_role;

update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = false,
       next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into public.auction_source_state (
  source_name,
  enabled,
  next_inventory_at
)
values
  (
    'pgtap-scheduler-recent',
    true,
    statement_timestamp() - interval '30 minutes'
  );

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values (
  'f3810000-0000-4000-8000-000000000001',
  'pgtap-scheduler-queue',
  'https://example.test/pgtap/scheduler/queue',
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
);

-- Keep this job explicit: the dispatcher only needs one due, retryable queue
-- row, and the sale insert trigger may be disabled or changed independently
-- of this scheduler contract.
insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  next_attempt_at
)
values (
  'https://example.test/pgtap/scheduler/queue',
  'display_description',
  'queued',
  100,
  'pgtap-scheduler-queue-v1',
  statement_timestamp()
);

create temporary table pgtap_scheduler_claims (
  case_name text primary key,
  payload jsonb
) on commit drop;

insert into pgtap_scheduler_claims (case_name, payload)
values ('recent-source-collection', public.claim_autonomous_pipeline_run());
insert into pgtap_scheduler_claims (case_name, payload)
values ('recent-source', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'source' from pgtap_scheduler_claims where case_name = 'recent-source-collection'),
  'pgtap-scheduler-recent',
  'a source less than one hour late is collected at once: the queue no longer preempts it'
);

select is(
  (select payload->>'source' from pgtap_scheduler_claims where case_name = 'recent-source'),
  'enrichment-queue',
  'the second claim of the tick creates the enrichment queue run on its own lane'
);

select is(
  (
    select count(*)
    from public.auction_runs
    where id = (
      select (payload->>'id')::uuid
      from pgtap_scheduler_claims
      where case_name = 'recent-source'
    )
      and status = 'queued'
      and scheduler_owned
      and summary->>'mode' = 'enrichment'
      and summary->'github_dispatch'->>'state' = 'in_flight'
  ),
  1::bigint,
  'the queue claim persists a scheduler-owned leased enrichment run'
);

select is(
  (
    select summary->'github_dispatch'->>'attempt'
    from public.auction_runs
    where id = (
      select (payload->>'id')::uuid
      from pgtap_scheduler_claims
      where case_name = 'recent-source'
    )
  ),
  '1',
  'a new queue claim starts with dispatch attempt one'
);

select is(
  (
    select summary->'github_dispatch'->>'max_attempts'
    from public.auction_runs
    where id = (
      select (payload->>'id')::uuid
      from pgtap_scheduler_claims
      where case_name = 'recent-source'
    )
  ),
  '4',
  'a new queue claim carries the bounded four-attempt retry budget'
);

select ok(
  (
    select next_inventory_at >= statement_timestamp() + interval '11 hours'
    from public.auction_source_state
    where source_name = 'pgtap-scheduler-recent'
  ),
  'the collected recent source moves to its next inventory turn'
);

-- Remove the first fixture run so the next scheduler decision can exercise
-- the older-source branch in the same transaction.  The test transaction
-- rolls back all fixture changes at the end of the file.
delete from public.auction_runs
 where id in (
   select (payload->>'id')::uuid
   from pgtap_scheduler_claims
   where case_name in ('recent-source', 'recent-source-collection')
 );
delete from public.auction_source_state
 where source_name = 'pgtap-scheduler-recent';
insert into public.auction_source_state (
  source_name,
  enabled,
  next_inventory_at
)
values (
  'pgtap-scheduler-overdue',
  true,
  statement_timestamp() - interval '2 hours'
);
update public.auction_pipeline_control
   set next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into pgtap_scheduler_claims (case_name, payload)
values ('overdue-source', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_scheduler_claims where case_name = 'overdue-source'),
  'collect',
  'a source more than one hour late keeps its collection turn'
);

select is(
  (select payload->>'source' from pgtap_scheduler_claims where case_name = 'overdue-source'),
  'pgtap-scheduler-overdue',
  'the overdue-source arbitration creates a collection run for that source'
);

select is(
  (
    select count(*)
    from public.auction_runs
    where id = (
      select (payload->>'id')::uuid
      from pgtap_scheduler_claims
      where case_name = 'overdue-source'
    )
      and status = 'queued'
      and scheduler_owned
      and summary->>'mode' = 'collect'
      and summary->'github_dispatch'->>'state' = 'in_flight'
  ),
  1::bigint,
  'the collection claim persists a scheduler-owned leased source run'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/scheduler/queue'
      and input_hash = 'pgtap-scheduler-queue-v1'
      and status in ('queued', 'failed')
      and attempt_count < max_attempts
      and next_attempt_at <= statement_timestamp()
  ),
  1::bigint,
  'the collection turn leaves the due enrichment work available for the next tick'
);

select ok(
  (
    select next_inventory_at >= statement_timestamp() + interval '5 hours'
    from public.auction_source_state
    where source_name = 'pgtap-scheduler-overdue'
  ),
  'a claimed source is postponed for its six-hour inventory cadence'
);

select is(
  (
    select count(*)
    from public.auction_pipeline_control
    where id
      and next_enrichment_at <= statement_timestamp()
  ),
  1::bigint,
  'a collection claim leaves the due enrichment cadence available for the next tick'
);

select * from finish();

rollback;
