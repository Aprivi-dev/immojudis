begin;

select plan(20);

-- The dispatcher must not pay the source-detail admission cost while an
-- existing run still owns the single pipeline lease.  Replace the public
-- entry point only inside this fixture transaction, before switching to the
-- worker role.  SECURITY DEFINER lets the wrapper increment the temporary
-- table after SET ROLE; the transaction rollback restores the production
-- function byte-for-byte.
create temporary table pgtap_scheduler_enqueue_calls (
  calls integer not null default 0
) on commit drop;

insert into pgtap_scheduler_enqueue_calls default values;

grant select, update on pgtap_scheduler_enqueue_calls to service_role;

create or replace function public.enqueue_due_source_details(
  p_now timestamptz default pg_catalog.now(),
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  update pg_temp.pgtap_scheduler_enqueue_calls
     set calls = calls + 1;
  return 0;
end;
$$;

set local role service_role;

-- Keep the fixture isolated from any baseline worker or queue rows.  Every
-- mutation is rolled back at the end of this file, so no production state is
-- changed by the behavioral assertions.
delete from public.auction_enrichment_jobs;
delete from public.auction_runs where status in ('queued', 'running');
update public.auction_source_state
   set enabled = false,
       next_inventory_at = statement_timestamp() + interval '1 day';
update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = false,
       enrichment_drain_until = null,
       queue_claim_not_before = null,
       source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() + interval '1 hour'
 where id;

select ok(
  to_regprocedure('public.claim_autonomous_pipeline_run()') is not null
  and has_function_privilege(
    'service_role',
    'public.claim_autonomous_pipeline_run()',
    'execute'
  ),
  'the service role can exercise the autonomous scheduler claim'
);

select ok(
  position(
    'perform public.enqueue_due_source_details(now_at,500);'
    in pg_get_functiondef('public.claim_autonomous_pipeline_run()'::regprocedure)
  ) > position(
    'if active_id is not null then'
    in pg_get_functiondef('public.claim_autonomous_pipeline_run()'::regprocedure)
  )
  and position(
    'perform public.enqueue_due_source_details(now_at,500);'
    in pg_get_functiondef('public.claim_autonomous_pipeline_run()'::regprocedure)
  ) < position(
    'update public.auction_source_state s set next_inventory_at'
    in pg_get_functiondef('public.claim_autonomous_pipeline_run()'::regprocedure)
  ),
  'detail admission occurs after active-run handling and before source arbitration'
);

-- A non-scheduler manual worker keeps the legacy lease and blocks the tick.
insert into public.auction_runs (
  id, status, source, scheduler_owned, started_at, created_at, updated_at, summary, errors
)
values (
  '40400000-0000-4000-8000-000000000001',
  'running',
  'pgtap-manual-running',
  false,
  statement_timestamp() - interval '30 minutes',
  statement_timestamp() - interval '30 minutes',
  statement_timestamp(),
  '{}'::jsonb,
  '{}'::jsonb
);

select is(
  public.claim_autonomous_pipeline_run(),
  null::jsonb,
  'a running manual worker keeps the scheduler blocked'
);

select is(
  (select calls from pgtap_scheduler_enqueue_calls),
  0,
  'a running manual worker skips source-detail admission'
);

delete from public.auction_runs where id = '40400000-0000-4000-8000-000000000001';

-- A running scheduler-owned worker is also a hard single-writer boundary.
insert into public.auction_runs (
  id, status, source, scheduler_owned, started_at, created_at, updated_at, summary, errors
)
values (
  '40400000-0000-4000-8000-000000000002',
  'running',
  'pgtap-automatic-running',
  true,
  statement_timestamp() - interval '30 minutes',
  statement_timestamp() - interval '30 minutes',
  statement_timestamp(),
  '{}'::jsonb,
  '{}'::jsonb
);

select is(
  public.claim_autonomous_pipeline_run(),
  null::jsonb,
  'a running scheduler-owned worker keeps the scheduler blocked'
);

select is(
  (select calls from pgtap_scheduler_enqueue_calls),
  0,
  'a running scheduler-owned worker skips source-detail admission'
);

delete from public.auction_runs where id = '40400000-0000-4000-8000-000000000002';

-- An accepted queued dispatch already has an external delivery in flight; it
-- must not be re-admitted or made to compete with source-detail discovery.
insert into public.auction_runs (
  id, status, source, scheduler_owned, started_at, created_at, updated_at, summary, errors
)
values (
  '40400000-0000-4000-8000-000000000003',
  'queued',
  'enrichment-queue',
  true,
  statement_timestamp(),
  statement_timestamp(),
  statement_timestamp(),
  jsonb_build_object(
    'github_dispatch', jsonb_build_object(
      'version', 1,
      'attempt', 1,
      'max_attempts', 4,
      'state', 'accepted',
      'next_attempt_at', statement_timestamp() - interval '1 minute',
      'lease_until', statement_timestamp() + interval '1 hour'
    )
  ),
  '{}'::jsonb
);

select is(
  public.claim_autonomous_pipeline_run(),
  null::jsonb,
  'an accepted queued dispatch remains pending without a new claim'
);

select is(
  (select calls from pgtap_scheduler_enqueue_calls),
  0,
  'an accepted queued dispatch skips source-detail admission'
);

delete from public.auction_runs where id = '40400000-0000-4000-8000-000000000003';

-- A due retry increments the existing dispatch attempt and returns the same
-- run id.  It is not a new scheduler decision, so the expensive detail scan
-- must still be skipped.
insert into public.auction_runs (
  id, status, source, scheduler_owned, started_at, created_at, updated_at, summary, errors
)
values (
  '40400000-0000-4000-8000-000000000004',
  'queued',
  'enrichment-queue',
  true,
  statement_timestamp(),
  statement_timestamp(),
  statement_timestamp(),
  jsonb_build_object(
    'github_dispatch', jsonb_build_object(
      'version', 1,
      'attempt', 0,
      'max_attempts', 4,
      'state', 'in_flight',
      'next_attempt_at', statement_timestamp() - interval '1 minute',
      'lease_until', statement_timestamp() + interval '1 hour'
    )
  ),
  '{}'::jsonb
);

create temporary table pgtap_scheduler_claims (
  case_name text primary key,
  payload jsonb
) on commit drop;

insert into pgtap_scheduler_claims (case_name, payload)
values ('queued-retry', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'id' from pgtap_scheduler_claims where case_name = 'queued-retry'),
  '40400000-0000-4000-8000-000000000004',
  'a due queued retry returns the existing run id'
);

