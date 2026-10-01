begin;

select plan(21);

set local role service_role;

-- The migration baseline may contain unrelated queue rows. The empty-queue
-- scenarios below need a genuinely empty queue and no pre-existing writer;
-- all changes are rolled back with the fixture transaction.
delete from public.auction_enrichment_jobs;
delete from public.auction_runs where status in ('queued', 'running');
update public.auction_source_state set enabled = false;
update public.auction_pipeline_control
   set enrichment_drain_until = null,
       queue_claim_not_before = null
 where id;

select ok(
  to_regprocedure(
    'app_private.pipeline_queue_should_preempt_source(boolean,timestamptz,timestamptz)'
  ) is not null,
  'the bounded queue/source arbitration helper exists'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    false,
    '2026-09-29 10:00:00+00'::timestamptz,
    '2026-09-29 12:00:00+00'::timestamptz
  ),
  false,
  'an ineligible queue never preempts an overdue source'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    null,
    '2026-09-29 12:00:00+00'::timestamptz
  ),
  true,
  'a due queue is selected when no source is due'
);

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    '2026-09-29 11:30:00+00'::timestamptz,
    '2026-09-29 12:00:00+00'::timestamptz
  ),
  true,
  'a due queue may preempt a source inside its one-hour freshness budget'
);

update public.auction_pipeline_control
   set source_dispatch_streak = 0
 where id;

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    '2026-09-29 10:00:00+00'::timestamptz,
    '2026-09-29 12:00:00+00'::timestamptz
  ),
  false,
  'the first overdue source claim keeps its collection turn'
);

update public.auction_pipeline_control
   set source_dispatch_streak = 1
 where id;

select is(
  app_private.pipeline_queue_should_preempt_source(
    true,
    '2026-09-29 10:00:00+00'::timestamptz,
    '2026-09-29 12:00:00+00'::timestamptz
  ),
  true,
  'the due queue receives the next turn after one overdue source claim'
);

select ok(
  position(
    'pg_try_advisory_xact_lock' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) > 0
  and position(
    'active_id' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) > 0,
  'the scheduler keeps its advisory lock and active-run single-writer guard'
);

update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = false,
       source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() + interval '1 hour'
 where id;

insert into public.auction_source_state (
  source_name,
  enabled,
  next_inventory_at
)
values (
  'pgtap-bounded-future',
  true,
  statement_timestamp() - interval '30 minutes'
);

insert into public.auction_sales (
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values (
  'pgtap-bounded-future-queue',
  'https://example.test/pgtap/bounded/future-queue',
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
  'https://example.test/pgtap/bounded/future-queue',
  'display_description',
  'queued',
  100,
  'pgtap-bounded-future-queue-v1',
  statement_timestamp()
);

create temporary table pgtap_bounded_claims (
  case_name text primary key,
  payload jsonb
) on commit drop;

-- An eligible job must still wait for next_enrichment_at when a source is
-- due.  This is the cadence guard, rather than an empty-queue case.
insert into pgtap_bounded_claims (case_name, payload)
values ('eligible-future-queue', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_bounded_claims where case_name = 'eligible-future-queue'),
  'collect',
  'a due source keeps its turn while an eligible queue is not yet due'
);

select ok(
  (
    select next_enrichment_at > statement_timestamp() + interval '50 minutes'
    from public.auction_pipeline_control
    where id
  ),
  'a source claim does not advance a future enrichment cadence'
);

select ok(
  (
    select count(*) = 1
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/bounded/future-queue'
      and input_hash = 'pgtap-bounded-future-queue-v1'
      and status = 'queued'
      and attempt_count < max_attempts
      and next_attempt_at <= statement_timestamp()
  ),
  'an eligible queue job remains available while its cadence is in the future'
);

delete from public.auction_runs
 where id = (
   select (payload->>'id')::uuid
   from pgtap_bounded_claims
   where case_name = 'eligible-future-queue'
 );

-- Remove the eligible fixture before exercising the empty-queue path.
update public.auction_enrichment_jobs
   set status = 'completed',
       completed_at = statement_timestamp(),
       updated_at = statement_timestamp()
 where source_url = 'https://example.test/pgtap/bounded/future-queue';

-- With an empty queue and an already due worker cadence, the source still
-- wins and the cadence remains due for the next queue-capable tick.
update public.auction_pipeline_control
   set source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into public.auction_source_state (
  source_name,
  enabled,
  next_inventory_at
)
values (
  'pgtap-bounded-due-empty',
  true,
  statement_timestamp() - interval '15 minutes'
);

