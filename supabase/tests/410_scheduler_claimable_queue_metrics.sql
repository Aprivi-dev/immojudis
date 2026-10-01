begin;

select plan(26);

select has_function(
  'public',
  'claim_autonomous_pipeline_run',
  array[]::text[],
  'the autonomous scheduler keeps its zero-argument signature'
);

select ok(
  (
    select not procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role',
        'public.claim_autonomous_pipeline_run()',
        'execute'
      )
      and not has_function_privilege(
        'anon',
        'public.claim_autonomous_pipeline_run()',
        'execute'
      )
      and not has_function_privilege(
        'authenticated',
        'public.claim_autonomous_pipeline_run()',
        'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.claim_autonomous_pipeline_run()'::regprocedure
  ),
  'the scheduler keeps invoker security, an empty search_path, and service-only ACLs'
);

select ok(
  position('), eligible as (' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0
  and position('j.status in (''queued'',''failed'')' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0
  and position('s.retention_deadline_materialized' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0
  and position('state.suspended_until' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0
  and position('partition by source_url, job_type, detail_source_name, detail_source_url' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0
  and position('where status <> ''cancelled''' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0
  and position('revision.revision_rank = 1' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0
  and position('interval ''30 minutes''' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0,
  'scheduler queue_due uses the bounded all-family admission fence'
);

select ok(
  position('pg_try_advisory_xact_lock' in lower(pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  ))) > 0
  and position('perform public.enqueue_due_source_details(now_at,500);' in
    pg_get_functiondef('public.claim_autonomous_pipeline_run()'::regprocedure)
      ) > position('if active_id is not null then' in
        pg_get_functiondef('public.claim_autonomous_pipeline_run()'::regprocedure))
  and position('perform public.enqueue_due_source_details(now_at,500);' in
    pg_get_functiondef('public.claim_autonomous_pipeline_run()'::regprocedure)
      ) < position('update public.auction_source_state s set next_inventory_at' in
        pg_get_functiondef('public.claim_autonomous_pipeline_run()'::regprocedure)),
  'advisory lock, active-run guard, and busy-enqueue order remain intact'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role',
        'public.observe_autonomous_pipeline(timestamptz)',
        'execute'
      )
      and not has_function_privilege(
        'anon',
        'public.observe_autonomous_pipeline(timestamptz)',
        'execute'
      )
      and not has_function_privilege(
        'authenticated',
        'public.observe_autonomous_pipeline(timestamptz)',
        'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ),
  'the observer remains SECURITY DEFINER with its private service-only boundary'
);

select ok(
  position('due_candidates as materialized' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('claimable_due' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('excluded_due' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('revision_rank = 1' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('partition by source_url, job_type, detail_source_name, detail_source_url' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('older_than_24h' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0,
  'the observer keeps raw age evidence and exposes the due split'
);

set local role service_role;

-- This file is a rollback-only fixture.  It deliberately isolates the queue
-- and scheduler rows before creating source-detail cases with distinct causes:
-- disabled, paused, expired retention, quarantined sale, and a recent lease.
delete from public.auction_enrichment_jobs;
delete from public.auction_runs where status in ('queued', 'running');
update public.auction_source_state
   set enabled = false,
       suspended_until = null,
       next_inventory_at = statement_timestamp() + interval '1 day';
update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = true,
       enrichment_drain_until = null,
       queue_claim_not_before = null,
       source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into public.auction_source_state (
  source_name,
  enabled,
  suspended_until,
  next_inventory_at
)
values
  ('pgtap-410-origin', false, null, statement_timestamp() + interval '1 day'),
  ('pgtap-410-disabled', false, null, statement_timestamp() + interval '1 day'),
  ('pgtap-410-paused', true, statement_timestamp() + interval '1 hour', statement_timestamp() + interval '1 day'),
  ('pgtap-410-retention', true, null, statement_timestamp() + interval '1 day'),
  ('pgtap-410-quarantine', true, null, statement_timestamp() + interval '1 day'),
  ('pgtap-410-recent', true, null, statement_timestamp() + interval '1 day'),
  ('pgtap-410-stale', true, null, statement_timestamp() + interval '1 day');

insert into public.auction_sales (
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values
  ('pgtap-410-origin', 'https://example.test/pgtap/410/disabled', 'upcoming', statement_timestamp() + interval '7 days', '{}'::jsonb),
  ('pgtap-410-origin', 'https://example.test/pgtap/410/paused', 'upcoming', statement_timestamp() + interval '7 days', '{}'::jsonb),
  ('pgtap-410-origin', 'https://example.test/pgtap/410/retention', 'past', statement_timestamp() - interval '30 days', '{}'::jsonb),
  ('pgtap-410-origin', 'https://example.test/pgtap/410/quarantine', 'quarantined', statement_timestamp() + interval '7 days', '{}'::jsonb),
  ('pgtap-410-origin', 'https://example.test/pgtap/410/recent', 'upcoming', statement_timestamp() + interval '7 days', '{}'::jsonb),
  ('pgtap-410-origin', 'https://example.test/pgtap/410/stale', 'upcoming', statement_timestamp() + interval '7 days', '{}'::jsonb);

-- Sale triggers can create ordinary revisions; the rows under test are inserted
-- explicitly after that side effect is removed.
delete from public.auction_enrichment_jobs;

insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  next_attempt_at,
  created_at,
  updated_at,
  detail_source_name,
  detail_source_url
)
values
  ('https://example.test/pgtap/410/disabled', 'source_detail', 'queued', 10, 'pgtap-410-disabled-v1', statement_timestamp() - interval '1 minute', statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 days', 'pgtap-410-disabled', 'https://example.test/pgtap/410/detail/disabled'),
  ('https://example.test/pgtap/410/paused', 'source_detail', 'queued', 10, 'pgtap-410-paused-v1', statement_timestamp() - interval '1 minute', statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 days', 'pgtap-410-paused', 'https://example.test/pgtap/410/detail/paused'),
  ('https://example.test/pgtap/410/retention', 'source_detail', 'queued', 10, 'pgtap-410-retention-v1', statement_timestamp() - interval '1 minute', statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 days', 'pgtap-410-retention', 'https://example.test/pgtap/410/detail/retention'),
  ('https://example.test/pgtap/410/quarantine', 'source_detail', 'queued', 10, 'pgtap-410-quarantine-v1', statement_timestamp() - interval '1 minute', statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 days', 'pgtap-410-quarantine', 'https://example.test/pgtap/410/detail/quarantine'),
  ('https://example.test/pgtap/410/recent', 'source_detail', 'queued', 10, 'pgtap-410-recent-queued-v1', statement_timestamp() - interval '1 minute', statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 days', 'pgtap-410-recent', 'https://example.test/pgtap/410/detail/recent-queued'),
  ('https://example.test/pgtap/410/recent', 'source_detail', 'running', 10, 'pgtap-410-recent-running-v1', statement_timestamp() - interval '1 minute', statement_timestamp() - interval '2 days', statement_timestamp(), 'pgtap-410-recent', 'https://example.test/pgtap/410/detail/recent-running');

create temporary table pgtap_410_claims (
  case_name text primary key,
  payload jsonb
) on commit drop;

select is(
  (
    select count(*)
      from public.auction_enrichment_jobs
     where source_url like 'https://example.test/pgtap/410/%'
       and status in ('queued', 'running', 'failed')
       and next_attempt_at <= statement_timestamp()
       and attempt_count < max_attempts
  ),
  6::bigint,
  'the excluded-only fixture contains six due or leased rows'
);

insert into pgtap_410_claims(case_name, payload)
values ('excluded-only', public.claim_autonomous_pipeline_run());

select is(
  (select payload from pgtap_410_claims where case_name = 'excluded-only'),
  null::jsonb,
  'disabled, paused, expired, quarantined, and recent-lease rows do not dispatch an empty worker'
);

select is(
  (
    select count(*)
      from public.auction_runs
     where source = 'enrichment-queue'
       and status = 'queued'
       and scheduler_owned
  ),
  0::bigint,
  'the excluded-only decision creates no scheduler-owned queue run'
);

insert into public.auction_sales (
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values (
  'pgtap-410-origin',
  'https://example.test/pgtap/410/general',
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
);
delete from public.auction_enrichment_jobs
 where source_url = 'https://example.test/pgtap/410/general';
insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  next_attempt_at,
  created_at,
  updated_at
)
values (
  'https://example.test/pgtap/410/general',
  'display_description',
  'queued',
  10,
  'pgtap-410-general-v1',
  statement_timestamp() - interval '1 minute',
  statement_timestamp() - interval '2 days',
  statement_timestamp() - interval '2 days'
);
update public.auction_pipeline_control
   set next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into pgtap_410_claims(case_name, payload)
values ('general', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_410_claims where case_name = 'general'),
  'enrichment',
  'a general admissible job still dispatches the enrichment queue'
);

select is(
  (select payload->>'source' from pgtap_410_claims where case_name = 'general'),
  'enrichment-queue',
  'the general job keeps the scheduler queue source'
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
  'one scheduler-owned queue run is created for admissible work'
);

delete from public.auction_runs
 where source = 'enrichment-queue'
   and status = 'queued';
update public.auction_enrichment_jobs
   set status = 'completed',
       completed_at = statement_timestamp(),
       updated_at = statement_timestamp()
 where source_url = 'https://example.test/pgtap/410/general';

insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  next_attempt_at,
  locked_at,
  created_at,
  updated_at,
  detail_source_name,
  detail_source_url
)
values (
  'https://example.test/pgtap/410/stale',
  'source_detail',
  'running',
  10,
  'pgtap-410-stale-v1',
  statement_timestamp() - interval '1 minute',
  statement_timestamp() - interval '31 minutes',
  statement_timestamp() - interval '2 days',
  statement_timestamp() - interval '31 minutes',
  'pgtap-410-stale',
  'https://example.test/pgtap/410/detail/stale'
);
update public.auction_pipeline_control
   set next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into pgtap_410_claims(case_name, payload)
values ('stale', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_410_claims where case_name = 'stale'),
  'enrichment',
  'a stale running lease is admissible after its 30-minute fence'
);

select ok(
  (
    select count(*) = 1
       and bool_and(status = 'running')
       and bool_and(locked_at < statement_timestamp() - interval '30 minutes')
      from public.auction_enrichment_jobs
     where source_url = 'https://example.test/pgtap/410/stale'
       and input_hash = 'pgtap-410-stale-v1'
  ),
  'scheduler observation does not mutate the authoritative stale lease'
);

-- A newer completed revision is part of the housekeeping ranking even when it
-- is not itself due.  The older due row must remain in the raw queue while the
-- scheduler treats it as excluded and creates no empty worker.
delete from public.auction_runs
 where source = 'enrichment-queue'
   and status = 'queued';
update public.auction_enrichment_jobs
   set status = 'completed',
       completed_at = statement_timestamp(),
       updated_at = statement_timestamp()
 where source_url = 'https://example.test/pgtap/410/stale'
   and input_hash = 'pgtap-410-stale-v1';

insert into public.auction_sales (
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values (
  'pgtap-410-origin',
  'https://example.test/pgtap/410/revision-completed',
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
);
delete from public.auction_enrichment_jobs
 where source_url = 'https://example.test/pgtap/410/revision-completed';
insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  next_attempt_at,
  created_at,
  updated_at,
  completed_at
)
values
  (
    'https://example.test/pgtap/410/revision-completed',
    'display_description',
    'queued',
    10,
    'pgtap-410-revision-old-v1',
    statement_timestamp() - interval '1 minute',
    statement_timestamp() - interval '2 days',
    statement_timestamp() - interval '2 days',
    null
  ),
  (
    'https://example.test/pgtap/410/revision-completed',
    'display_description',
    'completed',
    10,
    'pipeline_v2:pgtap-410-revision-new-v2',
    statement_timestamp() + interval '1 hour',
    statement_timestamp() - interval '1 hour',
    statement_timestamp() - interval '1 hour',
    statement_timestamp() - interval '30 minutes'
  );
update public.auction_pipeline_control
   set next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into pgtap_410_claims(case_name, payload)
values ('revision-completed', public.claim_autonomous_pipeline_run());

select is(
  (select payload from pgtap_410_claims where case_name = 'revision-completed'),
  null::jsonb,
  'a due row loses admission to a newer completed and not-due revision'
);

select is(
  (
    select count(*)
      from public.auction_runs
     where source = 'enrichment-queue'
       and status = 'queued'
       and scheduler_owned
  ),
  0::bigint,
  'the superseded-only queue does not create an empty scheduler run'
);

select ok(
  (
    select count(*) filter (where status = 'queued') = 1
       and count(*) filter (where status = 'completed') = 1
      from public.auction_enrichment_jobs
     where source_url = 'https://example.test/pgtap/410/revision-completed'
  ),
  'the scheduler leaves both raw revision rows unchanged for observation'
);

-- Three rows share a NULL detail identity and one statement timestamp.  The
-- exact claim order must prefer pipeline_v2, then the greatest UUID among the
-- two pipeline_v2 ties, while the other two rows remain raw excluded work.
insert into public.auction_sales (
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values (
  'pgtap-410-origin',
  'https://example.test/pgtap/410/revision-tie',
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
);
delete from public.auction_enrichment_jobs
 where source_url = 'https://example.test/pgtap/410/revision-tie';
insert into public.auction_enrichment_jobs (
  id,
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  next_attempt_at,
  created_at,
  updated_at
)
values
  (
    'f4100000-0000-4000-8000-000000000003',
    'https://example.test/pgtap/410/revision-tie',
    'display_description',
    'queued',
    10,
    'pgtap-410-tie-plain-v1',
    statement_timestamp() - interval '1 minute',
    statement_timestamp(),
    statement_timestamp()
  ),
  (
    'f4100000-0000-4000-8000-000000000001',
    'https://example.test/pgtap/410/revision-tie',
    'display_description',
    'queued',
    10,
    'pipeline_v2:pgtap-410-tie-low-v1',
    statement_timestamp() - interval '1 minute',
    statement_timestamp(),
    statement_timestamp()
  ),
  (
    'f4100000-0000-4000-8000-000000000002',
    'https://example.test/pgtap/410/revision-tie',
    'display_description',
    'queued',
    10,
    'pipeline_v2:pgtap-410-tie-high-v1',
    statement_timestamp() - interval '1 minute',
    statement_timestamp(),
    statement_timestamp()
  );

select is(
  (
    select id
      from (
        select id,
               row_number() over (
                 partition by source_url, job_type, detail_source_name, detail_source_url
                 order by created_at desc,
                          (input_hash like 'pipeline_v2:%') desc,
                          id desc
               ) as revision_rank
          from public.auction_enrichment_jobs
         where source_url = 'https://example.test/pgtap/410/revision-tie'
           and status <> 'cancelled'
      ) ranked
     where revision_rank = 1
  ),
  'f4100000-0000-4000-8000-000000000002'::uuid,
  'revision ranking is NULL-safe and prefers pipeline_v2 before the UUID tie-break'
);

update public.auction_pipeline_control
   set next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;
insert into pgtap_410_claims(case_name, payload)
values ('revision-tie', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_410_claims where case_name = 'revision-tie'),
  'enrichment',
  'the winning revision remains dispatchable while older ties stay excluded'
);

delete from public.auction_runs
 where source = 'enrichment-queue'
   and status = 'queued';

create temporary table pgtap_410_observe_context (
  p_now timestamptz not null,
  payload jsonb
) on commit drop;
insert into pgtap_410_observe_context(p_now)
values (statement_timestamp());

select lives_ok(
  $sql$
    update pgtap_410_observe_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where p_now is not null;
  $sql$,
  'the observer records claimable and excluded due metrics'
);

select ok(
  (
    select payload->>'enabled' = 'true'
       and payload->'queue' ? 'backlog'
       and payload->'queue' ? 'older_than_24h'
       and payload->'queue' ? 'claimable_due'
       and payload->'queue' ? 'excluded_due'
      from pgtap_410_observe_context
  ),
  'queue evidence keeps raw counters and exposes both due categories'
);

select is(
  (
    select (payload->'queue'->>'claimable_due')::integer
      from pgtap_410_observe_context
  ),
  1,
  'the observer counts only the winning revision as claimable due work'
);

select is(
  (
    select (payload->'queue'->>'excluded_due')::integer
      from pgtap_410_observe_context
  ),
  8,
  'the observer adds superseded revision rows to excluded due work'
);

select is(
  (
    select (payload->'queue'->>'backlog')::integer
      from pgtap_410_observe_context
  ),
  10,
  'the raw backlog still includes superseded and winning revision rows'
);

select ok(
  (
    select (payload->'queue'->>'older_than_24h')::integer > 0
      from pgtap_410_observe_context
  ),
  'the raw older-than-24-hour counter remains independent of claimability'
);

select is(
  (
    select count(*)
      from public.auction_pipeline_observations
     where source_name = 'enrichment-queue'
       and observed_at = (select p_now from pgtap_410_observe_context)
  ),
  1::bigint,
  'the observer writes one queue observation for the measured timestamp'
);

select * from finish();

rollback;