select is(
  (select payload->>'attempt' from pgtap_scheduler_claims where case_name = 'queued-retry'),
  '1',
  'a due queued retry increments its dispatch attempt once'
);

select is(
  (select calls from pgtap_scheduler_enqueue_calls),
  0,
  'a due queued retry skips source-detail admission'
);

delete from public.auction_runs where id = '40400000-0000-4000-8000-000000000004';

-- With no active run and a future worker cadence, the idle scheduler may
-- perform one bounded discovery pass even though it ultimately returns no
-- run.  This is the one positive admission count in the busy matrix.
insert into pgtap_scheduler_claims (case_name, payload)
values ('idle', public.claim_autonomous_pipeline_run());

select is(
  (select payload from pgtap_scheduler_claims where case_name = 'idle'),
  null::jsonb,
  'an idle scheduler with a future cadence creates no run'
);

select is(
  (select calls from pgtap_scheduler_enqueue_calls),
  1,
  'an idle scheduler performs one source-detail admission pass'
);

-- An expired manual lease is first marked failed.  The scheduler then
-- continues normally: it admits details once and can create a fresh queue
-- dispatch when a due job and a due source are present.
update public.auction_pipeline_control
   set next_enrichment_at = statement_timestamp() - interval '5 minutes',
       source_dispatch_streak = 0
 where id;

insert into public.auction_source_state (
  source_name,
  enabled,
  next_inventory_at
)
values (
  'pgtap-404-expired-source',
  true,
  statement_timestamp() - interval '5 minutes'
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
  '40400000-1000-4000-8000-000000000001',
  'pgtap-404-expired-queue',
  'https://example.test/pgtap/404/expired-queue',
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
);

insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  next_attempt_at
)
values (
  'https://example.test/pgtap/404/expired-queue',
  'display_description',
  'queued',
  100,
  'pgtap-404-expired-queue-v1',
  statement_timestamp() - interval '1 minute'
);

insert into public.auction_runs (
  id, status, source, scheduler_owned, started_at, created_at, updated_at, summary, errors
)
values (
  '40400000-0000-4000-8000-000000000005',
  'running',
  'pgtap-expired-manual',
  false,
  statement_timestamp() - interval '4 hours',
  statement_timestamp() - interval '4 hours',
  statement_timestamp() - interval '4 hours',
  '{}'::jsonb,
  '{}'::jsonb
);

update pg_temp.pgtap_scheduler_enqueue_calls set calls = 0;

insert into pgtap_scheduler_claims (case_name, payload)
values ('expired-manual', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_scheduler_claims where case_name = 'expired-manual'),
  'enrichment',
  'an expired manual lease does not block a new due queue claim'
);

select is(
  (select payload->>'source' from pgtap_scheduler_claims where case_name = 'expired-manual'),
  'enrichment-queue',
  'the post-expiry claim keeps the queue/source arbitration path'
);

select is(
  (
    select status
      from public.auction_runs
     where id = '40400000-0000-4000-8000-000000000005'
  ),
  'failed',
  'an expired manual lease is marked failed before the next claim'
);

select is(
  (
    select summary->>'completion_status'
      from public.auction_runs
     where id = '40400000-0000-4000-8000-000000000005'
  ),
  'lease_expired',
  'the expired manual lease records the lease-expired completion reason'
);

select is(
  (select calls from pgtap_scheduler_enqueue_calls),
  1,
  'an expired manual lease performs exactly one post-expiry admission pass'
);

select is(
  (
    select count(*)
      from public.auction_enrichment_jobs
     where source_url = 'https://example.test/pgtap/404/expired-queue'
       and status = 'queued'
       and attempt_count < max_attempts
       and next_attempt_at <= statement_timestamp()
  ),
  1::bigint,
  'the existing due queue job remains available after the admission pass'
);

select is(
  (
    select count(*)
      from public.auction_runs
     where source = 'enrichment-queue'
       and status = 'queued'
       and scheduler_owned
  ),
  1::bigint,
  'the expired-lease recovery creates one scheduler-owned queue run'
);

select * from finish();

rollback;