insert into pgtap_bounded_claims (case_name, payload)
values ('no-job-due-queue', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_bounded_claims where case_name = 'no-job-due-queue'),
  'collect',
  'a due source is collected when the queue cadence is due but no job is eligible'
);

select ok(
  (
    select next_enrichment_at <= statement_timestamp()
    from public.auction_pipeline_control
    where id
  ),
  'an empty due queue leaves next_enrichment_at due'
);

delete from public.auction_runs
 where id = (
   select (payload->>'id')::uuid
   from pgtap_bounded_claims
   where case_name = 'no-job-due-queue'
 );

-- A queue due alongside two overdue sources proves the bounded priority in
-- the actual claim RPC: one source gets a turn, then the queue gets the next.
update public.auction_pipeline_control
   set source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into public.auction_source_state (
  source_name,
  enabled,
  next_inventory_at
)
values
  (
    'pgtap-bounded-old-a',
    true,
    statement_timestamp() - interval '3 hours'
  ),
  (
    'pgtap-bounded-old-b',
    true,
    statement_timestamp() - interval '2 hours'
  );

insert into public.auction_sales (
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values (
  'pgtap-bounded-queue',
  'https://example.test/pgtap/bounded/queue',
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
  'https://example.test/pgtap/bounded/queue',
  'display_description',
  'queued',
  100,
  'pgtap-bounded-queue-v1',
  statement_timestamp()
);

insert into pgtap_bounded_claims (case_name, payload)
values ('old-source-first', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_bounded_claims where case_name = 'old-source-first'),
  'collect',
  'the first overdue source keeps one bounded collection turn'
);

select is(
  (select source_dispatch_streak from public.auction_pipeline_control where id),
  1,
  'the source turn increments the persisted streak'
);

delete from public.auction_runs
 where id = (
   select (payload->>'id')::uuid
   from pgtap_bounded_claims
   where case_name = 'old-source-first'
 );

insert into pgtap_bounded_claims (case_name, payload)
values ('queue-after-source', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_bounded_claims where case_name = 'queue-after-source'),
  'enrichment',
  'the queue receives the next scheduler turn after one overdue source'
);

select is(
  (select payload->>'source' from pgtap_bounded_claims where case_name = 'queue-after-source'),
  'enrichment-queue',
  'the bounded priority claim creates an enrichment run'
);

select ok(
  (
    select next_enrichment_at > statement_timestamp() + interval '29 minutes'
       and next_enrichment_at < statement_timestamp() + interval '31 minutes'
    from public.auction_pipeline_control
    where id
  ),
  'a queue claim advances next_enrichment_at by the existing 30-minute cadence'
);

select is(
  (select source_dispatch_streak from public.auction_pipeline_control where id),
  0,
  'the queue claim resets the source streak'
);

select ok(
  (
    select next_inventory_at <= statement_timestamp()
    from public.auction_source_state
    where source_name = 'pgtap-bounded-old-b'
  ),
  'queue priority does not postpone the remaining source inventory turn'
);

delete from public.auction_runs
 where id = (
   select (payload->>'id')::uuid
   from pgtap_bounded_claims
   where case_name = 'queue-after-source'
 );

-- No source due and no eligible queue: the scheduler returns no run and
-- advances the due worker cadence exactly as the existing no-work branch did.
update public.auction_pipeline_control
   set source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

update public.auction_source_state
   set enabled = false
 where source_name in (
   'pgtap-bounded-future',
   'pgtap-bounded-due-empty',
   'pgtap-bounded-old-a',
   'pgtap-bounded-old-b'
 );

update public.auction_enrichment_jobs
   set status = 'completed',
       completed_at = statement_timestamp(),
       updated_at = statement_timestamp()
 where source_url = 'https://example.test/pgtap/bounded/queue';

insert into pgtap_bounded_claims (case_name, payload)
values ('no-source-no-job', public.claim_autonomous_pipeline_run());

select is(
  (select payload from pgtap_bounded_claims where case_name = 'no-source-no-job'),
  null::jsonb,
  'no source and no eligible queue job produce no scheduler run'
);

select ok(
  (
    select next_enrichment_at > statement_timestamp() + interval '29 minutes'
       and next_enrichment_at < statement_timestamp() + interval '31 minutes'
    from public.auction_pipeline_control
    where id
  ),
  'the no-work branch advances next_enrichment_at by 30 minutes'
);

select * from finish();

rollback;
