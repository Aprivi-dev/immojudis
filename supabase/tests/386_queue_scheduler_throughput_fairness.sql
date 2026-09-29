begin;

select plan(13);

set local role service_role;

select ok(
  exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'auction_pipeline_control'
       and column_name = 'source_dispatch_streak'
  ),
  'the scheduler stores its bounded collection streak'
);

update public.auction_pipeline_control
   set source_dispatch_streak = 0,
       enabled = true,
       source_details_enabled = false,
       next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    statement_timestamp() - interval '2 hours',
    statement_timestamp()
  ),
  false,
  'the first overdue source keeps its collection turn'
);

update public.auction_pipeline_control
   set source_dispatch_streak = 1
 where id;

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    statement_timestamp() - interval '2 hours',
    statement_timestamp()
  ),
  true,
  'one overdue collection turn lets the due queue preempt the source'
);

update public.auction_pipeline_control
   set source_dispatch_streak = 2
 where id;

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    statement_timestamp() - interval '2 hours',
    statement_timestamp()
  ),
  true,
  'a persisted source streak above the bound still lets the due queue run'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    statement_timestamp() - interval '30 minutes',
    statement_timestamp()
  ),
  true,
  'a due queue may still preempt a source within the one-hour freshness budget'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    false,
    statement_timestamp() - interval '30 minutes',
    statement_timestamp()
  ),
  false,
  'a queue that is not due never preempts a source'
);

-- Verify the streak is advanced by collection claims and reset by a queue
-- claim, rather than relying only on the pure helper above.
update public.auction_pipeline_control
   set source_dispatch_streak = 0
 where id;

insert into public.auction_runs (
  status, source, scheduler_owned, summary, errors
) values (
  'queued', 'pgtap-throughput-source', true, '{}'::jsonb, '{}'::jsonb
);

select is(
  (select source_dispatch_streak from public.auction_pipeline_control where id),
  1,
  'a scheduler-owned collection claim increments the streak'
);

insert into public.auction_runs (
  status, source, scheduler_owned, summary, errors
) values (
  'queued', 'enrichment-queue', true, '{}'::jsonb, '{}'::jsonb
);

select is(
  (select source_dispatch_streak from public.auction_pipeline_control where id),
  0,
  'a scheduler-owned queue claim resets the streak'
);

-- The trigger fixtures must not become active dispatcher leases for the
-- integration checks below.
delete from public.auction_runs
 where source in ('pgtap-throughput-source', 'enrichment-queue')
   and status = 'queued';

-- Multiple independent overdue sources prove the actual claim RPC gives the
-- queue a turn after one collection claim, then resumes collection. The
-- transaction rolls all fixtures back at the end of the test.
insert into public.auction_source_state (source_name, enabled, next_inventory_at)
values
  ('pgtap-throughput-a', true, statement_timestamp() - interval '4 hours'),
  ('pgtap-throughput-b', true, statement_timestamp() - interval '3 hours'),
  ('pgtap-throughput-c', true, statement_timestamp() - interval '2 hours'),
  ('pgtap-throughput-d', true, statement_timestamp() - interval '2 hours');

insert into public.auction_sales (
  source_name, source_url, status, sale_date, raw_payload
) values (
  'pgtap-throughput-queue',
  'https://example.test/pgtap/throughput/queue',
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
);

insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, next_attempt_at
) values (
  'https://example.test/pgtap/throughput/queue',
  'display_description',
  'queued',
  100,
  'pgtap-throughput-queue-v1',
  statement_timestamp()
);

create temporary table pgtap_throughput_claims (
  ordinal integer primary key,
  payload jsonb
) on commit drop;

insert into pgtap_throughput_claims (ordinal, payload)
values (1, public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_throughput_claims where ordinal = 1),
  'collect',
  'the first overdue source keeps its collection turn'
);

delete from public.auction_runs
 where id = (select (payload->>'id')::uuid from pgtap_throughput_claims where ordinal = 1);

insert into pgtap_throughput_claims (ordinal, payload)
values (2, public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_throughput_claims where ordinal = 2),
  'enrichment',
  'the due queue runs after one overdue source claim'
);

select is(
  (
    select next_enrichment_at > statement_timestamp() + interval '29 minutes'
       and next_enrichment_at < statement_timestamp() + interval '31 minutes'
    from public.auction_pipeline_control
    where id
  ),
  true,
  'the queue turn advances the existing 30-minute enrichment cadence'
);

delete from public.auction_runs
 where id = (select (payload->>'id')::uuid from pgtap_throughput_claims where ordinal = 2);

insert into pgtap_throughput_claims (ordinal, payload)
values (3, public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_throughput_claims where ordinal = 3),
  'collect',
  'collection resumes after the bounded queue turn'
);

delete from public.auction_runs
 where id = (select (payload->>'id')::uuid from pgtap_throughput_claims where ordinal = 3);

select is(
  (select source_dispatch_streak from public.auction_pipeline_control where id),
  1,
  'the resumed source claim starts the next bounded streak'
);

select * from finish();
rollback;
